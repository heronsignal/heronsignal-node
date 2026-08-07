/**
 * The same payment journey inside an Express route. The browser forwards its
 * HeronSignal session id (and your user id) as headers; every event on the
 * request is correlated to that session.
 *
 * Needs `npm i express` to run.
 */

import express from "express";
import {
  init,
  event,
  captureError,
  heronExpressMiddleware,
  heronExpressErrorHandler,
} from "@heronsignal/node";

const client = init({
  token: process.env.HERONSIGNAL_SERVER_TOKEN!,
  service: "checkout-api",
});

const app = express();
app.use(express.json());

// Pull the browser session + user off every request.
const correlate = (request: unknown) => {
  const headers = (request as { headers: Record<string, string | undefined> })
    .headers;
  return {
    userId: headers["x-user-id"],
    sessionId: headers["x-hs-session"],
  };
};

// Records HTTP request events (5xx by default).
app.use(heronExpressMiddleware({ client, correlate }));

app.post("/checkout", async (request, response) => {
  const { orderId, amountCents } = request.body as {
    orderId: string;
    amountCents: number;
  };
  const who = { ...correlate(request), entity: { type: "order", id: orderId } };

  event("payment_attempted", { amountCents }, who);
  try {
    // await chargeCard(...)
    event("order_paid", { amountCents }, who);
    response.json({ ok: true });
  } catch (error) {
    captureError(error, { orderId }, who);
    event("payment_failed", {}, who);
    response.status(402).json({ ok: false });
  }
});

// Captures thrown errors. Mount last.
app.use(heronExpressErrorHandler({ client }));

app.listen(3000, () => console.log("checkout-api on :3000"));
