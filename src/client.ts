import { scrubAttributes } from "./scrub";
import type {
  Correlation,
  FetchLike,
  HeronSignalConfig,
  HttpInfo,
  ServerEventLevel,
  WireEvent,
} from "./types";

const DEFAULT_ENDPOINT = "https://api.heronsignal.com";
const HARD_BATCH_CAP = 100;
const SEND_TIMEOUT_MS = 10_000;

/**
 * A HeronSignal server-side client. Queues events and flushes them in batches
 * to POST {endpoint}/server-events. Instrumentation never throws into your app:
 * transport failures are reported via `onError` and dropped.
 */
export class HeronSignalClient {
  private readonly token: string;
  private readonly url: string;
  private readonly service?: string;
  private readonly environment?: string;
  private readonly release?: string;
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly scrub: boolean;
  private readonly debug: boolean;
  private readonly onError?: (error: unknown) => void;
  private readonly doFetch: FetchLike;

  private queue: WireEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing = false;
  private closed = false;

  constructor(config: HeronSignalConfig) {
    if (!config.token) {
      throw new Error("HeronSignal: `token` is required.");
    }

    const base = (config.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
    this.token = config.token;
    this.url = `${base}/server-events`;
    this.service = config.service;
    this.environment = config.environment ?? process.env.NODE_ENV;
    this.release = config.release;
    this.maxBatchSize = Math.min(config.maxBatchSize ?? 50, HARD_BATCH_CAP);
    this.maxQueueSize = config.maxQueueSize ?? 1000;
    this.scrub = !config.disableScrubbing;
    this.debug = Boolean(config.debug);
    this.onError = config.onError;
    this.doFetch =
      config.fetch ??
      ((url, init) =>
        (globalThis as { fetch: FetchLike }).fetch(url, init));

    const interval = config.flushIntervalMs ?? 2000;
    this.timer = setInterval(() => void this.flush(), interval);
    // Don't keep the process alive just for the flush timer.
    this.timer.unref?.();
  }

  /** Record a business milestone (e.g. "order_paid"). Powers funnels & metrics. */
  event(
    name: string,
    attributes?: Record<string, unknown>,
    correlation?: Correlation,
  ): void {
    this.enqueue({ type: "event", name, attributes }, correlation);
  }

  /** Record a diagnostic log line. */
  log(
    level: ServerEventLevel,
    message: string,
    attributes?: Record<string, unknown>,
    correlation?: Correlation,
  ): void {
    this.enqueue({ type: "log", level, message, attributes }, correlation);
  }

  /** Record a handled exception. Accepts an Error or anything thrown. */
  captureError(
    error: unknown,
    attributes?: Record<string, unknown>,
    correlation?: Correlation,
  ): void {
    const normalized = normalizeError(error);
    this.enqueue(
      {
        type: "exception",
        level: "error",
        name: normalized.name,
        message: normalized.message,
        stack: normalized.stack,
        attributes,
      },
      correlation,
    );
  }

  /** Record an HTTP request (used by the framework adapters). */
  captureHttp(
    http: HttpInfo,
    correlation?: Correlation,
    attributes?: Record<string, unknown>,
  ): void {
    const level: ServerEventLevel | undefined =
      http.statusCode && http.statusCode >= 500 ? "error" : undefined;
    this.enqueue({ type: "request", level, http, attributes }, correlation);
  }

  /** Send everything queued right now. Safe to call anytime. */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) {
      return;
    }

    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const chunk = this.queue.splice(0, HARD_BATCH_CAP);
        await this.send(chunk);
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Flush and stop the background timer. Call this in your shutdown handler. */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }

  private enqueue(
    partial: Omit<WireEvent, "occurredAt">,
    correlation?: Correlation,
  ): void {
    if (this.closed) {
      return;
    }

    const event: WireEvent = {
      ...partial,
      ...spreadCorrelation(correlation),
      attributes:
        this.scrub && partial.attributes
          ? scrubAttributes(partial.attributes)
          : partial.attributes,
      occurredAt: new Date().toISOString(),
    };

    this.queue.push(event);

    if (this.queue.length > this.maxQueueSize) {
      // Drop the oldest to bound memory; monitoring must never OOM the app.
      this.queue.splice(0, this.queue.length - this.maxQueueSize);
      if (this.debug) {
        console.warn("[heronsignal] queue full — dropping oldest events");
      }
    }

    if (this.queue.length >= this.maxBatchSize) {
      void this.flush();
    }
  }

  private async send(events: WireEvent[]): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

    try {
      const response = await this.doFetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          service: this.service,
          environment: this.environment,
          release: this.release,
          events,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.reportError(
          new Error(`HeronSignal ingest returned ${response.status}`),
        );
      } else if (this.debug) {
        console.log(`[heronsignal] sent ${events.length} event(s)`);
      }
    } catch (error) {
      this.reportError(error);
    } finally {
      clearTimeout(timeout);
    }
  }

  private reportError(error: unknown): void {
    if (this.onError) {
      try {
        this.onError(error);
      } catch {
        // never let the error handler break the app
      }
    } else if (this.debug) {
      console.warn("[heronsignal] failed to send events:", error);
    }
  }
}

function spreadCorrelation(
  correlation: Correlation | undefined,
): Partial<WireEvent> {
  if (!correlation) {
    return {};
  }

  const out: Partial<WireEvent> = {};
  if (correlation.userId) out.userId = correlation.userId;
  if (correlation.sessionId) out.sessionId = correlation.sessionId;
  if (correlation.entity) out.entity = correlation.entity;
  if (correlation.trace) out.trace = correlation.trace;
  return out;
}

function normalizeError(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message,
      stack: error.stack,
    };
  }

  if (typeof error === "string") {
    return { name: "Error", message: error };
  }

  try {
    return { name: "Error", message: JSON.stringify(error) };
  } catch {
    return { name: "Error", message: String(error) };
  }
}
