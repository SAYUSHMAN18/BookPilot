const { pool, query } = require("./db");
const { log } = require("../infra/logger");

// Section 8 — every statement here now keys by the pair (tenant_id, wa_id)
// (see db.js's `sessions` table — the same real phone number can have an
// independent in-progress conversation with two different tenants, each
// with their own WhatsApp number).
//
// The one-time legacy sessions.json import that used to live here (from
// this table's own original SQLite migration) is gone — doubly obsolete
// now that the database itself moved from SQLite to Postgres; a file
// predating even the FIRST migration has nothing left to migrate into a
// brand-new Postgres database.

// The in-memory Map's key mirrors the DB's composite key as one string —
// simpler than a Map-of-Maps or a tuple-keyed structure, and this key is
// purely an internal cache detail workflowEngine.js never needs to parse
// back apart (it always has both tenantId and waId in hand already).
function mapKey(tenantId, waId) {
  return `${tenantId}:${waId}`;
}

// Same external shape as before (a Map, loaded once at startup) so
// workflowEngine.js's own state management doesn't need to change —
// only how a single session gets persisted after each message does. Now
// async (Postgres, not node:sqlite) — callers await this once at process
// startup, before the server starts listening.
async function loadSessions() {
  const map = new Map();
  for (const row of await query("SELECT tenant_id, wa_id, data FROM sessions", [])) {
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
async function saveSession(tenantId, waId, sessionData) {
  await pool.query(
    `INSERT INTO sessions (tenant_id, wa_id, data, updated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT(tenant_id, wa_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    [tenantId, waId, JSON.stringify(sessionData), Date.now()]
  );
}

async function deleteSession(tenantId, waId) {
  await pool.query("DELETE FROM sessions WHERE tenant_id = $1 AND wa_id = $2", [tenantId, waId]);
}

module.exports = { loadSessions, saveSession, deleteSession, mapKey };
