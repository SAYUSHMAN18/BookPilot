const { db } = require("./db");

// What a provider manually blocks off from their dashboard (a day off, a
// lunch break, maintenance on a room) — separate from `bookings`, which is
// what customers have actually reserved. Both get excluded from the slots
// offered on WhatsApp, but they mean different things and a provider only
// manages their own blocks, never anyone's booking.
const insertStmt = db.prepare(
  "INSERT INTO blocked_slots (workflow_id, provider_id, date, time, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)"
);
const deleteByIdStmt = db.prepare("DELETE FROM blocked_slots WHERE id = ?");
const getByIdStmt = db.prepare("SELECT * FROM blocked_slots WHERE id = ?");
const listForProviderStmt = db.prepare(
  "SELECT * FROM blocked_slots WHERE workflow_id = ? AND provider_id = ? ORDER BY date, time"
);
const listForDayStmt = db.prepare("SELECT * FROM blocked_slots WHERE workflow_id = ? AND provider_id = ? AND date = ?");

function rowToBlock(row) {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    providerId: row.provider_id,
    date: row.date,
    time: row.time, // null = whole day blocked
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function blockSlot(workflowId, providerId, dateIso, time, reason) {
  insertStmt.run(workflowId, providerId, dateIso, time || null, reason || null, Date.now());
}

function unblockSlot(id) {
  deleteByIdStmt.run(id);
}

// Ownership check before delete — a provider must only ever be able to
// remove their own blocks, never one belonging to another provider_id/
// workflow_id just because they guessed a numeric id.
function getBlockById(id) {
  return rowToBlock(getByIdStmt.get(id));
}

function listBlocksForProvider(workflowId, providerId) {
  return listForProviderStmt.all(workflowId, providerId).map(rowToBlock);
}

function isDayBlocked(workflowId, providerId, dateIso) {
  return listForDayStmt.all(workflowId, providerId, dateIso).some((row) => row.time === null);
}

function blockedTimesForDay(workflowId, providerId, dateIso) {
  const times = new Set();
  for (const row of listForDayStmt.all(workflowId, providerId, dateIso)) {
    if (row.time !== null) times.add(row.time);
  }
  return times;
}

module.exports = { blockSlot, unblockSlot, getBlockById, listBlocksForProvider, isDayBlocked, blockedTimesForDay };
