// New plan, Block 12 — the billing/usage skeleton: GET /api/dashboard/billing
// (tenant-facing usage summary) and PATCH /api/platform/tenants/:id/plan
// (the one lever that can change a plan at all — every creation path
// hardcodes "free"). Usage is computed live from real booking rows, so
// these tests prove the computation itself (this-month-only, plan-aware
// limits), not just that the routes respond.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { freshApp, signupAndActivate } = require("./_setup");

function daysAgo(n) {
  return Date.now() - n * 24 * 60 * 60 * 1000;
}

test("a fresh tenant on the free plan starts at 0 usage with a 100-booking limit", async () => {
  const app = freshApp();
  const { cookie } = await signupAndActivate(app, request, { businessName: "Billing Fresh Biz", email: "billing-fresh@example.com" });

  const resp = await request(app).get("/api/dashboard/billing").set("Cookie", cookie);
  assert.equal(resp.status, 200);
  assert.equal(resp.body.plan, "free");
  assert.equal(resp.body.bookingsThisMonth, 0);
  assert.equal(resp.body.limit, 100);
  assert.equal(resp.body.softLimitExceeded, false);
});

test("usage only counts THIS month's bookings, not older ones", async () => {
  const app = freshApp();
  const { cookie, tenantId } = await signupAndActivate(app, request, { businessName: "Billing Month Biz", email: "billing-month@example.com" });
  const bookingStore = require("../../src/store/bookingStore");

  let slot = 0;
  function seed(overrides) {
    slot += 1;
    return bookingStore.create(tenantId, "919000033333", {
      bookingId: `APT-BILL-${Math.random().toString(36).slice(2, 8)}`,
      workflowId: "hair", providerId: "p1", providerName: "Test",
      visitDate: "2026-09-01", visitTime: `${9 + slot}:00 am`, customerName: "Test", status: "booked",
      createdAt: Date.now(),
      ...overrides,
    });
  }

  seed({}); // this month
  seed({}); // this month
  seed({ createdAt: daysAgo(45) }); // last month — must not count

  const resp = await request(app).get("/api/dashboard/billing").set("Cookie", cookie);
  assert.equal(resp.body.bookingsThisMonth, 2);
});

test("softLimitExceeded flips true once bookings this month reach the plan's limit, but the plan's own limit is never enforced as a hard block", async () => {
  const app = freshApp();
  const { cookie, tenantId } = await signupAndActivate(app, request, { businessName: "Billing Limit Biz", email: "billing-limit@example.com" });
  const bookingStore = require("../../src/store/bookingStore");

  for (let i = 0; i < 100; i++) {
    // A distinct visitDate per booking — the DB's own unique-slot
    // constraint (workflow_id, provider_id, visit_date, visit_time)
    // would otherwise reject anything past the first "same slot" insert;
    // this test is about counting usage, not exercising that constraint.
    bookingStore.create(tenantId, "919000033334", {
      bookingId: `APT-LIMIT-${i}`, workflowId: "hair", providerId: "p1", providerName: "Test",
      visitDate: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`, visitTime: `${9 + Math.floor(i / 28)}:00 am`,
      customerName: "Test", status: "booked", createdAt: Date.now(),
    });
  }

  const resp = await request(app).get("/api/dashboard/billing").set("Cookie", cookie);
  assert.equal(resp.body.bookingsThisMonth, 100);
  assert.equal(resp.body.softLimitExceeded, true);

  // "Soft" is the whole point — the WhatsApp booking pipeline itself must
  // still accept a new booking past the limit, not reject a real customer
  // because of the operator's plan choice.
  const conversation = await request(app).post("/api/simulate-whatsapp").send({ from: "919000033334", text: "I need a haircut", tenantId });
  assert.equal(conversation.status, 200);
});

test("growth and enterprise plans report unlimited usage regardless of booking count", async () => {
  const app = freshApp();
  const { cookie, tenantId } = await signupAndActivate(app, request, { businessName: "Billing Unlimited Biz", email: "billing-unlimited@example.com" });
  const tenantStore = require("../../src/store/tenantStore");
  tenantStore.setPlan(tenantId, "growth");

  const resp = await request(app).get("/api/dashboard/billing").set("Cookie", cookie);
  assert.equal(resp.body.plan, "growth");
  assert.equal(resp.body.limit, null);
  assert.equal(resp.body.softLimitExceeded, false);
});

test("PATCH /api/platform/tenants/:id/plan requires platform_admin and rejects an unknown plan", async () => {
  const app = freshApp();
  const { cookie: adminCookie, tenantId } = await signupAndActivate(app, request, { businessName: "Plan Change Biz", email: "plan-change@example.com" });

  const forbidden = await request(app).patch(`/api/platform/tenants/${tenantId}/plan`).set("Cookie", adminCookie).send({ plan: "growth" });
  assert.equal(forbidden.status, 403, "a tenant admin must not be able to change its own plan");

  const users = require("../../src/store/userStore");
  users.create({ email: "billing-platform@example.com", password: "password123", role: "platform_admin", tenantId: null });
  const platformLogin = await request(app).post("/api/auth/login").send({ email: "billing-platform@example.com", password: "password123" });
  const platformCookie = platformLogin.headers["set-cookie"];

  const badPlan = await request(app).patch(`/api/platform/tenants/${tenantId}/plan`).set("Cookie", platformCookie).send({ plan: "diamond" });
  assert.equal(badPlan.status, 400);

  const goodPlan = await request(app).patch(`/api/platform/tenants/${tenantId}/plan`).set("Cookie", platformCookie).send({ plan: "growth" });
  assert.equal(goodPlan.status, 200);
  assert.equal(goodPlan.body.plan, "growth");

  const billing = await request(app).get("/api/dashboard/billing").set("Cookie", adminCookie);
  assert.equal(billing.body.plan, "growth");
});

test("billing usage is tenant-isolated — one tenant's booking volume never affects another's usage summary", async () => {
  const app = freshApp();
  const tenantA = await signupAndActivate(app, request, { businessName: "Billing Isolation A", email: "billing-iso-a@example.com" });
  const tenantB = await signupAndActivate(app, request, { businessName: "Billing Isolation B", email: "billing-iso-b@example.com" });
  const bookingStore = require("../../src/store/bookingStore");

  for (let i = 0; i < 10; i++) {
    bookingStore.create(tenantA.tenantId, "919000033335", {
      bookingId: `APT-ISO-${i}`, workflowId: "hair", providerId: "p1", providerName: "Test",
      visitDate: "2026-09-01", visitTime: `${9 + i}:00 am`, customerName: "Test", status: "booked", createdAt: Date.now(),
    });
  }

  const billingA = await request(app).get("/api/dashboard/billing").set("Cookie", tenantA.cookie);
  const billingB = await request(app).get("/api/dashboard/billing").set("Cookie", tenantB.cookie);
  assert.equal(billingA.body.bookingsThisMonth, 10);
  assert.equal(billingB.body.bookingsThisMonth, 0);
});
