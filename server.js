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
const fs = require("fs");
const path = require("path");
const express = require("express");
const { log } = require("./src/logger");
const { loadWorkflows } = require("./src/loadWorkflows");
const { handleIncomingMessage } = require("./src/workflowEngine");
const { isValidSignature } = require("./src/verifySignature");
const { isDuplicate } = require("./src/dedupe");
const bookings = require("./src/bookingStore");
const { blockSlot, unblockSlot, getBlockById, listBlocksForProvider } = require("./src/availabilityStore");
const { createSessionToken, verifySessionToken, SESSION_TTL_MS } = require("./src/auth");
const users = require("./src/userStore");
const { recordAudit, listAudit } = require("./src/auditLog");
const { isLoginRateLimited } = require("./src/rateLimit");
const { generateWorkflowFromDescription } = require("./src/workflowGenerator");
const knowledge = require("./src/knowledgeStore");
const templates = require("./src/templateStore");
const { computeAnalytics } = require("./src/analytics");
const { isVoiceEnabled, downloadWhatsAppMedia, transcribeAudio, synthesizeSpeech } = require("./src/voice");
const { sendWhatsAppText, sendWhatsAppAudio, beginReplyCapture, endReplyCapture } = require("./src/whatsapp");

const app = express();
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
  // script-src needs 'unsafe-inline' because the dashboard's whole app is
  // one inline <script> block, not an external .js file — so this CSP
  // isn't the thing stopping an injected <script> from running (escapeHtml()
  // in dashboard.html is what actually prevents that). What it still buys:
  // no external script/iframe/object can be loaded from anywhere but this
  // origin, and frame-ancestors blocks the whole page from being framed
  // (clickjacking) elsewhere.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self' 'unsafe-inline'; " +
      "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'"
  );
  next();
});

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
  if (!process.env.SESSION_SECRET) {
    log("ERROR", "SESSION_SECRET not set — dashboard logins will fail until it's set in .env. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  }
  if (process.env.NODE_ENV === "production" && !process.env.WHATSAPP_APP_SECRET) {
    log("WARN", "Running with NODE_ENV=production but WHATSAPP_APP_SECRET is not set — webhook signature verification is disabled. Anyone who finds your webhook URL can inject fake messages.");
  }
}
validateEnv();
log("INFO", `Loaded workflows: ${Object.keys(workflows).join(", ")}`);

const bootstrap = users.bootstrapAdminIfNeeded();
if (bootstrap?.bootstrapped) {
  log("INFO", `Bootstrapped admin account for ${bootstrap.email} from ADMIN_BOOTSTRAP_EMAIL/PASSWORD. You can unset those env vars now — they only matter when the users table is empty.`);
} else if (users.count() === 0) {
  log("WARN", "No dashboard users exist yet and ADMIN_BOOTSTRAP_EMAIL/ADMIN_BOOTSTRAP_PASSWORD are not set — nobody can log into /dashboard. Set both env vars and restart once to create the first admin account.");
}

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

    // Voice note — transcribe it, then run the EXACT same text pipeline so
    // a spoken booking gets identical validation and slot locking, and
    // speak the reply back in whatever language they spoke.
    if (message.type === "audio" || message.type === "voice") {
      await handleVoiceMessage(waId, message);
      return;
    }

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

// Voice notes: Sarvam transcribes -> normal text pipeline -> Sarvam speaks
// the reply back. Every failure mode here degrades to text rather than
// dropping the customer's message: no Sarvam key, an unsupported TTS
// language, or a synthesis error all still produce the full text reply.
async function handleVoiceMessage(waId, message) {
  if (!isVoiceEnabled()) {
    log("WARN", `Voice note from ${waId} but SARVAM_API_KEY is not set — asking them to type instead.`);
    await sendWhatsAppText(waId, "Sorry, I can't listen to voice notes right now — could you type your message instead?");
    return;
  }

  const mediaId = message.audio?.id || message.voice?.id;
  if (!mediaId) return;

  let transcript;
  let languageCode;
  try {
    const media = await downloadWhatsAppMedia(mediaId);
    ({ transcript, languageCode } = await transcribeAudio(media.buffer, media.mimeType));
  } catch (err) {
    log("ERROR", `Voice transcription failed for ${waId}: ${err.message}`);
    await sendWhatsAppText(waId, "Sorry, I couldn't make out that voice note. Could you try again, or type your message?");
    return;
  }

  if (!transcript) {
    await sendWhatsAppText(waId, "I couldn't hear anything in that voice note — could you try again?");
    return;
  }
  log("INFO", `Voice note from ${waId} [${languageCode || "unknown"}]: "${transcript}"`);

  // Capture whatever the engine replies so it can be spoken back. The
  // engine itself is untouched and unaware this is a voice conversation.
  beginReplyCapture(waId);
  try {
    await handleIncomingMessage(waId, transcript, workflows);
  } finally {
    const replyText = endReplyCapture(waId);
    if (replyText && languageCode) {
      try {
        const audio = await synthesizeSpeech(replyText, languageCode);
        if (audio) await sendWhatsAppAudio(waId, audio, "audio/wav");
      } catch (err) {
        log("ERROR", `Voice synthesis failed for ${waId}: ${err.message}`);
      }
    }
  }
}

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
const SESSION_COOKIE = "bp_session";

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

function getSessionUser(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  try {
    return verifySessionToken(token);
  } catch {
    return null; // e.g. SESSION_SECRET missing — treat as logged out, not a crash
  }
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

// Real roles, not a shared secret: every request carries a signed session
// identifying exactly one person. `requireAuth()` with no args just means
// "must be logged in"; `requireAuth("admin")` additionally gates by role.
// Route handlers still do their own per-record ownership checks (a
// provider role alone doesn't prove *which* provider) — this only proves
// identity.
//
// Deliberately re-reads the user row from the DB on every request instead
// of trusting the signed token's payload — a signature only proves the
// token wasn't tampered with, not that the account is still active. Found
// live: deactivating a provider didn't revoke their already-issued cookie
// until it expired (up to 12h) because nothing re-checked `active`. This
// closes that — deactivation (or a future role change) takes effect on
// the very next request, not at next login.
function requireAuth(...allowedRoles) {
  return (req, res, next) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ error: "Not logged in." });
    const liveUser = users.getById(session.uid);
    if (!liveUser || !liveUser.active) {
      return res.status(401).json({ error: "This account is no longer active." });
    }
    if (allowedRoles.length && !allowedRoles.includes(liveUser.role)) {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    req.user = { uid: liveUser.id, email: liveUser.email, role: liveUser.role, name: liveUser.name, workflowId: liveUser.workflowId, providerId: liveUser.providerId };
    next();
  };
}

