/**
 * BookPilot AI — WhatsApp booking bot powered by a config-driven Dynamic
 * Workflow Engine.
 * -------------------------------------------------------------------------
 * Customer sends a free-text requirement on WhatsApp
 *   -> AI (Groq, free tier) classifies it into a business/workflow
 *      (defined by the JSON files in workflows/ — add a new industry
 *      there, no code changes needed)
 *   -> the workflow's own steps drive the rest of the conversation
 *      (pick a provider/service via a tappable list/buttons, collect
 *      whatever fields that industry needs, confirm)
 *
 * Two ways to run this:
 *   1. Real WhatsApp — set WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
 *      WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET in .env and point Meta's
 *      webhook at POST https://<your-public-url>/webhook (see README).
 *   2. Local testing without a real WhatsApp number — POST to
 *      /api/simulate-whatsapp with { "from": "<any id>", "text": "..." }.
 *      Replies are printed to the console/log file instead of sent
 *      over WhatsApp when WHATSAPP_TOKEN isn't configured yet.
 */

require("dotenv").config();
const express = require("express");
const { log } = require("./src/infra/logger");

// Section 15 — process-level crash safety, registered before anything
// else runs. Two genuinely different failure modes, handled differently
// on purpose:
//
// unhandledRejection: an async operation somewhere failed and nothing
// awaited/caught it. Every route handler in this app already goes
// through asyncHandler (see below) specifically so a rejected promise
// inside a REQUEST becomes a normal caught error, not this — so a
// rejection reaching here means it happened outside any request (a
// fire-and-forget call, a background job) or in code this pass missed.
// Logged loudly; the process keeps running, since Express's own
// per-request isolation means one such rejection didn't corrupt shared
// state the way a synchronous crash could.
//
// uncaughtException: a synchronous throw escaped every try/catch on the
// call stack. Node's own guidance is explicit here — the process is now
// in an undefined state, and continuing to serve requests from it risks
// silent corruption or a worse crash later. Logged with full detail, then
// the process exits (code 1) so a process manager (systemd, pm2, a
// container orchestrator's restart policy) can bring up a clean instance,
// which is a real, working recovery path this app already assumes exists
// (documented in README's production-readiness section).
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log("ERROR", `Unhandled promise rejection: ${err.stack || err.message}`);
});
process.on("uncaughtException", (err) => {
  log("ERROR", `Uncaught exception — exiting so a process manager can restart cleanly: ${err.stack || err.message}`);
  process.exit(1);
});
const users = require("./src/store/userStore");
const tenantStore = require("./src/store/tenantStore");
const { runBackup, scheduleBackups } = require("./src/infra/backupStore");
const { scheduleReminders } = require("./src/infra/reminders");
const { startOutboundQueueWorker } = require("./src/infra/whatsapp");
const { UPLOAD_DIR } = require("./src/infra/uploads");
const { runWithRequestId, newRequestId } = require("./src/infra/tracing");


const app = express();
app.disable("x-powered-by");


// Section 15 — the very first middleware, ahead of even the security
// headers below: every log() call anywhere in this request's lifecycle
// (including ones several async hops deep — a Groq call, a DB write, a
// WhatsApp send) needs the same requestId in scope for src/infra/logger.js
// to pick up automatically (see src/infra/tracing.js). X-Request-Id is
// also returned to the caller — genuinely useful for a tenant's own
// Public API integration (Section 14) to reference in a support request.
app.use((req, res, next) => {
  const requestId = newRequestId();
  res.setHeader("X-Request-Id", requestId);
  runWithRequestId(next, requestId);
});

// Express 4 (what this project uses) has no built-in awareness of
// async/await — a rejected promise inside an `async (req, res) => {...}`
// handler does NOT reach the error-handling middleware below the way a
// synchronous throw does; it becomes an unhandled rejection instead, and
// the client is left waiting on a response that will never come. Found
// live: a ReferenceError inside the bookings PATCH route hung a curl
// call for the full 2-minute timeout with nothing ever sent back. Every
// async route handler needs this wrapper (or its own complete try/catch)
// or it's vulnerable to the exact same silent hang.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Capture the raw body alongside the parsed one — signature verification
// needs to HMAC the exact bytes Meta sent, not a re-serialized version.
// Explicit size cap (Express defaults to 100kb anyway, but stating it here
// makes the limit an intentional, auditable decision rather than an
// implicit default — a booking webhook payload is never legitimately large.
app.use(express.json({ limit: "100kb", verify: (req, res, buf) => { req.rawBody = buf; } }));

