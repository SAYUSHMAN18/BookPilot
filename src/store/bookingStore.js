// @ts-check
// Section 15 — the worked example for this codebase's JSDoc-based typing
// (see src/types.js's own header comment for why JSDoc, not a TypeScript
// migration). `@ts-check` here turns on real editor type-checking for
// this one file via jsconfig.json's `checkJs` — a typo'd property name on
// a Booking, a wrong argument count, a `string` passed where the
// `Booking["status"]` union type expects one of its literal values, all
// show up as an actual editor warning, without a build step or file
// rename. Every other src/store/*.js file works exactly as it did
// before; extending this same treatment to them is real, independent,
// incremental follow-up work, not something this one file's annotations
// depend on.
const { db } = require("./db");
/** @typedef {import("../types").Booking} Booking */

// Each booking is its own row (auto-increment `id`), keyed by `wa_id` as a
// regular indexed column, NOT a primary key. This used to be an upsert
// keyed by wa_id — meaning a customer's second booking silently overwrote
// their first, so the dashboard (and STATUS) could only ever see the most
// recent booking per customer, never their real history. Real gap, fixed.
//
// Section 8 — every read/write here now takes `tenantId` and filters or
// stamps by it. This isn't optional scoping the way an extra query param
// would be: `getById`/`updateStatus`/`updateWithMeta`/`clearFeedbackRequest`
// all filter `WHERE id = ? AND tenant_id = ?` rather than just `id = ?`,
// specifically so a provider from Tenant A can never act on a booking that
// happens to share an id with one of Tenant B's rows just by guessing or
// probing ids — the DB query itself is the isolation boundary, not a
// caller remembering to check afterward.

const columns = [
  "tenant_id", "wa_id", "booking_id", "booking_code", "workflow_id", "provider_id", "provider_name",
  "hotel_id", "hotel_name", "visit_date", "visit_date_label", "visit_time",
  "check_in_iso", "nights", "customer_name", "age", "gender", "reason", "status", "created_at",
  "payment_status",
];

const insertStmt = db.prepare(`
  INSERT INTO bookings (${columns.join(", ")})
  VALUES (${columns.map(() => "?").join(", ")})
`);

const updateStatusStmt = db.prepare("UPDATE bookings SET status = ? WHERE id = ? AND tenant_id = ?");
// Section 9 — a denormalized convenience mirror of the payments table's
// latest state (not_required | pending | paid | failed | refunded |
// partially_refunded), kept in sync alongside the payments table itself
// so the dashboard's booking list can show payment status without a join
// for every row. The `payments` table (src/store/paymentStore.js) stays
// the actual source of truth/audit trail — this column is a read
// convenience, never consulted for a real payment decision.
const updatePaymentStatusStmt = db.prepare("UPDATE bookings SET payment_status = ? WHERE id = ? AND tenant_id = ?");
// visit_date/visit_time/visit_date_label use COALESCE — unlike every other
// field here, which this call always overwrites outright (see comment
// below) — because most callers (cancel/serve/complete) never pass them
// and must leave the actual appointment slot untouched. Only reschedule
// passes new values, which is also why this UPDATE (not just bookingStore
// .create()'s INSERT) can hit the same UNIQUE(workflow_id, provider_id,
// visit_date, visit_time) index and needs the identical SlotTakenError
// translation below.
const updateWithMetaStmt = db.prepare(`
  UPDATE bookings
  SET status = ?, cancelled_by = ?, rescheduled_date = ?, rescheduled_time = ?, reschedule_note = ?, provider_note = ?, feedback_requested_at = ?,
      visit_date = COALESCE(?, visit_date), visit_time = COALESCE(?, visit_time), visit_date_label = COALESCE(?, visit_date_label)
  WHERE id = ? AND tenant_id = ?
`);
const clearFeedbackRequestStmt = db.prepare("UPDATE bookings SET feedback_requested_at = NULL WHERE id = ? AND tenant_id = ?");
// New plan, Block 13 — one statement per reminder kind rather than a
// single parameterized column name (node:sqlite, like most SQL drivers,
// can't bind a column name as a placeholder).
const markReminder24hSentStmt = db.prepare("UPDATE bookings SET reminder_24h_sent_at = ? WHERE id = ? AND tenant_id = ?");
const markReminder2hSentStmt = db.prepare("UPDATE bookings SET reminder_2h_sent_at = ? WHERE id = ? AND tenant_id = ?");
const getByIdStmt = db.prepare("SELECT * FROM bookings WHERE id = ? AND tenant_id = ?");
// Section 14 — the tenant-issued bookingId (e.g. "APT-20260101-XY12"),
// not the internal numeric row id above. This is what a customer's own
// confirmation message shows them, so it's the natural lookup key for
// the Public API's GET /api/v1/bookings/:bookingId.
const getByBookingIdStmt = db.prepare("SELECT * FROM bookings WHERE booking_id = ? AND tenant_id = ?");

