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

// Separate, much stricter window for login attempts — this one guards
// against password guessing, not chat spam, so it's keyed by IP+email
// rather than WhatsApp id and trips at a much lower count.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const loginHits = new Map(); // key (ip:email) -> timestamps[]

function isLoginRateLimited(key) {
  const now = Date.now();
  const recent = (loginHits.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  recent.push(now);
  loginHits.set(key, recent);
  return recent.length > LOGIN_MAX_ATTEMPTS;
}

module.exports = { isRateLimited, isLoginRateLimited };
