// Item 6 — regression coverage for the bug bookingStateMachine.js's
// isTerminal() closes: a customer replying HERE used to have NO status
// guard at all, so it could silently move a "done"/"no_show" (finished) or
// "serving" (already further along) booking BACKWARD to "arrived". Driven
// through the real /api/simulate-whatsapp conversational pipeline, since
// that's the actual path a customer's WhatsApp reply takes — a store-level
// test would only prove bookingStore itself works, not that the bug (which
// lived in workflowEngine.js's handleHereCommand, not the store) is fixed.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { freshApp, signupAndActivate } = require("./_setup");

function seedBooking(bookingStore, overrides = {}) {
  return bookingStore.create(1, "919000005678", {
    bookingId: `APT-SM-${Math.random().toString(36).slice(2, 8)}`,
    workflowId: "medical",
    providerId: "p1",
    providerName: "Dr. Rajesh Sharma",
    visitDate: "2026-09-01",
    visitDateLabel: "1 September 2026",
    visitTime: "10:00 am",
    customerName: "State Machine Test Customer",
    status: "booked",
    createdAt: Date.now(),
    ...overrides,
  });
}

for (const terminalStatus of ["done", "no_show", "cancelled"]) {
  test(`HERE does not move a "${terminalStatus}" booking backward to "arrived"`, async () => {
    const app = freshApp();
    const bookingStore = require("../../src/store/bookingStore");
    const booking = seedBooking(bookingStore, { status: terminalStatus });

    const resp = await request(app).post("/api/simulate-whatsapp").send({ from: booking.waId, text: "HERE", tenantId: 1 });
    assert.equal(resp.status, 200);

    const after = bookingStore.getById(1, booking.id);
    assert.equal(after.status, terminalStatus, `expected status to stay "${terminalStatus}", not be overwritten by HERE`);
  });
}

test('HERE does not downgrade a "serving" booking back to "arrived"', async () => {
  const app = freshApp();
  const bookingStore = require("../../src/store/bookingStore");
  const booking = seedBooking(bookingStore, { status: "serving" });

  const resp = await request(app).post("/api/simulate-whatsapp").send({ from: booking.waId, text: "HERE", tenantId: 1 });
  assert.equal(resp.status, 200);

  const after = bookingStore.getById(1, booking.id);
  assert.equal(after.status, "serving", 'expected status to stay "serving", not be downgraded by HERE');
});

test('HERE still correctly marks a "booked" booking as "arrived" (the happy path stays intact)', async () => {
  const app = freshApp();
  const bookingStore = require("../../src/store/bookingStore");
  const booking = seedBooking(bookingStore, { status: "booked" });

  const resp = await request(app).post("/api/simulate-whatsapp").send({ from: booking.waId, text: "HERE", tenantId: 1 });
  assert.equal(resp.status, 200);

  const after = bookingStore.getById(1, booking.id);
  assert.equal(after.status, "arrived");
});

test('PATCH .../bookings/:id with action "serve" or "complete" rejects an already-no_show booking (the gap that guard used to miss)', async () => {
  const app = freshApp();
  const bookingStore = require("../../src/store/bookingStore");
  const { cookie, tenantId } = await signupAndActivate(app, request, { businessName: "State Machine Biz", email: "sm@example.com" });
  const booking = bookingStore.create(tenantId, "919000005679", {
    bookingId: `APT-SM2-${Math.random().toString(36).slice(2, 8)}`,
    workflowId: "medical",
    providerId: "p1",
    providerName: "Dr. Rajesh Sharma",
    visitDate: "2026-09-01",
    visitDateLabel: "1 September 2026",
    visitTime: "11:00 am",
    customerName: "No Show Customer",
    status: "no_show",
    createdAt: Date.now(),
  });

  const serve = await request(app).patch(`/api/dashboard/bookings/${booking.id}`).set("Cookie", cookie).send({ action: "serve" });
  assert.equal(serve.status, 400);

  const complete = await request(app).patch(`/api/dashboard/bookings/${booking.id}`).set("Cookie", cookie).send({ action: "complete" });
  assert.equal(complete.status, 400);

  const after = bookingStore.getById(tenantId, booking.id);
  assert.equal(after.status, "no_show", "a no_show booking must stay no_show — serve/complete must not overwrite it");
});
