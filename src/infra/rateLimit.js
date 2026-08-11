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

// Section 14 — the Public API's own limit, keyed by the API key itself
// (not IP — a tenant's real backend server may sit behind a shared
// egress IP with other traffic, and the key is what actually identifies
// the caller here). Generous enough for a real integration's normal
// traffic, tight enough that a misbehaving/compromised key can't hammer
// the DB or burn through this project's own downstream costs (Groq isn't
// on this path, but Razorpay/Google Calendar calls further down a
// booking's lifecycle are).
const API_WINDOW_MS = 60 * 1000;
const API_MAX_PER_WINDOW = 60;
const apiHits = new Map(); // raw API key -> timestamps[] (in-memory only, never persisted or logged)

function isApiRateLimited(rawKey) {
  const now = Date.now();
  const recent = (apiHits.get(rawKey) || []).filter((t) => now - t < API_WINDOW_MS);
  recent.push(now);
  apiHits.set(rawKey, recent);
  return recent.length > API_MAX_PER_WINDOW;
}

// Self-serve signup's own limit — keyed by IP only (there's no account yet
// to key by email/id). Loose enough for a real business to retry a typo'd
// form a few times, tight enough that scripting the public endpoint can't
// mass-create tenants.
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const SIGNUP_MAX_ATTEMPTS = 8;
const signupHits = new Map(); // ip -> timestamps[]

function isSignupRateLimited(ip) {
  const now = Date.now();
  const recent = (signupHits.get(ip) || []).filter((t) => now - t < SIGNUP_WINDOW_MS);
  recent.push(now);
  signupHits.set(ip, recent);
  return recent.length > SIGNUP_MAX_ATTEMPTS;
}

module.exports = { isRateLimited, isLoginRateLimited, isApiRateLimited, isSignupRateLimited };
