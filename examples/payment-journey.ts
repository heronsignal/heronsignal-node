/**
 * Payment journey: the correlation story end to end.
 *
 * The funnel STARTS in the browser (with @heronsignal/web):
 *
 *     heronsignal.event("checkout_started", { plan: "pro" });
 *
 * HeronSignal assigns that visit a session. Forward the **session id** (and your
 * app's user id) to the backend on the checkout request, e.g. as an
 * `x-hs-session` header, so the server-side events line up with the exact
 * browser journey and COMPLETE the funnel, and any server error is tied to the
 * session that hit it.
 *
 * Run this file with real values by setting HERONSIGNAL_SERVER_TOKEN, or just
 * read it as a reference.
 */

import { init, event, log, captureError, shutdown } from "@heronsignal/node";

init({
  token: process.env.HERONSIGNAL_SERVER_TOKEN ?? "srv_dev_token",
  service: "checkout-api",
  environment: process.env.NODE_ENV ?? "development",
  release: process.env.GIT_SHA,
});

interface PaymentRequest {
  userId: string;
  /** The browser session id, forwarded from the frontend (e.g. x-hs-session). */
  sessionId: string;
  orderId: string;
  amountCents: number;
  currency: string;
}

async function handlePayment(input: PaymentRequest): Promise<void> {
  // One correlation object, reused for every event in this journey. This is
  // what ties the backend telemetry to the visitor and the order.
  const who = {
    userId: input.userId,
    sessionId: input.sessionId,
    entity: { type: "order", id: input.orderId },
  };

  // Funnel step: the visitor's browser fired `checkout_started`; the server now
  // records the payment attempt against the same session.
  event(
    "payment_attempted",
    { amountCents: input.amountCents, currency: input.currency },
    who,
  );
  log("info", "Charging card", { orderId: input.orderId }, who);

  try {
    await chargeCard(input); // your payment provider call

    // Conversion milestone: completes the funnel that started in the browser.
    event(
      "order_paid",
      { amountCents: input.amountCents, currency: input.currency },
      who,
    );
    log("info", "Payment succeeded", { orderId: input.orderId }, who);
  } catch (error) {
    // Capture the error AND a business event, both correlated to the session,
    // so the drop-off in the funnel has an error you can click straight into.
    captureError(error, { orderId: input.orderId, step: "charge" }, who);
    event(
      "payment_failed",
      { reason: error instanceof Error ? error.message : "unknown" },
      who,
    );
    throw error;
  }
}

// --- demo run ---
async function main(): Promise<void> {
  try {
    await handlePayment({
      userId: "user_123",
      sessionId: "hs_sess_abc", // forwarded from the browser
      orderId: "ord_789",
      amountCents: 4200,
      currency: "usd",
    });
  } catch {
    // handled above; swallow so the demo exits cleanly
  }

  // This is a script that is about to exit, so shutting down is right here.
  //
  // A serverless handler must NOT do this. shutdown() closes the client
  // permanently, so on a warm container the first invocation would report and
  // every one after it would silently drop. Use `await flush()` there.
  await shutdown();
}

// A fake payment provider. Flip the throw to see the failure path.
async function chargeCard(_input: PaymentRequest): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  // throw new Error("card_declined");
}

void main();
