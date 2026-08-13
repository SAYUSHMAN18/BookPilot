const { pool, query } = require("./db");
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
async function computeQueuePosition(booking) {
  if (!booking || !ACTIVE_STATUSES.has(booking.status) || !booking.visitTime || !booking.visitDate) return null;
  const myMinutes = labelToMinutes(booking.visitTime);
  if (myMinutes === null) return null;

  let ahead = 0;
  // booking.tenantId (not a separate param) — every booking object already
  // carries the tenant it belongs to (bookingStore.js's rowToBooking), so
  // there's nothing to pass or get wrong here.
  for (const other of await bookings.values(booking.tenantId)) {
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
async function sameQueueBookings(tenantId, workflowId, providerId, date, excludeId) {
  const all = await bookings.values(tenantId);
  return all.filter((b) => b.workflowId === workflowId && b.providerId === providerId && b.visitDate === date && b.id !== excludeId && ACTIVE_STATUSES.has(b.status));
}

async function markAlerted(tenantId, bookingId) {
  await pool.query("UPDATE bookings SET alerted_next = true WHERE id = $1 AND tenant_id = $2", [bookingId, tenantId]);
}
async function wasAlerted(tenantId, bookingId) {
  const rows = await query("SELECT alerted_next FROM bookings WHERE id = $1 AND tenant_id = $2", [bookingId, tenantId]);
  return !!rows[0]?.alerted_next;
}

// Deliberately NOT tenant-scoped (customer_preferences has no tenant_id,
// unlike every other table in this file) — a "STOP ALERTS" opt-out is a
// preference tied to the real person behind a phone number, not to any
// one business they happen to be talking to. Not in the plan's explicit
// Section 8.1 table list either.
async function isOptedOutOfAlerts(waId) {
  const rows = await query("SELECT * FROM customer_preferences WHERE wa_id = $1", [waId]);
  return !!rows[0]?.alerts_opted_out;
}

async function setAlertsOptedOut(waId, optedOut) {
  await pool.query(
    `INSERT INTO customer_preferences (wa_id, alerts_opted_out, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT(wa_id) DO UPDATE SET alerts_opted_out = excluded.alerts_opted_out, updated_at = excluded.updated_at`,
    [waId, optedOut, Date.now()]
  );
}

module.exports = {
  computeQueuePosition,
  sameQueueBookings,
  markAlerted,
  wasAlerted,
  isOptedOutOfAlerts,
  setAlertsOptedOut,
};
