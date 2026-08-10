const fs = require("fs");
const path = require("path");
const { db } = require("./db");
const { log } = require("../infra/logger");

// Section 8 — every statement here now keys by the pair (tenant_id, wa_id),
// not wa_id alone (see db.js's migrateSessionsCompositeKey() for why: the
// same real phone number can have an independent in-progress conversation
// with two different tenants, each with their own WhatsApp number).
const getAllStmt = db.prepare("SELECT tenant_id, wa_id, data FROM sessions");
const upsertStmt = db.prepare(`
  INSERT INTO sessions (tenant_id, wa_id, data, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(tenant_id, wa_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);
const deleteStmt = db.prepare("DELETE FROM sessions WHERE tenant_id = ? AND wa_id = ?");
const countStmt = db.prepare("SELECT COUNT(*) AS n FROM sessions");

// The in-memory Map's key mirrors the DB's composite key as one string —
// simpler than a Map-of-Maps or a tuple-keyed structure, and this key is
// purely an internal cache detail workflowEngine.js never needs to parse
// back apart (it always has both tenantId and waId in hand already).
function mapKey(tenantId, waId) {
  return `${tenantId}:${waId}`;
}

// One-time import from the legacy JSON file this replaced (Section 5.2)
// — only runs when the new table is completely empty, so it can't ever
// clobber real session data with stale file contents on a later restart.
// Safe to skip entirely on a fresh install (no legacy file to find).
// Every session in that legacy file predates multi-tenancy entirely, so
// it unambiguously belongs to tenant 1 (the default tenant every existing
// install's data was backfilled to — see db.js).
function migrateLegacyJsonFile() {
  if (countStmt.get().n > 0) return;

  const legacyDir = process.env.DATA_DIR || path.join(__dirname, "..", "..", "logs");
  const legacyFile = path.join(legacyDir, "sessions.json");
  let raw;
  try {
    raw = fs.readFileSync(legacyFile, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") log("WARN", `Could not read legacy session file (${err.message}) — starting with no in-progress sessions.`);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log("WARN", `Legacy sessions.json was not valid JSON (${err.message}) — skipping migration.`);
    return;
  }

  const entries = Object.entries(parsed);
  if (entries.length === 0) return;
  const now = Date.now();
  for (const [waId, sessionData] of entries) {
    upsertStmt.run(1, waId, JSON.stringify(sessionData), now);
  }
  log("INFO", `Migrated ${entries.length} in-progress session(s) from the legacy sessions.json into SQLite (tenant: default).`);
}
migrateLegacyJsonFile();

// Same external shape as before (a Map, loaded once at startup) so
// workflowEngine.js's own state management doesn't need to change —
// only how a single session gets persisted after each message does.
function loadSessions() {
  const map = new Map();
  for (const row of getAllStmt.all()) {
    try {
      map.set(mapKey(row.tenant_id, row.wa_id), JSON.parse(row.data));
    } catch (err) {
      log("WARN", `Skipping corrupt session row for tenant ${row.tenant_id}/${row.wa_id}: ${err.message}`);
    }
  }
  return map;
}

// Upserts exactly one customer's session — the point of the whole
// migration. Called once per message with just the (tenantId, waId) that
// changed, not the entire in-memory Map, which is what makes two
// different customers' sessions safe to update concurrently from two
// processes.
function saveSession(tenantId, waId, sessionData) {
  upsertStmt.run(tenantId, waId, JSON.stringify(sessionData), Date.now());
}

function deleteSession(tenantId, waId) {
  deleteStmt.run(tenantId, waId);
}

module.exports = { loadSessions, saveSession, deleteSession, mapKey };
