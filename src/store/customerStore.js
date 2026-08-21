// Customer identity & history, keyed by (tenant_id, wa_id) — no dedicated
// `customers` table exists (a customer is just "whoever has booking rows
// under this wa_id"), so this is a read-only aggregation layer over
// `bookings`/`payments`, not a new source of truth. Matches this
// codebase's existing "no ORM, plain pg queries" style (see
// paymentStore.js).
const { query } = require("./db");

const customers = {
  // Cheap existence check, not a full history fetch — meant to be safe to
  // call on every inbound WhatsApp message (e.g. workflowEngine.js's
  // DETECTING stage, so a returning customer can be greeted differently).
  // A prior CANCELLED booking still counts as "returning" — they're a real
  // past customer regardless of how that visit ended.
  async isReturningCustomer(tenantId, waId) {
    const rows = await query("SELECT 1 FROM bookings WHERE tenant_id = $1 AND wa_id = $2 LIMIT 1", [tenantId, waId]);
    return rows.length > 0;
  },

  // Full history summary — visit stats + lifetime value. Not cheap enough
  // for the hot per-message path; for dashboard/on-demand use (e.g. a
  // provider looking up a customer, or a future "personalize this reply"
  // AI call, not every single turn).
  async summaryForCustomer(tenantId, waId) {
    const visitRows = await query(
      `SELECT COUNT(*) AS "visitCount", MIN(created_at) AS "firstVisitAt", MAX(created_at) AS "lastVisitAt"
       FROM bookings WHERE tenant_id = $1 AND wa_id = $2 AND status != 'cancelled'`,
      [tenantId, waId]
    );
    const ltvRows = await query(
      `SELECT COALESCE(SUM(p.amount), 0) AS "lifetimeValue"
       FROM payments p JOIN bookings b ON b.id = p.booking_id
       WHERE b.tenant_id = $1 AND b.wa_id = $2 AND p.status = 'paid'`,
      [tenantId, waId]
    );
    const visit = visitRows[0];
    return {
      visitCount: Number(visit.visitCount),
      firstVisitAt: visit.firstVisitAt !== null ? Number(visit.firstVisitAt) : null,
      lastVisitAt: visit.lastVisitAt !== null ? Number(visit.lastVisitAt) : null,
      lifetimeValue: Number(ltvRows[0].lifetimeValue),
    };
  },

  // Enterprise Hardening Phase 3, item 2 — internal, provider-facing note
  // about a customer (customer_notes table, db.js). Never surfaced to the
  // customer themselves — distinct from bookings.providerNote, which IS
  // sent to the customer on cancel/no-show/complete.
  async getNote(tenantId, waId) {
    const rows = await query("SELECT note FROM customer_notes WHERE tenant_id = $1 AND wa_id = $2", [tenantId, waId]);
    return rows[0]?.note || "";
  },

  async setNote(tenantId, waId, note) {
    await query(
      `INSERT INTO customer_notes (tenant_id, wa_id, note, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, wa_id) DO UPDATE SET note = EXCLUDED.note, updated_at = EXCLUDED.updated_at`,
      [tenantId, waId, note, Date.now()]
    );
  },
};

module.exports = customers;
