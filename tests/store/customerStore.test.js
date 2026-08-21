// customerStore.js — the aggregation layer built on top of bookings/
// payments (Enterprise Hardening Phase 1, item 1). Same isolated-DB
// pattern as tests/store/outboundQueueStore.test.js.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");

let bookings;
let payments;
let customers;
const TENANT = 1;

before(async () => {
  await createIsolatedTestDatabase();
  for (const mod of ["../../src/store/db", "../../src/store/bookingStore", "../../src/store/paymentStore", "../../src/store/customerStore"]) {
    delete require.cache[require.resolve(mod)];
  }
  bookings = require("../../src/store/bookingStore");
  payments = require("../../src/store/paymentStore");
  customers = require("../../src/store/customerStore");
});

function makeBooking(overrides = {}) {
  // providerId is randomized per call (not a fixed "p1") so that
  // independent tests sharing this one file's database never collide on
  // db.js's idx_no_double_slot unique index (workflow_id, provider_id,
  // visit_date, visit_time) just because they happened to reuse the same
  // default visitDate/visitTime — none of these tests care what the
  // provider id actually is.
  return {
    bookingId: `TEST-${Math.random().toString(36).slice(2, 8)}`,
    workflowId: "hair",
    providerId: `p-${Math.random().toString(36).slice(2, 8)}`,
    providerName: "Test Salon",
    visitDate: "2026-08-25",
    visitTime: "10:00 am",
    customerName: "Test Customer",
    status: "booked",
    createdAt: Date.now(),
    ...overrides,
  };
}

test("isReturningCustomer: false for a wa_id with no bookings at all", async () => {
  const result = await customers.isReturningCustomer(TENANT, "919000099001");
  assert.equal(result, false);
});

test("isReturningCustomer: true once a booking exists, even if later cancelled", async () => {
  const waId = "919000099002";
  const b = await bookings.create(TENANT, waId, makeBooking());
  assert.equal(await customers.isReturningCustomer(TENANT, waId), true);

  await bookings.updateStatus(TENANT, b.id, "cancelled");
  assert.equal(await customers.isReturningCustomer(TENANT, waId), true, "a past customer stays 'returning' even after their only booking is cancelled");
});

test("isReturningCustomer: is tenant-scoped — a booking under tenant 1 doesn't make the same wa_id 'returning' for tenant 2", async () => {
  const waId = "919000099003";
  await bookings.create(TENANT, waId, makeBooking());
  assert.equal(await customers.isReturningCustomer(2, waId), false);
});

test("summaryForCustomer: visit count excludes cancelled bookings, lifetime value sums only paid payments", async () => {
  const waId = "919000099004";

  const b1 = await bookings.create(TENANT, waId, makeBooking({ visitTime: "10:00 am" }));
  const p1 = await payments.create(TENANT, b1.id, { amount: 500 });
  await payments.markPaid(p1.id, "pay_test_1");

  const b2 = await bookings.create(TENANT, waId, makeBooking({ visitTime: "11:00 am" }));
  await payments.create(TENANT, b2.id, { amount: 800 });
  // Left unpaid on purpose — must NOT count toward lifetime value.

  const b3 = await bookings.create(TENANT, waId, makeBooking({ visitTime: "12:00 pm" }));
  await bookings.updateStatus(TENANT, b3.id, "cancelled");
  // Cancelled — must NOT count toward visit count.

  const summary = await customers.summaryForCustomer(TENANT, waId);
  assert.equal(summary.visitCount, 2, "only the 2 non-cancelled bookings should count");
  assert.equal(summary.lifetimeValue, 500, "only the paid payment (500) should count, not the unpaid 800 or anything from the cancelled booking");
  assert.ok(summary.firstVisitAt > 0 && summary.lastVisitAt >= summary.firstVisitAt);
});

test("summaryForCustomer: a customer with zero bookings gets zeroed-out numbers, not an error", async () => {
  const summary = await customers.summaryForCustomer(TENANT, "919000099099");
  assert.equal(summary.visitCount, 0);
  assert.equal(summary.lifetimeValue, 0);
  assert.equal(summary.firstVisitAt, null);
  assert.equal(summary.lastVisitAt, null);
});

test("getNote/setNote: round-trips, overwrites, and defaults to an empty string", async () => {
  const waId = "919000099005";
  assert.equal(await customers.getNote(TENANT, waId), "", "no note yet — empty string, not null/undefined");

  await customers.setNote(TENANT, waId, "Prefers evening slots");
  assert.equal(await customers.getNote(TENANT, waId), "Prefers evening slots");

  await customers.setNote(TENANT, waId, "Actually prefers mornings");
  assert.equal(await customers.getNote(TENANT, waId), "Actually prefers mornings", "setNote overwrites, not appends");
});

test("getNote/setNote: tenant-scoped — one tenant's note is invisible to another", async () => {
  const waId = "919000099006";
  await customers.setNote(TENANT, waId, "Tenant 1's note");
  assert.equal(await customers.getNote(2, waId), "", "a different tenant must see no note at all");
});
