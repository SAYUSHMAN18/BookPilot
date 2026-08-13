// Section 9.7 — the shared refund-percent policy engine used by both the
// customer-initiated (CANCEL reply) and provider-initiated (dashboard
// cancel/no-show) cancellation paths. computeRefundPercent is pure and
// gets the bulk of the coverage; refundIfPaid's network-calling branch is
// exercised with credentials deliberately unset so createRefund() throws
// synchronously (no real network call, no sandbox dependency) — same
// "don't require live credentials for automated tests" stance as
// tests/infra/razorpayProvider.test.js.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");

let bookings, paymentStore, computeRefundPercent, refundIfPaid;
const TENANT = 1;

before(async () => {
  await createIsolatedTestDatabase();
  for (const mod of ["../../src/store/db", "../../src/store/bookingStore", "../../src/store/paymentStore", "../../src/engine/paymentRefunds"]) {
    delete require.cache[require.resolve(mod)];
  }
  bookings = require("../../src/store/bookingStore");
  paymentStore = require("../../src/store/paymentStore");
  ({ computeRefundPercent, refundIfPaid } = require("../../src/engine/paymentRefunds"));
});

test("computeRefundPercent: provider-initiated cancellation is a full refund unless the policy says none", () => {
  assert.equal(computeRefundPercent({ initiatedBy: "provider", refundPolicy: null }), 100);
  assert.equal(computeRefundPercent({ initiatedBy: "provider", refundPolicy: { providerCancellation: "full" } }), 100);
  assert.equal(computeRefundPercent({ initiatedBy: "provider", refundPolicy: { providerCancellation: "none" } }), 0);
});

test("computeRefundPercent: customer-initiated with no policy defaults to a full refund", () => {
  assert.equal(computeRefundPercent({ initiatedBy: "customer", refundPolicy: null, visitDateIso: "2099-01-01", visitTime: "9:00 am" }), 100);
  assert.equal(computeRefundPercent({ initiatedBy: "customer", refundPolicy: { customerCancellation: [] }, visitDateIso: "2099-01-01", visitTime: "9:00 am" }), 100);
});

test("computeRefundPercent: customer-initiated tiers are checked in order, first satisfied notice wins", () => {
  const refundPolicy = {
    customerCancellation: [
      { hoursBefore: 24, refundPercent: 100 },
      { hoursBefore: 2, refundPercent: 50 },
    ],
  };
  // Visit is ~10 days out — well past the 24h tier.
  const farVisit = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  const farVisitIso = farVisit.toISOString().slice(0, 10);
  assert.equal(computeRefundPercent({ initiatedBy: "customer", refundPolicy, visitDateIso: farVisitIso, visitTime: "9:00 am" }), 100);

  // Visit is ~1 hour out — under every tier, falls through to 0.
  const soonVisit = new Date(Date.now() + 60 * 60 * 1000);
  const soonVisitIso = soonVisit.toISOString().slice(0, 10);
  const hh = String(soonVisit.getHours() % 12 || 12);
  const ampm = soonVisit.getHours() >= 12 ? "pm" : "am";
  assert.equal(
    computeRefundPercent({ initiatedBy: "customer", refundPolicy, visitDateIso: soonVisitIso, visitTime: `${hh}:${String(soonVisit.getMinutes()).padStart(2, "0")} ${ampm}` }),
    0
  );
});

test("computeRefundPercent: an unparseable visit date/time doesn't penalize on ambiguity — defaults to full refund", () => {
  assert.equal(
    computeRefundPercent({ initiatedBy: "customer", refundPolicy: { customerCancellation: [{ hoursBefore: 24, refundPercent: 100 }] }, visitDateIso: null, visitTime: null }),
    100
  );
});

test("refundIfPaid: a booking with no paid payment is a no-op, never calls the provider", () => {
  return (async () => {
    const booking = await bookings.create(TENANT, "919000006001", {
      bookingId: "REFUND-TEST-1", workflowId: "medical", providerId: "p1", providerName: "Dr. Test",
      visitDate: "2099-01-01", visitTime: "9:00 am", customerName: "No Payment", status: "booked", createdAt: Date.now(),
    });
    const result = await refundIfPaid(TENANT, booking, { initiatedBy: "customer", refundPolicy: null });
    assert.deepEqual(result, { refunded: false });
  })();
});

