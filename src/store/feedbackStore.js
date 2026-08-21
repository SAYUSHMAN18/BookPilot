const { query } = require("./db");

// Optional star rating parsed from free text ("5", "5 stars", "4/5") plus
// whatever the customer actually wrote, linked to the specific booking
// that prompted it — not just the customer, since someone with a long
// booking history should have feedback attributable to the visit it was
// actually about.
//
// tenant_id and workflow_id are both stored directly on this table
// (Section 8) rather than only derived via a JOIN to bookings —
// listAll()/listForWorkflow() both read far more often than
// feedback.create() writes, and a direct column filter is simpler than
// requiring every read here to join back to bookings just to scope by
// tenant or business. Both are set once at creation from the booking the
// feedback is about and never change afterward.

function rowToFeedback(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    bookingId: row.booking_id,
    waId: row.wa_id,
    rating: row.rating,
    comment: row.comment,
    createdAt: Number(row.created_at),
  };
}

// Lenient — "5", "5 stars", "4/5", "rated 3" all parse; anything that
// doesn't look like a rating is just treated as comment-only feedback
// rather than rejected.
function parseRating(text) {
  const m = /(\d)\s*(?:\/\s*5|stars?)?/.exec(text || "");
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 5 ? n : null;
}

const feedback = {
  async create(tenantId, bookingId, workflowId, waId, text) {
    const rating = parseRating(text);
    const rows = await query(
      "INSERT INTO feedback (tenant_id, booking_id, workflow_id, wa_id, rating, comment, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
      [tenantId, bookingId, workflowId, waId, rating, text || null, Date.now()]
    );
    return rowToFeedback(rows[0]);
  },
  async listForBooking(tenantId, bookingId) {
    const rows = await query("SELECT * FROM feedback WHERE tenant_id = $1 AND booking_id = $2 ORDER BY created_at DESC", [tenantId, bookingId]);
    return rows.map(rowToFeedback);
  },
  async listForWorkflow(tenantId, workflowId) {
    const rows = await query("SELECT * FROM feedback WHERE tenant_id = $1 AND workflow_id = $2 ORDER BY created_at DESC", [tenantId, workflowId]);
    return rows.map(rowToFeedback);
  },
  async listAll(tenantId) {
    const rows = await query("SELECT * FROM feedback WHERE tenant_id = $1 ORDER BY created_at DESC", [tenantId]);
    return rows.map(rowToFeedback);
  },
  // Enterprise Hardening Phase 3, item 1 — the Customer 360 page's own
  // query, same shape as listForBooking/listForWorkflow above.
  async listForCustomer(tenantId, waId) {
    const rows = await query("SELECT * FROM feedback WHERE tenant_id = $1 AND wa_id = $2 ORDER BY created_at DESC", [tenantId, waId]);
    return rows.map(rowToFeedback);
  },
  async averageRatingForWorkflow(tenantId, workflowId) {
    // AVG()/COUNT() return Postgres `numeric`/`bigint` — the `pg` driver
    // parses both as STRINGS by default (unlike node:sqlite, which
    // returned real JS numbers), so both need an explicit Number() here.
    const rows = await query(
      "SELECT AVG(rating) AS avg, COUNT(rating) AS n FROM feedback WHERE tenant_id = $1 AND workflow_id = $2 AND rating IS NOT NULL",
      [tenantId, workflowId]
    );
    const row = rows[0];
    return { average: row.avg !== null ? Math.round(Number(row.avg) * 10) / 10 : null, count: Number(row.n) };
  },
};

module.exports = feedback;