// Only trust X-Forwarded-* headers when explicitly told to — required for
// req.ip (the login rate limiter's key) and the Secure-cookie decision to
// be correct behind a real reverse proxy, but blindly trusting them with
// no proxy in front would let a client spoof its own IP in that header and
// walk straight through the rate limiter. Set TRUST_PROXY=1 in .env once
// there's an actual reverse proxy (nginx, a load balancer, etc.) in front.
if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY);

// Baseline security headers — small enough to hand-roll rather than add
// a dependency for. The dashboard is the only HTML page this server
// serves, and it renders no third-party scripts/styles beyond Google
// Fonts, so the CSP can stay tight.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  // Section 12 — only sent once this actually runs behind HTTPS (same
  // NODE_ENV==='production' signal setSessionCookie() already uses for
  // the cookie's own Secure flag) — sending it over plain HTTP would be
  // a no-op at best, and asserting HTTPS-only on a host that doesn't
  // serve it would be actively wrong. 1 year + preload-eligible, the
  // standard conservative choice once a domain is HTTPS-only for good.
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  // style-src needs 'unsafe-inline' because the React app renders plenty of
  // style={{...}} attributes (compiled to inline style="" on the DOM) — CSS
  // can't inject executable script, so this is a much smaller concession
  // than script-src would be. script-src itself has no 'unsafe-inline': the
  // built app (public/app/) and marketing site both load JS from external
  // files only (Item 4 removed the last inline <script> block, in the
  // now-deleted public/dashboard.html), so an injected inline <script> is
  // actually blocked here, not just discouraged.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      // img-src widened from 'self' data: to also allow https: — admins can
      // paste an arbitrary externally-hosted image URL for a provider (no
      // upload/storage infra of our own), and the business-location map
      // picker pulls its tiles from OpenStreetMap's tile servers. Both are
      // just <img> loads, so this is the narrowest widening that covers them.
      "font-src https://fonts.gstatic.com; img-src 'self' data: https:; script-src 'self'; " +
      "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'"
  );
  next();
});

const PORT = process.env.PORT || 8081;

// Item 8 — the public marketing site's live chat widget (POST
// /api/demo/chat) needs somewhere to run real conversations that isn't
// any actual customer's business. A dedicated, permanent tenant — created
// once (idempotent via its well-known slug, safe to call on every boot)
// and never assigned real WhatsApp credentials, so its sends always stay
// in simulated/logged mode regardless of what any real tenant on this
// install has configured. Never the upgrade-continuity fallback tenant
// (id 1) — a real single-tenant install's actual business could BE
// tenant 1, and a public demo visitor must never be able to touch it.
const DEMO_TENANT_SLUG = "bookpilot-live-demo";
function ensureDemoTenant() {
  const existing = tenantStore.getBySlug(DEMO_TENANT_SLUG);
  // tenantStore.create() always starts a tenant "pending" (every tenant
  // needs a platform_admin to explicitly activate it — see requireAuth()'s
  // own comment). The demo tenant never has a real user logging in
  // through it, so "pending" would just be permanent, meaningless clutter
  // in a platform admin's activation queue — force it active on every
  // boot, not just at creation, so an install that already had this
  // tenant from before this check existed gets corrected too.
  if (existing) {
    if (existing.status !== "active") tenantStore.setStatus(existing.id, "active");
    return existing.id;
  }
  const created = tenantStore.create({ name: "BookPilot AI — Live Demo", slug: DEMO_TENANT_SLUG, plan: "free" });
  tenantStore.setStatus(created.id, "active");
  log("INFO", `Created dedicated demo tenant (id ${created.id}) for the public marketing chat widget.`);
  return created.id;
}
const DEMO_TENANT_ID = ensureDemoTenant();

