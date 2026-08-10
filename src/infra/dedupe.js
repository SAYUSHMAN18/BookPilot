// Meta retries webhook deliveries if it doesn't get a fast 200, which can
// replay the same message. Track recently seen WhatsApp message ids so a
// retry doesn't get processed (and re-sent to the customer) twice.
const seen = new Map(); // messageId -> receivedAt
const TTL_MS = 10 * 60 * 1000;

function isDuplicate(messageId) {
  if (!messageId) return false;

  const now = Date.now();
  for (const [id, ts] of seen) {
    if (now - ts > TTL_MS) seen.delete(id);
  }

  if (seen.has(messageId)) return true;
  seen.set(messageId, now);
  return false;
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
