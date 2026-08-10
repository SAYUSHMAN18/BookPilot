const { db } = require("./db");

// Section 8 — tenant_id travels with each queued item because the
// background worker (processOutboundQueue, src/infra/whatsapp.js) drains
// ALL tenants' due items in one pass, and each one has to be sent using
// THAT tenant's own WhatsApp credentials (src/store/tenantStore.js), not
// a single global token — every tenant gets their own WhatsApp number.
const insertStmt = db.prepare(
  "INSERT INTO outbound_queue (tenant_id, wa_id, body, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)"
);
const dueStmt = db.prepare("SELECT * FROM outbound_queue WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at ASC LIMIT 20");
const markSentStmt = db.prepare("UPDATE outbound_queue SET status = 'sent' WHERE id = ?");
const markFailedStmt = db.prepare("UPDATE outbound_queue SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?");
const bumpRetryStmt = db.prepare(
  "UPDATE outbound_queue SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE id = ?"
);
const countByStatusStmt = db.prepare("SELECT status, COUNT(*) AS n FROM outbound_queue WHERE tenant_id = ? GROUP BY status");
const listRecentStmt = db.prepare("SELECT * FROM outbound_queue WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50");

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
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

function enqueue(tenantId, waId, body) {
  insertStmt.run(tenantId, waId, body, Date.now(), Date.now());
}

// Deliberately NOT tenant-filtered — the worker's whole job is draining
// every tenant's due items in one pass (see comment above); each returned
// item carries its own tenantId for the caller to pick the right
// credentials with.
function dueItems() {
  return dueStmt.all(Date.now()).map(rowToItem);
}

function markSent(id) {
  markSentStmt.run(id);
}

// Exponential-ish backoff (1m, 2m, 4m, 8m, 16m...) — a WhatsApp API
// outage lasting a few minutes shouldn't burn through all 5 attempts in
// the first thirty seconds.
function backoffMs(attempts) {
  return Math.min(60_000 * 2 ** attempts, 30 * 60_000); // capped at 30 minutes
}

function markFailedAttempt(item, errorMessage) {
  const attempts = item.attempts + 1;
  if (attempts >= item.maxAttempts) {
    markFailedStmt.run(errorMessage, item.id);
  } else {
    bumpRetryStmt.run(Date.now() + backoffMs(attempts), errorMessage, item.id);
  }
}

function statusCounts(tenantId) {
  const counts = { pending: 0, sent: 0, failed: 0 };
  for (const row of countByStatusStmt.all(tenantId)) counts[row.status] = row.n;
  return counts;
}

function listRecent(tenantId) {
  return listRecentStmt.all(tenantId).map(rowToItem);
}

module.exports = { enqueue, dueItems, markSent, markFailedAttempt, statusCounts, listRecent };
