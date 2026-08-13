const crypto = require("crypto");
const { pool, query } = require("./db");

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour — short enough that a leaked-but-unused token is low value

function hashToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

// Returns the raw token — this is the only moment it ever exists outside
// this function's stack. Callers hand it straight to the (simulated)
// email send and never persist it themselves.
async function createResetToken(userId) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4)",
    [userId, hashToken(rawToken), Date.now() + TOKEN_TTL_MS, Date.now()]
  );
  return rawToken;
}

// Single-use: a token that resolves here (valid, unexpired) is marked
// used in the same call, so a second attempt with the identical token —
// whether a retry, a replay, or an attacker who intercepted the link —
// always fails from this point on, not just "shouldn't be tried again."
async function consumeResetToken(rawToken) {
  if (typeof rawToken !== "string" || !rawToken) return null;
  const rows = await query("SELECT * FROM password_reset_tokens WHERE token_hash = $1", [hashToken(rawToken)]);
  const row = rows[0];
  if (!row) return null;
  if (row.used_at) return null;
  if (Number(row.expires_at) < Date.now()) return null;
  await pool.query("UPDATE password_reset_tokens SET used_at = $1 WHERE id = $2", [Date.now(), row.id]);
  return row.user_id;
}

module.exports = { createResetToken, consumeResetToken };
