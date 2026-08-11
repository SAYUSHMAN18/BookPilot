const { db } = require("./db");
const { loadWorkflows } = require("../engine/loadWorkflows");

// Item 5 — every query filters by tenant_id, same discipline as
// knowledgeStore.js and every other per-tenant store: upsert/remove filter
// by (tenant_id, workflow_id) together so one tenant's admin can never
// touch another tenant's business config just by knowing its workflow id.
const upsertStmt = db.prepare(`
  INSERT INTO tenant_workflows (tenant_id, workflow_id, definition, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(tenant_id, workflow_id) DO UPDATE SET definition = excluded.definition, updated_at = excluded.updated_at
`);
const removeStmt = db.prepare("DELETE FROM tenant_workflows WHERE tenant_id = ? AND workflow_id = ?");
const getStmt = db.prepare("SELECT * FROM tenant_workflows WHERE tenant_id = ? AND workflow_id = ?");
const listForTenantStmt = db.prepare("SELECT * FROM tenant_workflows WHERE tenant_id = ? ORDER BY created_at ASC");
const countForTenantStmt = db.prepare("SELECT COUNT(*) AS n FROM tenant_workflows WHERE tenant_id = ?");

function rowToDefinition(row) {
  if (!row) return undefined;
  return JSON.parse(row.definition);
}

const tenantWorkflows = {
  // Returns a { [workflowId]: definition } object — the same shape the old
  // global `workflows` object (loadWorkflows()) always had, so every
  // caller in workflowEngine.js/classify.js/factualQA.js that already does
  // Object.values(workflows)/workflows[id] keeps working unchanged; only
  // server.js's call sites (which now must pass a tenantId in) changed.
  listForTenant(tenantId) {
    const map = {};
    for (const row of listForTenantStmt.all(tenantId)) {
      map[row.workflow_id] = JSON.parse(row.definition);
    }
    return map;
  },

  get(tenantId, workflowId) {
    return rowToDefinition(getStmt.get(tenantId, workflowId));
  },

  upsert(tenantId, workflow) {
    const now = Date.now();
    upsertStmt.run(tenantId, workflow.id, JSON.stringify(workflow), now, now);
    return tenantWorkflows.get(tenantId, workflow.id);
  },

  remove(tenantId, workflowId) {
    removeStmt.run(tenantId, workflowId);
  },

  // Called once, right after a tenant is created (self-signup or
  // platform_admin's POST /api/platform/tenants) — copies the read-only
  // workflows/*.json starter catalog in as that tenant's OWN rows, so a
  // brand new dashboard isn't empty on first login (matching the product's
  // existing "here's a working demo, go customize it" onboarding), while
  // every tenant's copy is independently editable from every other's.
  // Idempotent: a no-op if the tenant already has any workflow rows, so
  // it's also safe to call as a startup backfill for tenants that existed
  // before this table did.
  seedDefaultsForTenant(tenantId) {
    const { n } = countForTenantStmt.get(tenantId);
    if (n > 0) return;
    const defaults = loadWorkflows();
    const now = Date.now();
    for (const workflow of Object.values(defaults)) {
      upsertStmt.run(tenantId, workflow.id, JSON.stringify(workflow), now, now);
    }
  },
};

module.exports = tenantWorkflows;
