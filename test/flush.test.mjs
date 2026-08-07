import assert from "node:assert/strict";
import test from "node:test";

import { HeronSignalClient } from "../dist/client.js";

// These cover one bug: `flush()` used to return immediately when a background
// flush was already in flight. On a serverless host that meant `await flush()`
// before returning a response resolved while the batch was still in the air,
// the function froze, and the events were lost with no error anywhere.
//
// Everything the Next.js docs tell people to do rests on flush() being
// genuinely awaitable, so it is worth pinning.

// A fetch stub that lets the test decide when each request completes.
function controllableFetch() {
  const calls = [];
  const pending = [];

  const doFetch = (_url, init) => {
    const body = JSON.parse(init.body);

    calls.push(body.events);

    return new Promise((resolve) => {
      pending.push(() => resolve({ ok: true, status: 200 }));
    });
  };

  return {
    doFetch,
    calls,
    sentCount: () => calls.reduce((total, batch) => total + batch.length, 0),
    releaseAll() {
      // Copy first: releasing one send can start the next, which pushes here.
      const waiting = pending.splice(0, pending.length);

      for (const release of waiting) {
        release();
      }
    },
    pendingCount: () => pending.length,
  };
}

function makeClient(fetchStub, overrides = {}) {
  return new HeronSignalClient({
    token: "test-token",
    // No background timer: these tests drive flushing explicitly, which is
    // also the configuration a serverless user is told to use.
    flushIntervalMs: 0,
    maxBatchSize: 1000,
    ...overrides,
    fetch: fetchStub.doFetch,
  });
}

test("flush resolves only after the events have actually gone", async () => {
  const stub = controllableFetch();
  const client = makeClient(stub);

  client.event("order_paid");

  let resolved = false;
  const flushed = client.flush().then(() => {
    resolved = true;
  });

  // The request is out but the server has not answered.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false, "flush resolved before the send completed");

  stub.releaseAll();
  await flushed;
  assert.equal(resolved, true);
  assert.equal(stub.sentCount(), 1);
});

test("a second flush waits for the first instead of returning empty", async () => {
  // The actual regression. The second caller is the serverless request handler,
  // and it must not be told "done" while the first batch is still in flight.
  const stub = controllableFetch();
  const client = makeClient(stub);

  client.event("first");

  const firstFlush = client.flush();

  await new Promise((resolve) => setImmediate(resolve));

  let secondResolved = false;
  const secondFlush = client.flush().then(() => {
    secondResolved = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    secondResolved,
    false,
    "second flush resolved while the first send was still in flight",
  );

  stub.releaseAll();
  await Promise.all([firstFlush, secondFlush]);
  assert.equal(secondResolved, true);
});

test("events queued during an in-flight send are not left behind", async () => {
  // The subtle half. Waiting for the running flush is not enough on its own:
  // anything enqueued while it was sending has to go too, or the caller
  // returns having sent somebody else's events and not their own.
  const stub = controllableFetch();
  const client = makeClient(stub);

  client.event("first");

  const firstFlush = client.flush();

  await new Promise((resolve) => setImmediate(resolve));

  client.event("second");

  const secondFlush = client.flush();

  // Release repeatedly: the second batch only starts once the first finishes.
  for (let round = 0; round < 4; round += 1) {
    stub.releaseAll();
    await new Promise((resolve) => setImmediate(resolve));
  }

  await Promise.all([firstFlush, secondFlush]);
  assert.equal(stub.sentCount(), 2, "an event queued mid-send was dropped");
});

test("flush on an empty queue is a no-op", async () => {
  const stub = controllableFetch();
  const client = makeClient(stub);

  await client.flush();
  assert.equal(stub.calls.length, 0);
});

test("no background timer is created when flushIntervalMs is 0", async () => {
  // Serverless users opt out of the timer. Before this it fell through to the
  // 2000ms default, and 0 would have been a hot loop if passed straight in.
  const stub = controllableFetch();
  const client = makeClient(stub);

  client.event("queued");

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(stub.calls.length, 0, "something flushed without being asked");

  const flushed = client.flush();
  stub.releaseAll();
  await flushed;
  assert.equal(stub.sentCount(), 1);
});

test("shutdown closes the client for good, and says so once", async () => {
  // The footgun: calling shutdown() in a request handler silently kills every
  // later invocation on a warm container. It stays permanent, because that is
  // what shutdown means, but it is no longer silent.
  const stub = controllableFetch();
  const client = makeClient(stub);
  const warnings = [];
  const realWarn = console.warn;

  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    const closing = client.shutdown();

    stub.releaseAll();
    await closing;

    client.event("after_shutdown");
    client.event("also_dropped");

    const flushed = client.flush();

    stub.releaseAll();
    await flushed;
  } finally {
    console.warn = realWarn;
  }

  assert.equal(stub.sentCount(), 0, "events were sent after shutdown");
  assert.equal(warnings.length, 1, "expected exactly one warning, once");
  assert.match(warnings[0], /shut down/);
});