// Item 5 previously backfilled every tenant with the workflows/*.json demo
// catalog (hair/hotel/makeup/medical/service) on every boot, and both
// signup routes below seeded it for every brand new tenant too. That's
// deliberately gone now: a tenant's admin lists their OWN real businesses
// by hand from the dashboard (Manage Businesses — POST /api/dashboard/
// workflows), with a real photo (upload or URL) and a real location (map
// pin, or typed coordinates/Maps link) per provider, rather than starting
// from fake demo data they'd have to notice and clean up themselves. A
// fresh tenant now genuinely starts with zero businesses — see the setup
// checklist's "Customize your first business" item. seedDefaultsForTenant
// still exists in tenantWorkflowStore.js purely as a test fixture helper
// (tests/http/_setup.js calls it directly) — nothing in server.js invokes
// it anymore.

function validateEnv() {
  if (!process.env.WHATSAPP_VERIFY_TOKEN) {
    log("WARN", "WHATSAPP_VERIFY_TOKEN not set — Meta's webhook verification handshake will fail.");
  }
  if (!process.env.WHATSAPP_APP_SECRET) {
    log(
      "WARN",
      "WHATSAPP_APP_SECRET not set — webhook signature verification is DISABLED. " +
        "Anyone who finds your webhook URL could send it fake messages. Set this before going to production."
    );
  }
  if (!process.env.GROQ_API_KEY) {
    log("WARN", "GROQ_API_KEY not set — using keyword-only classification (no AI).");
  }
  if (!process.env.SESSION_SECRET) {
    log("ERROR", "SESSION_SECRET not set — dashboard logins will fail until it's set in .env. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  }
  if (process.env.NODE_ENV === "production" && !process.env.WHATSAPP_APP_SECRET) {
    log("WARN", "Running with NODE_ENV=production but WHATSAPP_APP_SECRET is not set — webhook signature verification is disabled. Anyone who finds your webhook URL can inject fake messages.");
  }
}

// Section 6 — Meta's default test token expires every 24 hours (README's
// "Get a permanent WhatsApp token" section explains the System User
// alternative). Before this check existed, an expired token was only ever
// discovered when a real customer's message silently got no reply — the
// send fails, logs a 401, and that's it; nothing surfaces it anywhere an
// operator would actually see it in time. This pings the Graph API once at
// startup with the configured token and logs one loud, unmissable warning
// if it's already invalid, instead of waiting for a customer to notice.
// Best-effort and non-blocking — startup must never hang or fail because
// Meta's API is briefly unreachable.
async function checkWhatsAppTokenValidity() {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) return; // simulated/dev mode — nothing to check

  try {
    const resp = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}?fields=id`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      const body = await resp.text();
      log(
        "ERROR",
        `WHATSAPP_TOKEN appears to be invalid or expired (Graph API returned ${resp.status}): ${body.slice(0, 200)}. ` +
          "Outbound WhatsApp sends will silently fail until this is fixed. See README's \"Get a permanent WhatsApp token\" section for how to set up a System User token that doesn't expire every 24h."
      );
    }
  } catch (err) {
    log("WARN", `Could not verify WHATSAPP_TOKEN at startup (${err.message}) — Meta's API may be temporarily unreachable. Will retry naturally on the next real send.`);
  }
}
validateEnv();

const bootstrap = users.bootstrapAdminIfNeeded();
if (bootstrap?.bootstrapped) {
  log("INFO", `Bootstrapped admin account for ${bootstrap.email} from ADMIN_BOOTSTRAP_EMAIL/PASSWORD. You can unset those env vars now — they only matter when the users table is empty.`);
} else if (users.count() === 0) {
  log("WARN", "No dashboard users exist yet and ADMIN_BOOTSTRAP_EMAIL/ADMIN_BOOTSTRAP_PASSWORD are not set — nobody can log into /dashboard. Set both env vars and restart once to create the first admin account.");
}

const platformBootstrap = users.bootstrapPlatformAdminIfNeeded();
if (platformBootstrap?.bootstrapped) {
  log("INFO", `Bootstrapped platform_admin account for ${platformBootstrap.email} from PLATFORM_ADMIN_BOOTSTRAP_EMAIL/PASSWORD.`);
}

