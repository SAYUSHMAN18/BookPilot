const { db } = require("./db");

// Each booking is its own row (auto-increment `id`), keyed by `wa_id` as a
// regular indexed column, NOT a primary key. This used to be an upsert
// keyed by wa_id — meaning a customer's second booking silently overwrote
// their first, so the dashboard (and STATUS) could only ever see the most
// recent booking per customer, never their real history. Real gap, fixed.

const columns = [
  "wa_id", "booking_id", "booking_code", "workflow_id", "provider_id", "provider_name",
  "hotel_id", "hotel_name", "visit_date", "visit_date_label", "visit_time",
  "check_in_iso", "nights", "customer_name", "age", "gender", "reason", "status", "created_at",
];

const insertStmt = db.prepare(`
  INSERT INTO bookings (${columns.join(", ")})
  VALUES (${columns.map(() => "?").join(", ")})
`);

const updateStatusStmt = db.prepare("UPDATE bookings SET status = ? WHERE id = ?");
const updateWithMetaStmt = db.prepare(
  "UPDATE bookings SET status = ?, cancelled_by = ?, rescheduled_date = ?, rescheduled_time = ?, reschedule_note = ? WHERE id = ?"
);
const getByIdStmt = db.prepare("SELECT * FROM bookings WHERE id = ?");

const mostRecentForWaIdStmt = db.prepare("SELECT * FROM bookings WHERE wa_id = ? ORDER BY created_at DESC LIMIT 1");
const mostRecentActiveStmt = db.prepare(
  "SELECT * FROM bookings WHERE wa_id = ? AND status != 'cancelled' ORDER BY created_at DESC LIMIT 1"
);
const hasActiveForWaIdStmt = db.prepare("SELECT 1 FROM bookings WHERE wa_id = ? AND status != 'cancelled' LIMIT 1");
const allStmt = db.prepare("SELECT * FROM bookings ORDER BY created_at DESC");

function rowToBooking(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    waId: row.wa_id,
    bookingId: row.booking_id,
    bookingCode: row.booking_code,
    workflowId: row.workflow_id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    hotelId: row.hotel_id,
    hotelName: row.hotel_name,
    visitDate: row.visit_date,
    visitDateLabel: row.visit_date_label,
    visitTime: row.visit_time,
    checkInIso: row.check_in_iso,
    nights: row.nights,
    customerName: row.customer_name,
    age: row.age,
    gender: row.gender,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
  };
}

// Thrown when the DB's UNIQUE index rejects a booking because someone else
// already holds that exact provider/date/time slot — the authoritative
// check, catching the race window that a JS-level pre-check alone can't
// close once more than one process can write to this data.
class SlotTakenError extends Error {
  constructor() {
    super("That slot was just taken by someone else.");
    this.code = "SLOT_TAKEN";
  }
}

const bookings = {
  // Always inserts a new row — a customer's Nth booking never touches
  // their (N-1)th. Returns the created booking (with its new `id`).
  create(waId, booking) {
    try {
      const result = insertStmt.run(
        waId,
        booking.bookingId,
        booking.bookingCode ?? null,
        booking.workflowId,
        booking.providerId ?? null,
        booking.providerName ?? null,
        booking.hotelId ?? null,
        booking.hotelName ?? null,
        booking.visitDate ?? null,
        booking.visitDateLabel ?? null,
        booking.visitTime ?? null,
        booking.checkInIso ?? null,
        booking.nights ?? null,
        booking.customerName ?? null,
        booking.age ?? null,
        booking.gender ?? null,
        booking.reason ?? null,
        booking.status,
        booking.createdAt
      );
      return this.getById(result.lastInsertRowid);
    } catch (err) {
      // node:sqlite reports the failing columns, not the index name, e.g.
      // "UNIQUE constraint failed: bookings.provider_id, bookings.visit_date,
      // bookings.visit_time" — any UNIQUE violation reaching here is the
      // slot-uniqueness index (wa_id is no longer a unique column at all).
      if (String(err.message).includes("UNIQUE constraint failed")) {
        throw new SlotTakenError();
      }
      throw err;
    }
  },

  getById(id) {
    return rowToBooking(getByIdStmt.get(id));
  },

  // What STATUS/HERE act on — the customer's latest booking, active or not
  // (status itself communicates that). A customer with several bookings
  // gets the newest one for these commands; the dashboard is where the
  // full history is visible.
  mostRecentForCustomer(waId) {
    return rowToBooking(mostRecentForWaIdStmt.get(waId));
  },

  // What STATUS/HERE/CANCEL should actually operate on. A cancelled
  // booking is history, not something to check into or cancel again —
  // using mostRecentForCustomer() for those made the bot report a
  // cancelled appointment as if it were upcoming.
  activeForCustomer(waId) {
    return rowToBooking(mostRecentActiveStmt.get(waId));
  },

  // Excludes cancelled deliberately. This drives the "looks like you
  // already have a booking" nudge — counting cancelled ones meant a
  // customer who cancelled everything was still told they had a booking,
  // forever, with no way to make it stop.
  hasActive(waId) {
    return !!hasActiveForWaIdStmt.get(waId);
  },

  updateStatus(id, status) {
    updateStatusStmt.run(status, id);
  },

  // Provider-initiated cancel or reschedule. Stores who did it and any new
  // date/time so the caller can craft a WhatsApp notification with all details.
  updateWithMeta(id, { status, cancelledBy, rescheduledDate, rescheduledTime, rescheduleNote }) {
    updateWithMetaStmt.run(
      status,
      cancelledBy || null,
      rescheduledDate || null,
      rescheduledTime || null,
      rescheduleNote || null,
      id
    );
    return this.getById(id);
  },

  values() {
    return allStmt.all().map(rowToBooking);
  },
};

module.exports = bookings;
module.exports.SlotTakenError = SlotTakenError;
