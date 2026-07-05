import assert from "node:assert/strict";
import { test } from "node:test";

import { HeronSignalClient } from "../dist/client.js";
import { scrubAttributes } from "../dist/scrub.js";

function makeClient(overrides = {}) {
  const calls = [];
  let responses = overrides.responses ?? [];

  const client = new HeronSignalClient({
    token: "t-1",
    endpoint: "https://api.heronsignal.test",
    flushIntervalMs: 60_000,
    ...overrides.config,
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      const next = responses.shift() ?? { ok: true, status: 200 };
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  });

  return { client, calls };
}

test("scrubAttributes redacts broadened key set", () => {
  const out = scrubAttributes({
    password: "x",
    refresh_token: "x",
    client_secret: "x",
    cookie: "x",
    otp: "x",
    ssn_last4: "x",
    shipping: "express",
    spinner: true,
  });

  assert.equal(out.password, "[redacted]");
  assert.equal(out.refresh_token, "[redacted]");
  assert.equal(out.client_secret, "[redacted]");
  assert.equal(out.cookie, "[redacted]");
  assert.equal(out.otp, "[redacted]");
  assert.equal(out.ssn_last4, "[redacted]");
  assert.equal(out.shipping, "express");
  assert.equal(out.spinner, true);
});

test("constructor rejects non-https endpoints, allows localhost http", () => {
  assert.throws(
    () => new HeronSignalClient({ token: "t", endpoint: "http://evil.example.com" }),
    /must use https/,
  );
  assert.throws(
    () => new HeronSignalClient({ token: "t", endpoint: "not a url" }),
    /not a valid URL/,
  );

  const ok = new HeronSignalClient({
    token: "t",
    endpoint: "http://localhost:4000",
    flushIntervalMs: 60_000,
    fetch: async () => ({ ok: true, status: 200 }),
  });
  return ok.shutdown();
});

test("messages, stacks, and names are length-capped", async () => {
  const { client, calls } = makeClient();

  client.log("info", "m".repeat(10_000));
  client.event("e".repeat(1_000));
  const error = new Error("boom");
  error.stack = "s".repeat(100_000);
  client.captureError(error);

  await client.shutdown();

  const events = calls[0].body.events;
  assert.equal(events[0].message.length, 4096);
  assert.equal(events[1].name.length, 256);
  assert.equal(events[2].stack.length, 16384);
});

test("shutdown drains events even when a flush is already in flight", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];

  const client = new HeronSignalClient({
    token: "t-1",
    endpoint: "https://api.heronsignal.test",
    flushIntervalMs: 60_000,
    fetch: async (url, init) => {
      calls.push(JSON.parse(init.body).events.length);
      await gate;
      return { ok: true, status: 200 };
    },
  });

  client.event("first");
  const firstFlush = client.flush();

  client.event("second");
  const done = client.shutdown();

  release();
  await firstFlush;
  await done;

  const totalSent = calls.reduce((sum, n) => sum + n, 0);
  assert.equal(totalSent, 2);
});

test("5xx responses are retried then dropped after maxRetries", async () => {
  const onErrors = [];
  const { client, calls } = makeClient({
    responses: [
      { ok: false, status: 503 },
      { ok: false, status: 503 },
      { ok: false, status: 503 },
    ],
    config: { maxRetries: 2, retryBackoffMs: 1, onError: (e) => onErrors.push(e) },
  });

  client.event("order_paid");

  await client.flush();
  await client.flush();
  await client.flush();
  // Event is now dropped; a further flush must not send anything.
  await client.flush();

  assert.equal(calls.length, 3);
  assert.ok(onErrors.some((e) => /dropping 1 event/.test(String(e))));
  await client.shutdown();
});

test("non-429 4xx responses are dropped immediately, not retried", async () => {
  const { client, calls } = makeClient({
    responses: [{ ok: false, status: 400 }],
    config: { onError: () => {} },
  });

  client.event("bad_payload");
  await client.flush();
  await client.flush();

  assert.equal(calls.length, 1);
  await client.shutdown();
});

test("429 responses are retried", async () => {
  const { client, calls } = makeClient({
    responses: [{ ok: false, status: 429 }, { ok: true, status: 200 }],
    config: { retryBackoffMs: 1, onError: () => {} },
  });

  client.event("rate_limited");
  await client.flush();
  await client.flush();

  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.events.length, 1);
  await client.shutdown();
});

test("network errors are retried", async () => {
  const { client, calls } = makeClient({
    responses: [new Error("ECONNRESET"), { ok: true, status: 200 }],
    config: { retryBackoffMs: 1, onError: () => {} },
  });

  client.event("net_blip");
  await client.flush();
  await client.flush();

  assert.equal(calls.length, 2);
  await client.shutdown();
});

test("flush respects maxBatchSize when chunking", async () => {
  const { client, calls } = makeClient({ config: { maxBatchSize: 2 } });

  for (let i = 0; i < 5; i += 1) {
    client.log("info", `line ${i}`);
  }
  await client.shutdown();

  const sizes = calls.map((c) => c.body.events.length);
  assert.ok(sizes.every((size) => size <= 2), `batch too large: ${sizes}`);
  assert.equal(sizes.reduce((a, b) => a + b, 0), 5);
});
