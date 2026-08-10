// Regression test — found live during an exhaustive platform_admin
// testing pass: audit_log.tenant_id was originally added as
// `INTEGER NOT NULL`, but src/store/auditLog.js's own recordAudit() is
// written to accept `null` for a platform_admin's platform-wide actions
// (login, logout, password reset, a manual full-database backup — none
// of which belong to any single tenant). Every one of those crashed with
// a real NOT NULL constraint violation. Fixed via a recreate-and-copy
// migration in src/store/db.js (migrateAuditLogNullableTenantId) —
// this locks the fix down so the column can never silently regress back
// to NOT NULL.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bookpilot-auditlog-test-"));
for (const mod of ["../../src/store/db", "../../src/store/auditLog"]) {
  delete require.cache[require.resolve(mod)];
}
const { db } = require("../../src/store/db");
const { recordAudit, listAudit, listAuditAllTenants } = require("../../src/store/auditLog");

test("audit_log.tenant_id is nullable, not NOT NULL, on a fresh install", () => {
  const col = db.prepare("PRAGMA table_info(audit_log)").all().find((c) => c.name === "tenant_id");
  assert.ok(col, "tenant_id column must exist");
  assert.equal(col.notnull, 0, "tenant_id must be nullable so a platform-wide action can record NULL");
});

test("recordAudit(null, ...) succeeds for a platform-wide action instead of throwing", () => {
  assert.doesNotThrow(() => {
    recordAudit(null, { email: "platform-admin@example.com", role: "platform_admin" }, "login", null);
  });
});

test("a platform-wide (tenant_id NULL) entry never appears in any tenant-scoped listAudit()", () => {
  recordAudit(null, { email: "platform-admin@example.com", role: "platform_admin" }, "backup.manual", null);
  recordAudit(1, { email: "tenant1-admin@example.com", role: "admin" }, "login", null);

  const tenant1Log = listAudit(1);
  assert.ok(tenant1Log.every((e) => e.actorEmail !== "platform-admin@example.com"), "a platform-wide entry must never leak into a tenant's own audit log");
  assert.ok(tenant1Log.some((e) => e.actorEmail === "tenant1-admin@example.com"));
});

test("listAuditAllTenants includes both platform-wide and tenant-scoped entries", () => {
  recordAudit(null, { email: "platform-wide-actor@example.com", role: "platform_admin" }, "login", null);
  recordAudit(2, { email: "tenant2-admin@example.com", role: "admin" }, "login", null);

  const all = listAuditAllTenants();
  assert.ok(all.some((e) => e.actorEmail === "platform-wide-actor@example.com" && e.tenantId === null));
  assert.ok(all.some((e) => e.actorEmail === "tenant2-admin@example.com" && e.tenantId === 2));
});
