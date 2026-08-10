// Section 6 — hotel date-range double-booking gap. Time-slot bookings get
// a real DB-level UNIQUE index as a backstop against a race the JS
// pre-check can miss (see tests/walConcurrency.test.js); hotel bookings
// never had an equivalent — the only thing stopping two overlapping
// bookings for the same room was workflowEngine.js's hasDateRangeConflict(),
// a JS-level check that can run whole conversation turns before the actual
// INSERT. This proves the new trg_no_hotel_range_overlap trigger (src/db.js)
// actually closes that at the storage layer, the same way the UNIQUE index
// does for time slots.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bookpilot-hotel-range-test-"));
for (const mod of ["../../src/store/db", "../../src/store/bookingStore"]) {
  delete require.cache[require.resolve(mod)];
}
const bookings = require("../../src/store/bookingStore");
const TENANT = 1; // the default tenant, created by db.js's own migration

function makeHotelBooking(overrides = {}) {
  return bookings.create(TENANT, overrides.waId || "919000000301", {
    bookingId: overrides.bookingId || "HOTEL-RANGE-1",
    workflowId: "hotel",
    providerId: overrides.providerId || "h1",
    hotelId: overrides.providerId || "h1",
    hotelName: "Test Hotel",
    checkInIso: overrides.checkInIso || "2099-07-01",
    nights: overrides.nights ?? 3,
    customerName: "Range Tester",
    status: "booked",
    createdAt: Date.now(),
  });
}

test("an exactly-overlapping date range is rejected with DateRangeConflictError", () => {
  makeHotelBooking({ bookingId: "HOTEL-RANGE-BASE-1", providerId: "h-exact", checkInIso: "2099-07-10", nights: 3 });

  assert.throws(
    () => makeHotelBooking({ bookingId: "HOTEL-RANGE-DUP-1", providerId: "h-exact", checkInIso: "2099-07-10", nights: 3 }),
    (err) => err instanceof bookings.DateRangeConflictError
  );
});

test("a partially-overlapping range (starts mid-stay) is rejected", () => {
  makeHotelBooking({ bookingId: "HOTEL-RANGE-BASE-2", providerId: "h-partial", checkInIso: "2099-08-01", nights: 5 }); // 08-01 .. 08-06

  assert.throws(
    () => makeHotelBooking({ bookingId: "HOTEL-RANGE-DUP-2", providerId: "h-partial", checkInIso: "2099-08-04", nights: 2 }), // 08-04 .. 08-06, overlaps the tail
    (err) => err instanceof bookings.DateRangeConflictError
  );
});

test("back-to-back ranges (checkout day == next check-in day) do NOT conflict", () => {
  const first = makeHotelBooking({ bookingId: "HOTEL-RANGE-ADJ-1", providerId: "h-adjacent", checkInIso: "2099-09-01", nights: 3 }); // checks out 09-04
  const second = makeHotelBooking({ bookingId: "HOTEL-RANGE-ADJ-2", providerId: "h-adjacent", checkInIso: "2099-09-04", nights: 2 }); // checks in the same day
  assert.ok(first.id && second.id, "adjacent (non-overlapping) stays for the same room must both succeed");
});

test("a cancelled booking's old range no longer blocks a new one for the same dates", () => {
  const cancelled = makeHotelBooking({ bookingId: "HOTEL-RANGE-CANCEL-1", providerId: "h-cancel", checkInIso: "2099-10-01", nights: 4 });
  bookings.updateWithMeta(TENANT, cancelled.id, { status: "cancelled", cancelledBy: "provider@test.com" });

  const rebooked = makeHotelBooking({ bookingId: "HOTEL-RANGE-CANCEL-2", providerId: "h-cancel", checkInIso: "2099-10-01", nights: 4 });
  assert.ok(rebooked.id, "a cancelled booking must not keep blocking its old date range");
});

test("different providers with the same overlapping dates never conflict with each other", () => {
  const a = makeHotelBooking({ bookingId: "HOTEL-RANGE-DIFF-A", providerId: "h-A", checkInIso: "2099-11-01", nights: 3 });
  const b = makeHotelBooking({ bookingId: "HOTEL-RANGE-DIFF-B", providerId: "h-B", checkInIso: "2099-11-01", nights: 3 });
  assert.ok(a.id && b.id, "two different rooms/hotels booking the identical date range must both succeed");
});

test("time-slot (non-hotel) bookings are completely unaffected by the new trigger", () => {
  const b = bookings.create(TENANT, "919000000399", {
    bookingId: "HOTEL-RANGE-UNRELATED-SLOT",
    workflowId: "medical",
    providerId: "p1",
    providerName: "Dr. Test",
    visitDate: "2099-12-01",
    visitTime: "9:00 am",
    customerName: "Slot Customer",
    status: "booked",
    createdAt: Date.now(),
  });
  assert.ok(b.id);
});
