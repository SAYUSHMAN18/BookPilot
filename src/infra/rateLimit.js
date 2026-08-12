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

// Found live: a rate-limited sender got total silence with no way to know
// why the bot went quiet — the one deliberately-silent path in an
// otherwise "always reply" codebase. A notice fixes that, but the notice
// itself must not become a second flood: isRateLimited() stays true for
// every message over the limit for the rest of the window, so sending a
// text on each of those would just replace one kind of spam with another.
// This tracks "have we already told this sender" separately and caps it
// to once per window — the first over-limit message in a flood gets a
// notice, the rest of that same flood stay genuinely silent, same as before.
const notified = new Map(); // waId -> last-notified timestamp
function shouldNotifyRateLimit(waId) {
  const now = Date.now();
  const last = notified.get(waId);
  if (last && now - last < WINDOW_MS) return false;
  notified.set(waId, now);
  return true;
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

// Item 8 — the public marketing site's live chat widget (POST
// /api/demo/chat) is unauthenticated by design (anyone should be able to
// try the bot with zero signup) and always targets one shared, dedicated
// demo tenant — which makes it the one endpoint in this app where a
// single IP could otherwise burn through this project's own Groq quota,
// or spam DB writes, just by scripting requests. Keyed by IP (there's no
// account or WhatsApp id yet), generous enough for a real person actually
// trying the demo conversation, tight enough to blunt a script.
const DEMO_CHAT_WINDOW_MS = 5 * 60 * 1000;
const DEMO_CHAT_MAX_PER_WINDOW = 30;
const demoChatHits = new Map(); // ip -> timestamps[]

function isDemoChatRateLimited(ip) {
  const now = Date.now();
  const recent = (demoChatHits.get(ip) || []).filter((t) => now - t < DEMO_CHAT_WINDOW_MS);
  recent.push(now);
  demoChatHits.set(ip, recent);
  return recent.length > DEMO_CHAT_MAX_PER_WINDOW;
}

// New plan, Section 2 — OTP requests, keyed by the target email (not IP —
// the thing actually worth limiting is "how many codes get generated for
// one inbox," since that's both the abuse vector, spamming someone else's
// real email with codes, and the cost driver, one simulated/real send per
// request). Loose enough for a genuine retry ("didn't arrive, resend"),
// tight enough that scripting this endpoint can't mass-generate codes.
const OTP_WINDOW_MS = 10 * 60 * 1000;
const OTP_MAX_PER_WINDOW = 5;
const otpHits = new Map(); // normalized email -> timestamps[]

function isOtpRateLimited(email) {
  const now = Date.now();
  const key = email.trim().toLowerCase();
  const recent = (otpHits.get(key) || []).filter((t) => now - t < OTP_WINDOW_MS);
  recent.push(now);
  otpHits.set(key, recent);
  return recent.length > OTP_MAX_PER_WINDOW;
}

module.exports = { isRateLimited, shouldNotifyRateLimit, isLoginRateLimited, isApiRateLimited, isSignupRateLimited, isDemoChatRateLimited, isOtpRateLimited };
