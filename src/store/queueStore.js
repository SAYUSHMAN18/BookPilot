const { db } = require("./db");
const bookings = require("./bookingStore");
const { labelToMinutes } = require("../engine/dateSlots");

// Live queue position (Section 3) — deliberately NOT a stored "position"
// column that gets updated on write. A stored counter is exactly the bug
// this replaces: the old position was fixed at booking time and never
// changed again, so it silently went stale the moment anyone ahead in
// the queue got served, cancelled, or no-showed. Computed fresh on every
// read instead: "how many bookings for this same provider, same day,
// with an earlier time, are still active (not done, not cancelled)."
// `serving`/`done` extend the existing status enum — marking someone
// `done` immediately and correctly shifts everyone behind them down by
// one on their very next STATUS check, with no separate bookkeeping to
// keep in sync.
const ACTIVE_STATUSES = new Set(["booked", "arrived", "serving"]);

// Position 0 means "you're next" (or being served now). Returns null when
// position isn't meaningful — no time-slot booking (e.g. a hotel stay),
// or the booking itself isn't in an active state.
function computeQueuePosition(booking) {
  if (!booking || !ACTIVE_STATUSES.has(booking.status) || !booking.visitTime || !booking.visitDate) return null;
  const myMinutes = labelToMinutes(booking.visitTime);
  if (myMinutes === null) return null;

  let ahead = 0;
  // booking.tenantId (not a separate param) — every booking object already
  // carries the tenant it belongs to (bookingStore.js's rowToBooking), so
  // there's nothing to pass or get wrong here.
  for (const other of bookings.values(booking.tenantId)) {
    if (other.id === booking.id) continue;
    if (other.workflowId !== booking.workflowId || other.providerId !== booking.providerId) continue;
    if (other.visitDate !== booking.visitDate) continue;
    if (!ACTIVE_STATUSES.has(other.status)) continue;
    const otherMinutes = labelToMinutes(other.visitTime);
    if (otherMinutes === null) continue;
    if (otherMinutes < myMinutes) ahead += 1;
  }
  return ahead;
}

// Everyone else in the same day's queue whose position may have just
// shifted because `changedBookingId` was marked done/cancelled — used to
// decide who to send a threshold-crossing alert to after a status change,
// without recomputing every booking in the database.
function sameQueueBookings(tenantId, workflowId, providerId, date, excludeId) {
  return bookings
    .values(tenantId)
    .filter((b) => b.workflowId === workflowId && b.providerId === providerId && b.visitDate === date && b.id !== excludeId && ACTIVE_STATUSES.has(b.status));
}

const setAlertedStmt = db.prepare("UPDATE bookings SET alerted_next = 1 WHERE id = ? AND tenant_id = ?");
const getAlertedStmt = db.prepare("SELECT alerted_next FROM bookings WHERE id = ? AND tenant_id = ?");
function markAlerted(tenantId, bookingId) {
  setAlertedStmt.run(bookingId, tenantId);
}
function wasAlerted(tenantId, bookingId) {
  return !!getAlertedStmt.get(bookingId, tenantId)?.alerted_next;
}

// Deliberately NOT tenant-scoped (customer_preferences has no tenant_id,
// unlike every other table in this file) — a "STOP ALERTS" opt-out is a
// preference tied to the real person behind a phone number, not to any
// one business they happen to be talking to. Not in the plan's explicit
// Section 8.1 table list either.
const getPrefStmt = db.prepare("SELECT * FROM customer_preferences WHERE wa_id = ?");
const upsertPrefStmt = db.prepare(`
  INSERT INTO customer_preferences (wa_id, alerts_opted_out, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(wa_id) DO UPDATE SET alerts_opted_out = excluded.alerts_opted_out, updated_at = excluded.updated_at
`);

function isOptedOutOfAlerts(waId) {
  const row = getPrefStmt.get(waId);
  return !!row?.alerts_opted_out;
}

function setAlertsOptedOut(waId, optedOut) {
  upsertPrefStmt.run(waId, optedOut ? 1 : 0, Date.now());
}

module.exports = {
  computeQueuePosition,
  sameQueueBookings,
  markAlerted,
  wasAlerted,
  isOptedOutOfAlerts,
  setAlertsOptedOut,
};
