const { db } = require("./db");

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
const insertStmt = db.prepare("INSERT INTO feedback (tenant_id, booking_id, workflow_id, wa_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
const listForBookingStmt = db.prepare("SELECT * FROM feedback WHERE tenant_id = ? AND booking_id = ? ORDER BY created_at DESC");
const listForWorkflowStmt = db.prepare("SELECT * FROM feedback WHERE tenant_id = ? AND workflow_id = ? ORDER BY created_at DESC");
const listAllStmt = db.prepare("SELECT * FROM feedback WHERE tenant_id = ? ORDER BY created_at DESC");
const avgRatingForWorkflowStmt = db.prepare(
  "SELECT AVG(rating) AS avg, COUNT(rating) AS n FROM feedback WHERE tenant_id = ? AND workflow_id = ? AND rating IS NOT NULL"
);

function rowToFeedback(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    bookingId: row.booking_id,
    waId: row.wa_id,
    rating: row.rating,
    comment: row.comment,
    createdAt: row.created_at,
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
  create(tenantId, bookingId, workflowId, waId, text) {
    const rating = parseRating(text);
    const result = insertStmt.run(tenantId, bookingId, workflowId, waId, rating, text || null, Date.now());
    return rowToFeedback({ id: result.lastInsertRowid, tenant_id: tenantId, booking_id: bookingId, wa_id: waId, rating, comment: text, created_at: Date.now() });
  },
  listForBooking(tenantId, bookingId) {
    return listForBookingStmt.all(tenantId, bookingId).map(rowToFeedback);
  },
  listForWorkflow(tenantId, workflowId) {
    return listForWorkflowStmt.all(tenantId, workflowId).map(rowToFeedback);
  },
  listAll(tenantId) {
    return listAllStmt.all(tenantId).map(rowToFeedback);
  },
  averageRatingForWorkflow(tenantId, workflowId) {
    const row = avgRatingForWorkflowStmt.get(tenantId, workflowId);
    return { average: row.avg !== null ? Math.round(row.avg * 10) / 10 : null, count: row.n };
  },
};

module.exports = feedback;
