// Section 3's own definition of done, verbatim: "a test simulates a queue
// of 5, serves 3, and asserts positions and alert firing at each step."
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");

let bookings, computeQueuePosition, isOptedOutOfAlerts, setAlertsOptedOut, wasAlerted, markAlerted;
const TENANT = 1; // the default tenant, created by db.js's own migration

before(async () => {
  await createIsolatedTestDatabase();
  delete require.cache[require.resolve("../../src/store/db")];
  delete require.cache[require.resolve("../../src/store/bookingStore")];
  delete require.cache[require.resolve("../../src/store/queueStore")];
  bookings = require("../../src/store/bookingStore");
  ({ computeQueuePosition, isOptedOutOfAlerts, setAlertsOptedOut, wasAlerted, markAlerted } = require("../../src/store/queueStore"));
});

const DATE = "2099-01-01";
const TIMES = ["9:00 am", "9:30 am", "10:00 am", "10:30 am", "11:00 am"];

// Each test seeds its own queue under a fresh providerId — the DB's
// slot-uniqueness index (correctly) refuses two bookings at the same
// provider/date/time, so reusing "p1" across tests in this same process
// would collide with whatever an earlier test already created.
let providerCounter = 0;
function seedQueueOfFive() {
  const providerId = `p-test-${providerCounter++}`;
  return Promise.all(
    TIMES.map((visitTime, i) =>
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
    )
  );
}

test("queue of 5: initial positions are 0,1,2,3,4 in time order", async () => {
  const q = await seedQueueOfFive();
  const positions = await Promise.all(q.map(async (b) => computeQueuePosition(await bookings.getById(TENANT, b.id))));
  assert.deepEqual(positions, [0, 1, 2, 3, 4]);
});

test("queue of 5, serve+complete the first 3 in order: remaining 2 shift down each time", async () => {
  const q = await seedQueueOfFive();

  // #0 is next (position 0) — mark it done (the dashboard's "serve" then
  // "complete" flow ultimately lands here; done is what actually frees up
  // the position for queue math, same as the plan specifies).
  await bookings.updateStatus(TENANT, q[0].id, "done");
  assert.equal(await computeQueuePosition(await bookings.getById(TENANT, q[1].id)), 0, "#1 should now be next");
  assert.equal(await computeQueuePosition(await bookings.getById(TENANT, q[2].id)), 1);
  assert.equal(await computeQueuePosition(await bookings.getById(TENANT, q[3].id)), 2);
  assert.equal(await computeQueuePosition(await bookings.getById(TENANT, q[4].id)), 3);

  await bookings.updateStatus(TENANT, q[1].id, "done");
  assert.equal(await computeQueuePosition(await bookings.getById(TENANT, q[2].id)), 0, "#2 should now be next");
  assert.equal(await computeQueuePosition(await bookings.getById(TENANT, q[3].id)), 1);
  assert.equal(await computeQueuePosition(await bookings.getById(TENANT, q[4].id)), 2);

  await bookings.updateStatus(TENANT, q[2].id, "done");
  assert.equal(await computeQueuePosition(await bookings.getById(TENANT, q[3].id)), 0, "#3 should now be next");
  assert.equal(await computeQueuePosition(await bookings.getById(TENANT, q[4].id)), 1);

  // A done booking has no meaningful position of its own.
  assert.equal(await computeQueuePosition(await bookings.getById(TENANT, q[0].id)), null);
});

test("a cancelled booking is skipped in everyone else's position count, same as done", async () => {
  const q = await seedQueueOfFive();
  await bookings.updateStatus(TENANT, q[0].id, "cancelled");
  assert.equal(await computeQueuePosition(await bookings.getById(TENANT, q[1].id)), 0, "cancelling #0 should also free up the front of the queue");
});

test("marking someone 'serving' does NOT free their position (they're still occupying the front, just actively)", async () => {
  const q = await seedQueueOfFive();
  await bookings.updateStatus(TENANT, q[0].id, "serving");
  // #0 is being served but not yet done — #1 is still behind them, not
  // "next": their position stays at 1 (unchanged from the initial state),
  // only dropping to 0 once #0 is actually marked done.
  assert.equal(await computeQueuePosition(await bookings.getById(TENANT, q[1].id)), 1);
  await bookings.updateStatus(TENANT, q[0].id, "done");
  assert.equal(await computeQueuePosition(await bookings.getById(TENANT, q[1].id)), 0, "now #1 is next, once #0 is actually done");
});

test("alert bookkeeping: wasAlerted/markAlerted round-trip, opt-out is respected", async () => {
  const q = await seedQueueOfFive();
  const bookingId = q[1].id;
  const waId = q[1].waId;

  assert.equal(await wasAlerted(TENANT, bookingId), false);
  await markAlerted(TENANT, bookingId);
  assert.equal(await wasAlerted(TENANT, bookingId), true, "should not be re-alerted once marked");

  assert.equal(await isOptedOutOfAlerts(waId), false);
  await setAlertsOptedOut(waId, true);
  assert.equal(await isOptedOutOfAlerts(waId), true);
  await setAlertsOptedOut(waId, false);
  assert.equal(await isOptedOutOfAlerts(waId), false, "START ALERTS should flip it back");
});

test("a hotel-style booking (no visitTime) has no queue position — never throws", async () => {
  const hotelBooking = await bookings.create(TENANT, "919000009999", {
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
  assert.equal(await computeQueuePosition(await bookings.getById(TENANT, hotelBooking.id)), null);
});
