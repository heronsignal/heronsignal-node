# @heronsignal/node

Server-side SDK for [HeronSignal](https://heronsignal.com). Capture backend
**errors**, **logs**, and **business events**, correlated to the real user
session that triggered them, so a server error or a server-confirmed conversion
lines up with the browser journey and your funnels.

Mirrors the browser API (`event` / `log` / `captureError`), so the mental model
is the same on the front and back end.

- Zero runtime dependencies · Node **18+** (uses the built-in `fetch`)
- Non-blocking: events are queued and flushed in batches
- Safe by default: never throws into your app; sensitive attribute keys are
  scrubbed before they leave the process

## Install

```bash
npm install @heronsignal/node
```

## Quick start

Create a **server ingest token** in the dashboard (Settings → Tokens), then:

```ts
import { init, event, log, captureError } from "@heronsignal/node";

init({
  token: process.env.HERONSIGNAL_SERVER_TOKEN!,
  service: "checkout-api",
  environment: process.env.NODE_ENV,
  release: process.env.GIT_SHA,
});

// A business milestone. Powers funnels and metrics. Correlate it to the user so
// it can complete a funnel that started in the browser.
event("order_paid", { amount: 4200, currency: "usd" }, {
  userId: "user_123",
  entity: { type: "order", id: "ord_789" },
});

// A diagnostic log line
log("warn", "Payment retried", { attempt: 2 });

// A handled exception
try {
  await charge();
} catch (err) {
  captureError(err, { orderId: "ord_789" });
}
```

## Express

```ts
import express from "express";
import { init, heronExpressMiddleware, heronExpressErrorHandler } from "@heronsignal/node";

const client = init({ token: process.env.HERONSIGNAL_SERVER_TOKEN!, service: "web" });
const app = express();

// Records HTTP request events (5xx by default; pass captureAllRequests: true for all).
app.use(
  heronExpressMiddleware({
    client,
    correlate: (req: any) => ({
      userId: req.user?.id,
      sessionId: req.headers["x-heronsignal-session"],
    }),
  }),
);

// ... your routes ...

// Captures thrown errors. Mount last.
app.use(heronExpressErrorHandler({ client }));
```

## Correlation

The whole point is tying backend telemetry to the visitor. Attach any of:

| Field | Use |
| --- | --- |
| `userId` | Your application user id, the most durable link. |
| `entity` | A business object, e.g. `{ type: "order", id: "ord_789" }`. Use the same key you tracked in the browser to **complete a funnel server-side**. |
| `sessionId` | The browser session id (only valid while the session is live). |
| `trace` | `{ traceId, spanId }` for operation-level correlation. |

## Example: a payment journey

The funnel **starts in the browser** (`@heronsignal/web`):

```ts
heronsignal.event("checkout_started", { plan: "pro" });
```

Forward the HeronSignal **session id** (and your user id) to the backend on the
checkout request (e.g. an `x-heronsignal-session` header), then reuse one correlation
object so the server events line up with that exact visit and **complete the
funnel**, and any error is tied to the session that hit it:

```ts
async function handlePayment({ userId, sessionId, orderId, amountCents }) {
  const who = { userId, sessionId, entity: { type: "order", id: orderId } };

  event("payment_attempted", { amountCents }, who);
  try {
    await chargeCard();
    event("order_paid", { amountCents }, who); // completes the browser funnel
  } catch (err) {
    captureError(err, { orderId, step: "charge" }, who); // error, on the session
    event("payment_failed", { reason: String(err) }, who);
    throw err;
  }
}
```

Full runnable versions: [`examples/payment-journey.ts`](./examples/payment-journey.ts)
and an Express route in [`examples/express-checkout.ts`](./examples/express-checkout.ts).

## Configuration

```ts
init({
  token: "…",              // required: server ingest token
  endpoint: "https://api.heronsignal.com", // default
  service: "checkout-api",
  environment: "production", // default: process.env.NODE_ENV
  release: "2026.07.04",
  flushIntervalMs: 2000,     // batch flush cadence
  maxBatchSize: 50,          // flush early at this many queued (hard cap 100)
  maxQueueSize: 1000,        // drop oldest beyond this (never OOMs your app)
  maxRetries: 2,             // retries per batch for network / 429 / 5xx failures
  retryBackoffMs: 1000,      // base delay for exponential retry backoff
  disableScrubbing: false,   // client-side redaction of sensitive keys
  debug: false,
  onError: (err) => {},      // called if a batch fails to send
});
```

## Security & delivery behavior

- `endpoint` must be an `https://` URL (`http://` is accepted for `localhost`
  only); anything else throws at `init()`.
- Attribute values under sensitive-looking keys (`password`, `token`,
  `authorization`, `apiKey`, `cookie`, `client_secret`, `otp`, …) are replaced
  with `"[redacted]"` before events leave the process. The same rules apply in
  `@heronsignal/web` and the mobile SDKs.
- Event names are capped at 256 chars, log/error messages at 4 KB, and stack
  traces at 16 KB, so an oversized message can never bloat a batch.
- Transient failures (network errors, `429`, `5xx`) are retried up to
  `maxRetries` times with exponential backoff; other `4xx` responses drop the
  batch immediately so a rejected payload can never become a retry loop.
- `flush()` calls made while another flush is in flight await the same drain,
  so `shutdown()` never resolves while events are still queued.

## Next.js

Works in Route Handlers, Server Actions and Server Components. Initialise once
from `instrumentation.ts`, which is the only Next hook that runs per server
boot:

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { init } = await import("@heronsignal/node");

  init({
    token: process.env.HERONSIGNAL_SERVER_TOKEN!,
    service: "web-app",
    // Serverless: no background timer, flush explicitly instead. See below.
    flushIntervalMs: process.env.VERCEL ? 0 : 2000,
  });
}
```

Next 15 also gives you one hook that catches errors from Server Components,
Route Handlers and Server Actions together:

```ts
// instrumentation.ts
export async function onRequestError(error: unknown, request: unknown) {
  const { captureError, flush } = await import("@heronsignal/node");

  captureError(error, { path: (request as { path?: string })?.path });
  await flush();
}
```

**Edge runtime is not supported yet.** Keep the `NEXT_RUNTIME` guard above, and
do not initialise from `middleware.ts`.

## Flushing, and why serverless is different

The client batches in the background every 2 seconds and flushes on
`beforeExit`. Both assume a process that stays alive.

On Vercel, Cloud Run, Lambda or any serverless host, **the function freezes the
instant the response is returned.** A timer scheduled for later never fires, and
`beforeExit` never runs, so anything queued in the last couple of seconds is
lost with no error. Flush before you return:

```ts
// Next 15 and later: runs after the response has streamed, without blocking it
import { after } from "next/server";
import { event, flush } from "@heronsignal/node";

