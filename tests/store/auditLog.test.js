// Regression test — found live during an exhaustive platform_admin
// testing pass: audit_log.tenant_id was originally added as
// `INTEGER NOT NULL`, but src/store/auditLog.js's own recordAudit() is
// written to accept `null` for a platform_admin's platform-wide actions
// (login, logout, password reset, a manual full-database backup — none
// of which belong to any single tenant). Every one of those crashed with
// a real NOT NULL constraint violation. Fixed via db.js's own schema
// (tenant_id has no NOT NULL constraint on the audit_log table) — this
// locks the fix down so the column can never silently regress back to
// NOT NULL.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");

let query, recordAudit, listAudit, listAuditAllTenants;

before(async () => {
  await createIsolatedTestDatabase();
  for (const mod of ["../../src/store/db", "../../src/store/auditLog"]) {
    delete require.cache[require.resolve(mod)];
  }
  ({ query } = require("../../src/store/db"));
  ({ recordAudit, listAudit, listAuditAllTenants } = require("../../src/store/auditLog"));
});

test("audit_log.tenant_id is nullable, not NOT NULL, on a fresh install", async () => {
  // Postgres equivalent of the old `PRAGMA table_info(audit_log)` check —
  // information_schema.columns.is_nullable reports 'YES'/'NO' per column.
  const rows = await query(
    "SELECT is_nullable FROM information_schema.columns WHERE table_name = $1 AND column_name = $2",
    ["audit_log", "tenant_id"]
  );
  const col = rows[0];
  assert.ok(col, "tenant_id column must exist");
  assert.equal(col.is_nullable, "YES", "tenant_id must be nullable so a platform-wide action can record NULL");
});

test("recordAudit(null, ...) succeeds for a platform-wide action instead of throwing", async () => {
  await assert.doesNotReject(async () => {
    await recordAudit(null, { email: "platform-admin@example.com", role: "platform_admin" }, "login", null);
  });
});

test("a platform-wide (tenant_id NULL) entry never appears in any tenant-scoped listAudit()", async () => {
  await recordAudit(null, { email: "platform-admin@example.com", role: "platform_admin" }, "backup.manual", null);
  await recordAudit(1, { email: "tenant1-admin@example.com", role: "admin" }, "login", null);

  const tenant1Log = await listAudit(1);
  assert.ok(tenant1Log.every((e) => e.actorEmail !== "platform-admin@example.com"), "a platform-wide entry must never leak into a tenant's own audit log");
  assert.ok(tenant1Log.some((e) => e.actorEmail === "tenant1-admin@example.com"));
});

test("listAuditAllTenants includes both platform-wide and tenant-scoped entries", async () => {
  await recordAudit(null, { email: "platform-wide-actor@example.com", role: "platform_admin" }, "login", null);
  await recordAudit(2, { email: "tenant2-admin@example.com", role: "admin" }, "login", null);

  const all = await listAuditAllTenants();
  assert.ok(all.some((e) => e.actorEmail === "platform-wide-actor@example.com" && e.tenantId === null));
  assert.ok(all.some((e) => e.actorEmail === "tenant2-admin@example.com" && e.tenantId === 2));
});
