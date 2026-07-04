# @heronsignal/node

Server-side SDK for [HeronSignal](https://heronsignal.com). Capture backend
**errors**, **logs**, and **business events** — correlated to the real user
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

Create a **server ingest token** in the dashboard (Developer → Tokens), then:

```ts
import { init, event, log, captureError } from "@heronsignal/node";

init({
  token: process.env.HERONSIGNAL_SERVER_TOKEN!,
  service: "checkout-api",
  environment: process.env.NODE_ENV,
  release: process.env.GIT_SHA,
});

// A business milestone — powers funnels & metrics. Correlate it to the user so
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
      sessionId: req.headers["x-hs-session"],
    }),
  }),
);

// ... your routes ...

// Captures thrown errors — mount last.
app.use(heronExpressErrorHandler({ client }));
```

## Correlation

The whole point is tying backend telemetry to the visitor. Attach any of:

| Field | Use |
| --- | --- |
| `userId` | Your application user id — the most durable link. |
| `entity` | A business object, e.g. `{ type: "order", id: "ord_789" }`. Use the same key you tracked in the browser to **complete a funnel server-side**. |
| `sessionId` | The browser session id (only valid while the session is live). |
| `trace` | `{ traceId, spanId }` for operation-level correlation. |

## Configuration

```ts
init({
  token: "…",              // required — server ingest token
  endpoint: "https://api.heronsignal.com", // default
  service: "checkout-api",
  environment: "production", // default: process.env.NODE_ENV
  release: "2026.07.04",
  flushIntervalMs: 2000,     // batch flush cadence
  maxBatchSize: 50,          // flush early at this many queued (hard cap 100)
  maxQueueSize: 1000,        // drop oldest beyond this (never OOMs your app)
  disableScrubbing: false,   // client-side redaction of sensitive keys
  debug: false,
  onError: (err) => {},      // called if a batch fails to send
});
```

## Graceful shutdown

`init()` flushes best-effort on `beforeExit`. For hard signals, flush explicitly:

```ts
process.on("SIGTERM", async () => {
  await shutdown(); // flush + stop the timer
  process.exit(0);
});
```

## API

- `init(config)` → `HeronSignalClient` — configure the default client.
- `event(name, attributes?, correlation?)` — business milestone.
- `log(level, message, attributes?, correlation?)` — `"error" | "warn" | "info"`.
- `captureError(error, attributes?, correlation?)` — handled exception.
- `captureHttp(http, correlation?, attributes?)` — record a request manually.
- `flush()` / `shutdown()` — send now / send and stop.
- `heronExpressMiddleware(opts)` / `heronExpressErrorHandler(opts)`.

You can also create isolated clients directly: `new HeronSignalClient(config)`.

---

MIT © HeronSignal
