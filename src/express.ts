import type { HeronSignalClient } from "./client";
import type { Correlation, HttpInfo } from "./types";

// Structural subset of what we read off the Express request/response, so this
// adapter needs no dependency on @types/express.
interface RequestLike {
  method?: string;
  path?: string;
  originalUrl?: string;
  baseUrl?: string;
  route?: { path?: string };
}

interface ResponseLike {
  statusCode: number;
  on(event: "finish", listener: () => void): void;
}

type NextLike = (error?: unknown) => void;

export interface ExpressOptions {
  client: HeronSignalClient;
  /**
   * Derive correlation (userId / sessionId / business entity) from the request,
   * e.g. `(req) => ({ userId: req.user?.id, sessionId: req.headers["x-hs-session"] })`.
   */
  correlate?: (request: unknown) => Correlation | undefined;
  /** Capture every request, not just 5xx responses. Default false. */
  captureAllRequests?: boolean;
}

/**
 * Express middleware that records an HTTP request event when the response
 * finishes. Mount it early: `app.use(heronExpressMiddleware({ client }))`.
 */
export function heronExpressMiddleware(options: ExpressOptions) {
  const { client, correlate, captureAllRequests = false } = options;

  return function heronRequest(
    request: RequestLike,
    response: ResponseLike,
    next: NextLike,
  ): void {
    const startedAt = Date.now();

    response.on("finish", () => {
      if (!captureAllRequests && response.statusCode < 500) {
        return;
      }

      const http: HttpInfo = {
        method: request.method,
        route: routeOf(request),
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt,
      };

      client.captureHttp(http, correlate?.(request));
    });

    next();
  };
}

/**
 * Express error-handling middleware that captures the thrown error, then
 * re-throws it. Mount it last: `app.use(heronExpressErrorHandler({ client }))`.
 */
export function heronExpressErrorHandler(options: ExpressOptions) {
  const { client, correlate } = options;

  return function heronError(
    error: unknown,
    request: RequestLike,
    _response: ResponseLike,
    next: NextLike,
  ): void {
    client.captureError(
      error,
      { route: routeOf(request), method: request.method },
      correlate?.(request),
    );
    next(error);
  };
}

function routeOf(request: RequestLike): string | undefined {
  if (request.route?.path) {
    return `${request.baseUrl ?? ""}${request.route.path}`;
  }
  return request.path ?? request.originalUrl;
}
