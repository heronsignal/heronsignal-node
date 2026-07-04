import { HeronSignalClient } from "./client";
import type {
  Correlation,
  HeronSignalConfig,
  HttpInfo,
  ServerEventLevel,
} from "./types";

let defaultClient: HeronSignalClient | undefined;
let exitHookInstalled = false;

/**
 * Initialize the default HeronSignal client. Call once at startup, then use the
 * module-level `event` / `log` / `captureError` helpers anywhere.
 */
export function init(config: HeronSignalConfig): HeronSignalClient {
  defaultClient = new HeronSignalClient(config);

  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // Best-effort flush when the event loop drains. For hard signals (SIGTERM)
    // call `await shutdown()` from your own handler.
    process.once("beforeExit", () => {
      void defaultClient?.flush();
    });
  }

  return defaultClient;
}

/** The default client, if `init()` has been called. */
export function getClient(): HeronSignalClient | undefined {
  return defaultClient;
}

function warnUninitialized(): void {
  if (process.env.HERONSIGNAL_DEBUG) {
    console.warn("[heronsignal] not initialized — call init() first.");
  }
}

export function event(
  name: string,
  attributes?: Record<string, unknown>,
  correlation?: Correlation,
): void {
  if (!defaultClient) {
    return warnUninitialized();
  }
  defaultClient.event(name, attributes, correlation);
}

export function log(
  level: ServerEventLevel,
  message: string,
  attributes?: Record<string, unknown>,
  correlation?: Correlation,
): void {
  if (!defaultClient) {
    return warnUninitialized();
  }
  defaultClient.log(level, message, attributes, correlation);
}

export function captureError(
  error: unknown,
  attributes?: Record<string, unknown>,
  correlation?: Correlation,
): void {
  if (!defaultClient) {
    return warnUninitialized();
  }
  defaultClient.captureError(error, attributes, correlation);
}

export function captureHttp(
  http: HttpInfo,
  correlation?: Correlation,
  attributes?: Record<string, unknown>,
): void {
  if (!defaultClient) {
    return warnUninitialized();
  }
  defaultClient.captureHttp(http, correlation, attributes);
}

export function flush(): Promise<void> {
  return defaultClient ? defaultClient.flush() : Promise.resolve();
}

export function shutdown(): Promise<void> {
  return defaultClient ? defaultClient.shutdown() : Promise.resolve();
}

export { HeronSignalClient } from "./client";
export {
  heronExpressMiddleware,
  heronExpressErrorHandler,
  type ExpressOptions,
} from "./express";
export type {
  Correlation,
  HeronSignalConfig,
  HttpInfo,
  ServerEventLevel,
  ServerEventType,
} from "./types";
