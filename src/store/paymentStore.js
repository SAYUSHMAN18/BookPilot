const { pool, query } = require("./db");

// Section 9 — one row per payment ATTEMPT, not per booking. A failed
// attempt followed by a successful retry is two distinct rows: an honest
// audit trail of what actually happened, matching the Definition of
// Done's "all payment state changes are auditable in the payments table."

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
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const payments = {
  async create(tenantId, bookingId, { amount, currency = "INR", provider = "razorpay", providerOrderId }) {
    const now = Date.now();
    const rows = await query(
      `INSERT INTO payments (tenant_id, booking_id, amount, currency, status, provider, provider_order_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'created', $5, $6, $7, $8) RETURNING *`,
      [tenantId, bookingId, amount, currency, provider, providerOrderId || null, now, now]
    );
    return rowToPayment(rows[0]);
  },

  async getById(tenantId, id) {
    const rows = await query("SELECT * FROM payments WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
    return rowToPayment(rows[0]);
  },

  // The payment webhook (dashboard.js/webhook.js) only ever gets the
  // PROVIDER's own order id in the callback payload, never this table's
  // row id — this is how it finds the right row again. Not tenant-
  // filtered by the caller's own context (there isn't one — this IS a
  // webhook, no session) — the row itself carries which tenant it
  // belongs to, and the webhook signature (verified before this is ever
  // called) is what proves the request is genuinely from the payment
  // provider.
  async getByOrderId(providerOrderId) {
    const rows = await query("SELECT * FROM payments WHERE provider_order_id = $1", [providerOrderId]);
    return rowToPayment(rows[0]);
  },

  async listForBooking(tenantId, bookingId) {
    const rows = await query("SELECT * FROM payments WHERE tenant_id = $1 AND booking_id = $2 ORDER BY created_at DESC", [tenantId, bookingId]);
    return rows.map(rowToPayment);
  },

  async listForTenant(tenantId, limit = 200) {
    const rows = await query("SELECT * FROM payments WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2", [tenantId, limit]);
    return rows.map(rowToPayment);
  },

  async markPaid(id, providerPaymentId) {
    await pool.query("UPDATE payments SET status = 'paid', provider_payment_id = $1, updated_at = $2 WHERE id = $3", [providerPaymentId, Date.now(), id]);
  },

  async markFailed(id, reason) {
    await pool.query("UPDATE payments SET status = 'failed', failure_reason = $1, updated_at = $2 WHERE id = $3", [reason || null, Date.now(), id]);
  },

  // status is 'refunded' (full) or 'partially_refunded' — caller decides
  // which based on whether refundAmount === the original amount.
  async markRefunded(id, status, refundStatus, refundAmount) {
    await pool.query("UPDATE payments SET status = $1, refund_status = $2, refund_amount = $3, updated_at = $4 WHERE id = $5", [status, refundStatus, refundAmount, Date.now(), id]);
  },

  // Revenue: only ever counts 'paid' rows minus whatever was refunded off
  // them — a 'created'/'failed' row was never real money and must not
  // appear in a revenue figure just because a row exists. SUM()/COUNT()
  // return Postgres `numeric`/`bigint`, parsed as STRINGS by the `pg`
  // driver by default — Number() both before returning.
  async revenueForTenant(tenantId) {
    const rows = await query(
      `SELECT COALESCE(SUM(amount - COALESCE(refund_amount, 0)), 0) AS revenue, COUNT(*) AS "paidCount"
       FROM payments WHERE tenant_id = $1 AND status IN ('paid', 'partially_refunded', 'refunded')`,
      [tenantId]
    );
    const row = rows[0];
    return { revenue: Number(row.revenue), paidCount: Number(row.paidCount) };
  },
};

module.exports = payments;
