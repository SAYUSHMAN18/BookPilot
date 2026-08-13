const { pool, query } = require("./db");

// Section 8 — tenant_id travels with each queued item because the
// background worker (processOutboundQueue, src/infra/whatsapp.js) drains
// ALL tenants' due items in one pass, and each one has to be sent using
// THAT tenant's own WhatsApp credentials (src/store/tenantStore.js), not
// a single global token — every tenant gets their own WhatsApp number.

function rowToItem(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    waId: row.wa_id,
    body: row.body,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    status: row.status,
    nextAttemptAt: Number(row.next_attempt_at),
    lastError: row.last_error,
    createdAt: Number(row.created_at),
  };
}

async function enqueue(tenantId, waId, body) {
  await pool.query(
    "INSERT INTO outbound_queue (tenant_id, wa_id, body, next_attempt_at, created_at) VALUES ($1, $2, $3, $4, $5)",
    [tenantId, waId, body, Date.now(), Date.now()]
  );
}

// Deliberately NOT tenant-filtered — the worker's whole job is draining
// every tenant's due items in one pass (see comment above); each returned
// item carries its own tenantId for the caller to pick the right
// credentials with.
async function dueItems() {
  const rows = await query("SELECT * FROM outbound_queue WHERE status = 'pending' AND next_attempt_at <= $1 ORDER BY created_at ASC LIMIT 20", [Date.now()]);
  return rows.map(rowToItem);
}

async function markSent(id) {
  await pool.query("UPDATE outbound_queue SET status = 'sent' WHERE id = $1", [id]);
}

// Exponential-ish backoff (1m, 2m, 4m, 8m, 16m...) — a WhatsApp API
// outage lasting a few minutes shouldn't burn through all 5 attempts in
// the first thirty seconds.
function backoffMs(attempts) {
  return Math.min(60_000 * 2 ** attempts, 30 * 60_000); // capped at 30 minutes
}

async function markFailedAttempt(item, errorMessage) {
  const attempts = item.attempts + 1;
  if (attempts >= item.maxAttempts) {
    await pool.query("UPDATE outbound_queue SET status = 'failed', attempts = attempts + 1, last_error = $1 WHERE id = $2", [errorMessage, item.id]);
  } else {
    await pool.query(
      "UPDATE outbound_queue SET attempts = attempts + 1, next_attempt_at = $1, last_error = $2 WHERE id = $3",
      [Date.now() + backoffMs(attempts), errorMessage, item.id]
    );
  }
}

async function statusCounts(tenantId) {
  const counts = { pending: 0, sent: 0, failed: 0 };
  // COUNT(*) returns a Postgres `bigint`, parsed as a STRING by the `pg`
  // driver by default (unlike node:sqlite) — Number() it before storing.
  for (const row of await query("SELECT status, COUNT(*) AS n FROM outbound_queue WHERE tenant_id = $1 GROUP BY status", [tenantId])) {
    counts[row.status] = Number(row.n);
  }
  return counts;
}

async function listRecent(tenantId) {
  const rows = await query("SELECT * FROM outbound_queue WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50", [tenantId]);
  return rows.map(rowToItem);
}

module.exports = { enqueue, dueItems, markSent, markFailedAttempt, statusCounts, listRecent };
