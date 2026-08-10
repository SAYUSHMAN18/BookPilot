const { db } = require("./db");

// Section 8 — tenantId here is "which tenant's data this action was
// about," not the actor's own tenant (those usually coincide, but a
// platform_admin's actor.tenantId is always null while the action itself
// is almost always about one specific tenant — e.g. suspending it). Kept
// as an explicit param the caller supplies rather than derived from
// `actor`, so that distinction can't get silently conflated. NULL for a
// genuinely platform-wide action tied to no single tenant (e.g. creating
// a brand-new tenant — there's no "existing tenant" yet to attribute it to).
const insertStmt = db.prepare(`
  INSERT INTO audit_log (tenant_id, actor_email, actor_role, action, detail, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const listStmt = db.prepare("SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?");
// Platform-admin only — every tenant's audit trail in one view (Section 8.5).
const listAllTenantsStmt = db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?");

function rowToEntry(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    actorEmail: row.actor_email,
    actorRole: row.actor_role,
    action: row.action,
    detail: row.detail ? JSON.parse(row.detail) : null,
    createdAt: row.created_at,
  };
}

function recordAudit(tenantId, actor, action, detail) {
  insertStmt.run(tenantId, actor.email, actor.role, action, detail ? JSON.stringify(detail) : null, Date.now());
}

function listAudit(tenantId, limit = 200) {
  return listStmt.all(tenantId, limit).map(rowToEntry);
}

function listAuditAllTenants(limit = 200) {
  return listAllTenantsStmt.all(limit).map(rowToEntry);
}

module.exports = { recordAudit, listAudit, listAuditAllTenants };
