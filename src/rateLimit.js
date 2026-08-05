// A single abusive sender shouldn't be able to burn through the Groq quota
// (or spam DB writes) by firing messages as fast as possible. Sliding
// window per WhatsApp id — generous enough that no real conversation would
// ever hit it, tight enough to blunt a flood.
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 20;

const hits = new Map(); // waId -> timestamps[]

function isRateLimited(waId) {
  const now = Date.now();
  const recent = (hits.get(waId) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(waId, recent);
  return recent.length > MAX_PER_WINDOW;
}

module.exports = { isRateLimited };
