export type ServerEventLevel = "error" | "warn" | "info";

export type ServerEventType = "exception" | "log" | "request" | "event";

/**
 * How a backend event ties back to a real user. Prefer durable identifiers
 * (userId, a business entity like an order id) over sessionId, which only
 * exists while a browser session is live.
 */
export interface Correlation {
  userId?: string;
  sessionId?: string;
  entity?: { type?: string; id?: string };
  trace?: { traceId?: string; spanId?: string };
}

export interface HttpInfo {
  method?: string;
  route?: string;
  statusCode?: number;
  durationMs?: number;
}

/** Minimal shape of the response we need, avoiding a dependency on DOM or undici types. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export interface HeronSignalConfig {
  /** Server ingest token (create one in Developer → Tokens). Required. */
  token: string;
  /** Ingest base URL. Defaults to https://api.heronsignal.com */
  endpoint?: string;
  /** Service name attached to every event (e.g. "checkout-api"). */
  service?: string;
  /** Deployment environment. Defaults to process.env.NODE_ENV. */
  environment?: string;
  /** Release/version identifier (e.g. a git sha). */
  release?: string;
  /** How often the queue is flushed, in ms. Default 2000. */
  flushIntervalMs?: number;
  /** Flush early once this many events are queued. Default 50 (hard cap 100). */
  maxBatchSize?: number;
  /** Drop the oldest events past this queue size. Default 1000. */
  maxQueueSize?: number;
  /**
   * How many times a batch is retried after a transient failure (network
   * error, 429, or 5xx) before its events are dropped. Default 2.
   */
  maxRetries?: number;
  /** Base delay for exponential retry backoff, in ms. Default 1000. */
  retryBackoffMs?: number;
  /** Disable client-side scrubbing of sensitive attribute keys. Default false. */
  disableScrubbing?: boolean;
  /** Log SDK diagnostics to console. Default false. */
  debug?: boolean;
  /** Called when a batch fails to send. Never throws into your app. */
  onError?: (error: unknown) => void;
  /** Override the fetch implementation (mainly for tests). */
  fetch?: FetchLike;
}

/** The on-the-wire event shape accepted by POST /server-events. */
export interface WireEvent {
  type: ServerEventType;
  level?: ServerEventLevel;
  name?: string;
  message?: string;
  stack?: string;
  http?: HttpInfo;
  userId?: string;
  sessionId?: string;
  entity?: { type?: string; id?: string };
  trace?: { traceId?: string; spanId?: string };
  attributes?: Record<string, unknown>;
  occurredAt?: string;
}
