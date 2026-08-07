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
 *
 * Safe to call more than once: the previous client is shut down first. Next.js
 * hot reload re-runs modules, so without that every save leaked a timer and
 * stranded whatever was queued on the old client.
 */
export function init(config: HeronSignalConfig): HeronSignalClient {
  const previous = defaultClient;

  defaultClient = new HeronSignalClient(config);

  if (previous) {
    void previous.shutdown();
  }

  installExitHook();

  return defaultClient;
}

// `process.once` does not exist on the Edge runtime, where Next provides only a
// partial `process` shim. Calling it unguarded threw a TypeError during module
// init and took the customer's middleware down with it, which is a hard failure
// caused entirely by an optional convenience.
function installExitHook(): void {
  if (exitHookInstalled) {
    return;
  }

  if (typeof process === "undefined" || typeof process.once !== "function") {
    return;
  }

  exitHookInstalled = true;
  // Best-effort flush when the event loop drains. This never fires on a
  // serverless host: the function freezes rather than exiting, so flush before
  // the response returns instead. See the Next.js section of the README.
  process.once("beforeExit", () => {
    void defaultClient?.flush();
  });
}

/** The default client, if `init()` has been called. */
export function getClient(): HeronSignalClient | undefined {
  return defaultClient;
}

function warnUninitialized(): void {
  // Guarded for the same reason as the exit hook: no `process` on Edge.
  const debug =
    typeof process !== "undefined" && process.env?.HERONSIGNAL_DEBUG;

  if (debug) {
    console.warn("[heronsignal] not initialized, call init() first.");
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
