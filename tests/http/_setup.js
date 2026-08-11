// Item 2 — shared setup for HTTP-level (supertest) route tests. Same
// fresh-temp-DB-per-run + require-cache-busting pattern every other test
// file in this suite already uses (see tests/integration/multiTenant.test.js)
// — a real SQLite file per test run, not a mock, so these tests exercise
// the exact same store/engine code a real request would.
//
// Deliberately a function, not module-scope work — server.js reads several
// of these env vars (SESSION_SECRET, APP_ENCRYPTION_KEY, WHATSAPP_APP_SECRET)
// at require() time, so each test FILE needs its own fresh env + cache-bust
// before requiring server.js, not a single shared setup all files import.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

// Each freshApp() call re-requires server.js fresh (needed for per-test DB
// isolation — see below), and server.js registers its crash-safety
// process.on('uncaughtException'/'unhandledRejection'/...) listeners at
// module scope every time it's loaded. In real production that only ever
// happens once; here, one Node process runs every test in this file (and,
// under `node --test`, potentially this whole directory), so those
// listeners genuinely accumulate run over run. Raising the cap is a
// test-environment-only accommodation — production is unaffected, since
// nothing here runs unless this file itself is loaded.
process.setMaxListeners(50);

// Set to an empty string, never delete()'d — server.js does
// `require("dotenv").config()` at module load, and dotenv only fills in a
// key that's ABSENT from process.env; a deleted key looks absent and gets
// silently repopulated from the developer's own real .env on the very
// next freshApp() call (found live: a first version of this file used
// delete() and every "isolated" test was actually making real Groq and
// WhatsApp Graph API calls with real credentials). Every falsy-check in
// this codebase (`if (!token)`, `if (!process.env.X)`) treats "" exactly
// like undefined, so this keeps the app's own behavior identical while
// defeating dotenv's fill-in.
function blank(...keys) {
  for (const k of keys) process.env[k] = "";
}

function freshApp({ webhookAppSecret } = {}) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bookpilot-http-test-"));
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.APP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";
  process.env.WHATSAPP_APP_SECRET = webhookAppSecret || "";
  // Never let a real outbound call happen from a test run — no WhatsApp
  // creds means every send falls back to logging a "[SIMULATED ...]" line
  // instead (src/infra/whatsapp.js's own documented behavior), same as
  // every other test in this suite that exercises workflowEngine.
  blank("WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID");
  blank("GROQ_API_KEY"); // deterministic keyword-fallback classification, not a live AI call
  // Real bootstrap credentials living in the developer's own .env would
  // otherwise bootstrap a real-looking admin into every fresh test DB —
  // harmless (different DB, different email than any test uses) but
  // noisy and not what these tests are about.
  blank("ADMIN_BOOTSTRAP_EMAIL", "ADMIN_BOOTSTRAP_PASSWORD", "PLATFORM_ADMIN_BOOTSTRAP_EMAIL", "PLATFORM_ADMIN_BOOTSTRAP_PASSWORD");
  // Same leak risk for every other external integration this codebase
  // has — none of these HTTP tests are about Razorpay/Calendar/Sarvam,
  // so keep them all in their documented "not configured" fallback mode.
  blank("RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "SARVAM_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");
  // /api/simulate-whatsapp is auto-enabled whenever WHATSAPP_APP_SECRET is
  // unset (server.js's own simulateEndpointEnabled logic) — true by
  // default here, so no extra flag needed unless a test explicitly sets
  // webhookAppSecret AND still wants simulate enabled too.
  process.env.ALLOW_SIMULATE_ENDPOINT = webhookAppSecret ? "true" : "";

  for (const mod of [
    "../../server",
    "../../src/store/db",
    "../../src/store/tenantStore",
    "../../src/store/bookingStore",
    "../../src/store/userStore",
    "../../src/store/sessionStore",
    "../../src/store/availabilityStore",
    "../../src/store/signupOtpStore",
    "../../src/infra/rateLimit",
    "../../src/engine/workflowEngine",
    "../../src/engine/loadWorkflows",
    // Real bug, found live: any engine module that caches a require()'d
    // store reference at module scope (const bookings = require(...) at
    // the top of the file, not inside each function) holds onto that
    // FIRST freshApp() call's db connection forever unless it's busted
    // here too — src/engine/billing.js's usage counts were silently
    // reading from the wrong (stale, first-test's) database for every
    // freshApp() after the first one in the same file. workflowEngine.js
    // above already needed this same fix; these three have the identical
    // shape and would hit the identical bug the moment a test file uses
    // more than one tenant across more than one freshApp() call.
    "../../src/engine/billing",
    "../../src/engine/analytics",
    "../../src/engine/calendarSync",
    "../../src/engine/paymentRefunds",
    "../../src/infra/reminders",
  ]) {
    try {
      delete require.cache[require.resolve(mod)];
    } catch {
      // not loaded yet — fine
    }
  }

  return require("../../server");
}

// New plan, Section 2 — signup no longer grants instant dashboard access:
// a fresh tenant is "pending" until a platform_admin activates it, and
// POST /api/signup itself now requires a verified OTP. Every test in this
// suite that just needs a working logged-in admin (not specifically
// testing the OTP/activation flow itself, which is auth.test.js's job)
// uses this instead of hand-rolling the dance: generates a real OTP
// directly via signupOtpStore (bypassing the request-otp HTTP round trip,
// since the point here is a fast, valid fixture, not re-testing that
// route), signs up, then activates directly via tenantStore.setStatus
// (bypassing the platform_admin HTTP layer for the same reason).
async function signupAndActivate(app, request, { businessName, email, password = "password123", ownerName } = {}) {
  const { createOtp } = require("../../src/store/signupOtpStore");
  const tenantStore = require("../../src/store/tenantStore");
  const otp = createOtp(email);
  const resp = await request(app).post("/api/signup").send({ businessName, ownerName, email, password, otp });
  if (resp.status !== 201) {
    throw new Error(`signupAndActivate: POST /api/signup failed (${resp.status}): ${JSON.stringify(resp.body)}`);
  }
  const tenantId = resp.body.user.tenantId;
  tenantStore.setStatus(tenantId, "active");
  return { cookie: resp.headers["set-cookie"], tenantId };
}

module.exports = { freshApp, signupAndActivate };
