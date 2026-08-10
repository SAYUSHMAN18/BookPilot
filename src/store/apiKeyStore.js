const crypto = require("crypto");
const { db } = require("./db");

// Section 14 — API keys for the Public API (src/routes... actually
// server.js's /api/v1/* routes), distinct from the dashboard's session
// cookies. `bpk_` prefix (BookPilot Key) makes a leaked key recognizable
// in logs/scans, the same convention Stripe/GitHub/etc. use for exactly
// this reason. Hashed with plain SHA-256 (not scrypt/bcrypt) deliberately
// — unlike a human password, this is already a cryptographically random
// 32-byte value, not a low-entropy secret an attacker could feasibly
// brute-force even from the hash alone, so a slow KDF buys nothing here
// and would only slow down legitimate verification on every API call.
const KEY_PREFIX = "bpk_";

const insertStmt = db.prepare(
  "INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)"
);
const listStmt = db.prepare("SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC");
const getByIdStmt = db.prepare("SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?");
const getByHashStmt = db.prepare("SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL");
const revokeStmt = db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND tenant_id = ?");
const touchStmt = db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?");

function hashKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

function rowToKey(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revoked: !!row.revoked_at,
  };
}

const apiKeys = {
  // Returns { key, record } — `key` (the real bpk_... secret) is the ONLY
  // time it's ever available in plaintext; the caller must show it to the
  // admin now and never again. `record` is the safe, storable view.
  create(tenantId, name) {
    const rawKey = KEY_PREFIX + crypto.randomBytes(24).toString("base64url");
    const keyHash = hashKey(rawKey);
    const keyPrefix = rawKey.slice(0, 12);
    const now = Date.now();
    const result = insertStmt.run(tenantId, name, keyPrefix, keyHash, now);
    return { key: rawKey, record: rowToKey(getByIdStmt.get(result.lastInsertRowid, tenantId)) };
  },

  listForTenant(tenantId) {
    return listStmt.all(tenantId).map(rowToKey);
  },

  revoke(tenantId, id) {
    revokeStmt.run(Date.now(), id, tenantId);
  },

  // Verifies a raw key presented on an incoming Public API request and
  // returns the owning tenantId, or null if it's unknown/revoked. Never
  // throws on a malformed key — an attacker's garbage input is a normal,
  // expected case here, not a crash.
  verify(rawKey) {
    if (typeof rawKey !== "string" || !rawKey.startsWith(KEY_PREFIX)) return null;
    const row = getByHashStmt.get(hashKey(rawKey));
    if (!row) return null;
    touchStmt.run(Date.now(), row.id);
    return row.tenant_id;
  },
};

module.exports = apiKeys;
