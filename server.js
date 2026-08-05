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
const path = require("path");
const express = require("express");
const { log } = require("./src/logger");
const { loadWorkflows } = require("./src/loadWorkflows");
const { handleIncomingMessage } = require("./src/workflowEngine");
const { isValidSignature } = require("./src/verifySignature");
const { isDuplicate } = require("./src/dedupe");
const bookings = require("./src/bookingStore");
const { blockSlot, unblockSlot, listBlocksForProvider } = require("./src/availabilityStore");

const app = express();
// Capture the raw body alongside the parsed one — signature verification
// needs to HMAC the exact bytes Meta sent, not a re-serialized version.
// Explicit size cap (Express defaults to 100kb anyway, but stating it here
// makes the limit an intentional, auditable decision rather than an
// implicit default — a booking webhook payload is never legitimately large.
app.use(express.json({ limit: "100kb", verify: (req, res, buf) => { req.rawBody = buf; } }));

const PORT = process.env.PORT || 8081;
const workflows = loadWorkflows();

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
  if (!process.env.DASHBOARD_ACCESS_KEY) {
    log("WARN", "DASHBOARD_ACCESS_KEY not set — the /dashboard and /api/dashboard/* routes are open to anyone who finds the URL (shows all bookings, can edit availability). Set it before exposing this publicly.");
  }
}
validateEnv();
log("INFO", `Loaded workflows: ${Object.keys(workflows).join(", ")}`);

// Crash instead of continuing in an unknown state; run under a process
// manager (PM2, systemd, Docker restart policy) so it comes back up.
process.on("uncaughtException", (err) => {
  log("ERROR", `Uncaught exception — exiting: ${err.stack || err.message}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log("ERROR", `Unhandled promise rejection: ${reason}`);
});
process.on("SIGTERM", () => {
  log("INFO", "SIGTERM received, shutting down.");
  process.exit(0);
});
process.on("SIGINT", () => {
  log("INFO", "SIGINT received, shutting down.");
  process.exit(0);
});

// ---------------------------------------------------------------------------
// WhatsApp Cloud API webhook (Meta)
// ---------------------------------------------------------------------------

// Verification handshake — Meta calls this once when you save the webhook URL.
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    log("INFO", "Webhook verified by Meta.");
    return res.status(200).send(challenge);
  }
  log("WARN", "Webhook verification failed — check WHATSAPP_VERIFY_TOKEN matches the value entered in Meta's dashboard.");
  return res.sendStatus(403);
});

// Incoming messages from real WhatsApp users.
app.post("/webhook", async (req, res) => {
  const signature = req.get("X-Hub-Signature-256");
  if (!isValidSignature(req.rawBody, signature)) {
    log("WARN", "Rejected webhook POST: invalid or missing signature.");
    return res.sendStatus(403);
  }

  res.sendStatus(200); // Meta requires a fast ack; do the work after responding.
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return; // delivery/read status updates land here too — ignore them

    if (isDuplicate(message.id)) {
      log("INFO", `Ignoring duplicate webhook delivery for message ${message.id}.`);
      return;
    }

    const waId = message.from;
    // Prefer the tapped button/list id (machine-readable) over its title.
    const text =
      message.interactive?.list_reply?.id ||
      message.interactive?.button_reply?.id ||
      message.text?.body ||
      message.button?.text ||
      "";

    if (text) await handleIncomingMessage(waId, text, workflows);
  } catch (err) {
    log("ERROR", `Webhook processing error: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// Local testing helper (NOT a UI) — lets you exercise the exact same
// conversation logic with curl/Postman before wiring up a real WhatsApp
// number. Replies are logged (or sent for real if WHATSAPP_TOKEN is set).
//
// Unauthenticated by design (it's a dev tool), which means it's also an
// impersonation risk if left reachable in production — anyone could POST a
// real customer's WhatsApp id as `from` and read back their booking/STATUS.
// Auto-disabled once WHATSAPP_APP_SECRET is set (the same signal that
// switches the webhook into production mode) unless explicitly re-enabled —
// dev setups without that secret configured see no change in behavior.
// ---------------------------------------------------------------------------
const simulateEndpointEnabled = !process.env.WHATSAPP_APP_SECRET || process.env.ALLOW_SIMULATE_ENDPOINT === "true";
if (!simulateEndpointEnabled) {
  log("INFO", "POST /api/simulate-whatsapp is disabled (WHATSAPP_APP_SECRET is set). Set ALLOW_SIMULATE_ENDPOINT=true to re-enable it.");
}

app.post("/api/simulate-whatsapp", async (req, res) => {
  if (!simulateEndpointEnabled) return res.sendStatus(404);

  const { from, text } = req.body || {};
  if (typeof from !== "string" || !from.trim() || typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "from and text are required and must be non-empty strings" });
  }
  try {
    await handleIncomingMessage(from, text, workflows);
    res.json({ ok: true, note: "Check the console / logs/app.log for the bot's reply." });
  } catch (err) {
    log("ERROR", `Simulate endpoint error: ${err.stack || err.message}`);
    res.status(500).json({ error: "Internal error — see logs/app.log for details." });
  }
});

// ---------------------------------------------------------------------------
// Provider dashboard — one static page, same UI for every business type.
// "Login" is just picking yourself from a dropdown for now (explicitly
// deferred, not an oversight) — the dropdown is built from the same
// workflows/*.json the bot reads, so a new provider added there shows up
// here automatically, no dashboard code changes needed.
//
// Hotels: bookings show up here same as any workflow, but the availability
// editor is unavailable for hotel rooms — that table only knows how to
// block a single day/slot, and hotel stays span a date *range* (a
// different, harder problem: does a 3-night block-out prevent bookings
// that only overlap 1 of those nights?). Rather than ship a broken UI
// control for it, it's just not shown for rooms — see README.
// ---------------------------------------------------------------------------
function requireDashboardKey(req, res, next) {
  const required = process.env.DASHBOARD_ACCESS_KEY;
  if (!required) return next(); // no key configured — open (see startup warning)
  const provided = req.query.key || req.get("X-Dashboard-Key");
  if (provided === required) return next();
  return res.status(401).json({ error: "Missing or invalid dashboard access key. Pass it as ?key=... or an X-Dashboard-Key header." });
}

function listAllProviders() {
  const list = [];
  for (const workflow of Object.values(workflows)) {
    for (const p of workflow.providers || []) {
      list.push({ workflowId: workflow.id, workflowLabel: workflow.label, providerId: p.id, providerName: p.name, supportsAvailability: true });
    }
    for (const hotel of workflow.hotels || []) {
      for (const room of hotel.rooms || []) {
        list.push({
          workflowId: workflow.id,
          workflowLabel: workflow.label,
          providerId: room.id,
          providerName: `${hotel.name} — ${room.name}`,
          supportsAvailability: false,
        });
      }
    }
  }
  return list;
}

app.get("/dashboard", requireDashboardKey, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/api/dashboard/providers", requireDashboardKey, (req, res) => {
  res.json(listAllProviders());
});

