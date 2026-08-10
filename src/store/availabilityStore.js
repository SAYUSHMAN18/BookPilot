const { db } = require("./db");

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
const insertStmt = db.prepare(
  "INSERT INTO blocked_slots (tenant_id, workflow_id, provider_id, date, time, end_time, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
);
const deleteByIdStmt = db.prepare("DELETE FROM blocked_slots WHERE id = ? AND tenant_id = ?");
const getByIdStmt = db.prepare("SELECT * FROM blocked_slots WHERE id = ? AND tenant_id = ?");
const listForProviderStmt = db.prepare(
  "SELECT * FROM blocked_slots WHERE tenant_id = ? AND workflow_id = ? AND provider_id = ? ORDER BY date, time"
);
const listForDayStmt = db.prepare("SELECT * FROM blocked_slots WHERE tenant_id = ? AND workflow_id = ? AND provider_id = ? AND date = ?");

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
    createdAt: row.created_at,
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

function blockSlot(tenantId, workflowId, providerId, dateIso, startTime, endTime, reason) {
  insertStmt.run(tenantId, workflowId, providerId, dateIso, startTime || null, endTime || null, reason || null, Date.now());
}

function unblockSlot(tenantId, id) {
  deleteByIdStmt.run(id, tenantId);
}

// Ownership check before delete — a provider must only ever be able to
// remove their own blocks, never one belonging to another provider_id/
// workflow_id/tenant just because they guessed a numeric id.
function getBlockById(tenantId, id) {
  return rowToBlock(getByIdStmt.get(id, tenantId));
}

function listBlocksForProvider(tenantId, workflowId, providerId) {
  return listForProviderStmt.all(tenantId, workflowId, providerId).map(rowToBlock);
}

function isDayBlocked(tenantId, workflowId, providerId, dateIso) {
  return listForDayStmt.all(tenantId, workflowId, providerId, dateIso).some((row) => row.time === null);
}

// Minute-of-day ranges for everything blocked that day (excluding
// whole-day blocks, handled separately by isDayBlocked). A legacy row
// with no end_time — created before ranges existed — is treated as a
// single minute starting at its stored time, preserving "block exactly
// this slot" as the intended meaning for old data.
function blockedRangesForDay(tenantId, workflowId, providerId, dateIso) {
  const ranges = [];
  for (const row of listForDayStmt.all(tenantId, workflowId, providerId, dateIso)) {
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