// Found live (production-readiness audit): bootstrap only ever WARNS about
// unset credentials or CONFIRMS a fresh bootstrap — a startup where the
// account already existed from a PRIOR run and the bootstrap env vars are
// STILL sitting in .env produced no signal at all. That's a real, easy
// mistake (the "you can unset those now" message above is easy to miss or
// forget), and it means a plaintext admin password lingers in .env
// indefinitely for no reason once the account it was for already exists.
if (!bootstrap?.bootstrapped && process.env.ADMIN_BOOTSTRAP_PASSWORD) {
  log("WARN", "ADMIN_BOOTSTRAP_PASSWORD is still set even though the admin account it bootstraps already exists — it's not doing anything anymore. Remove it from .env.");
}
if (!platformBootstrap?.bootstrapped && process.env.PLATFORM_ADMIN_BOOTSTRAP_PASSWORD) {
  log("WARN", "PLATFORM_ADMIN_BOOTSTRAP_PASSWORD is still set even though a platform_admin account already exists — it's not doing anything anymore. Remove it from .env.");
}


const { createWebhookRouter } = require("./src/routes/webhook");
app.use(createWebhookRouter(DEMO_TENANT_ID));

const authRoutes = require("./src/routes/auth");
app.use(authRoutes.router);


const dashboardRoutes = require("./src/routes/dashboard");
app.use(dashboardRoutes.router);

// Serves whatever POST /api/dashboard/upload-image just saved. Public and
// unauthenticated on purpose — a business photo is customer-facing (shown
// on WhatsApp booking confirmations and in the dashboard's own <img> tags),
// exactly as public as the externally-hosted photo URLs an admin could
// already paste into the same field.
app.use("/uploads", express.static(UPLOAD_DIR));

const marketingRoutes = require("./src/routes/marketing");
app.use(marketingRoutes.router);

const platformAdminRoutes = require("./src/routes/platformAdmin");
app.use(platformAdminRoutes.router);

const publicApiRoutes = require("./src/routes/publicApi");
app.use(publicApiRoutes.router);

app.get("/health", (req, res) => {
  // Item 5 — used to list every workflow id on the entire platform here
  // (Object.keys() of the old global, un-scoped `workflows` object). Now
  // that workflows are tenant-owned, there's no single "current tenant"
  // for an unauthenticated health check to report on, and leaking every
  // tenant's business names to anyone who can reach this URL was never
  // something this endpoint's actual purpose (process liveness) needed.
  res.json({ status: "ok", uptimeSeconds: process.uptime() });
});

// Anything that fell through every route above.
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Final safety net — Express's own default error handler would otherwise
// send an HTML page (and, outside NODE_ENV=production, a stack trace) for
// any error a route handler didn't catch itself. This keeps every response
// this API sends as JSON and never leaks internals to the client, while
// the real detail still goes to the log.
app.use((err, req, res, next) => {
  log("ERROR", `Unhandled error on ${req.method} ${req.path}: ${err.stack || err.message}`);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error." });
});

// Item 2 (HTTP-level route tests) needs `app` importable without the side
// effect of actually binding a port and kicking off background loops
// (backups, the outbound queue worker, a live WhatsApp token check) —
// none of which a test run wants. `require.main === module` is true only
// when this file is the actual process entry point (`node server.js`),
// never when another file `require()`s it, so `node server.js` behaves
// identically to before; a test file gets the bare `app` instead.
if (require.main === module) {
  app.listen(PORT, () => {
    log("INFO", `BookPilot AI listening on port ${PORT}`);
    scheduleBackups(); // every BACKUP_INTERVAL_HOURS (default 6h)
    runBackup().catch((err) => log("ERROR", `Startup backup threw: ${err.message}`)); // one immediately, don't wait 6h for the first
    startOutboundQueueWorker(); // polls the durable send queue every 60s
    scheduleReminders(); // every 10 minutes — Block 13's 24h/2h pre-appointment reminders
    checkWhatsAppTokenValidity().catch((err) => log("WARN", `WhatsApp token check threw unexpectedly: ${err.message}`));
  });
}

module.exports = app;
