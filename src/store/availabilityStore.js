const { pool, query } = require("./db");

// What a provider manually blocks off from their dashboard (a day off, a
// lunch break, maintenance on a room) — separate from `bookings`, which is
// what customers have actually reserved. Both get excluded from the slots
// offered on WhatsApp, but they mean different things and a provider only
// manages their own blocks, never anyone's booking.
//
// Section 8 — every query filters by tenant_id, and getBlockById/unblockSlot
// filter by (id, tenant_id) together so a provider from one tenant can
// never read or delete a block belonging to another tenant just by
// guessing/probing a numeric id.

function rowToBlock(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workflowId: row.workflow_id,
    providerId: row.provider_id,
    date: row.date,
    time: row.time, // null = whole day blocked; the range's start (24h "HH:MM") otherwise
    endTime: row.end_time, // null on a pre-range-support row = "just this one slot"
    reason: row.reason,
    createdAt: Number(row.created_at),
  };
}

// Everything below compares in minute-of-day integers, not strings — the
// only way to make range overlap ([start, end)) correct, and what
// happened to also fix a real pre-existing bug: blocked_slots.time was
// stored 24h ("09:30", straight from <input type="time">) while the
// WhatsApp-facing slots are generated and matched as 12h labels ("9:30
// am"), so the old exact-string comparison could never succeed — single
// -slot blocking never actually excluded anything from the bot.
function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

async function blockSlot(tenantId, workflowId, providerId, dateIso, startTime, endTime, reason) {
  await pool.query(
    "INSERT INTO blocked_slots (tenant_id, workflow_id, provider_id, date, time, end_time, reason, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [tenantId, workflowId, providerId, dateIso, startTime || null, endTime || null, reason || null, Date.now()]
  );
}

async function unblockSlot(tenantId, id) {
  await pool.query("DELETE FROM blocked_slots WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
}

// Ownership check before delete — a provider must only ever be able to
// remove their own blocks, never one belonging to another provider_id/
// workflow_id/tenant just because they guessed a numeric id.
async function getBlockById(tenantId, id) {
  const rows = await query("SELECT * FROM blocked_slots WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
  return rowToBlock(rows[0]);
}

async function listBlocksForProvider(tenantId, workflowId, providerId) {
  const rows = await query(
    "SELECT * FROM blocked_slots WHERE tenant_id = $1 AND workflow_id = $2 AND provider_id = $3 ORDER BY date, time",
    [tenantId, workflowId, providerId]
  );
  return rows.map(rowToBlock);
}

async function listForDay(tenantId, workflowId, providerId, dateIso) {
  return query(
    "SELECT * FROM blocked_slots WHERE tenant_id = $1 AND workflow_id = $2 AND provider_id = $3 AND date = $4",
    [tenantId, workflowId, providerId, dateIso]
  );
}

async function isDayBlocked(tenantId, workflowId, providerId, dateIso) {
  const rows = await listForDay(tenantId, workflowId, providerId, dateIso);
  return rows.some((row) => row.time === null);
}

// Minute-of-day ranges for everything blocked that day (excluding
// whole-day blocks, handled separately by isDayBlocked). A legacy row
// with no end_time — created before ranges existed — is treated as a
// single minute starting at its stored time, preserving "block exactly
// this slot" as the intended meaning for old data.
async function blockedRangesForDay(tenantId, workflowId, providerId, dateIso) {
  const ranges = [];
  for (const row of await listForDay(tenantId, workflowId, providerId, dateIso)) {
    if (row.time === null) continue;
    const startMin = timeToMinutes(row.time);
    const endMin = row.end_time ? timeToMinutes(row.end_time) : startMin + 1;
    ranges.push({ startMin, endMin, id: row.id, reason: row.reason });
  }
  return ranges;
}

module.exports = {
  blockSlot,
  unblockSlot,
  getBlockById,
  listBlocksForProvider,
  isDayBlocked,
  blockedRangesForDay,
  timeToMinutes,
};
