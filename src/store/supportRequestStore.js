const { db } = require("./db");

// Section 8 — every query filters by tenant_id; getById/setResolved filter
// by (id, tenant_id) together so a provider from one tenant can never
// read or resolve another tenant's support request just by guessing a
// numeric id.
const insertStmt = db.prepare(
  "INSERT INTO support_requests (tenant_id, wa_id, workflow_id, message, created_at) VALUES (?, ?, ?, ?, ?)"
);
const resolveStmt = db.prepare("UPDATE support_requests SET resolved = ? WHERE id = ? AND tenant_id = ?");
const getByIdStmt = db.prepare("SELECT * FROM support_requests WHERE id = ? AND tenant_id = ?");
const listAllStmt = db.prepare("SELECT * FROM support_requests WHERE tenant_id = ? ORDER BY resolved ASC, created_at DESC");
const listForWorkflowStmt = db.prepare(
  "SELECT * FROM support_requests WHERE tenant_id = ? AND workflow_id = ? ORDER BY resolved ASC, created_at DESC"
);

function rowToRequest(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    waId: row.wa_id,
    workflowId: row.workflow_id,
    message: row.message,
    resolved: !!row.resolved,
    createdAt: row.created_at,
  };
}

const supportRequests = {
  create(tenantId, waId, workflowId, message) {
    const result = insertStmt.run(tenantId, waId, workflowId ?? null, message, Date.now());
    return rowToRequest(getByIdStmt.get(result.lastInsertRowid, tenantId));
  },
  listAll(tenantId) {
    return listAllStmt.all(tenantId).map(rowToRequest);
  },
  listForWorkflow(tenantId, workflowId) {
    return listForWorkflowStmt.all(tenantId, workflowId).map(rowToRequest);
  },
  getById(tenantId, id) {
    return rowToRequest(getByIdStmt.get(id, tenantId));
  },
  setResolved(tenantId, id, resolved) {
    resolveStmt.run(resolved ? 1 : 0, id, tenantId);
    return rowToRequest(getByIdStmt.get(id, tenantId));
  },
};

module.exports = supportRequests;