app.post("/api/auth/login", (req, res) => {
  if (!process.env.SESSION_SECRET) {
    return res.status(500).json({ error: "Server misconfigured: SESSION_SECRET is not set." });
  }
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  const rateLimitKey = `${req.ip}:${email.trim().toLowerCase()}`;
  if (isLoginRateLimited(rateLimitKey)) {
    log("WARN", `Login rate-limited for ${rateLimitKey}`);
    return res.status(429).json({ error: "Too many login attempts. Try again in a few minutes." });
  }

  const user = users.verifyCredentials(email.trim(), password);
  if (!user) {
    log("WARN", `Failed login attempt for ${email.trim()}`);
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const token = createSessionToken({
    uid: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    workflowId: user.workflowId,
    providerId: user.providerId,
  });
  setSessionCookie(res, token);
  recordAudit(user, "login", null);
  res.json({ ok: true, user: { email: user.email, role: user.role, name: user.name, workflowId: user.workflowId, providerId: user.providerId } });
});

app.post("/api/auth/logout", (req, res) => {
  const session = getSessionUser(req);
  if (session) recordAudit(session, "logout", null);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", requireAuth(), (req, res) => {
  res.json({ email: req.user.email, role: req.user.role, name: req.user.name, workflowId: req.user.workflowId, providerId: req.user.providerId });
});

function listAllProviders() {
  const list = [];
  for (const workflow of Object.values(workflows)) {
    for (const p of workflow.providers || []) {
      list.push({
        workflowId: workflow.id,
        workflowLabel: workflow.label,
        providerId: p.id,
        providerName: p.name,
        providerAttribute: p.attribute || null,
        providerFee: p.fee || null,
        address: p.address || workflow.businessAddress || null,
        mapQuery: p.mapQuery || workflow.mapQuery || null,
        photo: p.photo || null,
        supportsAvailability: true,
        type: "provider",
      });
    }
    for (const hotel of workflow.hotels || []) {
      for (const room of hotel.rooms || []) {
        list.push({
          workflowId: workflow.id,
          workflowLabel: workflow.label,
          providerId: room.id,
          providerName: room.name,           // just the room name — no hotel prefix
          hotelId: hotel.id,
          hotelName: hotel.name,
          hotelLocation: hotel.location || null,
          hotelPhoto: hotel.photo || null,
          mapQuery: hotel.mapQuery || null,
          supportsAvailability: false,
          type: "hotel_room",
        });
      }
    }
  }
  return list;
}

// Public shell — the page itself carries no data; every fetch inside it
// sends the session cookie and gets gated by requireAuth below. An
// unauthenticated visitor sees only a login form.
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/api/dashboard/providers", requireAuth(), (req, res) => {
  const all = listAllProviders();
  if (req.user.role === "provider") {
    // Not the roster — only the caller's own entry, so a provider session
    // can render its label without ever learning who else is on the platform.
    return res.json(all.filter((p) => p.workflowId === req.user.workflowId && p.providerId === req.user.providerId));
  }
  res.json(all);
});

