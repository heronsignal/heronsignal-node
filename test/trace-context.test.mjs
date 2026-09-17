import assert from "node:assert/strict";
import { test } from "node:test";

import { heronExpressMiddleware, heronExpressErrorHandler } from "../dist/express.js";
import { readTraceContext } from "../dist/trace-context.js";

const header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

test("readTraceContext reads a traceparent and mints a span id for this side", () => {
  const trace = readTraceContext({ traceparent: header });

  assert.equal(trace.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.match(trace.spanId, /^[0-9a-f]{16}$/);
});

test("readTraceContext accepts a Headers-like object and rejects garbage", () => {
  const fromGetter = readTraceContext({ get: (name) => (name === "traceparent" ? header.toUpperCase() : null) });

  assert.equal(fromGetter.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(readTraceContext({ traceparent: "garbage" }), undefined);
  assert.equal(readTraceContext({ traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01" }), undefined);
  assert.equal(readTraceContext(undefined), undefined);
});

function fakeClient() {
  const captured = [];

  return {
    captured,
    captureHttp: (http, correlation) => captured.push({ kind: "http", http, correlation }),
    captureError: (error, attributes, correlation) => captured.push({ kind: "error", attributes, correlation }),
  };
}

function fakeResponse(statusCode) {
  const listeners = [];

  return {
    statusCode,
    on: (event, listener) => listeners.push(listener),
    finish: () => listeners.forEach((listener) => listener()),
  };
}

test("the Express middleware attaches the request's trace on its own", () => {
  const client = fakeClient();
  const middleware = heronExpressMiddleware({
    client,
    correlate: () => ({ userId: "u1" }),
  });
  const response = fakeResponse(500);

  middleware({ method: "POST", path: "/checkout", headers: { traceparent: header } }, response, () => {});
  response.finish();

  assert.equal(client.captured.length, 1);
  assert.equal(client.captured[0].correlation.userId, "u1");
  assert.equal(client.captured[0].correlation.trace.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
});

test("a trace the app set itself wins over the header", () => {
  const client = fakeClient();
  const middleware = heronExpressMiddleware({
    client,
    correlate: () => ({ trace: { traceId: "a".repeat(32), spanId: "b".repeat(16) } }),
  });
  const response = fakeResponse(503);

  middleware({ method: "GET", path: "/x", headers: { traceparent: header } }, response, () => {});
  response.finish();

  assert.equal(client.captured[0].correlation.trace.traceId, "a".repeat(32));
});

test("the error handler carries the trace too, and passes the error on", () => {
  const client = fakeClient();
  const handler = heronExpressErrorHandler({ client });
  let passed;

  handler(new Error("boom"), { method: "POST", path: "/pay", headers: { traceparent: header } }, {}, (error) => {
    passed = error;
  });

  assert.equal(passed.message, "boom");
  assert.equal(client.captured[0].correlation.trace.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
});