export async function POST() {
  event("order_paid", { amountCents: 4200 });
  after(() => flush());

  return Response.json({ ok: true });
}
```

```ts
// Next 14 on Vercel
import { waitUntil } from "@vercel/functions";

waitUntil(flush());
```

```ts
// Anywhere else: pay the latency
await flush();
```

`flush()` resolves only once the batch has actually gone, so awaiting it is
safe even when a background flush is already running.

**Never call `shutdown()` in a request handler.** It closes the client
permanently, so on a warm container the first invocation reports and every one
after it silently drops everything. `shutdown()` is for process exit only.

## Graceful shutdown

`init()` flushes best-effort on `beforeExit`. For hard signals, flush explicitly:

```ts
process.on("SIGTERM", async () => {
  await shutdown(); // flush + stop the timer
  process.exit(0);
});
```

## API

- `init(config)` returns a `HeronSignalClient`: configure the default client.
- `event(name, attributes?, correlation?)`: business milestone.
- `log(level, message, attributes?, correlation?)`: `"error" | "warn" | "info"`.
- `captureError(error, attributes?, correlation?)`: handled exception.
- `captureHttp(http, correlation?, attributes?)`: record a request manually.
- `flush()` / `shutdown()`: send now / send and stop.
- `heronExpressMiddleware(opts)` / `heronExpressErrorHandler(opts)`.

You can also create isolated clients directly: `new HeronSignalClient(config)`.

---

MIT © HeronSignal
