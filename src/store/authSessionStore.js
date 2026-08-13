const { pool, query } = require("./db");

// New plan, Block 14 — see db.js's own comment on auth_sessions for the
// "why a table when tokens are already stateless" reasoning. Every
// query here is scoped by user_id wherever a caller could otherwise
// touch someone else's session by guessing a session id — the exact
// same discipline every other per-account store in this codebase
// already follows.

function rowToSession(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    userId: row.user_id,
    userAgent: row.user_agent,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  };
}

const authSessions = {
  async create(sessionId, userId, expiresAt, userAgent) {
    await pool.query(
      "INSERT INTO auth_sessions (id, user_id, user_agent, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)",
      [sessionId, userId, userAgent || null, Date.now(), expiresAt]
    );
  },

  // A session with no row here at all (e.g. a token issued before this
  // table existed) is treated as NOT revoked — the token's own signature
  // and expiry are still what actually gate access; this is an
  // additional check, not the only one.
  async isRevoked(sessionId) {
    const rows = await query("SELECT revoked_at FROM auth_sessions WHERE id = $1", [sessionId]);
    return !!rows[0]?.revoked_at;
  },

  /** @param {string} sessionId @param {number} userId — a user can only revoke their OWN session */
  async revoke(sessionId, userId) {
    await pool.query(
      "UPDATE auth_sessions SET revoked_at = $1 WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL",
      [Date.now(), sessionId, userId]
    );
  },

  // "Log out everywhere" / a platform_admin force-logging-out a
  // compromised account — every one of that user's currently-active
  // sessions stops working on its very next request.
  async revokeAllForUser(userId) {
    await pool.query("UPDATE auth_sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL", [Date.now(), userId]);
  },

  async listForUser(userId) {
    const rows = await query(
      "SELECT * FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2 ORDER BY created_at DESC",
      [userId, Date.now()]
    );
    return rows.map(rowToSession);
  },
};

module.exports = authSessions;
