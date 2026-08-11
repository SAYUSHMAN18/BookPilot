const { db } = require("./db");

// New plan, Block 14 — see db.js's own comment on auth_sessions for the
// "why a table when tokens are already stateless" reasoning. Every
// query here is scoped by user_id wherever a caller could otherwise
// touch someone else's session by guessing a session id — the exact
// same discipline every other per-account store in this codebase
// already follows.
const insertStmt = db.prepare(
  "INSERT INTO auth_sessions (id, user_id, user_agent, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
);
const isRevokedStmt = db.prepare("SELECT revoked_at FROM auth_sessions WHERE id = ?");
const revokeStmt = db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL");
const revokeAllForUserStmt = db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL");
const listForUserStmt = db.prepare(
  "SELECT * FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC"
);

function rowToSession(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    userId: row.user_id,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

const authSessions = {
  create(sessionId, userId, expiresAt, userAgent) {
    insertStmt.run(sessionId, userId, userAgent || null, Date.now(), expiresAt);
  },

  // A session with no row here at all (e.g. a token issued before this
  // table existed) is treated as NOT revoked — the token's own signature
  // and expiry are still what actually gate access; this is an
  // additional check, not the only one.
  isRevoked(sessionId) {
    const row = isRevokedStmt.get(sessionId);
    return !!row?.revoked_at;
  },

  /** @param {string} sessionId @param {number} userId — a user can only revoke their OWN session */
  revoke(sessionId, userId) {
    revokeStmt.run(Date.now(), sessionId, userId);
  },

  // "Log out everywhere" / a platform_admin force-logging-out a
  // compromised account — every one of that user's currently-active
  // sessions stops working on its very next request.
  revokeAllForUser(userId) {
    revokeAllForUserStmt.run(Date.now(), userId);
  },

  listForUser(userId) {
    return listForUserStmt.all(userId, Date.now()).map(rowToSession);
  },
};

module.exports = authSessions;
