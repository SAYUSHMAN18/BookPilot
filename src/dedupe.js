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

module.exports = { isDuplicate };
