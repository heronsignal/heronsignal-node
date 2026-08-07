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
const MAX_NAME_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 4_096;
const MAX_STACK_LENGTH = 16_384;
const MAX_BACKOFF_MS = 30_000;

interface QueuedEvent {
  wire: WireEvent;
  attempts: number;
}

type SendOutcome = "ok" | "retry" | "drop";

/**
 * A HeronSignal server-side client. Queues events and flushes them in batches
 * to POST {endpoint}/server-events. Instrumentation never throws into your app:
 * transport failures are reported via `onError`, retried with backoff for
 * transient errors (network, 429, 5xx), and dropped otherwise.
 */
export class HeronSignalClient {
  private readonly token: string;
  private readonly url: string;
  private readonly service?: string;
  private readonly environment?: string;
  private readonly release?: string;
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly scrub: boolean;
  private readonly debug: boolean;
  private readonly onError?: (error: unknown) => void;
  private readonly doFetch: FetchLike;

  private queue: QueuedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private backoffUntil = 0;
  private closed = false;
  private warnedClosed = false;

  constructor(config: HeronSignalConfig) {
    if (!config.token) {
      throw new Error("HeronSignal: `token` is required.");
    }

    const base = (config.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
    assertSafeEndpoint(base);

    this.token = config.token;
    this.url = `${base}/server-events`;
    this.service = config.service;
    // `process` is absent on Edge and Workers runtimes, where reading it
    // unguarded throws at construction and takes the request down with it.
    this.environment = config.environment ?? readNodeEnv();
    this.release = config.release;
    this.maxBatchSize = Math.min(config.maxBatchSize ?? 50, HARD_BATCH_CAP);
    this.maxQueueSize = config.maxQueueSize ?? 1000;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryBackoffMs = config.retryBackoffMs ?? 1000;
    this.scrub = !config.disableScrubbing;
    this.debug = Boolean(config.debug);
    this.onError = config.onError;
    this.doFetch =
      config.fetch ??
      ((url, init) =>
        (globalThis as { fetch: FetchLike }).fetch(url, init));

    // 0 or less means "no background timer, I will flush explicitly". That is
    // the correct setting on a serverless host, where the function freezes the
    // moment the response returns and a timer scheduled for later never fires.
    const interval = config.flushIntervalMs ?? 2000;

    if (interval > 0) {
      this.timer = setInterval(() => this.timerFlush(), interval);
      // Don't keep the process alive just for the flush timer.
      this.timer.unref?.();
    }
  }

  /** Record a business milestone (e.g. "order_paid"). Powers funnels & metrics. */
  event(
    name: string,
    attributes?: Record<string, unknown>,
    correlation?: Correlation,
  ): void {
    this.enqueue(
      { type: "event", name: truncate(name, MAX_NAME_LENGTH), attributes },
      correlation,
    );
  }

  /** Record a diagnostic log line. */
  log(
    level: ServerEventLevel,
    message: string,
    attributes?: Record<string, unknown>,
    correlation?: Correlation,
  ): void {
    this.enqueue(
      {
        type: "log",
        level,
        message: truncate(message, MAX_MESSAGE_LENGTH),
        attributes,
      },
      correlation,
    );
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
        name: truncate(normalized.name, MAX_NAME_LENGTH),
        message: truncate(normalized.message, MAX_MESSAGE_LENGTH),
        stack: normalized.stack
          ? truncate(normalized.stack, MAX_STACK_LENGTH)
          : undefined,
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

  /**
   * Send everything queued right now. Safe to call anytime; concurrent calls
   * share the same in-flight drain, so awaiting flush() during another flush
   * still waits until the queue has actually been drained.
   */
  flush(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.drain().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /**
   * Flush and stop the background timer, permanently. Call this from a process
   * shutdown handler ONLY.
   *
   * Never call it in a request handler. It closes the client for good, and on a
   * warm serverless container that means the first invocation reports and every
   * one after it silently drops. Use `flush()` there instead.
   */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
    // A flush that was already in-flight when we were called may have finished
    // its final queue check before the last events were enqueued, so drain again.
    if (this.queue.length > 0) {
      await this.flush();
    }
  }

  private timerFlush(): void {
    if (Date.now() < this.backoffUntil) {
      return;
    }
    void this.flush();
  }

  private enqueue(
    partial: Omit<WireEvent, "occurredAt">,
    correlation?: Correlation,
  ): void {
    if (this.closed) {
      // Say it once. Dropping events after shutdown is correct, but a caller
      // who put shutdown() in a request handler is now losing everything and
      // has nothing at all to tell them so.
      if (!this.warnedClosed) {
        this.warnedClosed = true;
        console.warn(
          "[heronsignal] client is shut down, dropping events. " +
            "shutdown() closes the client permanently: use flush() to send " +
            "before a serverless response returns.",
        );
      }

      return;
    }

    const wire: WireEvent = {
      ...partial,
      ...spreadCorrelation(correlation),
      attributes:
        this.scrub && partial.attributes
          ? scrubAttributes(partial.attributes)
          : partial.attributes,
      occurredAt: new Date().toISOString(),
    };

    this.queue.push({ wire, attempts: 0 });

    if (this.queue.length > this.maxQueueSize) {
      // Drop the oldest to bound memory; monitoring must never OOM the app.
      this.queue.splice(0, this.queue.length - this.maxQueueSize);
      if (this.debug) {
        console.warn("[heronsignal] queue full, dropping oldest events");
      }
    }

    if (this.queue.length >= this.maxBatchSize && Date.now() >= this.backoffUntil) {
      void this.flush();
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const chunk = this.queue.splice(0, this.maxBatchSize);
      const outcome = await this.send(chunk.map((item) => item.wire));

      if (outcome === "ok") {
        this.consecutiveFailures = 0;
        this.backoffUntil = 0;
        continue;
      }

      if (outcome === "retry") {
        this.consecutiveFailures += 1;
        this.backoffUntil =
          Date.now() +
          Math.min(
            this.retryBackoffMs * 2 ** (this.consecutiveFailures - 1),
            MAX_BACKOFF_MS,
          );

        // Re-queue events that still have retry budget; the normal
        // drop-oldest bound applies, so retries can never grow the queue.
        const retriable = chunk
          .map((item) => ({ wire: item.wire, attempts: item.attempts + 1 }))
          .filter((item) => item.attempts <= this.maxRetries);

        const exhausted = chunk.length - retriable.length;
        if (exhausted > 0) {
          this.reportError(
            new Error(
              `HeronSignal: dropping ${exhausted} event(s) after ${this.maxRetries} retries`,
            ),
          );
        }

        this.queue.push(...retriable);
        if (this.queue.length > this.maxQueueSize) {
          this.queue.splice(0, this.queue.length - this.maxQueueSize);
        }
      }

      // "retry" waits for backoff; "drop" already reported. Either way, stop
      // draining. The next flush picks the queue back up.
      return;
    }
  }

  private async send(events: WireEvent[]): Promise<SendOutcome> {
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

      if (response.ok) {
        if (this.debug) {
          console.log(`[heronsignal] sent ${events.length} event(s)`);
        }
        return "ok";
      }

      this.reportError(
        new Error(`HeronSignal ingest returned ${response.status}`),
      );

      // 429 and 5xx are transient; other 4xx means the batch itself was
      // rejected and must not become a poison loop.
      return response.status === 429 || response.status >= 500
        ? "retry"
        : "drop";
    } catch (error) {
      this.reportError(error);
      return "retry";
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

function assertSafeEndpoint(base: string): void {
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`HeronSignal: \`endpoint\` is not a valid URL: ${base}`);
  }

  if (parsed.protocol === "https:") {
    return;
  }

  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname.endsWith(".localhost");

  if (parsed.protocol === "http:" && loopback) {
    return;
  }

  throw new Error(
    `HeronSignal: \`endpoint\` must use https:// (http:// is allowed for localhost only): ${base}`,
  );
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
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

// `process` is not defined on the Edge runtime or in Cloudflare Workers, and
// Next's Edge shim provides only part of it. Reading it defensively keeps the
// SDK runtime-agnostic, which is the whole reason it uses globalThis.fetch.
function readNodeEnv(): string | undefined {
  return typeof process !== "undefined" ? process.env?.NODE_ENV : undefined;
}
