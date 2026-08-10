const { db } = require("./db");
const { hashPassword, verifyPassword } = require("../infra/auth");

// Section 8 — email stays GLOBALLY unique (not unique-per-tenant). Two
// different tenants both wanting to use the same login email would need a
// "which business are you logging into" step before password entry — a
// real feature, not a one-line change — and isn't needed for the common
// case (a business's own admin/provider uses their own distinct email
// anyway). Documented as a deliberate scope decision, not an oversight:
// findByEmail/verifyCredentials/getById are deliberately NOT tenant-filtered
// — they're what LOGIN uses to figure out who someone is and which tenant
// they belong to in the first place, so there's no tenant to filter by
// yet. Once identity is established, every other function here that
// manages a tenant's own team (list/create/setActive) IS tenant-filtered,
// so one tenant's admin can never see or touch another tenant's accounts.
const getByEmailStmt = db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE");
const getByIdStmt = db.prepare("SELECT * FROM users WHERE id = ?");
const listStmt = db.prepare("SELECT * FROM users WHERE tenant_id = ? ORDER BY role, name");
const listAllTenantsStmt = db.prepare("SELECT * FROM users ORDER BY tenant_id, role, name");
const insertStmt = db.prepare(`
  INSERT INTO users (email, password_hash, role, name, workflow_id, provider_id, tenant_id, active, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
`);
const countStmt = db.prepare("SELECT COUNT(*) AS n FROM users");
const setActiveStmt = db.prepare("UPDATE users SET active = ? WHERE id = ? AND tenant_id = ?");
const setPasswordStmt = db.prepare("UPDATE users SET password_hash = ? WHERE id = ?");

class DuplicateEmailError extends Error {
  constructor(email) {
    super(`An account already exists for ${email}.`);
    this.code = "DUPLICATE_EMAIL";
  }
}

function rowToUser(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    name: row.name,
    workflowId: row.workflow_id,
    providerId: row.provider_id,
    tenantId: row.tenant_id, // null only for role === 'platform_admin'
    active: !!row.active,
    createdAt: row.created_at,
  };
}

const users = {
  findByEmail(email) {
    return rowToUser(getByEmailStmt.get(email));
  },

  getById(id) {
    return rowToUser(getByIdStmt.get(id));
  },

  // Kept separate from findByEmail (which strips the hash) so login is the
  // only call site that ever touches password_hash.
  verifyCredentials(email, password) {
    const row = getByEmailStmt.get(email);
    if (!row || !row.active) return null;
    if (!verifyPassword(password, row.password_hash)) return null;
    return rowToUser(row);
  },

  // tenantId is null for a platform_admin account (Section 8.5) — every
  // other role always belongs to exactly one tenant.
  create({ email, password, role, name, workflowId, providerId, tenantId }) {
    const normalizedEmail = email.trim().toLowerCase();
    try {
      const result = insertStmt.run(
        normalizedEmail,
        hashPassword(password),
        role,
        name ?? null,
        workflowId ?? null,
        providerId ?? null,
        tenantId ?? null,
        Date.now()
      );
      return rowToUser(getByIdStmt.get(result.lastInsertRowid));
    } catch (err) {
      if (String(err.message).includes("UNIQUE constraint failed")) {
        throw new DuplicateEmailError(normalizedEmail);
      }
      throw err;
    }
  },

  list(tenantId) {
    return listStmt.all(tenantId).map(rowToUser);
  },

  // Platform-admin only (Section 8.5).
  listAllTenants() {
    return listAllTenantsStmt.all().map(rowToUser);
  },

  count() {
    return countStmt.get().n;
  },

  // Deactivating (not deleting) preserves the account's history in
  // audit_log and keeps its id stable if it's ever reactivated — a
  // provider who left and came back doesn't need a brand-new account.
  // tenantId-filtered so an admin can only ever deactivate their own
  // tenant's accounts, never another tenant's by guessing a numeric id.
  setActive(tenantId, id, active) {
    setActiveStmt.run(active ? 1 : 0, id, tenantId);
    return rowToUser(getByIdStmt.get(id));
  },

  // Section 6 — self-serve password reset lands here, same as the admin
  // re-creating an account used to be the only way to change a lost
  // password. Takes the plain new password (not a hash) so this stays the
  // one place hashPassword() is called for a password change, matching
  // create() above. Not tenant-filtered — same category as getById/
  // findByEmail above: the reset token itself (src/store/passwordResetStore.js)
  // already proved identity before this is ever called.
  setPassword(id, newPassword) {
    setPasswordStmt.run(hashPassword(newPassword), id);
    return rowToUser(getByIdStmt.get(id));
  },
};

// Bootstrap: without this there's no way to log in on a fresh install
// without hand-writing a SQL INSERT. Only fires when the users table is
// completely empty, so it can't be used to re-create an admin account
// after the fact — set the env vars, start the server once, then remove
// them (or leave them; they only matter when the table is empty).
// Bootstraps as the default tenant's (id 1) admin — a fresh install always
// starts with exactly one tenant, same as the DB migration itself (see
// src/store/db.js).
function bootstrapAdminIfNeeded() {
  if (users.count() > 0) return;
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!email || !password) {
    return { bootstrapped: false };
  }
  users.create({ email, password, role: "admin", name: "Admin", tenantId: 1 });
  return { bootstrapped: true, email };
}

// Section 8.5 — same bootstrap pattern as bootstrapAdminIfNeeded above,
// for the platform-wide role instead of a tenant's own admin. Gated on
// "does a platform_admin already exist" specifically (not "is the users
// table empty" — by the time an operator sets these env vars, the
// default tenant's admin from the block above may already exist), so
// it's safe to leave PLATFORM_ADMIN_BOOTSTRAP_EMAIL/PASSWORD set
// indefinitely without it ever re-creating or duplicating the account.
const countPlatformAdminsStmt = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'platform_admin'");
function bootstrapPlatformAdminIfNeeded() {
  if (countPlatformAdminsStmt.get().n > 0) return { bootstrapped: false };
  const email = process.env.PLATFORM_ADMIN_BOOTSTRAP_EMAIL;
  const password = process.env.PLATFORM_ADMIN_BOOTSTRAP_PASSWORD;
  if (!email || !password) {
    return { bootstrapped: false };
  }
  users.create({ email, password, role: "platform_admin", name: "Platform Admin", tenantId: null });
  return { bootstrapped: true, email };
}

module.exports = users;
module.exports.bootstrapAdminIfNeeded = bootstrapAdminIfNeeded;
module.exports.bootstrapPlatformAdminIfNeeded = bootstrapPlatformAdminIfNeeded;
module.exports.DuplicateEmailError = DuplicateEmailError;
