// Section 6 — the reschedule bug: PATCH .../reschedule used to write
// rescheduled_date/rescheduled_time (fields nothing else in the app ever
// reads) while leaving visit_date/visit_time — what STATUS, the queue,
// the dashboard, and the DB's own UNIQUE slot index all actually use —
// frozen at the ORIGINAL time forever. A "rescheduled" customer's STATUS
// reply kept showing the old appointment, and the old slot stayed
// permanently blocked for other customers since status never left
// 'rescheduled'/became 'cancelled'.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bookpilot-reschedule-test-"));
for (const mod of ["../../src/store/db", "../../src/store/bookingStore"]) {
  delete require.cache[require.resolve(mod)];
}
const bookings = require("../../src/store/bookingStore");
const TENANT = 1; // the default tenant, created by db.js's own migration

function makeBooking(overrides = {}) {
  return bookings.create(TENANT, overrides.waId || "919000000201", {
    bookingId: overrides.bookingId || "RESCHED-1",
    workflowId: "medical",
    providerId: overrides.providerId || "p1",
    providerName: "Dr. Test",
    visitDate: overrides.visitDate || "2099-05-01",
    visitDateLabel: "1 May 2099",
    visitTime: overrides.visitTime || "9:00 am",
    customerName: "Reschedule Tester",
    status: "booked",
    createdAt: Date.now(),
  });
}

test("rescheduling actually moves visit_date/visit_time, not just the rescheduled_* audit fields", () => {
  const original = makeBooking();

  const updated = bookings.updateWithMeta(TENANT, original.id, {
    status: "booked",
    cancelledBy: "provider@test.com",
    rescheduledDate: "2099-05-10",
    rescheduledTime: "3:00 pm",
    rescheduleNote: "doctor emergency",
    visitDate: "2099-05-10",
    visitTime: "3:00 pm",
    visitDateLabel: "10 May 2099",
  });

  assert.equal(updated.visitDate, "2099-05-10", "visit_date must reflect the NEW date, not the original");
  assert.equal(updated.visitTime, "3:00 pm", "visit_time must reflect the NEW time, not the original");
  assert.equal(updated.visitDateLabel, "10 May 2099");
  assert.equal(updated.status, "booked");

  // STATUS/dashboard both read booking.visitDate/visitTime directly —
  // re-fetching from the DB (not just trusting the returned object) proves
  // the write actually persisted, not just an in-memory echo.
  const reFetched = bookings.getById(TENANT, original.id);
  assert.equal(reFetched.visitDate, "2099-05-10");
  assert.equal(reFetched.visitTime, "3:00 pm");
});

test("the original slot is freed once rescheduled away — someone else can now book it", () => {
  const original = makeBooking({ bookingId: "RESCHED-FREE-1", providerId: "p-free", visitDate: "2099-05-02", visitTime: "11:00 am" });

  bookings.updateWithMeta(TENANT, original.id, {
    status: "booked",
    visitDate: "2099-06-01",
    visitTime: "11:00 am",
    visitDateLabel: "1 June 2099",
  });

  // Before the fix, this slot would have stayed permanently blocked
  // because status never changed away from a value the UNIQUE index's
  // partial-index WHERE clause treats as "still active."
  const newBookingInOldSlot = bookings.create(TENANT, "919000000299", {
    bookingId: "RESCHED-FREE-TAKES-OLD-SLOT",
    workflowId: "medical",
    providerId: "p-free",
    providerName: "Dr. Test",
    visitDate: "2099-05-02",
    visitTime: "11:00 am",
    customerName: "New Customer",
    status: "booked",
    createdAt: Date.now(),
  });
  assert.ok(newBookingInOldSlot.id, "the vacated original slot should be bookable by someone else");
});

test("rescheduling onto a slot someone else already holds throws SlotTakenError and changes nothing", () => {
  const providerId = "p-conflict";
  const occupied = makeBooking({ bookingId: "RESCHED-OCCUPIED", providerId, visitDate: "2099-05-05", visitTime: "2:00 pm" });
  const toMove = makeBooking({ bookingId: "RESCHED-MOVER", providerId, visitDate: "2099-05-06", visitTime: "9:00 am" });

  assert.throws(
    () =>
      bookings.updateWithMeta(TENANT, toMove.id, {
        status: "booked",
        visitDate: occupied.visitDate,
        visitTime: occupied.visitTime,
        visitDateLabel: occupied.visitDateLabel,
      }),
    (err) => err instanceof bookings.SlotTakenError
  );

  // The failed reschedule must not have partially applied.
  const unchanged = bookings.getById(TENANT, toMove.id);
  assert.equal(unchanged.visitDate, "2099-05-06");
  assert.equal(unchanged.visitTime, "9:00 am");
});

test("cancel/serve/complete-style updateWithMeta calls that don't pass visitDate/visitTime leave them untouched", () => {
  const original = makeBooking({ bookingId: "RESCHED-UNTOUCHED", visitDate: "2099-05-07", visitTime: "4:00 pm" });

  const updated = bookings.updateWithMeta(TENANT, original.id, {
    status: "cancelled",
    cancelledBy: "provider@test.com",
    rescheduleNote: "customer requested",
  });

  assert.equal(updated.status, "cancelled");
  assert.equal(updated.visitDate, "2099-05-07", "a plain cancel must not clear or alter the original appointment slot");
  assert.equal(updated.visitTime, "4:00 pm");
});

test("Section 8 — a booking created for one tenant is invisible to another tenant's getById, even with the correct row id", () => {
  const other = makeBooking({ bookingId: "RESCHED-TENANT-ISOLATION" });
  const OTHER_TENANT = 999999; // doesn't exist — the point is the row must not leak across the boundary regardless
  assert.equal(bookings.getById(OTHER_TENANT, other.id), undefined, "a different tenant must never be able to fetch this booking by guessing its id");
});
