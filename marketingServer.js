/**
 * BookPilot AI — the MARKETING SITE server. Powered by the same codebase,
 * a separate process from the dashboard/bot server (server.js).
 * -------------------------------------------------------------------------
 * This is the OTHER of the two servers this project runs — see README's
 * "Running both servers" section. This one is deliberately small: the
 * public marketing site (public/marketing/ — plain HTML/CSS/JS, no build
 * step), the signup flow (which needs to POST to the same auth routes the
 * dashboard server also mounts), and the homepage's live chat demo widget
 * (POST /api/demo/chat, sandboxed to its own dedicated tenant — see
 * src/infra/demoTenant.js — so a site visitor can never reach or affect
 * any real tenant's data). It does NOT mount the WhatsApp webhook, the
 * dashboard app, payments, or the platform-admin/public API — those all
 * live only on server.js, and this process never starts any of the
 * dashboard server's background jobs (the outbound WhatsApp queue,
 * appointment reminders), so the two processes never do that work twice
 * against the same shared database.
 *
 * Listens on MARKETING_PORT (default 8082), meant to sit behind the
 * marketing domain (this repo's convention, per the request that split
 * this out: app.bookpilot.com — see README for the reasoning, and swap it
 * there if your actual domain mapping is the more common way around).
 *
 * Startup is async (Postgres — src/store/db.js) — see server.js's own
 * comment on why route mounting itself lives inside bootstrap() rather
 * than at module-top-level. `module.exports.ready` is the same bootstrap
 * promise for tests/other tooling to await.
 */

require("dotenv").config();
const express = require("express");
const { log } = require("./src/infra/logger");

// Same two crash-safety handlers as server.js, registered independently —
// this is a genuinely separate OS process, so it needs its own. See
// server.js's own comment for why these two are handled differently.
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log("ERROR", `Unhandled promise rejection: ${err.stack || err.message}`);
});
process.on("uncaughtException", (err) => {
  log("ERROR", `Uncaught exception — exiting so a process manager can restart cleanly: ${err.stack || err.message}`);
  process.exit(1);
});

const { runMigrations } = require("./src/store/db");
const { runWithRequestId, newRequestId } = require("./src/infra/tracing");
const { ensureDemoTenant } = require("./src/infra/demoTenant");
const { finalErrorHandler } = require("./src/infra/finalErrorHandler");

const app = express();
app.disable("x-powered-by");

app.use((req, res, next) => {
  const requestId = newRequestId();
  res.setHeader("X-Request-Id", requestId);
  runWithRequestId(next, requestId);
});

app.use(express.json({ limit: "100kb" }));

if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY);

// Same security headers as server.js — kept identical on purpose so both
// public-facing surfaces of this product carry the same policy. The
// marketing site loads no third-party scripts either (Google Fonts CSS
// only), so the same tight CSP applies unchanged.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data: https:; script-src 'self'; " +
      "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'"
  );
  next();
});

// MARKETING_PORT is the dedicated env var for this server. PORT is intentionally
// NOT used here — it is already claimed by server.js (8081). In a cloud deployment
// where only one PORT is injected per container, this server runs in its own
// container/process and you should set MARKETING_PORT (not PORT) for it.
const MARKETING_PORT = process.env.MARKETING_PORT || 8082;

async function bootstrap() {
  await runMigrations();

  // This process's own copy of workflowEngine.js's in-memory `sessions`
  // Map — needed even here, since the demo-chat widget (below) routes
  // through the same handleIncomingMessage() a real WhatsApp conversation
  // does. See server.js's identical comment for why this has to be
  // awaited before any route that could reach it is mounted.
  await require("./src/engine/workflowEngine").initSessions();

  // Idempotent — safe to call here even if server.js's process already
  // created this row (or hasn't started yet). See src/infra/demoTenant.js.
  const demoTenantId = await ensureDemoTenant();

  // Found live: the marketing site's own "Log in" links were hardcoded as
  // `href="/app"` — a same-origin relative path that only worked back when
  // marketing and dashboard were one process on one port. Now that they're
  // two separate origins (this server doesn't even mount dashboard.js),
  // that link 404s. Rather than hardcode the dashboard's URL into static
  // HTML (which would need editing on every environment), this serves it
  // as a tiny runtime config the marketing pages fetch once — see
  // public/marketing/dashboardLinks.js, which reads window.DASHBOARD_URL
  // and rewrites those links after the page loads. Defaults to this
  // project's own dev convention (dashboard on 8081); set DASHBOARD_URL in
  // .env for any other environment (e.g. https://bookpilot.com in prod).
  const dashboardUrl = process.env.DASHBOARD_URL || "http://localhost:8081";
  app.get("/marketing/config.js", (req, res) => {
    res.type("application/javascript").send(`window.DASHBOARD_URL = ${JSON.stringify(dashboardUrl)};`);
  });

  const marketingRoutes = require("./src/routes/marketing");
  app.use(marketingRoutes.router);

  // Signup lives in the same router as login/session management (auth.js) —
  // mounted here in full rather than split further, since exposing login on
  // the marketing domain too is harmless (it's stateless route logic backed
  // by the same shared database server.js uses, not a security boundary
  // between the two processes) and the signup page genuinely needs
  // POST /api/signup + /api/signup/request-otp.
  const authRoutes = require("./src/routes/auth");
  app.use(authRoutes.router);

  // Same reasoning as auth.js just above — the new plan-selection page
  // (public/marketing/plan-selection.html) runs on this same origin right
  // after signup and needs POST /api/billing/checkout + GET /api/billing/plans.
  const billingRoutes = require("./src/routes/billing");
  app.use(billingRoutes.router);

  const { createDemoChatRouter } = require("./src/routes/demoChat");
  app.use(createDemoChatRouter(demoTenantId));

  app.get("/health", (req, res) => {
    res.json({ status: "ok", uptimeSeconds: process.uptime() });
  });

  app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use(finalErrorHandler);
}

const readyPromise = bootstrap();
app.ready = readyPromise;

if (require.main === module) {
  readyPromise
    .then(() => {
      app.listen(MARKETING_PORT, () => {
        log("INFO", `BookPilot AI marketing server listening on port ${MARKETING_PORT}`);
      });
    })
    .catch((err) => {
      log("ERROR", `Startup failed: ${err.stack || err.message}`);
      process.exit(1);
    });
}

module.exports = app;