const mostRecentForWaIdStmt = db.prepare("SELECT * FROM bookings WHERE tenant_id = ? AND wa_id = ? ORDER BY created_at DESC LIMIT 1");
const mostRecentActiveStmt = db.prepare(
  "SELECT * FROM bookings WHERE tenant_id = ? AND wa_id = ? AND status != 'cancelled' ORDER BY created_at DESC LIMIT 1"
);
const hasActiveForWaIdStmt = db.prepare("SELECT 1 FROM bookings WHERE tenant_id = ? AND wa_id = ? AND status != 'cancelled' LIMIT 1");
const allStmt = db.prepare("SELECT * FROM bookings WHERE tenant_id = ? ORDER BY created_at DESC");
// Platform-admin only (Section 8.5) — the one deliberate exception to
// "every query filters by tenant_id." Never call this from a tenant-scoped
// route.
const allAcrossTenantsStmt = db.prepare("SELECT * FROM bookings ORDER BY created_at DESC");

function rowToBooking(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    tenantId: row.tenant_id,
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
    // Previously written but never read back out anywhere — found while
    // building Section 4, which needed provider_note/feedback_requested_at
    // exposed; fixed the same gap for the reschedule/cancel metadata that
    // had the identical problem (Section 6's reschedule-metadata item).
    cancelledBy: row.cancelled_by,
    rescheduledDate: row.rescheduled_date,
    rescheduledTime: row.rescheduled_time,
    rescheduleNote: row.reschedule_note,
    providerNote: row.provider_note,
    feedbackRequestedAt: row.feedback_requested_at,
    // Schema groundwork for Phase 2's payments feature (Section 9) — not
    // read or enforced anywhere yet. 'not_required' for every booking
    // today since no workflow actually declares requiresPayment.
    paymentStatus: row.payment_status,
    reminder24hSentAt: row.reminder_24h_sent_at,
    reminder2hSentAt: row.reminder_2h_sent_at,
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

// Thrown by the trg_no_hotel_range_overlap trigger (src/db.js) — the
// date-range equivalent of SlotTakenError above, for hotel-style bookings
// where "no double booking" can't be a plain UNIQUE index.
class DateRangeConflictError extends Error {
  constructor() {
    super("That date range overlaps an existing booking for this room.");
    this.code = "DATE_RANGE_CONFLICT";
  }
}

const bookings = {
  // Always inserts a new row — a customer's Nth booking never touches
  // their (N-1)th. Returns the created booking (with its new `id`).
  /**
   * @param {number} tenantId
   * @param {string} waId
   * @param {Partial<Booking>} booking
   * @returns {Booking}
   */
  create(tenantId, waId, booking) {
    try {
      const result = insertStmt.run(
        tenantId,
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
        booking.createdAt,
        booking.paymentStatus ?? "not_required"
      );
      return this.getById(tenantId, result.lastInsertRowid);
    } catch (err) {
      // node:sqlite reports the failing columns, not the index name, e.g.
      // "UNIQUE constraint failed: bookings.provider_id, bookings.visit_date,
      // bookings.visit_time" — any UNIQUE violation reaching here is the
      // slot-uniqueness index (wa_id is no longer a unique column at all).
      if (String(err.message).includes("UNIQUE constraint failed")) {
        throw new SlotTakenError();
      }
      if (String(err.message).includes("HOTEL_RANGE_CONFLICT")) {
        throw new DateRangeConflictError();
      }
      throw err;
    }
  },

  // id is `number | bigint` — node:sqlite's own insert result type for
  // `lastInsertRowid` (the immediate caller, create() below), since a row
  // id can in principle exceed Number.MAX_SAFE_INTEGER. This app's real
  // row counts never approach that, but the type is honest about what
  // SQLite itself allows, matching the actual node:sqlite return type.
  /** @param {number} tenantId @param {number|bigint} id @returns {Booking|undefined} */
  getById(tenantId, id) {
    return rowToBooking(getByIdStmt.get(id, tenantId));
  },

  /** @param {number} tenantId @param {string} bookingId @returns {Booking|undefined} */
  getByBookingId(tenantId, bookingId) {
    return rowToBooking(getByBookingIdStmt.get(bookingId, tenantId));
  },

  // What STATUS/HERE act on — the customer's latest booking, active or not
  // (status itself communicates that). A customer with several bookings
  // gets the newest one for these commands; the dashboard is where the
  // full history is visible.
  /** @param {number} tenantId @param {string} waId @returns {Booking|undefined} */
  mostRecentForCustomer(tenantId, waId) {
    return rowToBooking(mostRecentForWaIdStmt.get(tenantId, waId));
  },

  // What STATUS/HERE/CANCEL should actually operate on. A cancelled
  // booking is history, not something to check into or cancel again —
  // using mostRecentForCustomer() for those made the bot report a
  // cancelled appointment as if it were upcoming.
  /** @param {number} tenantId @param {string} waId @returns {Booking|undefined} */
  activeForCustomer(tenantId, waId) {
    return rowToBooking(mostRecentActiveStmt.get(tenantId, waId));
  },

  // Excludes cancelled deliberately. This drives the "looks like you
  // already have a booking" nudge — counting cancelled ones meant a
  // customer who cancelled everything was still told they had a booking,
  // forever, with no way to make it stop.
  /** @param {number} tenantId @param {string} waId @returns {boolean} */
  hasActive(tenantId, waId) {
    return !!hasActiveForWaIdStmt.get(tenantId, waId);
  },

  /** @param {number} tenantId @param {number} id @param {Booking["status"]} status */
  updateStatus(tenantId, id, status) {
    updateStatusStmt.run(status, id, tenantId);
  },

  /** @param {number} tenantId @param {number} id @param {Booking["paymentStatus"]} paymentStatus */
  updatePaymentStatus(tenantId, id, paymentStatus) {
    updatePaymentStatusStmt.run(paymentStatus, id, tenantId);
  },

  // Provider-initiated cancel/reschedule/serve/complete. Stores who did it
  // and any new date/time so the caller can craft a WhatsApp notification
  // with all details. Every field not passed is explicitly cleared (not
  // left alone) — this call always represents the provider setting the
  // booking's full new state in one action, so e.g. completing a booking
  // with a note also correctly clears any stale reschedule/cancel meta
  // from an earlier action on the same row.
  /**
   * @param {number} tenantId
   * @param {number} id
   * @param {Partial<Booking>} meta
   * @returns {Booking|undefined}
   */
  updateWithMeta(tenantId, id, { status, cancelledBy, rescheduledDate, rescheduledTime, rescheduleNote, providerNote, feedbackRequestedAt, visitDate, visitTime, visitDateLabel }) {
    try {
      const result = updateWithMetaStmt.run(
        status,
        cancelledBy || null,
        rescheduledDate || null,
        rescheduledTime || null,
        rescheduleNote || null,
        providerNote || null,
        feedbackRequestedAt || null,
        visitDate || null,
        visitTime || null,
        visitDateLabel || null,
        id,
        tenantId
      );
      if (result.changes === 0) return undefined; // no row matched this id for this tenant
    } catch (err) {
      // Same UNIQUE(workflow_id, provider_id, visit_date, visit_time) index
      // create() enforces — a reschedule onto a slot someone else already
      // holds hits it here instead.
      if (String(err.message).includes("UNIQUE constraint failed")) {
        throw new SlotTakenError();
      }
      throw err;
    }
    return this.getById(tenantId, id);
  },

  // Narrow, surgical update — clears ONLY the "awaiting feedback" flag
  // once a reply has been captured, without touching status or any other
  // field the way updateWithMeta's blanket overwrite would.
  /** @param {number} tenantId @param {number} id */
  clearFeedbackRequest(tenantId, id) {
    clearFeedbackRequestStmt.run(id, tenantId);
  },

  // New plan, Block 13 — marks one specific reminder (never both at
  // once) as sent, so src/infra/reminders.js's periodic scan never sends
  // the same one twice.
  /** @param {number} tenantId @param {number} id @param {"24h"|"2h"} which */
  markReminderSent(tenantId, id, which) {
    const stmt = which === "24h" ? markReminder24hSentStmt : markReminder2hSentStmt;
    stmt.run(Date.now(), id, tenantId);
  },

  /** @param {number} tenantId @returns {Booking[]} */
  values(tenantId) {
    return allStmt.all(tenantId).map(rowToBooking);
  },

  // Platform-admin only (Section 8.5) — see allAcrossTenantsStmt above.
  /** @returns {Booking[]} */
  valuesAllTenants() {
    return allAcrossTenantsStmt.all().map(rowToBooking);
  },
};

// A single export assignment (rather than `module.exports = bookings`
// followed by separate `module.exports.X = Y` property assignments) —
// functionally identical at runtime, but the split form is a pattern
// TypeScript's CommonJS module typing genuinely can't represent cleanly
// (an "export assignment" combined with additional exported properties),
// which shows up as a real diagnostic under `// @ts-check` even though
// nothing here is actually broken.
module.exports = Object.assign(bookings, { SlotTakenError, DateRangeConflictError });
