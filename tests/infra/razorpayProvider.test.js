// Section 9.1/9.5 — the parts of the Razorpay integration that don't
// require a real merchant account: webhook signature verification (pure
// HMAC math, same scheme Razorpay documents) and event-shape parsing.
// createOrder()/createRefund() make real HTTP calls to Razorpay's API and
// are NOT covered here — there is no sandbox account available to this
// project to test them against. Read as: "the parts that can be proven
// correct from documentation alone, are."
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

delete require.cache[require.resolve("../../src/infra/paymentProviders/razorpayProvider")];
const razorpay = require("../../src/infra/paymentProviders/razorpayProvider");

const originalSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
test.after(() => {
  if (originalSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
  else process.env.RAZORPAY_WEBHOOK_SECRET = originalSecret;
});

test("verifyWebhookSignature accepts a correctly-signed payload and rejects a tampered one", () => {
  process.env.RAZORPAY_WEBHOOK_SECRET = "test-webhook-secret";
  const rawBody = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_test1" } } } });
  const validSignature = crypto.createHmac("sha256", "test-webhook-secret").update(rawBody).digest("hex");

  assert.equal(razorpay.verifyWebhookSignature(rawBody, validSignature), true);
  assert.equal(razorpay.verifyWebhookSignature(rawBody, "0".repeat(64)), false, "a wrong-but-same-length signature must be rejected");
  assert.equal(razorpay.verifyWebhookSignature(rawBody + "tampered", validSignature), false, "a modified body must invalidate the original signature");
  assert.equal(razorpay.verifyWebhookSignature(rawBody, ""), false, "an empty signature must be rejected, not treated as valid");
});

test("verifyWebhookSignature fails closed when RAZORPAY_WEBHOOK_SECRET isn't configured", () => {
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  const rawBody = JSON.stringify({ event: "payment.captured" });
  const signature = crypto.createHmac("sha256", "irrelevant").update(rawBody).digest("hex");
  assert.equal(razorpay.verifyWebhookSignature(rawBody, signature), false, "no secret configured must mean no request is ever trusted, not skip verification");
});

test("parseWebhookEvent normalizes a real-shaped payment.captured payload", () => {
  const event = razorpay.parseWebhookEvent({
    event: "payment.captured",
    payload: { payment: { entity: { id: "pay_test1", order_id: "order_test1", amount: 50000, currency: "INR" } } },
  });
  assert.equal(event.type, "payment.captured");
  assert.equal(event.paymentId, "pay_test1");
  assert.equal(event.orderId, "order_test1");
  assert.equal(event.amount, 50000);
});

test("parseWebhookEvent prefers the payment_link id over the payment's own order_id when both are present", () => {
  const event = razorpay.parseWebhookEvent({
    event: "payment.captured",
    payload: {
      payment: { entity: { id: "pay_test1", order_id: "order_internal_xyz", amount: 50000, currency: "INR" } },
      payment_link: { entity: { id: "plink_test1" } },
    },
  });
  assert.equal(event.orderId, "plink_test1", "must match what createOrder() actually stored (the payment link id), not the internally auto-created order id");
});

test("parseWebhookEvent normalizes a real-shaped payment.failed payload", () => {
  const event = razorpay.parseWebhookEvent({
    event: "payment.failed",
    payload: { payment: { entity: { id: "pay_test2", order_id: "order_test2", amount: 50000, currency: "INR", error_description: "Insufficient funds" } } },
  });
  assert.equal(event.type, "payment.failed");
  assert.equal(event.failureReason, "Insufficient funds");
});

test("parseWebhookEvent normalizes a real-shaped refund.processed payload", () => {
  const event = razorpay.parseWebhookEvent({
    event: "refund.processed",
    payload: { refund: { entity: { id: "rfnd_test1", payment_id: "pay_test1", amount: 25000 } } },
  });
  assert.equal(event.type, "refund.processed");
  assert.equal(event.refundId, "rfnd_test1");
  assert.equal(event.amount, 25000);
});

test("parseWebhookEvent returns null for an event type this integration doesn't act on", () => {
  assert.equal(razorpay.parseWebhookEvent({ event: "subscription.activated", payload: {} }), null);
  assert.equal(razorpay.parseWebhookEvent({}), null);
  assert.equal(razorpay.parseWebhookEvent(null), null);
});

test("isConfigured reflects whether real credentials are present", () => {
  const savedId = process.env.RAZORPAY_KEY_ID;
  const savedSecret = process.env.RAZORPAY_KEY_SECRET;
  try {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    assert.equal(razorpay.isConfigured(), false);
    process.env.RAZORPAY_KEY_ID = "rzp_test_fake";
    process.env.RAZORPAY_KEY_SECRET = "fake_secret";
    assert.equal(razorpay.isConfigured(), true);
  } finally {
    if (savedId === undefined) delete process.env.RAZORPAY_KEY_ID; else process.env.RAZORPAY_KEY_ID = savedId;
    if (savedSecret === undefined) delete process.env.RAZORPAY_KEY_SECRET; else process.env.RAZORPAY_KEY_SECRET = savedSecret;
  }
});
