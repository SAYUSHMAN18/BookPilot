const { pool, query } = require("./db");

// Section 8 — every query filters by tenant_id; getById/setResolved filter
// by (id, tenant_id) together so a provider from one tenant can never
// read or resolve another tenant's support request just by guessing a
// numeric id.

function rowToRequest(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    waId: row.wa_id,
    workflowId: row.workflow_id,
    message: row.message,
    resolved: row.resolved,
    createdAt: Number(row.created_at),
  };
}

const supportRequests = {
  async create(tenantId, waId, workflowId, message) {
    const rows = await query(
      "INSERT INTO support_requests (tenant_id, wa_id, workflow_id, message, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [tenantId, waId, workflowId ?? null, message, Date.now()]
    );
    return rowToRequest(rows[0]);
  },
  async listAll(tenantId) {
    const rows = await query("SELECT * FROM support_requests WHERE tenant_id = $1 ORDER BY resolved ASC, created_at DESC", [tenantId]);
    return rows.map(rowToRequest);
  },
  async listForWorkflow(tenantId, workflowId) {
    const rows = await query("SELECT * FROM support_requests WHERE tenant_id = $1 AND workflow_id = $2 ORDER BY resolved ASC, created_at DESC", [tenantId, workflowId]);
    return rows.map(rowToRequest);
  },
  async getById(tenantId, id) {
    const rows = await query("SELECT * FROM support_requests WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
    return rowToRequest(rows[0]);
  },
  async setResolved(tenantId, id, resolved) {
    await pool.query("UPDATE support_requests SET resolved = $1 WHERE id = $2 AND tenant_id = $3", [resolved, id, tenantId]);
    return this.getById(tenantId, id);
  },
};

module.exports = supportRequests;