test("refundIfPaid: a policy that computes 0% never calls the provider and marks nothing refunded", () => {
  return (async () => {
    const booking = await bookings.create(TENANT, "919000006002", {
      bookingId: "REFUND-TEST-2", workflowId: "medical", providerId: "p1", providerName: "Dr. Test",
      visitDate: "2099-01-01", visitTime: "9:30 am", customerName: "Zero Percent", status: "booked", createdAt: Date.now(),
    });
    const payment = await paymentStore.create(TENANT, booking.id, { amount: 10000, providerOrderId: "order_zero_pct" });
    await paymentStore.markPaid(payment.id, "pay_zero_pct");

    const result = await refundIfPaid(TENANT, booking, { initiatedBy: "provider", refundPolicy: { providerCancellation: "none" } });
    assert.deepEqual(result, { refunded: false, percent: 0 });

    const stillPaid = await paymentStore.getById(TENANT, payment.id);
    assert.equal(stillPaid.status, "paid", "a 0%-refund decision must not touch the payment row");
  })();
});

test("refundIfPaid: a provider-side failure (createRefund throws) is caught and reported, never thrown", () => {
  return (async () => {
    const savedId = process.env.RAZORPAY_KEY_ID;
    const savedSecret = process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    try {
      const booking = await bookings.create(TENANT, "919000006003", {
        bookingId: "REFUND-TEST-3", workflowId: "medical", providerId: "p1", providerName: "Dr. Test",
        visitDate: "2099-01-01", visitTime: "10:00 am", customerName: "Provider Down", status: "booked", createdAt: Date.now(),
      });
      const payment = await paymentStore.create(TENANT, booking.id, { amount: 10000, providerOrderId: "order_provider_down" });
      await paymentStore.markPaid(payment.id, "pay_provider_down");

      const result = await refundIfPaid(TENANT, booking, { initiatedBy: "provider", refundPolicy: null });
      assert.equal(result.refunded, false);
      assert.ok(result.error, "must report why the refund didn't go through");

      const stillPaid = await paymentStore.getById(TENANT, payment.id);
      assert.equal(stillPaid.status, "paid", "a failed refund attempt must not falsely mark the payment refunded");
    } finally {
      if (savedId === undefined) delete process.env.RAZORPAY_KEY_ID; else process.env.RAZORPAY_KEY_ID = savedId;
      if (savedSecret === undefined) delete process.env.RAZORPAY_KEY_SECRET; else process.env.RAZORPAY_KEY_SECRET = savedSecret;
    }
  })();
});

test("refundIfPaid: with real credentials configured, a bogus provider payment id is rejected by Razorpay itself, not silently marked refunded", () => {
  return (async () => {
    // Credentials are real (from .env) at this point in the file, but the
    // providerPaymentId is fake — this proves refundIfPaid's real-network
    // branch is wired correctly (reaches Razorpay's real API, doesn't
    // throw uncaught, doesn't mark the payment refunded on a denial).
    // The success path (a genuinely paid payment id) can't be exercised
    // here — creating one requires a real UPI/card payment against a live
    // payment link, which isn't automatable — but that path was proven
    // manually via createOrder() earlier in this project's Section 9 work.
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return; // no credentials in this environment — skip

    const booking = await bookings.create(TENANT, "919000006004", {
      bookingId: "REFUND-TEST-4", workflowId: "medical", providerId: "p1", providerName: "Dr. Test",
      visitDate: "2099-01-01", visitTime: "10:30 am", customerName: "Bogus Payment Id", status: "booked", createdAt: Date.now(),
    });
    const payment = await paymentStore.create(TENANT, booking.id, { amount: 10000, providerOrderId: "order_bogus" });
    await paymentStore.markPaid(payment.id, "pay_this_id_does_not_exist_on_razorpay");

    const result = await refundIfPaid(TENANT, booking, { initiatedBy: "provider", refundPolicy: null });
    assert.equal(result.refunded, false, "Razorpay must reject a refund against a payment id it doesn't recognize");
    assert.ok(result.error);
  })();
});