// Admin role view — every booking across every business, one call. The
// client already has /api/dashboard/providers loaded, so it joins on
// workflowId+providerId client-side for human-readable labels rather than
// this endpoint duplicating that lookup server-side. Admin-only: this is
// exactly the cross-business visibility a provider must never get.
app.get("/api/dashboard/all-bookings", requireAuth("admin"), (req, res) => {
  res.json(bookings.values());
});

app.get("/api/dashboard/audit-log", requireAuth("admin"), (req, res) => {
  res.json(listAudit());
});

// Business/workflow management — admin only. Mutates the SAME `workflows`
// object handle_incoming_message() and every dashboard read route already
// hold a reference to, so a save/delete here takes effect immediately for
// both the WhatsApp bot and the rest of the dashboard, no restart needed.
const WORKFLOWS_DIR = path.join(__dirname, "workflows");
const WORKFLOW_ID_RE = /^[a-z0-9_-]+$/i;

function validateWorkflowShape(workflow) {
  const hasInventory = workflow?.providers?.length || workflow?.hotels?.length;
  if (!workflow || typeof workflow !== "object") return "Workflow body must be a JSON object.";
  if (!workflow.id || typeof workflow.id !== "string" || !WORKFLOW_ID_RE.test(workflow.id)) {
    return "id is required and must contain only letters, numbers, dashes, and underscores.";
  }
  if (!workflow.label || typeof workflow.label !== "string") return "label is required.";
  if (!hasInventory) return "At least one entry in providers[] or hotels[] is required.";
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) return "steps[] is required and must be non-empty.";
  return null;
}

app.get("/api/dashboard/workflows", requireAuth("admin"), (req, res) => {
  res.json(workflows);
});

