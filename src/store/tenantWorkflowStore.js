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
const editedCountStmt = db.prepare("SELECT COUNT(*) AS n FROM tenant_workflows WHERE tenant_id = ? AND updated_at != created_at");

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

  // No longer called anywhere in server.js — a brand new tenant now starts
  // with zero businesses; its admin adds real ones by hand from the
  // dashboard instead of getting a fake demo catalog to notice and clean
  // up. Kept as a test fixture: tests/http/_setup.js's signupAndActivate()
  // calls this directly so booking-flow tests still have a working
  // business to exercise, without that being real product behavior.
  // Idempotent: a no-op if the tenant already has any workflow rows.
  seedDefaultsForTenant(tenantId) {
    const { n } = countForTenantStmt.get(tenantId);
    if (n > 0) return;
    const defaults = loadWorkflows();
    const now = Date.now();
    for (const workflow of Object.values(defaults)) {
      upsertStmt.run(tenantId, workflow.id, JSON.stringify(workflow), now, now);
    }
  },

  // The setup checklist's "customize your first business" signal. A brand
  // new tenant now starts with zero workflow rows (nothing is auto-seeded
  // any more — see server.js's comment by ensureDemoTenant()), so simply
  // having ANY row is real signal the admin added a business of their own.
  // Still checks `edited` too, purely for the legacy case of a tenant that
  // still carries rows from before auto-seeding was removed: an untouched
  // leftover demo catalog with nothing added/removed and nothing edited
  // shouldn't itself count as "customized".
  hasCustomizations(tenantId) {
    const { n: total } = countForTenantStmt.get(tenantId);
    if (total === 0) return false;
    const { n: edited } = editedCountStmt.get(tenantId);
    const defaultCount = Object.keys(loadWorkflows()).length;
    return edited > 0 || total !== defaultCount;
  },
};

module.exports = tenantWorkflows;
