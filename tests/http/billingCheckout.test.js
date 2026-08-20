// Regression coverage for POST /api/billing/checkout — previously untested
// despite handling real money. Pins the exact behavior change this pass
// made: Starter went from amount:0 (instant-activate, no payment) to a
// real ₹199/mo listing fee (src/infra/plans.js) — a signup choosing
// Starter must now go through the same real-payment branch Growth
// already did, not the old free-instant-activate shortcut.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { freshApp } = require("./_setup");

// Signs up WITHOUT activating — leaves the tenant in "awaiting_payment",
// exactly the state POST /api/billing/checkout expects its caller to be
// in. Deliberately not using _setup.js's signupAndActivate (that helper
// skips straight past this exact state, which is what this test needs to
// exercise).
async function signupAwaitingPayment(app, email) {
  const { createOtp } = require("../../src/store/signupOtpStore");
  const otp = await createOtp(email);
  const resp = await request(app).post("/api/signup").send({
    businessName: "Checkout Test Biz", ownerName: "Test Owner", email, password: "password123", otp,
  });
  assert.equal(resp.status, 201, `signup failed: ${JSON.stringify(resp.body)}`);
  return resp.headers["set-cookie"];
}

test("GET /api/billing/plans reports Starter as a real, priced plan (not free)", async () => {
  const app = await freshApp();
  const resp = await request(app).get("/api/billing/plans");
  assert.equal(resp.status, 200);
  const starter = resp.body.find((p) => p.id === "starter");
  assert.ok(starter, "expected a 'starter' plan in the list");
  assert.equal(starter.amount, 19900, "Starter should be a real ₹199/mo listing fee, not 0");
});

test("choosing Starter at checkout does NOT instantly activate for free — it goes through the same real-payment path as Growth", async () => {
  const app = await freshApp();
  const cookie = await signupAwaitingPayment(app, "starter-checkout@example.com");

  const resp = await request(app).post("/api/billing/checkout").set("Cookie", cookie).send({ plan: "starter" });

  // Razorpay isn't configured in the test environment, so a real-amount
  // plan correctly gets rejected with "payments not configured" — the
  // one thing that must NEVER happen is the old free-tier shortcut
  // (`activated: true`, no payment at all).
  assert.notEqual(resp.body.activated, true, "Starter must not instant-activate for free anymore");
  assert.equal(resp.status, 503);
  assert.match(resp.body.error, /not configured/i);
});

test("choosing Growth at checkout behaves identically to Starter (both are real, priced plans)", async () => {
  const app = await freshApp();
  const cookie = await signupAwaitingPayment(app, "growth-checkout@example.com");

  const resp = await request(app).post("/api/billing/checkout").set("Cookie", cookie).send({ plan: "growth" });

  assert.notEqual(resp.body.activated, true);
  assert.equal(resp.status, 503);
  assert.match(resp.body.error, /not configured/i);
});

test("choosing Enterprise at checkout is still rejected as sales-assisted, not self-serve", async () => {
  const app = await freshApp();
  const cookie = await signupAwaitingPayment(app, "enterprise-checkout@example.com");

  const resp = await request(app).post("/api/billing/checkout").set("Cookie", cookie).send({ plan: "enterprise" });

  assert.equal(resp.status, 400);
  assert.match(resp.body.error, /sales-assisted/i);
});
