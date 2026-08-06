const { db } = require("./db");
const { hashPassword, verifyPassword } = require("./auth");

const getByEmailStmt = db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE");
const getByIdStmt = db.prepare("SELECT * FROM users WHERE id = ?");
const listStmt = db.prepare("SELECT * FROM users ORDER BY role, name");
const insertStmt = db.prepare(`
  INSERT INTO users (email, password_hash, role, name, workflow_id, provider_id, active, created_at)
  VALUES (?, ?, ?, ?, ?, ?, 1, ?)
`);
const countStmt = db.prepare("SELECT COUNT(*) AS n FROM users");
const setActiveStmt = db.prepare("UPDATE users SET active = ? WHERE id = ?");

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

  create({ email, password, role, name, workflowId, providerId }) {
    const normalizedEmail = email.trim().toLowerCase();
    try {
      const result = insertStmt.run(
        normalizedEmail,
        hashPassword(password),
        role,
        name ?? null,
        workflowId ?? null,
        providerId ?? null,
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

  list() {
    return listStmt.all().map(rowToUser);
  },

  count() {
    return countStmt.get().n;
  },

  // Deactivating (not deleting) preserves the account's history in
  // audit_log and keeps its id stable if it's ever reactivated — a
  // provider who left and came back doesn't need a brand-new account.
  setActive(id, active) {
    setActiveStmt.run(active ? 1 : 0, id);
    return rowToUser(getByIdStmt.get(id));
  },
};

// Bootstrap: without this there's no way to log in on a fresh install
// without hand-writing a SQL INSERT. Only fires when the users table is
// completely empty, so it can't be used to re-create an admin account
// after the fact — set the env vars, start the server once, then remove
// them (or leave them; they only matter when the table is empty).
function bootstrapAdminIfNeeded() {
  if (users.count() > 0) return;
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!email || !password) {
    return { bootstrapped: false };
  }
  users.create({ email, password, role: "admin", name: "Admin" });
  return { bootstrapped: true, email };
}

module.exports = users;
module.exports.bootstrapAdminIfNeeded = bootstrapAdminIfNeeded;
module.exports.DuplicateEmailError = DuplicateEmailError;