app.get("/api/dashboard/bookings", requireDashboardKey, (req, res) => {
  const { workflowId, providerId } = req.query;
  if (!workflowId || !providerId) return res.status(400).json({ error: "workflowId and providerId query params are required" });
  const rows = bookings.values().filter((b) => b.workflowId === workflowId && b.providerId === providerId);
  rows.sort((a, b) => b.createdAt - a.createdAt);
  res.json(rows);
});

app.get("/api/dashboard/availability", requireDashboardKey, (req, res) => {
  const { workflowId, providerId } = req.query;
  if (!workflowId || !providerId) return res.status(400).json({ error: "workflowId and providerId query params are required" });
  res.json(listBlocksForProvider(workflowId, providerId));
});

app.post("/api/dashboard/availability", requireDashboardKey, (req, res) => {
  const { workflowId, providerId, date, time, reason } = req.body || {};
  if (typeof workflowId !== "string" || typeof providerId !== "string" || typeof date !== "string") {
    return res.status(400).json({ error: "workflowId, providerId, and date are required strings" });
  }
  if (!workflows[workflowId]) return res.status(400).json({ error: "Unknown workflowId" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
  if (time !== undefined && time !== null && typeof time !== "string") {
    return res.status(400).json({ error: "time must be a string (or omitted to block the whole day)" });
  }
  blockSlot(workflowId, providerId, date, time || null, typeof reason === "string" ? reason : null);
  res.status(201).json({ ok: true });
});

app.delete("/api/dashboard/availability/:id", requireDashboardKey, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  unblockSlot(id);
  res.json({ ok: true });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", workflows: Object.keys(workflows), uptimeSeconds: process.uptime() });
});

app.get("/", (req, res) => {
  res.type("text/plain").send(`BookPilot AI is running. Workflows loaded: ${Object.keys(workflows).join(", ")}. Messages arrive at POST /webhook.`);
});

app.listen(PORT, () => {
  log("INFO", `BookPilot AI listening on port ${PORT}`);
});
