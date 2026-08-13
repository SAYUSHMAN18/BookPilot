const { pool, query } = require("./db");

// The plan-checkout counterpart of paymentStore.js — see db.js's comment
// on subscription_orders for why this isn't just another payments row.

function rowToOrder(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    plan: row.plan,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    provider: row.provider,
    providerOrderId: row.provider_order_id,
    providerPaymentId: row.provider_payment_id,
    failureReason: row.failure_reason,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const subscriptionOrders = {
  async create(tenantId, plan, { amount, currency = "INR", provider = "razorpay", providerOrderId }) {
    const now = Date.now();
    const rows = await query(
      `INSERT INTO subscription_orders (tenant_id, plan, amount, currency, status, provider, provider_order_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'created', $5, $6, $7, $8) RETURNING *`,
      [tenantId, plan, amount, currency, provider, providerOrderId || null, now, now]
    );
    return rowToOrder(rows[0]);
  },

  // Same no-session-context reasoning as paymentStore.getByOrderId — this
  // is looked up straight from a webhook, whose signature (already
  // verified before this is ever called) is what proves the request is
  // genuinely from the payment provider.
  async getByOrderId(providerOrderId) {
    const rows = await query("SELECT * FROM subscription_orders WHERE provider_order_id = $1", [providerOrderId]);
    return rowToOrder(rows[0]);
  },

  // Razorpay's own order/receipt id only exists AFTER the checkout call
  // this row itself triggers — set separately rather than threaded through
  // create(), since this is the only handle the payment webhook later has
  // to find this row again (see getByOrderId above).
  async setProviderOrderId(id, providerOrderId) {
    await pool.query("UPDATE subscription_orders SET provider_order_id = $1, updated_at = $2 WHERE id = $3", [providerOrderId, Date.now(), id]);
  },

  async markPaid(id, providerPaymentId) {
    await pool.query("UPDATE subscription_orders SET status = 'paid', provider_payment_id = $1, updated_at = $2 WHERE id = $3", [providerPaymentId, Date.now(), id]);
  },

  async markFailed(id, reason) {
    await pool.query("UPDATE subscription_orders SET status = 'failed', failure_reason = $1, updated_at = $2 WHERE id = $3", [reason || null, Date.now(), id]);
  },
};

module.exports = subscriptionOrders;
