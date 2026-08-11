const crypto = require("crypto");
const { db } = require("./db");

// New plan, Section 2 — same single-use, hashed-at-rest discipline
// src/store/passwordResetStore.js already established, adapted for a
// typed-back 6-digit code instead of a clicked link: 10-minute expiry,
// and requesting a new code for the same email invalidates any earlier
// unused one (so only the most recently sent code ever works — a customer
// who requests twice, e.g. because the first "email" seemed slow, isn't
// left wondering which code is the real one).
const CODE_TTL_MS = 10 * 60 * 1000;

const invalidateStmt = db.prepare("UPDATE signup_otps SET used_at = ? WHERE email = ? AND used_at IS NULL");
const insertStmt = db.prepare("INSERT INTO signup_otps (email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)");
const findLatestStmt = db.prepare(
  "SELECT * FROM signup_otps WHERE email = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1"
);
const markUsedStmt = db.prepare("UPDATE signup_otps SET used_at = ? WHERE id = ?");

function hashCode(email, rawCode) {
  return crypto.createHash("sha256").update(`${email.toLowerCase()}:${rawCode}`).digest("hex");
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

// Returns the raw 6-digit code — this is the only moment it ever exists
// outside this function's stack. The caller hands it straight to the
// (simulated) email send and never persists it.
function createOtp(email) {
  const normalized = normalizeEmail(email);
  const now = Date.now();
  invalidateStmt.run(now, normalized);
  const rawCode = String(crypto.randomInt(100000, 1000000)); // always 6 digits
  insertStmt.run(normalized, hashCode(normalized, rawCode), now + CODE_TTL_MS, now);
  return rawCode;
}

// Single-use, same reasoning as consumeResetToken: a code that resolves
// here (matching, unused, unexpired) is marked used in the same call, so
// a replay of the exact same code always fails from this point on.
function verifyOtp(email, rawCode) {
  if (typeof rawCode !== "string" || !rawCode.trim()) return false;
  const normalized = normalizeEmail(email);
  const row = findLatestStmt.get(normalized);
  if (!row) return false;
  if (row.expires_at < Date.now()) return false;
  if (row.code_hash !== hashCode(normalized, rawCode.trim())) return false;
  markUsedStmt.run(Date.now(), row.id);
  return true;
}

module.exports = { createOtp, verifyOtp };
