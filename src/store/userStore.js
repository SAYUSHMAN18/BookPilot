const { pool, query } = require("./db");
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
    active: row.active,
    createdAt: Number(row.created_at),
  };
}

const users = {
  // SQLite's `COLLATE NOCASE` has no direct Postgres equivalent —
  // LOWER(x) = LOWER($1) is the standard, extension-free way to do a
  // case-insensitive exact match.
  async findByEmail(email) {
    const rows = await query("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [email]);
    return rowToUser(rows[0]);
  },

  async getById(id) {
    const rows = await query("SELECT * FROM users WHERE id = $1", [id]);
    return rowToUser(rows[0]);
  },

  // Kept separate from findByEmail (which strips the hash) so login is the
  // only call site that ever touches password_hash.
  async verifyCredentials(email, password) {
    const rows = await query("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [email]);
    const row = rows[0];
    if (!row || !row.active) return null;
    if (!verifyPassword(password, row.password_hash)) return null;
    return rowToUser(row);
  },

  // tenantId is null for a platform_admin account (Section 8.5) — every
  // other role always belongs to exactly one tenant.
  async create({ email, password, role, name, workflowId, providerId, tenantId }) {
    const normalizedEmail = email.trim().toLowerCase();
    try {
      const rows = await query(
        `INSERT INTO users (email, password_hash, role, name, workflow_id, provider_id, tenant_id, active, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8) RETURNING *`,
        [normalizedEmail, hashPassword(password), role, name ?? null, workflowId ?? null, providerId ?? null, tenantId ?? null, Date.now()]
      );
      return rowToUser(rows[0]);
    } catch (err) {
      if (err.code === "23505") {
        throw new DuplicateEmailError(normalizedEmail);
      }
      throw err;
    }
  },

  async list(tenantId) {
    const rows = await query("SELECT * FROM users WHERE tenant_id = $1 ORDER BY role, name", [tenantId]);
    return rows.map(rowToUser);
  },

  // Platform-admin only (Section 8.5).
  async listAllTenants() {
    const rows = await query("SELECT * FROM users ORDER BY tenant_id, role, name", []);
    return rows.map(rowToUser);
  },

  async count() {
    const rows = await query("SELECT COUNT(*) AS n FROM users", []);
    return Number(rows[0].n);
  },

  // Deactivating (not deleting) preserves the account's history in
  // audit_log and keeps its id stable if it's ever reactivated — a
  // provider who left and came back doesn't need a brand-new account.
  // tenantId-filtered so an admin can only ever deactivate their own
  // tenant's accounts, never another tenant's by guessing a numeric id.
  //
  // Found live: the UPDATE below is tenant-scoped (a cross-tenant id
  // updates zero rows), but a NAIVE version would fetch the return value
  // with an unscoped query — a cross-tenant PATCH would then silently
  // no-op the write yet still return the TARGET tenant's full user record
  // (email, name, role, workflowId/providerId) as a "successful" 200,
  // instead of ever reaching the route's own 404 guard. Checking
  // `rowCount` (whether the UPDATE actually touched a row — impossible
  // unless id AND tenantId both matched) closes that: a cross-tenant id
  // correctly returns undefined, same as a nonexistent one always did.
  async setActive(tenantId, id, active) {
    const result = await pool.query("UPDATE users SET active = $1 WHERE id = $2 AND tenant_id = $3", [active, id, tenantId]);
    if (result.rowCount === 0) return undefined;
    return this.getById(id);
  },

  // Section 6 — self-serve password reset lands here, same as the admin
  // re-creating an account used to be the only way to change a lost
  // password. Takes the plain new password (not a hash) so this stays the
  // one place hashPassword() is called for a password change, matching
  // create() above. Not tenant-filtered — same category as getById/
  // findByEmail above: the reset token itself (src/store/passwordResetStore.js)
  // already proved identity before this is ever called.
  async setPassword(id, newPassword) {
    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hashPassword(newPassword), id]);
    return this.getById(id);
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
async function bootstrapAdminIfNeeded() {
  if ((await users.count()) > 0) return { bootstrapped: false };
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!email || !password) {
    return { bootstrapped: false };
  }
  await users.create({ email, password, role: "admin", name: "Admin", tenantId: 1 });
  return { bootstrapped: true, email };
}

// Section 8.5 — same bootstrap pattern as bootstrapAdminIfNeeded above,
// for the platform-wide role instead of a tenant's own admin. Gated on
// "does a platform_admin already exist" specifically (not "is the users
// table empty" — by the time an operator sets these env vars, the
// default tenant's admin from the block above may already exist), so
// it's safe to leave PLATFORM_ADMIN_BOOTSTRAP_EMAIL/PASSWORD set
// indefinitely without it ever re-creating or duplicating the account.
async function bootstrapPlatformAdminIfNeeded() {
  const rows = await query("SELECT COUNT(*) AS n FROM users WHERE role = 'platform_admin'", []);
  if (Number(rows[0].n) > 0) return { bootstrapped: false };
  const email = process.env.PLATFORM_ADMIN_BOOTSTRAP_EMAIL;
  const password = process.env.PLATFORM_ADMIN_BOOTSTRAP_PASSWORD;
  if (!email || !password) {
    return { bootstrapped: false };
  }
  await users.create({ email, password, role: "platform_admin", name: "Platform Admin", tenantId: null });
  return { bootstrapped: true, email };
}

module.exports = users;
module.exports.bootstrapAdminIfNeeded = bootstrapAdminIfNeeded;
module.exports.bootstrapPlatformAdminIfNeeded = bootstrapPlatformAdminIfNeeded;
module.exports.DuplicateEmailError = DuplicateEmailError;
