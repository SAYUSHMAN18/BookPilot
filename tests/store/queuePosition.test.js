// Section 3's own definition of done, verbatim: "a test simulates a queue
// of 5, serves 3, and asserts positions and alert firing at each step."
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bookpilot-queue-test-"));
delete require.cache[require.resolve("../../src/store/db")];
delete require.cache[require.resolve("../../src/store/bookingStore")];
delete require.cache[require.resolve("../../src/store/queueStore")];
const bookings = require("../../src/store/bookingStore");
const { computeQueuePosition, isOptedOutOfAlerts, setAlertsOptedOut, wasAlerted, markAlerted } = require("../../src/store/queueStore");
const TENANT = 1; // the default tenant, created by db.js's own migration

const DATE = "2099-01-01";
const TIMES = ["9:00 am", "9:30 am", "10:00 am", "10:30 am", "11:00 am"];

// Each test seeds its own queue under a fresh providerId — the DB's
// slot-uniqueness index (correctly) refuses two bookings at the same
// provider/date/time, so reusing "p1" across tests in this same process
// would collide with whatever an earlier test already created.
let providerCounter = 0;
function seedQueueOfFive() {
  const providerId = `p-test-${providerCounter++}`;
  return TIMES.map((visitTime, i) =>
    bookings.create(TENANT, `91900000000${i}`, {
      bookingId: `Q-${providerId}-${i}`,
      workflowId: "medical",
      providerId,
      providerName: "Dr. Test",
      visitDate: DATE,
      visitDateLabel: DATE,
      visitTime,
      customerName: `Customer ${i}`,
      status: "booked",
      createdAt: Date.now(),
    })
  );
}

test("queue of 5: initial positions are 0,1,2,3,4 in time order", () => {
  const q = seedQueueOfFive();
  const positions = q.map((b) => computeQueuePosition(bookings.getById(TENANT, b.id)));
  assert.deepEqual(positions, [0, 1, 2, 3, 4]);
});

test("queue of 5, serve+complete the first 3 in order: remaining 2 shift down each time", () => {
  const q = seedQueueOfFive();

  // #0 is next (position 0) — mark it done (the dashboard's "serve" then
  // "complete" flow ultimately lands here; done is what actually frees up
  // the position for queue math, same as the plan specifies).
  bookings.updateStatus(TENANT, q[0].id, "done");
  assert.equal(computeQueuePosition(bookings.getById(TENANT, q[1].id)), 0, "#1 should now be next");
  assert.equal(computeQueuePosition(bookings.getById(TENANT, q[2].id)), 1);
  assert.equal(computeQueuePosition(bookings.getById(TENANT, q[3].id)), 2);
  assert.equal(computeQueuePosition(bookings.getById(TENANT, q[4].id)), 3);

  bookings.updateStatus(TENANT, q[1].id, "done");
  assert.equal(computeQueuePosition(bookings.getById(TENANT, q[2].id)), 0, "#2 should now be next");
  assert.equal(computeQueuePosition(bookings.getById(TENANT, q[3].id)), 1);
  assert.equal(computeQueuePosition(bookings.getById(TENANT, q[4].id)), 2);

  bookings.updateStatus(TENANT, q[2].id, "done");
  assert.equal(computeQueuePosition(bookings.getById(TENANT, q[3].id)), 0, "#3 should now be next");
  assert.equal(computeQueuePosition(bookings.getById(TENANT, q[4].id)), 1);

  // A done booking has no meaningful position of its own.
  assert.equal(computeQueuePosition(bookings.getById(TENANT, q[0].id)), null);
});

test("a cancelled booking is skipped in everyone else's position count, same as done", () => {
  const q = seedQueueOfFive();
  bookings.updateStatus(TENANT, q[0].id, "cancelled");
  assert.equal(computeQueuePosition(bookings.getById(TENANT, q[1].id)), 0, "cancelling #0 should also free up the front of the queue");
});

test("marking someone 'serving' does NOT free their position (they're still occupying the front, just actively)", () => {
  const q = seedQueueOfFive();
  bookings.updateStatus(TENANT, q[0].id, "serving");
  // #0 is being served but not yet done — #1 is still behind them, not
  // "next": their position stays at 1 (unchanged from the initial state),
  // only dropping to 0 once #0 is actually marked done.
  assert.equal(computeQueuePosition(bookings.getById(TENANT, q[1].id)), 1);
  bookings.updateStatus(TENANT, q[0].id, "done");
  assert.equal(computeQueuePosition(bookings.getById(TENANT, q[1].id)), 0, "now #1 is next, once #0 is actually done");
});

test("alert bookkeeping: wasAlerted/markAlerted round-trip, opt-out is respected", () => {
  const q = seedQueueOfFive();
  const bookingId = q[1].id;
  const waId = q[1].waId;

  assert.equal(wasAlerted(TENANT, bookingId), false);
  markAlerted(TENANT, bookingId);
  assert.equal(wasAlerted(TENANT, bookingId), true, "should not be re-alerted once marked");

  assert.equal(isOptedOutOfAlerts(waId), false);
  setAlertsOptedOut(waId, true);
  assert.equal(isOptedOutOfAlerts(waId), true);
  setAlertsOptedOut(waId, false);
  assert.equal(isOptedOutOfAlerts(waId), false, "START ALERTS should flip it back");
});

test("a hotel-style booking (no visitTime) has no queue position — never throws", () => {
  const hotelBooking = bookings.create(TENANT, "919000009999", {
    bookingId: "HTL-1",
    workflowId: "hotel",
    providerId: "r1",
    hotelId: "h1",
    checkInIso: DATE,
    nights: 2,
    customerName: "Guest",
    status: "booked",
    createdAt: Date.now(),
  });
  assert.equal(computeQueuePosition(bookings.getById(TENANT, hotelBooking.id)), null);
});
