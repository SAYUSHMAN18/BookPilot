const { pool, query } = require("./db");

// See db.js's comment on onboarding_requests — one row per tenant, opened
// by the subscription webhook the moment payment succeeds, closed when the
// onboarding team marks it complete. Deliberately NOT tenant-scoped the way
// support_requests's own methods are (that store is for a tenant's OWN
// dashboard listing their own requests) — every method here is
// platform-admin-only, working across every tenant's queue at once.

function rowToRequest(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status,
    intake: row.intake_json ? JSON.parse(row.intake_json) : null,
    assignedTo: row.assigned_to,
    contactedAt: row.contacted_at ? Number(row.contacted_at) : null,
    createdAt: Number(row.created_at),
    completedAt: row.completed_at ? Number(row.completed_at) : null,
  };
}

const onboardingRequests = {
  async create(tenantId, intake) {
    const rows = await query(
      `INSERT INTO onboarding_requests (tenant_id, status, intake_json, created_at) VALUES ($1, 'pending', $2, $3) RETURNING *`,
      [tenantId, intake ? JSON.stringify(intake) : null, Date.now()]
    );
    return rowToRequest(rows[0]);
  },

  // The queue view — every tenant still being onboarded, oldest first (an
  // SLA queue, not a feed), joined with just enough tenant info for the
  // admin list view so the frontend doesn't need N follow-up requests.
  async listQueue() {
    const rows = await query(
      `SELECT r.*, t.name AS tenant_name, t.slug AS tenant_slug, t.plan AS tenant_plan, t.billing_email AS tenant_billing_email, t.status AS tenant_status
       FROM onboarding_requests r JOIN tenants t ON t.id = r.tenant_id
       WHERE r.status IN ('pending', 'in_progress')
       ORDER BY r.created_at ASC`,
      []
    );
    return rows.map((row) => ({
      ...rowToRequest(row),
      tenant: { name: row.tenant_name, slug: row.tenant_slug, plan: row.tenant_plan, billingEmail: row.tenant_billing_email, status: row.tenant_status },
    }));
  },

  async getById(id) {
    const rows = await query("SELECT * FROM onboarding_requests WHERE id = $1", [id]);
    return rowToRequest(rows[0]);
  },

  async getForTenant(tenantId) {
    const rows = await query("SELECT * FROM onboarding_requests WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1", [tenantId]);
    return rowToRequest(rows[0]);
  },

  async assign(id, assignedTo) {
    await pool.query("UPDATE onboarding_requests SET assigned_to = $1 WHERE id = $2", [assignedTo, id]);
    return this.getById(id);
  },

  // Resets the SLA clock (a re-contact after a gap still counts as "we're
  // on it") rather than only ever recording the first touch.
  async markContacted(id) {
    await pool.query("UPDATE onboarding_requests SET status = 'in_progress', contacted_at = $1 WHERE id = $2", [Date.now(), id]);
    return this.getById(id);
  },

  async markComplete(id) {
    await pool.query("UPDATE onboarding_requests SET status = 'complete', completed_at = $1 WHERE id = $2", [Date.now(), id]);
    return this.getById(id);
  },
};

module.exports = onboardingRequests;
