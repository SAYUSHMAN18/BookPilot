const { pool } = require("../store/db");

// Meta retries webhook deliveries if it doesn't get a fast 200, which can
// replay the same message. Track recently seen WhatsApp message ids so a
// retry doesn't get processed (and re-sent to the customer) twice.
//
// Found live (self-audit): this used to be a plain in-process Map — correct
// on a single instance, but silently wrong under more than one (each
// instance's own Map has no idea what the other has already seen, so a
// retry that lands on a different instance than the original delivery gets
// processed — and replied to — a second time), and even ON one instance,
// checking `seen.has(id)` then `seen.set(id, ...)` as two separate
// statements has no atomicity guarantee once this becomes two DB round-trips
// instead of one synchronous Map operation. INSERT ... ON CONFLICT DO
// NOTHING is the fix for both: message_id PRIMARY KEY makes "was this id
// already claimed" and "claim it" one atomic statement, enforced by Postgres
// itself, not by which process happens to ask first.
const TTL_MS = 10 * 60 * 1000;

async function isDuplicate(messageId) {
  if (!messageId) return false;

  const now = Date.now();
  // Pruned inline, same reasoning as rateLimitStore.js's own per-hit prune —
  // this runs once per inbound webhook message, cheap with the index below,
  // and keeps the table from growing unbounded without a separate GC pass.
  await pool.query("DELETE FROM processed_webhook_messages WHERE received_at < $1", [now - TTL_MS]);

  const result = await pool.query(
    "INSERT INTO processed_webhook_messages (message_id, received_at) VALUES ($1, $2) ON CONFLICT (message_id) DO NOTHING RETURNING message_id",
    [messageId, now]
  );
  // 0 rows returned means the ON CONFLICT branch fired — someone (this
  // process or another instance) already claimed this id.
  return result.rowCount === 0;
}

// Section 1.9 investigation: a real transcript appeared to show the same
// reply sent twice (once with emoji, once plain) at several points. Code
// review found no call site where a single logical reply triggers two
// separate sendWhatsApp*() calls — every step in workflowEngine.js sends
// exactly one text/buttons/list message per reply, and isDuplicate() above
// already guards against Meta re-delivering the same INCOMING webhook
// (which would otherwise reprocess and re-send). No genuine duplicate-send
// code path was found; the leading theory is a rendering/export artifact
// in however that transcript was captured, not a bug here — but this
// wasn't reproduced live, so treat it as "investigated, not confirmed"
// rather than closed. Section 5.4's structured logging (message id in,
// every send out) would make a real recurrence provable one way or the
// other in production.

module.exports = { isDuplicate };
