// Enterprise Hardening Phase 3 — Customer 360 (GET /api/dashboard/customers/:waId)
// and the internal note (PATCH .../note). Same seedBooking/adminSession
// pattern as tests/http/bookings.test.js, same provider-session pattern
// (create a provider user, log in as them) as its "provider session can
// only PATCH their own bookings" test.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { freshApp } = require("./_setup");

async function adminSession(app, email = "customer360-admin@example.com") {
  const { signupAndActivate } = require("./_setup");
  return signupAndActivate(app, request, { businessName: "Customer 360 Test Biz", email });
}

async function seedBooking(bookingStore, tenantId, waId, overrides = {}) {
  return bookingStore.create(tenantId, waId, {
    bookingId: `C360-${Math.random().toString(36).slice(2, 8)}`,
    workflowId: "medical",
    providerId: "p1",
    providerName: "Dr. Rajesh Sharma",
    visitDate: "2026-09-01",
    visitTime: "10:00 am",
    customerName: "Test Customer",
    status: "booked",
    createdAt: Date.now(),
    ...overrides,
  });
}

test("GET /api/dashboard/customers/:waId returns summary, full booking history (terminal included), and note", async () => {
  const app = await freshApp();
  const bookingStore = require("../../src/store/bookingStore");
  const { cookie, tenantId } = await adminSession(app);
  const waId = "919888844001";
  await seedBooking(bookingStore, tenantId, waId, { visitTime: "10:00 am", status: "done" });
  await seedBooking(bookingStore, tenantId, waId, { visitTime: "11:00 am", status: "cancelled" });

  const resp = await request(app).get(`/api/dashboard/customers/${waId}`).set("Cookie", cookie);
  assert.equal(resp.status, 200);
  assert.equal(resp.body.waId, waId);
  assert.equal(resp.body.bookings.length, 2, "terminal-status bookings must be included, unlike every bot-facing query");
  assert.equal(resp.body.summary.visitCount, 1, "summary itself still excludes the cancelled one — that's customerStore's own contract");
  assert.equal(resp.body.note, "");
});

test("GET .../customers/:waId 404s for a wa_id with no bookings at all under this tenant", async () => {
  const app = await freshApp();
  const { cookie } = await adminSession(app);
  const resp = await request(app).get("/api/dashboard/customers/919888844099").set("Cookie", cookie);
  assert.equal(resp.status, 404);
});

test("a provider only sees the customer's bookings/feedback with their OWN business, and 404s if none exist", async () => {
  const app = await freshApp();
  const bookingStore = require("../../src/store/bookingStore");
  const { cookie: adminCookie, tenantId } = await adminSession(app);
  const waId = "919888844002";
  await seedBooking(bookingStore, tenantId, waId, { providerId: "p1", visitTime: "10:00 am" });
  await seedBooking(bookingStore, tenantId, waId, { providerId: "p2", providerName: "Dr. Neha Mehta", visitTime: "11:00 am" });

  await request(app).post("/api/dashboard/users").set("Cookie", adminCookie)
    .send({ email: "c360-provider1@example.com", password: "password123", role: "provider", name: "P1", workflowId: "medical", providerId: "p1" });
  const login1 = await request(app).post("/api/auth/login").send({ email: "c360-provider1@example.com", password: "password123" });

  const asP1 = await request(app).get(`/api/dashboard/customers/${waId}`).set("Cookie", login1.headers["set-cookie"]);
  assert.equal(asP1.status, 200);
  assert.equal(asP1.body.bookings.length, 1);
  assert.equal(asP1.body.bookings[0].providerId, "p1");

  await request(app).post("/api/dashboard/users").set("Cookie", adminCookie)
    .send({ email: "c360-provider3@example.com", password: "password123", role: "provider", name: "P3", workflowId: "medical", providerId: "p3" });
  const login3 = await request(app).post("/api/auth/login").send({ email: "c360-provider3@example.com", password: "password123" });

  const asP3 = await request(app).get(`/api/dashboard/customers/${waId}`).set("Cookie", login3.headers["set-cookie"]);
  assert.equal(asP3.status, 404, "provider 3 never served this customer at all — must not see p1/p2's history");
});

test("PATCH .../customers/:waId/note sets and overwrites the note, admin-visible on the next GET", async () => {
  const app = await freshApp();
  const bookingStore = require("../../src/store/bookingStore");
  const { cookie, tenantId } = await adminSession(app);
  const waId = "919888844003";
  await seedBooking(bookingStore, tenantId, waId);

  const set = await request(app).patch(`/api/dashboard/customers/${waId}/note`).set("Cookie", cookie).send({ note: "Prefers evening slots" });
  assert.equal(set.status, 200);
  assert.equal(set.body.note, "Prefers evening slots");

  const get1 = await request(app).get(`/api/dashboard/customers/${waId}`).set("Cookie", cookie);
  assert.equal(get1.body.note, "Prefers evening slots");

  const overwrite = await request(app).patch(`/api/dashboard/customers/${waId}/note`).set("Cookie", cookie).send({ note: "Actually prefers mornings" });
  assert.equal(overwrite.status, 200);
  const get2 = await request(app).get(`/api/dashboard/customers/${waId}`).set("Cookie", cookie);
  assert.equal(get2.body.note, "Actually prefers mornings");
});

test("PATCH .../note rejects a non-string note and a note over 2000 characters", async () => {
  const app = await freshApp();
  const bookingStore = require("../../src/store/bookingStore");
  const { cookie, tenantId } = await adminSession(app);
  const waId = "919888844004";
  await seedBooking(bookingStore, tenantId, waId);

  const notAString = await request(app).patch(`/api/dashboard/customers/${waId}/note`).set("Cookie", cookie).send({ note: 12345 });
  assert.equal(notAString.status, 400);

  const tooLong = await request(app).patch(`/api/dashboard/customers/${waId}/note`).set("Cookie", cookie).send({ note: "x".repeat(2001) });
  assert.equal(tooLong.status, 400);
});

test("a provider cannot write a note for a customer who has never booked with their business", async () => {
  const app = await freshApp();
  const bookingStore = require("../../src/store/bookingStore");
  const { cookie: adminCookie, tenantId } = await adminSession(app);
  const waId = "919888844005";
  await seedBooking(bookingStore, tenantId, waId, { providerId: "p1" });

  const createResp = await request(app).post("/api/dashboard/users").set("Cookie", adminCookie)
    .send({ email: "c360-provider2@example.com", password: "password123", role: "provider", name: "P2", workflowId: "medical", providerId: "p2" });
  assert.equal(createResp.status, 201, "sanity check: provider account must actually be created for this test to be meaningful");
  const login2 = await request(app).post("/api/auth/login").send({ email: "c360-provider2@example.com", password: "password123" });

  const resp = await request(app).patch(`/api/dashboard/customers/${waId}/note`).set("Cookie", login2.headers["set-cookie"]).send({ note: "sneaky" });
  assert.equal(resp.status, 404);
});

test("both routes require authentication", async () => {
  const app = await freshApp();
  const getResp = await request(app).get("/api/dashboard/customers/919888844006");
  assert.equal(getResp.status, 401);
  const patchResp = await request(app).patch("/api/dashboard/customers/919888844006/note").send({ note: "x" });
  assert.equal(patchResp.status, 401);
});
