import type { Correlation } from "./types";

// W3C Trace Context, read off an incoming request.
//
// The HeronSignal browser tracker puts a `traceparent` header on the page's
// own requests, and so does any OpenTelemetry client. Reading it here is what
// lets a request event or an exception be found again from the browser
// request that caused it: the dashboard joins the two by trace id.

const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i;

type HeaderValue = string | string[] | undefined;
type HeadersLike =
  | Record<string, HeaderValue>
  | { get(name: string): string | null | undefined };

/**
 * The trace of the request these headers belong to: the trace id from its
 * `traceparent`, and a fresh span id for this server's side of it. Undefined
 * when there is no readable header, so it can be spread into a correlation.
 */
export function readTraceContext(
  headers: HeadersLike | undefined,
): Correlation["trace"] | undefined {
  const header = readHeader(headers, "traceparent");

  if (!header) {
    return undefined;
  }

  const traceId = traceparentPattern.exec(header.trim())?.[1];

  if (!traceId || /^0+$/.test(traceId)) {
    return undefined;
  }

  return { traceId: traceId.toLowerCase(), spanId: createSpanId() };
}

function readHeader(
  headers: HeadersLike | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (
      headers as { get(name: string): string | null | undefined }
    ).get(name);

    return value ?? undefined;
  }

  const record = headers as Record<string, HeaderValue>;
  const value = record[name] ?? record[name.toLowerCase()];

  return Array.isArray(value) ? value[0] : value;
}

// No DOM lib in this package, so the Web Crypto shape is spelled out.
type RandomSource = { getRandomValues?: (array: Uint8Array) => Uint8Array };

function createSpanId(): string {
  const bytes = new Uint8Array(8);
  const api = (globalThis as { crypto?: RandomSource }).crypto;

  if (api && typeof api.getRandomValues === "function") {
    api.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
