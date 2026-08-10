const { db } = require("./db");

// Section 9 — one row per payment ATTEMPT, not per booking. A failed
// attempt followed by a successful retry is two distinct rows: an honest
// audit trail of what actually happened, matching the Definition of
// Done's "all payment state changes are auditable in the payments table."
const insertStmt = db.prepare(`
  INSERT INTO payments (tenant_id, booking_id, amount, currency, status, provider, provider_order_id, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?)
`);
const getByIdStmt = db.prepare("SELECT * FROM payments WHERE id = ? AND tenant_id = ?");
const getByOrderIdStmt = db.prepare("SELECT * FROM payments WHERE provider_order_id = ?");
const listForBookingStmt = db.prepare("SELECT * FROM payments WHERE tenant_id = ? AND booking_id = ? ORDER BY created_at DESC");
const listForTenantStmt = db.prepare("SELECT * FROM payments WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?");
const markPaidStmt = db.prepare(
  "UPDATE payments SET status = 'paid', provider_payment_id = ?, updated_at = ? WHERE id = ?"
);
const markFailedStmt = db.prepare("UPDATE payments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?");
const markRefundedStmt = db.prepare(
  "UPDATE payments SET status = ?, refund_status = ?, refund_amount = ?, updated_at = ? WHERE id = ?"
);
// Revenue: only ever counts 'paid' rows minus whatever was refunded off
// them — a 'created'/'failed' row was never real money and must not
// appear in a revenue figure just because a row exists.
const revenueForTenantStmt = db.prepare(`
  SELECT COALESCE(SUM(amount - COALESCE(refund_amount, 0)), 0) AS revenue, COUNT(*) AS paidCount
  FROM payments WHERE tenant_id = ? AND status IN ('paid', 'partially_refunded', 'refunded')
`);

function rowToPayment(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    bookingId: row.booking_id,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    provider: row.provider,
    providerOrderId: row.provider_order_id,
    providerPaymentId: row.provider_payment_id,
    refundStatus: row.refund_status,
    refundAmount: row.refund_amount,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const payments = {
  create(tenantId, bookingId, { amount, currency = "INR", provider = "razorpay", providerOrderId }) {
    const now = Date.now();
    const result = insertStmt.run(tenantId, bookingId, amount, currency, provider, providerOrderId || null, now, now);
    return this.getById(tenantId, result.lastInsertRowid);
  },

  getById(tenantId, id) {
    return rowToPayment(getByIdStmt.get(id, tenantId));
  },

  // The payment webhook (server.js) only ever gets the PROVIDER's own
  // order id in the callback payload, never this table's row id — this
  // is how it finds the right row again. Not tenant-filtered by the
  // caller's own context (there isn't one — this IS a webhook, no
  // session) — the row itself carries which tenant it belongs to, and
  // the webhook signature (verified before this is ever called) is what
  // proves the request is genuinely from the payment provider.
  getByOrderId(providerOrderId) {
    return rowToPayment(getByOrderIdStmt.get(providerOrderId));
  },

  listForBooking(tenantId, bookingId) {
    return listForBookingStmt.all(tenantId, bookingId).map(rowToPayment);
  },

  listForTenant(tenantId, limit = 200) {
    return listForTenantStmt.all(tenantId, limit).map(rowToPayment);
  },

  markPaid(id, providerPaymentId) {
    markPaidStmt.run(providerPaymentId, Date.now(), id);
  },

  markFailed(id, reason) {
    markFailedStmt.run(reason || null, Date.now(), id);
  },

  // status is 'refunded' (full) or 'partially_refunded' — caller decides
  // which based on whether refundAmount === the original amount.
  markRefunded(id, status, refundStatus, refundAmount) {
    markRefundedStmt.run(status, refundStatus, refundAmount, Date.now(), id);
  },

  revenueForTenant(tenantId) {
    const row = revenueForTenantStmt.get(tenantId);
    return { revenue: row.revenue, paidCount: row.paidCount };
  },
};

module.exports = payments;
