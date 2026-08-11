// Item 2 — HTTP-level booking CRUD + conflict detection. Bookings are
// seeded directly via the store (fast, and every store-level guarantee is
// already covered by tests/store/*) — what THESE tests prove is that the
// HTTP layer (auth gating, role scoping, request validation, and the
// SlotTakenError -> 409 mapping) actually behaves correctly end to end,
// through real Express routes.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { freshApp, signupAndActivate } = require("./_setup");

async function adminSession(app, email = "admin@example.com") {
  return signupAndActivate(app, request, { businessName: "Booking HTTP Test Biz", email });
}

function seedBooking(bookingStore, tenantId, overrides = {}) {
  return bookingStore.create(tenantId, "917838881412", {
    bookingId: `APT-TEST-${Math.random().toString(36).slice(2, 8)}`,
    workflowId: "medical",
    providerId: "p1",
    providerName: "Dr. Rajesh Sharma",
    visitDate: "2026-09-01",
    visitDateLabel: "1 September 2026",
    visitTime: "10:00 am",
    customerName: "Test Customer",
    status: "booked",
    createdAt: Date.now(),
    ...overrides,
  });
}

test("GET /api/dashboard/bookings requires workflowId+providerId and returns only that scope", async () => {
  const app = freshApp();
  const bookingStore = require("../../src/store/bookingStore");
  const { cookie, tenantId } = await adminSession(app);
  seedBooking(bookingStore, tenantId, { visitTime: "10:00 am" });
  seedBooking(bookingStore, tenantId, { providerId: "p2", providerName: "Dr. Neha Mehta", visitTime: "11:00 am" });

  const missingParams = await request(app).get("/api/dashboard/bookings").set("Cookie", cookie);
  assert.equal(missingParams.status, 400);

  const scoped = await request(app).get("/api/dashboard/bookings?workflowId=medical&providerId=p1").set("Cookie", cookie);
  assert.equal(scoped.status, 200);
  assert.equal(scoped.body.length, 1);
  assert.equal(scoped.body[0].providerId, "p1");
});

test("PATCH .../bookings/:id cancel: works once, rejects a second cancel, and refuses a completed booking", async () => {
  const app = freshApp();
  const bookingStore = require("../../src/store/bookingStore");
  const { cookie, tenantId } = await adminSession(app);
  const booking = seedBooking(bookingStore, tenantId);
  const doneBooking = seedBooking(bookingStore, tenantId, { status: "done", visitTime: "2:00 pm" });

  const first = await request(app).patch(`/api/dashboard/bookings/${booking.id}`).set("Cookie", cookie).send({ action: "cancel" });
  assert.equal(first.status, 200);
  assert.equal(first.body.booking.status, "cancelled");

  const second = await request(app).patch(`/api/dashboard/bookings/${booking.id}`).set("Cookie", cookie).send({ action: "cancel" });
  assert.equal(second.status, 400);

  const cancelDone = await request(app).patch(`/api/dashboard/bookings/${doneBooking.id}`).set("Cookie", cookie).send({ action: "cancel" });
  assert.equal(cancelDone.status, 400);
});

test("PATCH .../bookings/:id reschedule onto an already-taken slot returns 409 and changes nothing", async () => {
  const app = freshApp();
  const bookingStore = require("../../src/store/bookingStore");
  const { cookie, tenantId } = await adminSession(app);
  const target = seedBooking(bookingStore, tenantId, { visitTime: "10:00 am" });
  seedBooking(bookingStore, tenantId, { visitDate: "2026-09-02", visitTime: "3:00 pm" }); // the slot we'll collide into

  const conflict = await request(app)
    .patch(`/api/dashboard/bookings/${target.id}`)
    .set("Cookie", cookie)
    .send({ action: "reschedule", rescheduleDate: "2026-09-02", rescheduleTime: "3:00 pm" });
  assert.equal(conflict.status, 409);

  const stillOriginal = await request(app).get(`/api/dashboard/bookings?workflowId=medical&providerId=p1`).set("Cookie", cookie);
  const unchanged = stillOriginal.body.find((b) => b.id === target.id);
  assert.equal(unchanged.visitDate, "2026-09-01");
  assert.equal(unchanged.visitTime, "10:00 am");
});

test("a provider session can only PATCH their own bookings, never another provider's", async () => {
  const app = freshApp();
  const bookingStore = require("../../src/store/bookingStore");
  const { cookie: adminCookie, tenantId } = await adminSession(app);
  const otherProvidersBooking = seedBooking(bookingStore, tenantId, { providerId: "p2", providerName: "Dr. Neha Mehta" });

  await request(app).post("/api/dashboard/users").set("Cookie", adminCookie).send({ email: "provider1@example.com", password: "password123", role: "provider", name: "P1", workflowId: "medical", providerId: "p1" });
  const providerLogin = await request(app).post("/api/auth/login").send({ email: "provider1@example.com", password: "password123" });

  const resp = await request(app)
    .patch(`/api/dashboard/bookings/${otherProvidersBooking.id}`)
    .set("Cookie", providerLogin.headers["set-cookie"])
    .send({ action: "cancel" });
  assert.equal(resp.status, 403);
});

test("a full booking created via the real webhook-simulate conversation actually lands in the store, and stays invisible to an unrelated tenant's dashboard session", async () => {
  const app = freshApp();
  const bookingStore = require("../../src/store/bookingStore");

  // The date-picker only offers a rolling 7-day window from "today" — a
  // fixed hardcoded date would fall outside it depending on when this
  // suite runs, so "tomorrow" is computed fresh each run instead.
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const steps = ["I need a haircut", "p1", tomorrow, "10:00 am", "HTTP Test Customer", "confirm"];
  const waId = "919000000555";
  for (const text of steps) {
    const resp = await request(app).post("/api/simulate-whatsapp").send({ from: waId, text, tenantId: 1 });
    assert.equal(resp.status, 200);
  }

  // simulate-whatsapp defaults to tenant 1 when tenantId is passed as 1
  // explicitly (the pre-Section-8 default tenant, created by db.js's own
  // migration) — confirm the conversation actually produced a real row
  // there, driven entirely through the HTTP conversational pipeline, not
  // a direct store call.
  const created = bookingStore.values(1).find((b) => b.waId === waId && b.workflowId === "hair");
  assert.ok(created, "expected the simulated conversation to have created a real booking for tenant 1");
  assert.equal(created.customerName, "HTTP Test Customer");

  // A completely different, freshly-signed-up tenant's admin dashboard
  // session must not see it — tenant isolation holds even for a booking
  // that came in through the full conversational path, not just seeded data.
  const { cookie } = await adminSession(app, "unrelated-tenant-admin@example.com");
  const list = await request(app).get("/api/dashboard/bookings?workflowId=hair&providerId=p1").set("Cookie", cookie);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 0);
});