// AI Workflow Generator — drafts a workflow from a plain-language
// description, but never writes anything. The admin reviews/edits the
// draft in the same modal used for hand-written JSON, and only the
// existing POST /api/dashboard/workflows below (with its own
// validateWorkflowShape check) actually persists it.
app.post("/api/dashboard/workflows/generate", requireAuth("admin"), async (req, res) => {
  const { description } = req.body || {};
  if (typeof description !== "string" || !description.trim()) {
    return res.status(400).json({ error: "A business description is required." });
  }
  try {
    const workflow = await generateWorkflowFromDescription(description.trim());
    const validationWarning = validateWorkflowShape(workflow);
    recordAudit(req.user, "workflow.generate", { description: description.trim().slice(0, 200), valid: !validationWarning });
    res.json({ workflow, validationWarning: validationWarning || null });
  } catch (err) {
    log("ERROR", `Workflow generation failed: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/dashboard/workflows", requireAuth("admin"), (req, res) => {
  const workflow = req.body;
  const validationError = validateWorkflowShape(workflow);
  if (validationError) return res.status(400).json({ error: validationError });

  const isUpdate = !!workflows[workflow.id];
  try {
    fs.writeFileSync(path.join(WORKFLOWS_DIR, `${workflow.id}.json`), JSON.stringify(workflow, null, 2));
  } catch (err) {
    log("ERROR", `Failed to write workflow file for ${workflow.id}: ${err.message}`);
    return res.status(500).json({ error: "Failed to save workflow file." });
  }
  workflows[workflow.id] = workflow;
  recordAudit(req.user, isUpdate ? "workflow.update" : "workflow.create", { workflowId: workflow.id });
  log("INFO", `${req.user.email} ${isUpdate ? "updated" : "created"} workflow "${workflow.id}"`);
  res.status(isUpdate ? 200 : 201).json({ ok: true });
});

app.delete("/api/dashboard/workflows/:id", requireAuth("admin"), (req, res) => {
  const id = req.params.id;
  if (!workflows[id]) return res.status(404).json({ error: "Unknown workflowId" });
  try {
    fs.unlinkSync(path.join(WORKFLOWS_DIR, `${id}.json`));
  } catch (err) {
    log("ERROR", `Failed to delete workflow file for ${id}: ${err.message}`);
    return res.status(500).json({ error: "Failed to delete workflow file." });
  }
  delete workflows[id];
  recordAudit(req.user, "workflow.delete", { workflowId: id });
  log("INFO", `${req.user.email} deleted workflow "${id}"`);
  res.json({ ok: true });
});

// Team management — admin only. This is what makes "every business gets
// its own login and only sees its own data" self-serve instead of a CLI
// step: an admin creates one account per doctor/stylist/room here, each
// pinned to exactly one workflowId+providerId, and requireAuth() + the
// per-route ownership checks above do the actual isolation.
app.get("/api/dashboard/users", requireAuth("admin"), (req, res) => {
  res.json(users.list());
});

app.post("/api/dashboard/users", requireAuth("admin"), (req, res) => {
  const { email, password, role, name, workflowId, providerId } = req.body || {};
  if (typeof email !== "string" || !email.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return res.status(400).json({ error: "A valid email is required." });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  if (role !== "admin" && role !== "provider") {
    return res.status(400).json({ error: "role must be 'admin' or 'provider'." });
  }
  if (role === "provider") {
    if (typeof workflowId !== "string" || typeof providerId !== "string") {
      return res.status(400).json({ error: "workflowId and providerId are required for a provider account." });
    }
    const matches = listAllProviders().some((p) => p.workflowId === workflowId && p.providerId === providerId);
    if (!matches) return res.status(400).json({ error: "Unknown workflowId/providerId — pick one from the provider list." });
  }

  try {
    const user = users.create({
      email: email.trim(),
      password,
      role,
      name: typeof name === "string" && name.trim() ? name.trim() : null,
      workflowId: role === "provider" ? workflowId : null,
      providerId: role === "provider" ? providerId : null,
    });
    recordAudit(req.user, "user.create", { email: user.email, role: user.role, workflowId: user.workflowId, providerId: user.providerId });
    log("INFO", `${req.user.email} created a ${role} account for ${user.email}`);
    res.status(201).json(user);
  } catch (err) {
    if (err.code === "DUPLICATE_EMAIL") return res.status(409).json({ error: err.message });
    log("ERROR", `Failed to create user: ${err.message}`);
    res.status(500).json({ error: "Failed to create account." });
  }
});

app.patch("/api/dashboard/users/:id", requireAuth("admin"), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  if (typeof req.body?.active !== "boolean") return res.status(400).json({ error: "active (boolean) is required." });
  if (id === req.user.uid && !req.body.active) {
    return res.status(400).json({ error: "You can't deactivate your own account." });
  }
  const user = users.setActive(id, req.body.active);
  if (!user) return res.status(404).json({ error: "Not found" });
  recordAudit(req.user, user.active ? "user.activate" : "user.deactivate", { email: user.email });
  res.json(user);
});

app.get("/api/dashboard/bookings", requireAuth(), (req, res) => {
  // A provider session is pinned to exactly one workflowId+providerId —
  // for that role the query params are ignored outright (not merely
  // validated), so there's no way to read someone else's bookings by
  // editing the URL.
  const { workflowId, providerId } = req.user.role === "provider" ? req.user : req.query;
  if (!workflowId || !providerId) return res.status(400).json({ error: "workflowId and providerId query params are required" });
  const rows = bookings.values().filter((b) => b.workflowId === workflowId && b.providerId === providerId);
  rows.sort((a, b) => b.createdAt - a.createdAt);
  res.json(rows);
});

// Provider-initiated cancel or reschedule.  When a provider cancels or
// reschedules a booking from the dashboard, the customer gets a WhatsApp
// message immediately so they aren't left waiting for an appointment that
// no longer exists.  Providers can only act on their OWN bookings (enforced
// by checking workflowId+providerId against the authenticated session).
app.patch("/api/dashboard/bookings/:id", requireAuth(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid booking id" });

  const booking = bookings.getById(id);
  if (!booking) return res.status(404).json({ error: "Booking not found" });

  // Provider role: scope check — they cannot touch another provider's booking.
  if (req.user.role === "provider" &&
      (booking.workflowId !== req.user.workflowId || booking.providerId !== req.user.providerId)) {
    return res.status(403).json({ error: "You can only manage your own bookings." });
  }

  const { action, rescheduleDate, rescheduleTime, note } = req.body || {};

  if (action === "cancel") {
    if (booking.status === "cancelled") return res.status(400).json({ error: "Booking is already cancelled." });

    const updated = bookings.updateWithMeta(id, {
      status: "cancelled",
      cancelledBy: req.user.email,
      rescheduleNote: note || null,
    });

    recordAudit(req.user, "booking.cancel", {
      bookingId: booking.bookingId, waId: booking.waId, workflowId: booking.workflowId, note: note || null,
    });
    log("INFO", `${req.user.email} cancelled booking ${booking.bookingId} for ${booking.waId}`);

    // Notify the customer on WhatsApp.
    const providerLabel = booking.providerName || "your provider";
    const whenLabel = booking.visitDateLabel || booking.visitDate || booking.checkInIso || "";
    const timeLabel = booking.visitTime ? ` at ${booking.visitTime}` : "";
    const noteText = note ? `\n\nNote from provider: "${note}"` : "";
    const msg =
      `❌ Your booking (${booking.bookingId}) with ${providerLabel}` +
      `${whenLabel ? " on " + whenLabel : ""}${timeLabel} has been cancelled by the provider.` +
      noteText +
      `\n\nIf you'd like to rebook, simply message us and we'll find you a new slot.`;

    try {
      await sendWhatsAppText(booking.waId, msg);
    } catch (err) {
      log("WARN", `WhatsApp notification failed for cancel of ${booking.bookingId}: ${err.message}`);
    }

    return res.json({ ok: true, booking: updated });
  }

  if (action === "reschedule") {
    if (!rescheduleDate || typeof rescheduleDate !== "string") {
      return res.status(400).json({ error: "rescheduleDate (YYYY-MM-DD) is required for reschedule." });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rescheduleDate)) {
      return res.status(400).json({ error: "rescheduleDate must be in YYYY-MM-DD format." });
    }
    if (booking.status === "cancelled") return res.status(400).json({ error: "Cannot reschedule a cancelled booking." });

    const updated = bookings.updateWithMeta(id, {
      status: "rescheduled",
      cancelledBy: req.user.email,
      rescheduledDate: rescheduleDate,
      rescheduledTime: rescheduleTime || null,
      rescheduleNote: note || null,
    });

    recordAudit(req.user, "booking.reschedule", {
      bookingId: booking.bookingId, waId: booking.waId,
      newDate: rescheduleDate, newTime: rescheduleTime || null, note: note || null,
    });
    log("INFO", `${req.user.email} rescheduled booking ${booking.bookingId} for ${booking.waId} → ${rescheduleDate} ${rescheduleTime || ""}`);

    // Notify the customer.
    const providerLabel = booking.providerName || "your provider";
    const oldWhen = (booking.visitDateLabel || booking.visitDate || "") + (booking.visitTime ? ` at ${booking.visitTime}` : "");
    const newWhen = rescheduleDate + (rescheduleTime ? ` at ${rescheduleTime}` : "");
    const noteText = note ? `\n\nMessage from provider: "${note}"` : "";
    const msg =
      `📅 Your booking (${booking.bookingId}) with ${providerLabel} has been rescheduled by the provider.` +
      (oldWhen ? `\n\nOld: ${oldWhen}` : "") +
      `\nNew: ${newWhen}` +
      noteText +
      `\n\nReply STATUS to see your updated booking details.`;

    try {
      await sendWhatsAppText(booking.waId, msg);
    } catch (err) {
      log("WARN", `WhatsApp notification failed for reschedule of ${booking.bookingId}: ${err.message}`);
    }

    return res.json({ ok: true, booking: updated });
  }

  return res.status(400).json({ error: 'action must be "cancel" or "reschedule".' });
});



app.get("/api/dashboard/availability", requireAuth(), (req, res) => {
  const { workflowId, providerId } = req.user.role === "provider" ? req.user : req.query;
  if (!workflowId || !providerId) return res.status(400).json({ error: "workflowId and providerId query params are required" });
  res.json(listBlocksForProvider(workflowId, providerId));
});

app.post("/api/dashboard/availability", requireAuth(), (req, res) => {
  const body = req.body || {};
  const workflowId = req.user.role === "provider" ? req.user.workflowId : body.workflowId;
  const providerId = req.user.role === "provider" ? req.user.providerId : body.providerId;
  const { date, time, reason } = body;
  if (typeof workflowId !== "string" || typeof providerId !== "string" || typeof date !== "string") {
    return res.status(400).json({ error: "workflowId, providerId, and date are required strings" });
  }
  if (!workflows[workflowId]) return res.status(400).json({ error: "Unknown workflowId" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
  if (time !== undefined && time !== null && typeof time !== "string") {
    return res.status(400).json({ error: "time must be a string (or omitted to block the whole day)" });
  }
  const cappedReason = typeof reason === "string" ? reason.slice(0, 200) : null;
  blockSlot(workflowId, providerId, date, time || null, cappedReason);
  recordAudit(req.user, "availability.block", { workflowId, providerId, date, time: time || null, reason: cappedReason });
  res.status(201).json({ ok: true });
});

app.delete("/api/dashboard/availability/:id", requireAuth(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const block = getBlockById(id);
  if (!block) return res.status(404).json({ error: "Not found" });
  if (req.user.role === "provider" && (block.workflowId !== req.user.workflowId || block.providerId !== req.user.providerId)) {
    return res.status(403).json({ error: "You can only remove your own availability blocks." });
  }
  unblockSlot(id);
  recordAudit(req.user, "availability.unblock", { id, workflowId: block.workflowId, providerId: block.providerId, date: block.date, time: block.time });
  res.json({ ok: true });
});

// Analytics — same role scoping as every other dashboard route: a
// provider only ever gets their own numbers (the query params are ignored
// for that role, not merely validated), an admin gets platform-wide.
app.get("/api/dashboard/analytics", requireAuth(), (req, res) => {
  const scope = req.user.role === "provider"
    ? { workflowId: req.user.workflowId, providerId: req.user.providerId }
    : { workflowId: req.query.workflowId || null, providerId: req.query.providerId || null };
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 90);
  res.json(computeAnalytics({ ...scope, days }));
});

// Marketplace — publish a working business as a reusable template, then
// install it later (or into another business) as a fresh workflow. Admin
// only: installing writes a new workflows/*.json and makes it live for the
// WhatsApp bot immediately, same blast radius as creating one by hand.
function persistWorkflow(workflow) {
  fs.writeFileSync(path.join(WORKFLOWS_DIR, `${workflow.id}.json`), JSON.stringify(workflow, null, 2));
  workflows[workflow.id] = workflow;
}

app.get("/api/dashboard/templates", requireAuth("admin"), (req, res) => {
  // Strip the full definition from the list — it can be large and the
  // browser only needs it at install time, which re-fetches by id.
  res.json(templates.list().map(({ definition, ...rest }) => ({
    ...rest,
    stepCount: definition.steps?.length ?? 0,
    providerCount: definition.providers?.length ?? definition.hotels?.length ?? 0,
  })));
});

app.post("/api/dashboard/templates", requireAuth("admin"), (req, res) => {
  const { workflowId, name, industry, description } = req.body || {};
  const source = workflows[workflowId];
  if (!source) return res.status(400).json({ error: "Unknown workflowId — publish from an existing business." });
  if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "A template name is required." });

  const template = templates.create({
    name: name.trim().slice(0, 120),
    industry: typeof industry === "string" ? industry.trim().slice(0, 60) : null,
    description: typeof description === "string" ? description.trim().slice(0, 500) : source.description || null,
    definition: source,
    createdBy: req.user.email,
  });
  recordAudit(req.user, "template.publish", { templateId: template.id, name: template.name, fromWorkflowId: workflowId });
  res.status(201).json({ id: template.id, name: template.name });
});

app.post("/api/dashboard/templates/:id/install", requireAuth("admin"), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const template = templates.getById(id);
  if (!template) return res.status(404).json({ error: "Template not found" });

  const { newId, newLabel } = req.body || {};
  if (typeof newId !== "string" || !WORKFLOW_ID_RE.test(newId)) {
    return res.status(400).json({ error: "newId is required and must contain only letters, numbers, dashes, and underscores." });
  }
  if (workflows[newId]) return res.status(409).json({ error: `A business with id "${newId}" already exists.` });

  // Deep copy so the stored template is never mutated by the install.
  const workflow = JSON.parse(JSON.stringify(template.definition));
  workflow.id = newId;
  if (typeof newLabel === "string" && newLabel.trim()) workflow.label = newLabel.trim();

  const validationError = validateWorkflowShape(workflow);
  if (validationError) return res.status(400).json({ error: `Template produced an invalid workflow: ${validationError}` });

  try {
    persistWorkflow(workflow);
  } catch (err) {
    log("ERROR", `Failed to install template ${id} as ${newId}: ${err.message}`);
    return res.status(500).json({ error: "Failed to write the new workflow file." });
  }
  recordAudit(req.user, "template.install", { templateId: id, newWorkflowId: newId });
  log("INFO", `${req.user.email} installed template "${template.name}" as workflow "${newId}"`);
  res.status(201).json({ ok: true, workflowId: newId });
});

app.delete("/api/dashboard/templates/:id", requireAuth("admin"), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const template = templates.getById(id);
  if (!template) return res.status(404).json({ error: "Template not found" });
  templates.remove(id);
  recordAudit(req.user, "template.delete", { templateId: id, name: template.name });
  res.json({ ok: true });
});

// Knowledge base (RAG-lite) — the FAQ/policy/pricing text the WhatsApp
// bot is allowed to answer questions from. Scoped per business: a provider
// manages only their own workflow's entries, an admin manages any.
// Providers CAN edit these (unlike workflow config, which is admin-only) —
// answering "do you take insurance?" is the provider's own domain
// knowledge, not a platform-level setting.
const MAX_KNOWLEDGE_CONTENT = 5000;

function resolveKnowledgeWorkflowId(req, requested) {
  if (req.user.role === "provider") return req.user.workflowId;
  return requested;
}

app.get("/api/dashboard/knowledge", requireAuth(), (req, res) => {
  const workflowId = resolveKnowledgeWorkflowId(req, req.query.workflowId);
  if (!workflowId) return res.json(knowledge.listAll()); // admin, no filter
  res.json(knowledge.listForWorkflow(workflowId));
});

app.post("/api/dashboard/knowledge", requireAuth(), (req, res) => {
  const { title, content } = req.body || {};
  const workflowId = resolveKnowledgeWorkflowId(req, req.body?.workflowId);
  if (typeof workflowId !== "string" || !workflows[workflowId]) {
    return res.status(400).json({ error: "A known workflowId is required." });
  }
  if (typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "title is required." });
  if (typeof content !== "string" || !content.trim()) return res.status(400).json({ error: "content is required." });

  const doc = knowledge.create(workflowId, title.trim().slice(0, 200), content.trim().slice(0, MAX_KNOWLEDGE_CONTENT));
  recordAudit(req.user, "knowledge.create", { workflowId, id: doc.id, title: doc.title });
  res.status(201).json(doc);
});

app.put("/api/dashboard/knowledge/:id", requireAuth(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const existing = knowledge.getById(id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (req.user.role === "provider" && existing.workflowId !== req.user.workflowId) {
    return res.status(403).json({ error: "You can only edit your own business's knowledge base." });
  }
  const { title, content } = req.body || {};
  if (typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "title is required." });
  if (typeof content !== "string" || !content.trim()) return res.status(400).json({ error: "content is required." });

  const doc = knowledge.update(id, title.trim().slice(0, 200), content.trim().slice(0, MAX_KNOWLEDGE_CONTENT));
  recordAudit(req.user, "knowledge.update", { workflowId: existing.workflowId, id, title: doc.title });
  res.json(doc);
});

app.delete("/api/dashboard/knowledge/:id", requireAuth(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const existing = knowledge.getById(id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (req.user.role === "provider" && existing.workflowId !== req.user.workflowId) {
    return res.status(403).json({ error: "You can only delete your own business's knowledge base." });
  }
  knowledge.remove(id);
  recordAudit(req.user, "knowledge.delete", { workflowId: existing.workflowId, id, title: existing.title });
  res.json({ ok: true });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", workflows: Object.keys(workflows), uptimeSeconds: process.uptime() });
});

app.get("/", (req, res) => {
  res.type("text/plain").send(`BookPilot AI is running. Workflows loaded: ${Object.keys(workflows).join(", ")}. Messages arrive at POST /webhook.`);
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

app.listen(PORT, () => {
  log("INFO", `BookPilot AI listening on port ${PORT}`);
});
