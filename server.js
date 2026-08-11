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
const crypto = require("crypto");
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
const { handleIncomingMessage } = require("./src/engine/workflowEngine");
const { isTerminal } = require("./src/engine/bookingStateMachine");
const { isValidSignature } = require("./src/infra/verifySignature");
const { isDuplicate } = require("./src/infra/dedupe");
const bookings = require("./src/store/bookingStore");
const { blockSlot, unblockSlot, getBlockById, listBlocksForProvider, timeToMinutes } = require("./src/store/availabilityStore");
const { labelToMinutes, formatLongDate, parseIsoDate } = require("./src/engine/dateSlots");
const { createSessionToken, verifySessionToken, SESSION_TTL_MS } = require("./src/infra/auth");
const users = require("./src/store/userStore");
const { recordAudit, listAudit } = require("./src/store/auditLog");
const { isLoginRateLimited, isApiRateLimited, isSignupRateLimited, isDemoChatRateLimited, isOtpRateLimited } = require("./src/infra/rateLimit");
const { generateWorkflowFromDescription } = require("./src/ai/workflowGenerator");
const knowledge = require("./src/store/knowledgeStore");
const templates = require("./src/store/templateStore");
const { computeAnalytics } = require("./src/engine/analytics");
const supportRequests = require("./src/store/supportRequestStore");
const feedbackStore = require("./src/store/feedbackStore");
const { runBackup, listBackups, scheduleBackups } = require("./src/infra/backupStore");
const { getErrorRate } = require("./src/infra/alerting");
const { MAX_DOC_CHARS } = require("./src/ai/factualQA");
const { createResetToken, consumeResetToken } = require("./src/store/passwordResetStore");
const { createOtp, verifyOtp } = require("./src/store/signupOtpStore");
const { sendEmail } = require("./src/infra/emailSender");
const { isVoiceEnabled, downloadWhatsAppMedia, transcribeAudio, synthesizeSpeech } = require("./src/infra/voice");
const { sendWhatsAppText, sendWhatsAppAudio, sendTypingIndicator, sendWithRetry, beginReplyCapture, endReplyCapture, startOutboundQueueWorker } = require("./src/infra/whatsapp");
const outboundQueueStore = require("./src/store/outboundQueueStore");
const { computeQueuePosition, sameQueueBookings, markAlerted, wasAlerted, isOptedOutOfAlerts } = require("./src/store/queueStore");
const tenantStore = require("./src/store/tenantStore");
const tenantWorkflowStore = require("./src/store/tenantWorkflowStore");
const paymentStore = require("./src/store/paymentStore");
const razorpay = require("./src/infra/paymentProviders/razorpayProvider");
const { resolvePaymentRequirement, getAvailableSlots } = require("./src/engine/workflowEngine");
const { refundIfPaid } = require("./src/engine/paymentRefunds");
const apiKeys = require("./src/store/apiKeyStore");
const { syncBookingCreated, syncBookingRescheduled, syncBookingCancelled } = require("./src/engine/calendarSync");
const { calendarConnections } = require("./src/store/calendarStore");
const googleCalendar = require("./src/infra/calendarProviders/googleCalendarProvider");
const { signOAuthState, verifyOAuthState } = require("./src/infra/oauthState");
const dashboardEvents = require("./src/infra/dashboardEvents");
const { runWithRequestId, newRequestId } = require("./src/infra/tracing");

// Section 11 — every dashboard route that mutates a booking publishes
// through this one helper so the payload shape (always workflowId +
// providerId alongside the booking, whatever the event type) stays
// consistent for the SSE route below to filter a provider session's
// events from everyone else's — same helper workflowEngine.js's own
// publishBookingEvent() exists for, just server.js's side of it.
function publishBookingEvent(tenantId, type, booking) {
  dashboardEvents.publish(tenantId, type, { workflowId: booking.workflowId, providerId: booking.providerId, booking });
}

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
      "font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; " +
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
  if (existing) return existing.id;
  const created = tenantStore.create({ name: "BookPilot AI — Live Demo", slug: DEMO_TENANT_SLUG, plan: "free" });
  // tenantStore.create() always starts a tenant "pending" (every tenant
  // needs a platform_admin to explicitly activate it — see requireAuth()'s
  // own comment). The demo tenant never has a real user logging in
  // through it, so "pending" would just be permanent, meaningless clutter
  // in a platform admin's activation queue — set it active immediately,
  // the one tenant this bootstrap owns end-to-end itself.
  tenantStore.setStatus(created.id, "active");
  log("INFO", `Created dedicated demo tenant (id ${created.id}) for the public marketing chat widget.`);
  return created.id;
}
const DEMO_TENANT_ID = ensureDemoTenant();

// Item 5 — every tenant now owns its own copy of its business definitions
// (src/store/tenantWorkflowStore.js), seeded from the workflows/*.json
// starter catalog at signup. This backfills any tenant that existed
// before this table did (including the default tenant id=1 every fresh
// install starts with, and the demo tenant just created above) —
// seedDefaultsForTenant is a no-op for a tenant that already has rows, so
// this is safe to run on every boot, not just the first one after upgrading.
for (const tenant of tenantStore.list()) {
  tenantWorkflowStore.seedDefaultsForTenant(tenant.id);
}

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
log("INFO", `Tenant workflow backfill complete for ${tenantStore.list().length} tenant(s).`);

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
app.post("/webhook", asyncHandler(async (req, res) => {
  const signature = req.get("X-Hub-Signature-256");
  if (!isValidSignature(req.rawBody, signature)) {
    log("WARN", "Rejected webhook POST: invalid or missing signature.");
    return res.sendStatus(403);
  }

  res.sendStatus(200); // Meta requires a fast ack; do the work after responding.
  let waId;
  let tenantId;
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return; // delivery/read status updates land here too — ignore them

    if (isDuplicate(message.id)) {
      log("INFO", `Ignoring duplicate webhook delivery for message ${message.id}.`);
      return;
    }

    waId = message.from;

    // Section 8.3 — each tenant has their own WhatsApp Business number;
    // Meta's payload always carries which one actually received this
    // message (value.metadata.phone_number_id), so that's the ONLY
    // signal this route uses to attribute an incoming message to a
    // tenant. Falls back to the default tenant (id 1) if no tenant has
    // registered that phone_number_id yet — true for every existing
    // install upgrading into Section 8, where the default tenant's
    // WhatsApp number still only lives in the global .env vars (see
    // src/infra/whatsapp.js's credentials()). A genuinely unrecognized
    // number (not the default tenant's own) should NOT silently fall
    // through to tenant 1's data — that would leak one tenant's
    // conversation into another's — so the fallback only applies when no
    // tenant in the system has claimed any phone_number_id at all yet.
    const incomingPhoneNumberId = value?.metadata?.phone_number_id;
    const matchedTenant = tenantStore.getByPhoneNumberId(incomingPhoneNumberId);
    if (matchedTenant) {
      tenantId = matchedTenant.id;
    } else if (!tenantStore.getById(1)?.whatsappPhoneNumberId) {
      tenantId = 1; // upgrade-continuity fallback — see comment above
    } else {
      log("WARN", `Webhook message for unrecognized phone_number_id "${incomingPhoneNumberId}" — no tenant claims it. Dropping.`);
      return;
    }

    // Section 8.6 — a suspended/cancelled tenant's number should not keep
    // quietly booking real appointments no one is running (or, at the
    // other extreme, go completely silent with zero explanation, which
    // this codebase's own "no silent failures" principle already treats
    // as a bug elsewhere — Section 6's async-handler-hang fix exists for
    // exactly that reason). One clear, non-alarming reply, then stop.
    const currentTenant = tenantStore.getById(tenantId);
    if (currentTenant && currentTenant.status !== "active") {
      log("WARN", `Webhook message for tenant ${tenantId} whose status is "${currentTenant.status}" — not processing.`);
      await sendWhatsAppText(tenantId, waId, "This business isn't currently accepting bookings. Please check back later.");
      return;
    }

    // Instant feedback before any AI call starts — Section 0.5. Fire and
    // forget: never await/block the actual processing on this.
    sendTypingIndicator(tenantId, message.id);

    // Voice note — transcribe it, then run the EXACT same text pipeline so
    // a spoken booking gets identical validation and slot locking, and
    // speak the reply back in whatever language they spoke.
    if (message.type === "audio" || message.type === "voice") {
      await handleVoiceMessage(tenantId, waId, message);
      return;
    }

    // Prefer the tapped button/list id (machine-readable) over its title.
    const text =
      message.interactive?.list_reply?.id ||
      message.interactive?.button_reply?.id ||
      message.text?.body ||
      message.button?.text ||
      "";

    if (text) await handleIncomingMessage(tenantId, waId, text, tenantWorkflowStore.listForTenant(tenantId));
  } catch (err) {
    // The safety net, not the fix (Section 0's timeouts are the fix — a
    // hung call used to be the actual cause of this path firing at all).
    // Found live via transcript review: this catch block used to only
    // log, so a thrown error meant the customer got silently nothing —
    // five consecutive messages including a real symptom report vanished
    // with no reply at all. An error here must never mean total silence.
    log("ERROR", `Webhook processing error: ${err.stack || err.message}`);
    if (waId && tenantId) {
      try {
        await sendWhatsAppText(tenantId, waId, "Sorry, something went wrong on my end — could you try that again?");
      } catch (sendErr) {
        log("ERROR", `Also failed to send the error fallback reply to ${waId}: ${sendErr.message}`);
      }
    }
  }
}));


// Section 9.5 — Razorpay's webhook. Same discipline as the WhatsApp
// webhook above: verify the signature over the RAW body before trusting
// anything in it (src/infra/paymentProviders/razorpayProvider.js's
// verifyWebhookSignature, reusing the exact HMAC-over-raw-bytes pattern
// src/infra/verifySignature.js already established for Meta — not a
// second, different verification scheme). This is also the ONLY thing
// that ever flips a payment_pending booking to booked — never a client
// redirect/callback, which could be spoofed or simply never fire if the
// customer closes the browser tab.
app.post("/api/payments/webhook", asyncHandler(async (req, res) => {
  const signature = req.get("X-Razorpay-Signature");
  if (!razorpay.verifyWebhookSignature(req.rawBody, signature)) {
    log("WARN", "Rejected Razorpay webhook: invalid or missing signature.");
    return res.sendStatus(403);
  }
  res.sendStatus(200); // ack fast, same reasoning as the WhatsApp webhook

  const event = razorpay.parseWebhookEvent(req.body);
  if (!event) return; // an event type this integration has no opinion about

  const payment = event.orderId ? paymentStore.getByOrderId(event.orderId) : null;
  if (!payment) {
    log("WARN", `Razorpay webhook "${event.type}" for order ${event.orderId} matches no known payment row — ignoring.`);
    return;
  }
  const booking = bookings.getById(payment.tenantId, payment.bookingId);
  if (!booking) {
    log("ERROR", `Razorpay webhook "${event.type}" for payment ${payment.id} references booking ${payment.bookingId}, which no longer exists.`);
    return;
  }

  if (event.type === "payment.captured") {
    paymentStore.markPaid(payment.id, event.paymentId);
    bookings.updateStatus(payment.tenantId, booking.id, "booked");
    bookings.updatePaymentStatus(payment.tenantId, booking.id, "paid");
    recordAudit(payment.tenantId, { email: "razorpay-webhook", role: "system" }, "payment.captured", { bookingId: booking.bookingId, paymentId: event.paymentId, amount: event.amount });
    log("INFO", `Payment captured for booking ${booking.bookingId} (₹${event.amount / 100}) — booking confirmed.`);
    try {
      await sendWhatsAppText(payment.tenantId, booking.waId, `✅ Payment received! Your booking (${booking.bookingId}) is now confirmed. Reply STATUS anytime to check it.`);
    } catch (err) {
      log("WARN", `Payment-confirmed WhatsApp notification failed for ${booking.bookingId}: ${err.message}`);
    }
    await syncBookingCreated(payment.tenantId, booking, tenantWorkflowStore.get(payment.tenantId, booking.workflowId));
    publishBookingEvent(payment.tenantId, "booking.updated", { ...booking, status: "booked", paymentStatus: "paid" });
  } else if (event.type === "payment.failed") {
    paymentStore.markFailed(payment.id, event.failureReason);
    bookings.updatePaymentStatus(payment.tenantId, booking.id, "failed");
    // Booking stays payment_pending (NOT auto-cancelled) — Razorpay
    // payment links allow a retry on the same link, so cancelling the
    // slot here would yank it out from under a customer mid-retry. The
    // slot is released explicitly if/when the customer or provider
    // actually cancels, same as any other booking.
    recordAudit(payment.tenantId, { email: "razorpay-webhook", role: "system" }, "payment.failed", { bookingId: booking.bookingId, reason: event.failureReason });
    log("WARN", `Payment failed for booking ${booking.bookingId}: ${event.failureReason}`);
    publishBookingEvent(payment.tenantId, "booking.updated", { ...booking, paymentStatus: "failed" });
  } else if (event.type === "refund.processed") {
    log("INFO", `Refund processed for payment ${event.paymentId}, refund ${event.refundId} (₹${event.amount / 100}).`);
    // The refund itself was already recorded in `payments` at the point
    // it was INITIATED (server.js's manual-refund route / the
    // cancellation-triggered refund below) — this webhook confirms it
    // actually completed on Razorpay's side, which is worth logging but
    // doesn't need a second DB write for what this app already tracks.
  }
}));

// Voice notes: Sarvam transcribes -> normal text pipeline -> Sarvam speaks
// the reply back. Every failure mode here degrades to text rather than
// dropping the customer's message: no Sarvam key, an unsupported TTS
// language, or a synthesis error all still produce the full text reply.
async function handleVoiceMessage(tenantId, waId, message) {
  if (!isVoiceEnabled()) {
    log("WARN", `Voice note from ${waId} but SARVAM_API_KEY is not set — asking them to type instead.`);
    await sendWhatsAppText(tenantId, waId, "Sorry, I can't listen to voice notes right now — could you type your message instead?");
    return;
  }

  const mediaId = message.audio?.id || message.voice?.id;
  if (!mediaId) return;

  let transcript;
  let languageCode;
  try {
    const media = await downloadWhatsAppMedia(tenantId, mediaId);
    ({ transcript, languageCode } = await transcribeAudio(media.buffer, media.mimeType));
  } catch (err) {
    log("ERROR", `Voice transcription failed for ${waId}: ${err.message}`);
    await sendWhatsAppText(tenantId, waId, "Sorry, I couldn't make out that voice note. Could you try again, or type your message?");
    return;
  }

  if (!transcript) {
    await sendWhatsAppText(tenantId, waId, "I couldn't hear anything in that voice note — could you try again?");
    return;
  }
  log("INFO", `Voice note from ${waId} [${languageCode || "unknown"}]: "${transcript}"`);

  // Capture whatever the engine replies so it can be spoken back. The
  // engine itself is untouched and unaware this is a voice conversation.
  beginReplyCapture(waId);
  try {
    await handleIncomingMessage(tenantId, waId, transcript, tenantWorkflowStore.listForTenant(tenantId));
  } finally {
    const replyText = endReplyCapture(waId);
    if (replyText && languageCode) {
      try {
        const audio = await synthesizeSpeech(replyText, languageCode);
        if (audio) await sendWhatsAppAudio(tenantId, waId, audio, "audio/mpeg");
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

app.post("/api/simulate-whatsapp", asyncHandler(async (req, res) => {
  if (!simulateEndpointEnabled) return res.sendStatus(404);

  const { from, text, tenantId } = req.body || {};
  if (typeof from !== "string" || !from.trim() || typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "from and text are required and must be non-empty strings" });
  }
  // Defaults to the default tenant (id 1) — optional so every existing
  // curl/test call site from before Section 8 keeps working unchanged.
  const effectiveTenantId = Number.isInteger(tenantId) ? tenantId : 1;
  try {
    await handleIncomingMessage(effectiveTenantId, from, text, tenantWorkflowStore.listForTenant(effectiveTenantId));
    res.json({ ok: true, note: "Check the console / logs/app.log for the bot's reply." });
  } catch (err) {
    log("ERROR", `Simulate endpoint error: ${err.stack || err.message}`);
    // Same guarantee as the real webhook: an internal error still gets a
    // reply to the "customer" (waId), not just an API-level 500 to
    // whoever's testing — this endpoint exists specifically to exercise
    // the same pipeline the real webhook uses, so it should fail the same way too.
    try {
      await sendWhatsAppText(effectiveTenantId, from, "Sorry, something went wrong on my end — could you try that again?");
    } catch {
      // best-effort
    }
    res.status(500).json({ error: "Internal error — see logs/app.log for details." });
  }
}));

// ---------------------------------------------------------------------------
// Item 8 — the public marketing site's live chat widget. Deliberately a
// SEPARATE route from /api/simulate-whatsapp above, not a relaxed version
// of it, because the two have fundamentally different trust models:
// simulate-whatsapp accepts a client-chosen tenantId (a dev/test tool,
// disabled by default once real WhatsApp traffic is live) — accepting
// that same freedom here, on a route meant to be reachable by anyone on
// the internet with no login, would let a visitor inject fake messages
// into ANY real tenant's live conversation. This route can't do that even
// in principle: the tenant is hardcoded to DEMO_TENANT_ID, never read from
// the request. Safe to leave enabled permanently, independent of whether
// this install also has real WhatsApp/ALLOW_SIMULATE_ENDPOINT configured.
//
// `sessionId` is a random token the widget generates client-side (crypto.
// randomUUID(), stored in sessionStorage — gone when the tab closes) and
// is NOT treated as a real phone number; it's hashed into a synthetic
// waId so two concurrent visitors' demo conversations never collide, and
// so nothing here ever touches the shape a real WhatsApp id has.
// ---------------------------------------------------------------------------
function syntheticDemoWaId(sessionId) {
  const hash = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return `demo-${hash}`;
}

app.post("/api/demo/chat", asyncHandler(async (req, res) => {
  if (isDemoChatRateLimited(req.ip)) {
    return res.status(429).json({ error: "Too many demo messages from this connection — please wait a few minutes and try again." });
  }
  const { sessionId, text } = req.body || {};
  if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 200) {
    return res.status(400).json({ error: "sessionId is required." });
  }
  if (typeof text !== "string" || !text.trim() || text.length > 500) {
    return res.status(400).json({ error: "text is required and must be 500 characters or fewer." });
  }

  const waId = syntheticDemoWaId(sessionId.trim());
  beginReplyCapture(waId);
  try {
    await handleIncomingMessage(DEMO_TENANT_ID, waId, text.trim(), tenantWorkflowStore.listForTenant(DEMO_TENANT_ID));
    const reply = endReplyCapture(waId);
    res.json({ reply: reply || "..." });
  } catch (err) {
    endReplyCapture(waId);
    log("ERROR", `Demo chat error: ${err.stack || err.message}`);
    res.status(500).json({ reply: "Sorry, something went wrong on my end — could you try that again?" });
  }
}));


// ---------------------------------------------------------------------------
// Provider dashboard — one static page, same UI for every business type.
// "Login" is just picking yourself from a dropdown for now (explicitly
// deferred, not an oversight) — the dropdown is built from that tenant's
// own tenant_workflows rows, so a new provider added there shows up here
// automatically, no dashboard code changes needed.
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
    // Section 8.6 — a tenant-scoped user (everyone except platform_admin,
    // whose tenantId is always null) is re-checked against their tenant's
    // current lifecycle status on every request, same reasoning as the
    // `active` check just above: a tenant getting suspended must take
    // effect on the user's very next request, not linger until their
    // session naturally expires (up to 12h).
    //
    // New plan, Section 2 — "pending" now blocks here too, a deliberate
    // reversal of this route's own previous behavior. It used to be
    // explicitly NOT a hard gate (a self-signed-up admin got instant
    // dashboard access; "pending" existed only for a platform_admin's own
    // visibility). Account creation is now sales-assisted: a self-signup
    // creates a real, logged-in-capable account, but every dashboard
    // route stays blocked until a platform_admin reviews and activates it
    // (PATCH /api/platform/tenants/:id/status) — see README.
    if (liveUser.tenantId) {
      const tenant = tenantStore.getById(liveUser.tenantId);
      if (!tenant || tenant.status === "suspended" || tenant.status === "cancelled") {
        return res.status(403).json({ error: `This account's business is ${tenant?.status || "no longer available"}. Contact support if this seems wrong.` });
      }
      if (tenant.status === "pending") {
        return res.status(403).json({ error: "Your account is pending activation. Our team will be in touch shortly — contact support if it's been a while.", pendingActivation: true });
      }
    }
    if (allowedRoles.length && !allowedRoles.includes(liveUser.role)) {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    req.user = { uid: liveUser.id, email: liveUser.email, role: liveUser.role, name: liveUser.name, workflowId: liveUser.workflowId, providerId: liveUser.providerId, tenantId: liveUser.tenantId };
    next();
  };
}

// Section 14 — the Public API's own auth: `Authorization: Bearer bpk_...`,
// not a session cookie. A valid key resolves straight to a tenantId (the
// key itself proves which tenant, the way a session cookie proves which
// user) — no separate account/role concept on this path, since a Public
// API caller is a tenant's own backend system, not a human choosing
// between admin/provider views. Rate-limited per key (not per route) so
// a single misbehaving integration can't be worked around by hitting a
// different /api/v1/* endpoint.
function requireApiKey(req, res, next) {
  const header = req.get("Authorization") || "";
  const rawKey = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!rawKey) return res.status(401).json({ error: "Missing Authorization: Bearer <api key> header." });
  if (isApiRateLimited(rawKey)) return res.status(429).json({ error: "Rate limit exceeded — too many requests with this API key." });
  const tenantId = apiKeys.verify(rawKey);
  if (!tenantId) return res.status(401).json({ error: "Invalid or revoked API key." });
  const tenant = tenantStore.getById(tenantId);
  if (!tenant || tenant.status !== "active") {
    return res.status(403).json({ error: "This business's account is not currently active." });
  }
  req.apiTenantId = tenantId;
  next();
}

// Section 8.5 — platform_admin manages every tenant, so req.user.tenantId
// is always null for that role (see src/store/userStore.js). Every
// tenant-scoped store call in this file needs a real tenantId, so any
// route reachable by a platform_admin that ALSO does tenant-scoped work
// must resolve which tenant it's acting on some other way (a route param,
// a request body field) — never by silently falling back to a default.
// This helper just makes that requirement explicit and fails loudly
// rather than letting `undefined` silently reach a SQL query.
function requireTenantId(req) {
  if (!req.user.tenantId) {
    throw new Error(`requireTenantId() called for a request with no tenant context (role=${req.user.role}) — this route needs to resolve one explicitly instead of assuming req.user.tenantId.`);
  }
  return req.user.tenantId;
}

// New plan, Section 2 — verifies the signer actually owns the email
// before anything else happens. Deliberately loose about whether that
// email already has an account (uniform response either way) — telling
// an anonymous caller "that email's taken" is an enumeration leak this
// endpoint doesn't need to have; POST /api/signup below still gives the
// real "an account already exists" error, but only to someone who could
// also prove they own the code that address's real inbox received.
app.post("/api/signup/request-otp", asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (typeof email !== "string" || !email.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return res.status(400).json({ error: "A valid email is required." });
  }
  if (isOtpRateLimited(email.trim())) {
    log("WARN", `Signup OTP rate-limited for ${email.trim()}`);
    return res.status(429).json({ error: "Too many codes requested for this email. Please wait a while and try again." });
  }
  const code = createOtp(email.trim());
  await sendEmail(email.trim(), "Your BookPilot AI verification code", `Your verification code is ${code}. It expires in 10 minutes.`);
  res.json({ ok: true, message: "A verification code has been sent to that email." });
}));

// Self-serve signup — the missing link between the public marketing site
// and the dashboard: until now only a platform_admin could create a
// tenant (POST /api/platform/tenants). Creates the tenant AND its first
// admin account in one request (after verifying the OTP from
// POST /api/signup/request-otp above), then logs that admin in (same
// session-cookie mechanism as /api/auth/login below) — but landing a
// session doesn't mean landing in a working dashboard yet, see below.
//
// New tenants default to "pending" status (tenantStore.create's own
// behavior, same as a platform_admin-created one). Unlike before, this IS
// now a hard gate — requireAuth() blocks "pending" the same way it
// already blocked "suspended"/"cancelled" — so a self-signed-up admin can
// log in (the account is real) but every /api/dashboard/* route 403s
// with a clear "pending activation" message until a platform_admin
// reviews and activates the tenant (PATCH /api/platform/tenants/:id/status).
// This is a deliberate reversal of this route's own previous behavior
// (instant self-serve dashboard access) — see README's "Account creation
// & activation" section for why.
app.post("/api/signup", asyncHandler(async (req, res) => {
  if (!process.env.SESSION_SECRET) {
    return res.status(500).json({ error: "Server misconfigured: SESSION_SECRET is not set." });
  }
  if (isSignupRateLimited(req.ip)) {
    log("WARN", `Signup rate-limited for ${req.ip}`);
    return res.status(429).json({ error: "Too many signup attempts. Try again in a while." });
  }

  const { businessName, ownerName, email, password, otp } = req.body || {};
  if (typeof businessName !== "string" || !businessName.trim()) {
    return res.status(400).json({ error: "Business name is required." });
  }
  if (typeof email !== "string" || !email.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return res.status(400).json({ error: "A valid email is required." });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  if (!verifyOtp(email.trim(), otp)) {
    return res.status(400).json({ error: "That verification code is invalid or has expired. Request a new one and try again." });
  }

  // Derive a URL-safe slug from the business name, same character rules
  // POST /api/platform/tenants already enforces (lowercase, digits,
  // dashes) — then de-duplicate against existing tenants by suffixing
  // -2, -3, ... rather than rejecting the signup over a name collision a
  // customer has no way to resolve themselves (unlike the platform_admin
  // form, there's no separate "slug" field on this one).
  const baseSlug = businessName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "business";
  let slug = baseSlug;
  for (let suffix = 2; tenantStore.getBySlug(slug); suffix++) {
    slug = `${baseSlug}-${suffix}`;
  }

  let tenant;
  try {
    tenant = tenantStore.create({ name: businessName.trim(), slug, plan: "free", billingEmail: email.trim() });
  } catch (err) {
    if (err.code === "DUPLICATE_SLUG") return res.status(409).json({ error: "A business with a very similar name already exists — try a slightly different name." });
    throw err;
  }
  // Item 5 — every brand new tenant starts from its own editable copy of
  // the demo catalog (workflows/*.json), so the dashboard isn't empty on
  // first login. Independent from every other tenant's copy from this
  // point on — editing one never touches another's.
  tenantWorkflowStore.seedDefaultsForTenant(tenant.id);

  let user;
  try {
    user = users.create({ email: email.trim(), password, role: "admin", name: (ownerName || "").trim() || null, tenantId: tenant.id });
  } catch (err) {
    if (err.code === "DUPLICATE_EMAIL") return res.status(409).json({ error: "An account already exists for that email — try logging in instead." });
    throw err;
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
  recordAudit(tenant.id, user, "tenant.self_signup", { name: tenant.name, slug: tenant.slug });
  // 🔔 — deliberately distinct from every other INFO log line in this
  // file, so a platform admin tailing/grepping logs.app.log can find
  // exactly the events that need their action, the same way a real
  // notification would surface — see README's "Account creation &
  // activation" section for the honest gap this is standing in for (no
  // real email/Slack notification channel exists yet).
  log("INFO", `🔔 New signup pending activation: "${tenant.name}" (${tenant.slug}, tenant id ${tenant.id}) — ${user.email}`);
  res.status(201).json({
    ok: true,
    pending: true,
    user: { email: user.email, role: user.role, name: user.name, tenantId: user.tenantId },
  });
}));

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
  recordAudit(user.tenantId, user, "login", null);
  res.json({ ok: true, user: { email: user.email, role: user.role, name: user.name, workflowId: user.workflowId, providerId: user.providerId, tenantId: user.tenantId } });
});

// Section 6 — self-serve password reset. Before this, a lost password
// meant an admin had to re-create the account (`users.create()`), which
// doesn't even work for the ONE admin account on a single-admin install.
// Deliberately returns the identical response whether or not the email
// exists — a different response ("no account found" vs "email sent")
// would let anyone probe which emails have accounts on this system, a
// real (if minor) information leak the login endpoint doesn't have
// (login already fails identically for "wrong password" and "no such
// user"). Rate-limited the same way login attempts are, keyed separately
// so exhausting one doesn't exhaust the other.
app.post("/api/auth/forgot-password", asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (typeof email !== "string" || !email.trim()) {
    return res.status(400).json({ error: "email is required" });
  }
  const rateLimitKey = `reset:${req.ip}:${email.trim().toLowerCase()}`;
  if (isLoginRateLimited(rateLimitKey)) {
    log("WARN", `Password reset rate-limited for ${rateLimitKey}`);
    return res.status(429).json({ error: "Too many reset requests. Try again in a few minutes." });
  }

  const user = users.findByEmail(email.trim());
  if (user && user.active) {
    const rawToken = createResetToken(user.id);
    const resetLink = `${req.protocol}://${req.get("host")}/dashboard?resetToken=${rawToken}`;
    await sendEmail(
      user.email,
      "Reset your BookPilot AI password",
      `Someone requested a password reset for this account. If this was you, set a new password here (valid for 1 hour, works once):\n\n${resetLink}\n\nIf you didn't request this, you can ignore this email.`
    );
    recordAudit(user.tenantId, user, "password_reset.requested", null);
  } else {
    log("INFO", `Password reset requested for unknown/inactive email: ${email.trim()}`);
  }

  // Same message either way — see comment above.
  res.json({ ok: true, message: "If an account exists for that email, a reset link has been sent." });
}));

app.post("/api/auth/reset-password", (req, res) => {
  const { token, newPassword } = req.body || {};
  if (typeof token !== "string" || !token) return res.status(400).json({ error: "token is required" });
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const userId = consumeResetToken(token);
  if (!userId) return res.status(400).json({ error: "That reset link is invalid, expired, or already used. Request a new one." });

  const user = users.setPassword(userId, newPassword);
  recordAudit(user.tenantId, user, "password_reset.completed", null);
  log("INFO", `Password reset completed for ${user.email}`);
  res.json({ ok: true, message: "Password updated. You can log in with your new password now." });
});

app.post("/api/auth/logout", (req, res) => {
  const session = getSessionUser(req);
  // The token payload itself has no tenantId (deliberately — see
  // requireAuth()'s comment on always re-reading the live row); a quick
  // lookup here is cheap and keeps this audit entry correctly attributed.
  if (session) recordAudit(users.getById(session.uid)?.tenantId ?? null, session, "logout", null);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", requireAuth(), (req, res) => {
  res.json({ email: req.user.email, role: req.user.role, name: req.user.name, workflowId: req.user.workflowId, providerId: req.user.providerId });
});

function listAllProviders(tenantId) {
  const list = [];
  for (const workflow of Object.values(tenantWorkflowStore.listForTenant(tenantId))) {
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

// Item 4 — /dashboard was the hand-rolled dashboard.html shell; that file
// reached full feature parity in the React/Vite app (frontend/, built via
// `npm run build` there into public/app/) and has been deleted, so old
// links/bookmarks/the Google OAuth callback below just redirect to the
// real thing now. No client-side router in the React app (it's a single
// view that switches between Provider/Admin in-place), so no SPA-fallback
// wildcard is needed beyond serving the built directory statically.
app.get("/dashboard", (req, res) => {
  res.redirect(302, "/app");
});
app.use("/app", express.static(path.join(__dirname, "public", "app")));

// Public marketing site (public/marketing/) — plain HTML/CSS/JS, same
// "static files served by Express" pattern as /dashboard and /app above,
// no build step. This is now what "/" serves instead of the old
// plain-text status line; the JSON health check moved to /healthz.
app.use("/marketing", express.static(path.join(__dirname, "public", "marketing")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "marketing", "index.html"));
});
app.get("/signup", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "marketing", "signup.html"));
});

// Item 7 — the go-live journey's persistent checklist. Computed live from
// real state every call (no separate "wizard progress" table to keep in
// sync or let drift) — each item's `done` is a genuine fact about the
// tenant (has any workflow been customized, is a real WhatsApp number
// connected, is there more than just the founding admin, has a booking
// ever landed), not a step someone can check off without doing it.
// `dismissed` persists in the tenant's own feature_flags_json (Section 8's
// existing per-tenant config store) — no schema change needed for it.
app.get("/api/dashboard/setup-checklist", requireAuth("admin"), (req, res) => {
  const tenant = tenantStore.getById(req.user.tenantId);
  const teamCount = users.list(req.user.tenantId).length;
  const bookingCount = bookings.values(req.user.tenantId).length;

  const items = [
    {
      id: "customize-business",
      label: "Customize your first business",
      done: tenantWorkflowStore.hasCustomizations(req.user.tenantId),
      hint: "Edit or add a business under Manage Businesses — the demo catalog is just a starting point, not your real menu.",
    },
    {
      id: "connect-whatsapp",
      label: "Connect your WhatsApp number",
      done: !!tenant?.whatsappPhoneNumberId,
      hint: "Ask an admin to set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID — or keep testing with simulated messages for now.",
    },
    {
      id: "invite-team",
      label: "Invite your team",
      done: teamCount > 1,
      hint: "Add a login for each provider under Manage Team, so everyone only sees their own bookings.",
    },
    {
      id: "first-booking",
      label: "Get your first booking",
      done: bookingCount > 0,
      hint: "Message your WhatsApp number (or try the simulate endpoint) to see a real booking land here.",
    },
  ];

  res.json({
    items,
    allDone: items.every((i) => i.done),
    dismissed: !!tenant?.featureFlags?.setupChecklistDismissed,
  });
});

app.post("/api/dashboard/setup-checklist/dismiss", requireAuth("admin"), (req, res) => {
  const tenant = tenantStore.getById(req.user.tenantId);
  tenantStore.updateConfig(req.user.tenantId, { featureFlags: { ...tenant.featureFlags, setupChecklistDismissed: true } });
  res.json({ ok: true });
});

app.get("/api/dashboard/providers", requireAuth("admin", "provider"), (req, res) => {
  const all = listAllProviders(req.user.tenantId);
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
  res.json(bookings.values(req.user.tenantId));
});

app.get("/api/dashboard/audit-log", requireAuth("admin"), (req, res) => {
  res.json(listAudit(req.user.tenantId));
});

// Backups (Section 5.1) — automated on a schedule (see scheduleBackups()
// near app.listen below), plus a manual trigger and a list so an operator
// can actually see backups are happening rather than trusting they are.
// Section 8 — platform_admin only, not a tenant admin: a backup captures
// the ENTIRE database file, every tenant's data at once. Letting a
// tenant's own admin trigger or even see backup timestamps/filenames for
// the whole platform is a real (if narrow) cross-tenant information leak
// this file used to have from before multi-tenancy existed — closed here,
// not carried forward silently.
app.get("/api/dashboard/backups", requireAuth("platform_admin"), (req, res) => {
  res.json(listBackups());
});

app.post("/api/dashboard/backups", requireAuth("platform_admin"), asyncHandler(async (req, res) => {
  const result = await runBackup();
  recordAudit(null, req.user, "backup.manual", result);
  if (!result.ok) return res.status(500).json(result);
  res.status(201).json(result);
}));

// Durable outbound queue (Section 5.3) — visibility into proactive sends
// (arrival alerts, feedback requests) that failed their immediate retries
// and are now waiting on the background worker (see startOutboundQueueWorker()
// near app.listen below).
app.get("/api/dashboard/outbound-queue", requireAuth("admin"), (req, res) => {
  res.json({ counts: outboundQueueStore.statusCounts(req.user.tenantId), recent: outboundQueueStore.listRecent(req.user.tenantId) });
});

// Section 5.4 — the two rates worth an admin's attention at a glance: how
// often the app is erroring (webhook handling, Groq calls, DB writes —
// anything logged at ERROR), and how often proactive WhatsApp sends are
// failing even after retries. Both are already tracked durably/in-memory
// elsewhere (src/alerting.js, src/outboundQueueStore.js) — this just
// surfaces them together in one place instead of an operator having to
// know to check two different things.
app.get("/api/dashboard/alerts", requireAuth("admin"), (req, res) => {
  // errorRate is deliberately global, not tenant-scoped — it's a signal
  // about this one Node process's overall health (Groq/DB/webhook
  // errors), not about any tenant's business data, so a tenant admin
  // seeing "the platform had N errors recently" isn't a meaningful leak
  // the way seeing another tenant's bookings/backups would be.
  const outboundCounts = outboundQueueStore.statusCounts(req.user.tenantId);
  const outboundTotal = outboundCounts.pending + outboundCounts.sent + outboundCounts.failed;
  res.json({
    errorRate: getErrorRate(),
    outboundQueue: {
      ...outboundCounts,
      failureRate: outboundTotal > 0 ? outboundCounts.failed / outboundTotal : 0,
    },
  });
});

// Business/workflow management — admin only, and (Item 5) tenant-scoped:
// every read/write here goes through tenantWorkflowStore keyed on
// req.user.tenantId, so a save/delete here takes effect immediately for
// that tenant's own WhatsApp bot and dashboard, and is invisible to every
// other tenant, no restart needed.
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
  res.json(tenantWorkflowStore.listForTenant(req.user.tenantId));
});

// AI Workflow Generator — drafts a workflow from a plain-language
// description, but never writes anything. The admin reviews/edits the
// draft in the same modal used for hand-written JSON, and only the
// existing POST /api/dashboard/workflows below (with its own
// validateWorkflowShape check) actually persists it.
app.post("/api/dashboard/workflows/generate", requireAuth("admin"), asyncHandler(async (req, res) => {
  const { description } = req.body || {};
  if (typeof description !== "string" || !description.trim()) {
    return res.status(400).json({ error: "A business description is required." });
  }
  try {
    const workflow = await generateWorkflowFromDescription(description.trim());
    const validationWarning = validateWorkflowShape(workflow);
    recordAudit(req.user.tenantId, req.user, "workflow.generate", { description: description.trim().slice(0, 200), valid: !validationWarning });
    res.json({ workflow, validationWarning: validationWarning || null });
  } catch (err) {
    log("ERROR", `Workflow generation failed: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
}));


app.post("/api/dashboard/workflows", requireAuth("admin"), (req, res) => {
  const workflow = req.body;
  const validationError = validateWorkflowShape(workflow);
  if (validationError) return res.status(400).json({ error: validationError });

  const isUpdate = !!tenantWorkflowStore.get(req.user.tenantId, workflow.id);
  tenantWorkflowStore.upsert(req.user.tenantId, workflow);
  recordAudit(req.user.tenantId, req.user, isUpdate ? "workflow.update" : "workflow.create", { workflowId: workflow.id });
  log("INFO", `${req.user.email} ${isUpdate ? "updated" : "created"} workflow "${workflow.id}"`);
  res.status(isUpdate ? 200 : 201).json({ ok: true });
});

app.delete("/api/dashboard/workflows/:id", requireAuth("admin"), (req, res) => {
  const id = req.params.id;
  if (!tenantWorkflowStore.get(req.user.tenantId, id)) return res.status(404).json({ error: "Unknown workflowId" });
  tenantWorkflowStore.remove(req.user.tenantId, id);
  recordAudit(req.user.tenantId, req.user, "workflow.delete", { workflowId: id });
  log("INFO", `${req.user.email} deleted workflow "${id}"`);
  res.json({ ok: true });
});

// Team management — admin only. This is what makes "every business gets
// its own login and only sees its own data" self-serve instead of a CLI
// step: an admin creates one account per doctor/stylist/room here, each
// pinned to exactly one workflowId+providerId, and requireAuth() + the
// per-route ownership checks above do the actual isolation.
// Section 14 — API key management for the Public API above. Admin-only,
// same as Manage Team: issuing a credential another system can act with
// is exactly the kind of action a provider account shouldn't have.
app.get("/api/dashboard/api-keys", requireAuth("admin"), (req, res) => {
  res.json(apiKeys.listForTenant(req.user.tenantId));
});

app.post("/api/dashboard/api-keys", requireAuth("admin"), (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "A name for this key is required (e.g. \"Website integration\")." });
  const { key, record } = apiKeys.create(req.user.tenantId, name.trim().slice(0, 100));
  recordAudit(req.user.tenantId, req.user, "api_key.create", { id: record.id, name: record.name });
  log("INFO", `${req.user.email} created API key "${record.name}" (${record.keyPrefix}...).`);
  // The only response that will ever carry the full raw key — shown to
  // the admin exactly once, matching the create/record split in
  // src/store/apiKeyStore.js's own doc comment.
  res.status(201).json({ key, record });
});

app.delete("/api/dashboard/api-keys/:id", requireAuth("admin"), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  apiKeys.revoke(req.user.tenantId, id);
  recordAudit(req.user.tenantId, req.user, "api_key.revoke", { id });
  log("INFO", `${req.user.email} revoked API key ${id}.`);
  res.json({ ok: true });
});

app.get("/api/dashboard/users", requireAuth("admin"), (req, res) => {
  res.json(users.list(req.user.tenantId));
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
    const matches = listAllProviders(req.user.tenantId).some((p) => p.workflowId === workflowId && p.providerId === providerId);
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
      tenantId: req.user.tenantId,
    });
    recordAudit(req.user.tenantId, req.user, "user.create", { email: user.email, role: user.role, workflowId: user.workflowId, providerId: user.providerId });
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
  const user = users.setActive(req.user.tenantId, id, req.body.active);
  if (!user) return res.status(404).json({ error: "Not found" });
  recordAudit(req.user.tenantId, req.user, user.active ? "user.activate" : "user.deactivate", { email: user.email });
  res.json(user);
});

app.get("/api/dashboard/bookings", requireAuth("admin", "provider"), (req, res) => {
  // A provider session is pinned to exactly one workflowId+providerId —
  // for that role the query params are ignored outright (not merely
  // validated), so there's no way to read someone else's bookings by
  // editing the URL.
  const { workflowId, providerId } = req.user.role === "provider" ? req.user : req.query;
  if (!workflowId || !providerId) return res.status(400).json({ error: "workflowId and providerId query params are required" });
  const rows = bookings.values(req.user.tenantId).filter((b) => b.workflowId === workflowId && b.providerId === providerId);
  rows.sort((a, b) => b.createdAt - a.createdAt);
  res.json(rows);
});

// Provider-initiated cancel or reschedule.  When a provider cancels or
// reschedules a booking from the dashboard, the customer gets a WhatsApp
// message immediately so they aren't left waiting for an appointment that
// no longer exists.  Providers can only act on their OWN bookings (enforced
// by checking workflowId+providerId against the authenticated session).
app.patch("/api/dashboard/bookings/:id", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid booking id" });

  const booking = bookings.getById(req.user.tenantId, id);
  if (!booking) return res.status(404).json({ error: "Booking not found" });

  // Provider role: scope check — they cannot touch another provider's booking.
  if (req.user.role === "provider" &&
      (booking.workflowId !== req.user.workflowId || booking.providerId !== req.user.providerId)) {
    return res.status(403).json({ error: "You can only manage your own bookings." });
  }

  const { action, rescheduleDate, rescheduleTime, note } = req.body || {};

  if (action === "cancel") {
    if (booking.status === "cancelled") return res.status(400).json({ error: "Booking is already cancelled." });
    // Real bug, found live during an exhaustive endpoint-testing pass: this
    // check previously only excluded "cancelled" by name, so a "done" (or
    // "no_show") booking — a finished, historical record — could be
    // silently flipped to "cancelled" and even trigger a refund via
    // refundIfPaid() below for a service that had already been rendered.
    // A terminal state should stay terminal; if a completed booking
    // genuinely needs undoing, that's a manual DB/support action, not a
    // one-click dashboard button with no confirmation of what it implies.
    // isTerminal() (Item 6's bookingStateMachine.js) is the single shared
    // definition of "terminal" every status-changing action below uses —
    // this exact bug shape (excluding one terminal status by name instead
    // of terminal-ness itself) recurred enough times in this file that a
    // hand-written list here was the actual bug, not a one-off typo.
    if (isTerminal(booking.status)) {
      return res.status(400).json({ error: `Cannot cancel a booking that's already marked ${booking.status.replace("_", "-")} — it's a completed record, not an active one.` });
    }

    const updated = bookings.updateWithMeta(req.user.tenantId, id, {
      status: "cancelled",
      cancelledBy: req.user.email,
      rescheduleNote: note || null,
    });

    recordAudit(req.user.tenantId, req.user, "booking.cancel", {
      bookingId: booking.bookingId, waId: booking.waId, workflowId: booking.workflowId, note: note || null,
    });
    log("INFO", `${req.user.email} cancelled booking ${booking.bookingId} for ${booking.waId}`);

    // Section 9.7 — a provider-initiated cancellation refunds automatically
    // (workflow.refundPolicy.providerCancellation can still say "none").
    // Never blocks the cancellation itself on a refund failure — see
    // src/engine/paymentRefunds.js's own comment for why.
    const refundResult = await refundIfPaid(req.user.tenantId, booking, {
      initiatedBy: "provider",
      refundPolicy: tenantWorkflowStore.get(req.user.tenantId, booking.workflowId)?.refundPolicy,
    });

    // Notify the customer on WhatsApp.
    const providerLabel = booking.providerName || "your provider";
    const whenLabel = booking.visitDateLabel || booking.visitDate || booking.checkInIso || "";
    const timeLabel = booking.visitTime ? ` at ${booking.visitTime}` : "";
    const noteText = note ? `\n\nNote from provider: "${note}"` : "";
    const refundText = refundResult.refunded ? `\n\n💳 A refund of ₹${refundResult.amount / 100} has been issued.` : "";
    const msg =
      `❌ Your booking (${booking.bookingId}) with ${providerLabel}` +
      `${whenLabel ? " on " + whenLabel : ""}${timeLabel} has been cancelled by the provider.` +
      noteText + refundText +
      `\n\nIf you'd like to rebook, simply message us and we'll find you a new slot.`;

    try {
      await sendWhatsAppText(booking.tenantId, booking.waId, msg);
    } catch (err) {
      log("WARN", `WhatsApp notification failed for cancel of ${booking.bookingId}: ${err.message}`);
    }

    await syncBookingCancelled(req.user.tenantId, booking);
    publishBookingEvent(req.user.tenantId, "booking.updated", updated);

    return res.json({ ok: true, booking: updated, refund: refundResult });
  }

  if (action === "reschedule") {
    if (!rescheduleDate || typeof rescheduleDate !== "string") {
      return res.status(400).json({ error: "rescheduleDate (YYYY-MM-DD) is required for reschedule." });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rescheduleDate)) {
      return res.status(400).json({ error: "rescheduleDate must be in YYYY-MM-DD format." });
    }
    // Same real bug as the cancel branch above, same fix (now via the
    // shared isTerminal() check): a "done"/"no_show"/"cancelled" booking
    // (a finished, historical record) could be silently rewritten back to
    // "booked" with a new date/time, which is exactly the "un-complete a
    // finished appointment" bug found live in this same pass. Live-verified
    // before this fix: completing a booking, then rescheduling it, flipped
    // its status straight back to "booked" with no warning. "serving" is
    // additionally blocked here — a reschedule-specific rule, not a
    // terminal-status one — since the customer is being served RIGHT NOW.
    if (isTerminal(booking.status) || booking.status === "serving") {
      return res.status(400).json({ error: `Cannot reschedule a booking that's ${booking.status === "serving" ? "currently being served" : `already marked ${booking.status.replace("_", "-")}`} — cancel and create a new booking instead.` });
    }
    // Reschedule moves a single time-slot booking to a new date/time — a
    // hotel stay is a date RANGE (checkInIso + nights), a fundamentally
    // different shape this single-date/single-time modal can't represent.
    // Rather than silently write a half-correct visit_date onto a booking
    // that doesn't actually use it, refuse outright (same call the
    // dashboard already makes for hotel availability blocking — see
    // README's Availability section).
    if (!booking.visitTime || !booking.visitDate) {
      return res.status(400).json({ error: "Reschedule only supports time-slot bookings, not hotel stays. Cancel and create a new booking for a date-range change." });
    }

    const oldWhen = (booking.visitDateLabel || booking.visitDate || "") + (booking.visitTime ? ` at ${booking.visitTime}` : "");

    let updated;
    try {
      updated = bookings.updateWithMeta(req.user.tenantId, id, {
        // Back to "booked" — the appointment simply has a new date/time
        // now. Not a distinct state anything else in the system (STATUS,
        // queue position, arrival alerts) needs to know how to handle.
        status: "booked",
        cancelledBy: req.user.email,
        rescheduledDate: rescheduleDate,
        rescheduledTime: rescheduleTime || null,
        rescheduleNote: note || null,
        // The actual fix: visit_date/visit_time are what STATUS, the
        // queue, the dashboard, and the UNIQUE slot index all read — they
        // used to stay frozen at the ORIGINAL booking time forever, so a
        // "rescheduled" booking silently reported stale info everywhere
        // and its old slot stayed permanently blocked for other customers.
        visitDate: rescheduleDate,
        visitTime: rescheduleTime || null,
        visitDateLabel: formatLongDate(parseIsoDate(rescheduleDate)),
      });
    } catch (err) {
      if (err instanceof bookings.SlotTakenError) {
        return res.status(409).json({ error: "That slot is already booked. Choose a different date/time." });
      }
      throw err;
    }

    recordAudit(req.user.tenantId, req.user, "booking.reschedule", {
      bookingId: booking.bookingId, waId: booking.waId,
      oldDate: booking.visitDate, oldTime: booking.visitTime,
      newDate: rescheduleDate, newTime: rescheduleTime || null, note: note || null,
    });
    log("INFO", `${req.user.email} rescheduled booking ${booking.bookingId} for ${booking.waId} → ${rescheduleDate} ${rescheduleTime || ""}`);

    // Notify the customer.
    const providerLabel = booking.providerName || "your provider";
    const newWhen = rescheduleDate + (rescheduleTime ? ` at ${rescheduleTime}` : "");
    const noteText = note ? `\n\nMessage from provider: "${note}"` : "";
    const msg =
      `📅 Your booking (${booking.bookingId}) with ${providerLabel} has been rescheduled by the provider.` +
      (oldWhen ? `\n\nOld: ${oldWhen}` : "") +
      `\nNew: ${newWhen}` +
      noteText +
      `\n\nReply STATUS to see your updated booking details.`;

    try {
      await sendWhatsAppText(booking.tenantId, booking.waId, msg);
    } catch (err) {
      log("WARN", `WhatsApp notification failed for reschedule of ${booking.bookingId}: ${err.message}`);
    }

    await syncBookingRescheduled(req.user.tenantId, updated, tenantWorkflowStore.get(req.user.tenantId, updated.workflowId));
    publishBookingEvent(req.user.tenantId, "booking.updated", updated);

    return res.json({ ok: true, booking: updated });
  }

  if (action === "serve" || action === "complete") {
    // "serve" (currently-being-seen, Section 3's queue) only makes sense
    // for a time-slot booking. "complete" (Section 4's post-appointment
    // notes/feedback) applies to a hotel stay too — a checkout is a
    // completion worth asking about, it just doesn't participate in
    // queue-position math the way a same-day appointment does.
    if (action === "serve" && (!booking.visitTime || !booking.visitDate)) {
      return res.status(400).json({ error: "Serve only applies to a time-slot booking." });
    }
    // Same terminal-status bug shape as the cancel/reschedule branches
    // above, closed here too: this guard used to only name "cancelled"
    // and "done", so a "no_show" booking could still be marked "serving"
    // or "done" — business-nonsensical (a no-show is, by definition, a
    // completed record of the customer never arriving) but not actually
    // blocked before this. isTerminal() catches all three uniformly.
    if (isTerminal(booking.status)) {
      return res.status(400).json({ error: `Cannot ${action} a booking that's already marked ${booking.status.replace("_", "-")}.` });
    }

    // `note` already destructured from req.body above, alongside action/
    // rescheduleDate/rescheduleTime — no separate `body` variable exists
    // in this route (unlike the availability route, which does use one).
    const cappedNote = typeof note === "string" ? note.slice(0, 500) : null;

    // Handoff: only one booking is "being served" at a time per provider —
    // starting a new one implicitly finishes whatever was previously in
    // that state, rather than leaving two bookings simultaneously marked
    // "serving" (which would double-count in the queue position math).
    if (action === "serve") {
      for (const other of bookings.values(req.user.tenantId)) {
        if (other.id !== booking.id && other.workflowId === booking.workflowId && other.providerId === booking.providerId &&
            other.visitDate === booking.visitDate && other.status === "serving") {
          bookings.updateWithMeta(req.user.tenantId, other.id, { status: "done" });
        }
      }
    }

    const newStatus = action === "serve" ? "serving" : "done";
    const updated = bookings.updateWithMeta(req.user.tenantId, id, {
      status: newStatus,
      providerNote: cappedNote,
      feedbackRequestedAt: action === "complete" ? Date.now() : null,
    });
    recordAudit(req.user.tenantId, req.user, `booking.${action}`, { bookingId: booking.bookingId, waId: booking.waId, note: cappedNote });
    log("INFO", `${req.user.email} marked booking ${booking.bookingId} as ${newStatus}`);

    if (action === "serve" && booking.visitTime) {
      // Section 3.4 — everyone else in today's queue may have just moved
      // up a position; find anyone who newly crossed into "you're next"
      // and ping them, at most once each (tracked via alerted_next).
      await notifyQueueShifts(req.user.tenantId, booking.workflowId, booking.providerId, booking.visitDate, id);
    }

    if (action === "complete") {
      // Section 4.2 — the provider's note (if any) plus a feedback ask.
      // The customer's NEXT free-text reply gets captured as feedback by
      // workflowEngine.js checking feedback_requested_at before running
      // normal intent detection, not by anything tracked here.
      const providerLabel = booking.providerName || "your provider";
      const noteText = cappedNote ? `\n\n📝 Note from ${providerLabel}: "${cappedNote}"` : "";
      const msg =
        `✅ Your visit with ${providerLabel} is complete.${noteText}\n\n` +
        "How was it? Reply with a quick rating (1-5) or a few words — it helps us improve.";
      const sent = await sendWithRetry(booking.tenantId, booking.waId, msg);
      if (!sent) log("WARN", `Completion/feedback-request message to ${booking.waId} for booking ${booking.bookingId} queued for durable retry after immediate attempts failed.`);
    }

    publishBookingEvent(req.user.tenantId, "booking.updated", updated);
    return res.json({ ok: true, booking: updated });
  }

  // Section 9.6 — no-show fee handling. Only makes sense for a time-slot
  // booking (a hotel no-show is a different problem — a stay simply not
  // checked into — not modeled here). Default policy is to RETAIN any
  // deposit already collected, since that's the entire point of a
  // no-show deterrent deposit; a workflow can explicitly opt back into
  // refunding no-shows anyway via `refundPolicy.noShow: "refund"`.
  //
  // The plan's other no-show model — charging a SAVED payment method only
  // when a no-show actually happens, for a workflow that doesn't want to
  // collect anything upfront — is deliberately NOT implemented here: it
  // needs Razorpay's card tokenization API and a real customer consent
  // flow for storing a card on file, which is a materially different (and
  // materially larger) feature than everything else in this section, not
  // a same-shape extension of it. Flagged here rather than half-built.
  if (action === "no_show") {
    if (!booking.visitTime || !booking.visitDate) {
      return res.status(400).json({ error: "no_show only applies to a time-slot booking." });
    }
    if (isTerminal(booking.status)) {
      return res.status(400).json({ error: `Cannot mark a ${booking.status} booking as no-show.` });
    }

    const updated = bookings.updateWithMeta(req.user.tenantId, id, { status: "no_show", providerNote: typeof note === "string" ? note.slice(0, 500) : null });
    const policy = tenantWorkflowStore.get(req.user.tenantId, booking.workflowId)?.refundPolicy?.noShow;
    let refundResult = { refunded: false };
    if (policy === "refund") {
      refundResult = await refundIfPaid(req.user.tenantId, booking, { initiatedBy: "provider", refundPolicy: { providerCancellation: "full" } });
    } else {
      const hadPaidDeposit = paymentStore.listForBooking(req.user.tenantId, booking.id).some((p) => p.status === "paid");
      if (hadPaidDeposit) log("INFO", `Deposit retained for no-show booking ${booking.bookingId} (policy: retain, the default).`);
    }
    recordAudit(req.user.tenantId, req.user, "booking.no_show", { bookingId: booking.bookingId, waId: booking.waId, refunded: refundResult.refunded });
    log("INFO", `${req.user.email} marked booking ${booking.bookingId} as no-show.`);
    publishBookingEvent(req.user.tenantId, "booking.updated", updated);
    return res.json({ ok: true, booking: updated, refund: refundResult });
  }

  return res.status(400).json({ error: 'action must be "cancel", "reschedule", "serve", "complete", or "no_show".' });
}));

// Recomputes live queue position for everyone else still active in this
// provider's queue for this date and sends a one-time "you're next" alert
// to anyone who just crossed into position 0 — called after any action
// that could shift the queue (serve/complete). Best-effort: uses
// sendWithRetry (Section 3.6's stopgap retry) so a transient WhatsApp API
// failure doesn't just silently drop the alert, but a failure here never
// blocks or fails the triggering request itself.
async function notifyQueueShifts(tenantId, workflowId, providerId, date, excludeId) {
  for (const other of sameQueueBookings(tenantId, workflowId, providerId, date, excludeId)) {
    const position = computeQueuePosition(other);
    if (position !== 0) continue;
    if (wasAlerted(tenantId, other.id)) continue;
    if (isOptedOutOfAlerts(other.waId)) continue;

    markAlerted(tenantId, other.id); // mark first — never re-attempt-storm the same alert if the send itself throws
    const sent = await sendWithRetry(
      tenantId,
      other.waId,
      `🔔 You're next! ${other.providerName} will see you shortly for your ${other.visitTime} appointment.\n\n(Reply STOP ALERTS to turn these off.)`
    );
    if (!sent) log("WARN", `"You're next" alert to ${other.waId} for booking ${other.bookingId} queued for durable retry after immediate attempts failed.`);
  }
}



app.get("/api/dashboard/availability", requireAuth("admin", "provider"), (req, res) => {
  const { workflowId, providerId } = req.user.role === "provider" ? req.user : req.query;
  if (!workflowId || !providerId) return res.status(400).json({ error: "workflowId and providerId query params are required" });
  res.json(listBlocksForProvider(req.user.tenantId, workflowId, providerId));
});

app.post("/api/dashboard/availability", requireAuth("admin", "provider"), (req, res) => {
  const body = req.body || {};
  const workflowId = req.user.role === "provider" ? req.user.workflowId : body.workflowId;
  const providerId = req.user.role === "provider" ? req.user.providerId : body.providerId;
  const { date, time, endTime, reason } = body;
  if (typeof workflowId !== "string" || typeof providerId !== "string" || typeof date !== "string") {
    return res.status(400).json({ error: "workflowId, providerId, and date are required strings" });
  }
  if (!tenantWorkflowStore.get(req.user.tenantId, workflowId)) return res.status(400).json({ error: "Unknown workflowId" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
  if (time !== undefined && time !== null && typeof time !== "string") {
    return res.status(400).json({ error: "time must be a string (or omitted to block the whole day)" });
  }
  if (endTime !== undefined && endTime !== null && typeof endTime !== "string") {
    return res.status(400).json({ error: "endTime must be a string, or omitted" });
  }
  if (endTime && !time) {
    return res.status(400).json({ error: "endTime needs a time (the range's start) too." });
  }
  // 2.4: start < end, checked server-side regardless of what the <input
  // type="time"> pair in the dashboard already enforces client-side.
  if (time && endTime && timeToMinutes(endTime) <= timeToMinutes(time)) {
    return res.status(400).json({ error: "endTime must be after time." });
  }

  const cappedReason = typeof reason === "string" ? reason.slice(0, 200) : null;
  blockSlot(req.user.tenantId, workflowId, providerId, date, time || null, endTime || null, cappedReason);
  recordAudit(req.user.tenantId, req.user, "availability.block", { workflowId, providerId, date, time: time || null, endTime: endTime || null, reason: cappedReason });

  // Advisory, not a hard reject — surface which existing bookings fall
  // inside the new block so the provider can decide whether to also
  // cancel/reschedule them, rather than the block silently coexisting
  // with confirmed bookings it now conflicts with (Section 2.4).
  let conflictingBookings = [];
  if (time) {
    const startMin = timeToMinutes(time);
    const endMin = endTime ? timeToMinutes(endTime) : startMin + 1;
    conflictingBookings = bookings
      .values(req.user.tenantId)
      .filter((b) => {
        if (b.workflowId !== workflowId || b.providerId !== providerId || b.visitDate !== date || b.status === "cancelled" || !b.visitTime) {
          return false;
        }
        const bookedMin = labelToMinutes(b.visitTime);
        return bookedMin !== null && bookedMin >= startMin && bookedMin < endMin;
      })
      .map((b) => ({ bookingId: b.bookingId, customerName: b.customerName, visitTime: b.visitTime }));
  }

  res.status(201).json({ ok: true, conflictingBookings });
});

app.delete("/api/dashboard/availability/:id", requireAuth("admin", "provider"), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const block = getBlockById(req.user.tenantId, id);
  if (!block) return res.status(404).json({ error: "Not found" });
  if (req.user.role === "provider" && (block.workflowId !== req.user.workflowId || block.providerId !== req.user.providerId)) {
    return res.status(403).json({ error: "You can only remove your own availability blocks." });
  }
  unblockSlot(req.user.tenantId, id);
  recordAudit(req.user.tenantId, req.user, "availability.unblock", { id, workflowId: block.workflowId, providerId: block.providerId, date: block.date, time: block.time, endTime: block.endTime });
  res.json({ ok: true });
});

// Support requests — what makes human escalation (Section 1.4) land
// somewhere real instead of a dead end. Same role scoping as every other
// resource: a provider sees only requests tied to their own workflow (or
// with no workflow yet resolved — a fresh complaint before the customer
// named a business — which nobody can scope, so only admin sees those).
app.get("/api/dashboard/support-requests", requireAuth("admin", "provider"), (req, res) => {
  const list = req.user.role === "provider"
    ? supportRequests.listForWorkflow(req.user.tenantId, req.user.workflowId)
    : supportRequests.listAll(req.user.tenantId);
  res.json(list);
});

app.patch("/api/dashboard/support-requests/:id", requireAuth("admin", "provider"), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  if (typeof req.body?.resolved !== "boolean") return res.status(400).json({ error: "resolved (boolean) is required." });
  const existing = supportRequests.getById(req.user.tenantId, id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (req.user.role === "provider" && existing.workflowId !== req.user.workflowId) {
    return res.status(403).json({ error: "You can only manage support requests for your own business." });
  }
  const updated = supportRequests.setResolved(req.user.tenantId, id, req.body.resolved);
  recordAudit(req.user.tenantId, req.user, updated.resolved ? "support_request.resolve" : "support_request.reopen", { id, waId: updated.waId });
  res.json(updated);
});

// Feedback (Section 4) — same role scoping as everything else.
app.get("/api/dashboard/feedback", requireAuth("admin", "provider"), (req, res) => {
  const list = req.user.role === "provider" ? feedbackStore.listForWorkflow(req.user.tenantId, req.user.workflowId) : feedbackStore.listAll(req.user.tenantId);
  // Joined with the booking's own label fields client-side needs (booking
  // id, customer name) so the dashboard doesn't have to make a second
  // round trip per row to make sense of who left what.
  const withBookingInfo = list.map((f) => {
    const b = bookings.getById(req.user.tenantId, f.bookingId);
    return { ...f, bookingLabel: b?.bookingId || null, customerName: b?.customerName || null, workflowId: b?.workflowId || null };
  });
  res.json(withBookingInfo);
});

// Analytics — same role scoping as every other dashboard route: a
// provider only ever gets their own numbers (the query params are ignored
// for that role, not merely validated), an admin gets platform-wide.
app.get("/api/dashboard/analytics", requireAuth("admin", "provider"), (req, res) => {
  const scope = req.user.role === "provider"
    ? { workflowId: req.user.workflowId, providerId: req.user.providerId }
    : { workflowId: req.query.workflowId || null, providerId: req.query.providerId || null };
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 90);
  res.json(computeAnalytics({ tenantId: req.user.tenantId, ...scope, days }));
});

// Section 9.8 — payment visibility + the manual "issue refund" escape
// hatch for whatever the automatic cancellation-triggered flow doesn't
// cover (a partial goodwill refund outside the stated policy, a payment
// stuck in a state the webhook never resolved, etc.).
app.get("/api/dashboard/payments", requireAuth("admin", "provider"), (req, res) => {
  const list = paymentStore.listForTenant(req.user.tenantId);
  // Provider role sees only payments for their own bookings — same
  // ownership-check style as GET /api/dashboard/feedback above (a join
  // back to bookings, since payments itself doesn't carry workflow/
  // provider id — it only ever needs tenant_id + booking_id).
  const scoped = req.user.role === "provider"
    ? list.filter((p) => {
        const b = bookings.getById(req.user.tenantId, p.bookingId);
        return b && b.workflowId === req.user.workflowId && b.providerId === req.user.providerId;
      })
    : list;
  const withBookingInfo = scoped.map((p) => {
    const b = bookings.getById(req.user.tenantId, p.bookingId);
    return { ...p, bookingLabel: b?.bookingId || null, customerName: b?.customerName || null, workflowId: b?.workflowId || null };
  });
  res.json(withBookingInfo);
});

app.post("/api/dashboard/payments/:id/refund", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const payment = paymentStore.getById(req.user.tenantId, id);
  if (!payment) return res.status(404).json({ error: "Not found" });
  if (payment.status !== "paid") return res.status(400).json({ error: `Cannot refund a payment with status "${payment.status}" — only a paid payment can be refunded.` });

  const booking = bookings.getById(req.user.tenantId, payment.bookingId);
  if (req.user.role === "provider" && booking && (booking.workflowId !== req.user.workflowId || booking.providerId !== req.user.providerId)) {
    return res.status(403).json({ error: "You can only refund payments for your own bookings." });
  }

  const { amount } = req.body || {}; // optional partial-refund amount in rupees; omitted = full refund
  const refundAmountPaise = typeof amount === "number" && amount > 0 ? Math.round(amount * 100) : undefined;
  if (refundAmountPaise !== undefined && refundAmountPaise > payment.amount) {
    return res.status(400).json({ error: "Refund amount cannot exceed the original payment amount." });
  }

  try {
    const refund = await razorpay.createRefund({ providerPaymentId: payment.providerPaymentId, amount: refundAmountPaise });
    const finalAmount = refundAmountPaise ?? payment.amount;
    const status = finalAmount >= payment.amount ? "refunded" : "partially_refunded";
    paymentStore.markRefunded(payment.id, status, refund.status, finalAmount);
    if (booking) {
      bookings.updatePaymentStatus(req.user.tenantId, booking.id, status);
      publishBookingEvent(req.user.tenantId, "booking.updated", { ...booking, paymentStatus: status });
    }
    recordAudit(req.user.tenantId, req.user, "payment.manual_refund", { paymentId: payment.id, bookingId: payment.bookingId, amount: finalAmount });
    log("INFO", `${req.user.email} manually refunded ₹${finalAmount / 100} for payment ${payment.id} (booking ${payment.bookingId}).`);
    res.json({ ok: true, refundAmount: finalAmount, status });
  } catch (err) {
    log("ERROR", `Manual refund failed for payment ${payment.id}: ${err.message}`);
    res.status(502).json({ error: `Refund failed: ${err.message}` });
  }
}));

// Section 10.2 — Google Calendar OAuth. A provider session is pinned to
// exactly one workflowId+providerId (same pattern as GET
// /api/dashboard/bookings above); an admin acting on a specific
// provider's behalf must pass both as query params/body fields.
function resolveWorkflowProvider(req) {
  return req.user.role === "provider" ? { workflowId: req.user.workflowId, providerId: req.user.providerId } : { workflowId: req.query.workflowId || req.body?.workflowId, providerId: req.query.providerId || req.body?.providerId };
}

app.get("/api/dashboard/calendar/status", requireAuth("admin", "provider"), (req, res) => {
  const { workflowId, providerId } = resolveWorkflowProvider(req);
  if (!workflowId || !providerId) return res.status(400).json({ error: "workflowId and providerId are required" });
  const connection = calendarConnections.getForProvider(req.user.tenantId, workflowId, providerId);
  res.json({ configured: googleCalendar.isConfigured(), connection: calendarConnections.toPublicView(connection) });
});

// A real browser top-level navigation (the "Connect Calendar" button is a
// plain link, not a fetch call) — redirects to Google's own consent
// screen rather than returning JSON, since there's no XHR caller to hand
// JSON back to.
app.get("/api/dashboard/calendar/connect", requireAuth("admin", "provider"), (req, res) => {
  const { workflowId, providerId } = resolveWorkflowProvider(req);
  if (!workflowId || !providerId) return res.status(400).send("workflowId and providerId are required.");
  if (!googleCalendar.isConfigured()) {
    return res.status(503).send("Google Calendar isn't configured on this server yet (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI). Ask an admin to set it up.");
  }
  const state = signOAuthState({ tenantId: req.user.tenantId, workflowId, providerId });
  res.redirect(googleCalendar.getAuthUrl(state));
});

// Google redirects the browser here after consent. Not JSON — this is a
// top-level navigation, so it redirects back into the dashboard UI with a
// query flag the frontend reads to show a toast, same shape as any
// OAuth-callback page.
app.get("/api/dashboard/calendar/callback", requireAuth("admin", "provider"), asyncHandler(async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/dashboard?calendar=error&message=${encodeURIComponent(String(error))}`);

  const statePayload = verifyOAuthState(state);
  if (!statePayload || statePayload.tenantId !== req.user.tenantId) {
    return res.redirect(`/dashboard?calendar=error&message=${encodeURIComponent("Invalid or expired connection request — please try again.")}`);
  }
  if (!code || typeof code !== "string") {
    return res.redirect(`/dashboard?calendar=error&message=${encodeURIComponent("Google did not return an authorization code.")}`);
  }

  try {
    const tokens = await googleCalendar.exchangeCodeForTokens(code);
    calendarConnections.create(req.user.tenantId, statePayload.workflowId, statePayload.providerId, {
      calendarType: "google",
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.expiresAt,
    });
    recordAudit(req.user.tenantId, req.user, "calendar.connect", { workflowId: statePayload.workflowId, providerId: statePayload.providerId });
    log("INFO", `${req.user.email} connected Google Calendar for ${statePayload.workflowId}/${statePayload.providerId}.`);
    res.redirect("/dashboard?calendar=connected");
  } catch (err) {
    log("ERROR", `Google Calendar connection failed for tenant ${req.user.tenantId}: ${err.message}`);
    res.redirect(`/dashboard?calendar=error&message=${encodeURIComponent(err.message)}`);
  }
}));

app.post("/api/dashboard/calendar/disconnect", requireAuth("admin", "provider"), (req, res) => {
  const { workflowId, providerId } = resolveWorkflowProvider(req);
  if (!workflowId || !providerId) return res.status(400).json({ error: "workflowId and providerId are required" });
  const connection = calendarConnections.getForProvider(req.user.tenantId, workflowId, providerId);
  if (!connection) return res.status(404).json({ error: "No active calendar connection to disconnect." });
  calendarConnections.disconnect(req.user.tenantId, connection.id);
  recordAudit(req.user.tenantId, req.user, "calendar.disconnect", { workflowId, providerId });
  log("INFO", `${req.user.email} disconnected Google Calendar for ${workflowId}/${providerId}.`);
  res.json({ ok: true });
});

// Section 11 — Server-Sent Events. A dashboard tab open on GET
// /api/dashboard/bookings-shaped data used to only ever learn about a new
// booking, cancellation, or support escalation by the user clicking
// "Refresh" (or the periodic poll a few other dashboards resort to) —
// this makes it push instead. Plain SSE (EventSource), not WebSockets:
// one-directional (server -> browser) is all the dashboard ever needed,
// SSE auto-reconnects on its own with zero client code, and it rides
// over a normal HTTPS GET (no extra infra, no new dependency) — the same
// "simplest thing that's actually correct" bias as everywhere else in
// this codebase.
//
// A provider session only ever receives events for its own
// workflowId+providerId, OR workflow-scoped events (support requests)
// that don't carry a providerId at all — never another provider's
// bookings, even within the same tenant. An admin session receives every
// event for its own tenant, matching the same full-tenant visibility
// GET /api/dashboard/all-bookings already grants.
// Section 12 — each open SSE connection holds a socket + a heartbeat
// timer for as long as it's open; nothing previously stopped one browser
// tab (or a malicious/buggy client scripting `new EventSource(...)` in a
// loop) from opening an unbounded number of them under the same account
// and slowly exhausting the process's file descriptors. A small per-user
// cap closes that gap without needing a general-purpose connection-limit
// middleware — SSE is the only long-lived connection this app holds
// open, so it's the only place this matters.
const MAX_SSE_CONNECTIONS_PER_USER = 5;
const sseConnectionsByUser = new Map(); // uid -> count

app.get("/api/dashboard/events", requireAuth("admin", "provider"), (req, res) => {
  const { uid, tenantId, role, workflowId, providerId } = req.user;

  const openCount = sseConnectionsByUser.get(uid) || 0;
  if (openCount >= MAX_SSE_CONNECTIONS_PER_USER) {
    return res.status(429).json({ error: "Too many open live-update connections for this account. Close some other dashboard tabs and try again." });
  }
  sseConnectionsByUser.set(uid, openCount + 1);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disables proxy buffering if this ever runs behind nginx
  });
  res.write(":connected\n\n"); // opens the stream immediately rather than waiting for the first real event

  const unsubscribe = dashboardEvents.subscribe((evt) => {
    if (evt.tenantId !== tenantId) return;
    if (role === "provider") {
      if (evt.payload?.workflowId !== workflowId) return;
      // Some event types (support_request.created) are workflow-scoped,
      // not tied to one provider — only filter on providerId when the
      // event actually carries one.
      if (evt.payload?.providerId && evt.payload.providerId !== providerId) return;
    }
    res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt.payload)}\n\n`);
  });

  // Keeps the connection alive through any intermediary that would
  // otherwise time out an idle HTTP connection (a load balancer, some
  // browsers) — a comment line, not a real event, so it's invisible to
  // EventSource's onmessage/addEventListener.
  const heartbeat = setInterval(() => res.write(":heartbeat\n\n"), 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    const remaining = (sseConnectionsByUser.get(uid) || 1) - 1;
    if (remaining <= 0) sseConnectionsByUser.delete(uid);
    else sseConnectionsByUser.set(uid, remaining);
  });
});

// Marketplace — publish a working business as a reusable template (shared
// across every tenant, deliberately — see workflow_templates' own comment
// in src/store/db.js), then install it later (into any tenant, or another
// business within the same one) as a fresh, tenant-owned workflow. Admin
// only: installing makes it live for that tenant's WhatsApp bot
// immediately, same blast radius as creating one by hand.
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
  const source = tenantWorkflowStore.get(req.user.tenantId, workflowId);
  if (!source) return res.status(400).json({ error: "Unknown workflowId — publish from an existing business." });
  if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "A template name is required." });

  const template = templates.create({
    name: name.trim().slice(0, 120),
    industry: typeof industry === "string" ? industry.trim().slice(0, 60) : null,
    description: typeof description === "string" ? description.trim().slice(0, 500) : source.description || null,
    definition: source,
    createdBy: req.user.email,
  });
  recordAudit(req.user.tenantId, req.user, "template.publish", { templateId: template.id, name: template.name, fromWorkflowId: workflowId });
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
  if (tenantWorkflowStore.get(req.user.tenantId, newId)) return res.status(409).json({ error: `A business with id "${newId}" already exists.` });

  // Deep copy so the stored template is never mutated by the install.
  const workflow = JSON.parse(JSON.stringify(template.definition));
  workflow.id = newId;
  if (typeof newLabel === "string" && newLabel.trim()) workflow.label = newLabel.trim();

  const validationError = validateWorkflowShape(workflow);
  if (validationError) return res.status(400).json({ error: `Template produced an invalid workflow: ${validationError}` });

  tenantWorkflowStore.upsert(req.user.tenantId, workflow);
  recordAudit(req.user.tenantId, req.user, "template.install", { templateId: id, newWorkflowId: newId });
  log("INFO", `${req.user.email} installed template "${template.name}" as workflow "${newId}"`);
  res.status(201).json({ ok: true, workflowId: newId });
});

app.delete("/api/dashboard/templates/:id", requireAuth("admin"), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const template = templates.getById(id);
  if (!template) return res.status(404).json({ error: "Template not found" });
  templates.remove(id);
  recordAudit(req.user.tenantId, req.user, "template.delete", { templateId: id, name: template.name });
  res.json({ ok: true });
});

// Knowledge base (RAG-lite) — the FAQ/policy/pricing text the WhatsApp
// bot is allowed to answer questions from. Scoped per business: a provider
// manages only their own workflow's entries, an admin manages any.
// Providers CAN edit these (unlike workflow config, which is admin-only) —
// answering "do you take insurance?" is the provider's own domain
// knowledge, not a platform-level setting.
//
// Reuses factualQA.js's own MAX_DOC_CHARS rather than a separate, larger
// cap here — real gap, found while reconciling the two: this used to allow
// saving up to 5000 chars per document, but buildKnowledgeBase() (the
// thing that actually reads these back out at query time) only ever uses
// the first 1500 of it. An admin could save a 4000-char policy doc, get no
// error, and never learn that ~2500 chars of it were silently invisible to
// every customer question the bot answers. One cap now, enforced at write
// time with a clear error instead of a silent truncation.
const MAX_KNOWLEDGE_CONTENT = MAX_DOC_CHARS;

function resolveKnowledgeWorkflowId(req, requested) {
  if (req.user.role === "provider") return req.user.workflowId;
  return requested;
}

app.get("/api/dashboard/knowledge", requireAuth("admin", "provider"), (req, res) => {
  const workflowId = resolveKnowledgeWorkflowId(req, req.query.workflowId);
  if (!workflowId) return res.json(knowledge.listAll(req.user.tenantId)); // admin, no workflow filter (still tenant-scoped)
  res.json(knowledge.listForWorkflow(req.user.tenantId, workflowId));
});

app.post("/api/dashboard/knowledge", requireAuth("admin", "provider"), (req, res) => {
  const { title, content } = req.body || {};
  const workflowId = resolveKnowledgeWorkflowId(req, req.body?.workflowId);
  if (typeof workflowId !== "string" || !tenantWorkflowStore.get(req.user.tenantId, workflowId)) {
    return res.status(400).json({ error: "A known workflowId is required." });
  }
  if (typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "title is required." });
  if (typeof content !== "string" || !content.trim()) return res.status(400).json({ error: "content is required." });
  if (content.trim().length > MAX_KNOWLEDGE_CONTENT) {
    return res.status(400).json({ error: `content must be ${MAX_KNOWLEDGE_CONTENT} characters or fewer (got ${content.trim().length}).` });
  }

  const doc = knowledge.create(req.user.tenantId, workflowId, title.trim().slice(0, 200), content.trim());
  recordAudit(req.user.tenantId, req.user, "knowledge.create", { workflowId, id: doc.id, title: doc.title });
  res.status(201).json(doc);
});

app.put("/api/dashboard/knowledge/:id", requireAuth("admin", "provider"), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const existing = knowledge.getById(req.user.tenantId, id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (req.user.role === "provider" && existing.workflowId !== req.user.workflowId) {
    return res.status(403).json({ error: "You can only edit your own business's knowledge base." });
  }
  const { title, content } = req.body || {};
  if (typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "title is required." });
  if (typeof content !== "string" || !content.trim()) return res.status(400).json({ error: "content is required." });
  if (content.trim().length > MAX_KNOWLEDGE_CONTENT) {
    return res.status(400).json({ error: `content must be ${MAX_KNOWLEDGE_CONTENT} characters or fewer (got ${content.trim().length}).` });
  }

  const doc = knowledge.update(req.user.tenantId, id, title.trim().slice(0, 200), content.trim());
  recordAudit(req.user.tenantId, req.user, "knowledge.update", { workflowId: existing.workflowId, id, title: doc.title });
  res.json(doc);
});

app.delete("/api/dashboard/knowledge/:id", requireAuth("admin", "provider"), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const existing = knowledge.getById(req.user.tenantId, id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (req.user.role === "provider" && existing.workflowId !== req.user.workflowId) {
    return res.status(403).json({ error: "You can only delete your own business's knowledge base." });
  }
  knowledge.remove(req.user.tenantId, id);
  recordAudit(req.user.tenantId, req.user, "knowledge.delete", { workflowId: existing.workflowId, id, title: existing.title });
  res.json({ ok: true });
});

// Section 8.5 — platform-admin routes. Distinct from every /api/dashboard/*
// route above: those are all scoped to the caller's OWN tenant (a real
// tenant admin/provider can never see another tenant's data through them,
// even by guessing ids — see every store module's tenant_id filtering).
// These operate ACROSS tenants by design, which is exactly why they're
// gated to the platform_admin role only, a role distinct from any
// tenant's own admin (src/store/userStore.js).
app.get("/api/platform/tenants", requireAuth("platform_admin"), (req, res) => {
  // Section 8's own Definition of Done, verbatim: "a platform admin can
  // see both tenants' summary stats from one view." One query per tenant
  // here (not a JOIN) — the tenant count is expected to stay small enough
  // that this is simpler and clearer than an aggregate query, and it
  // reuses each store's own tenant-scoped counting rather than a
  // one-off cross-tenant query living only here.
  const allTenants = tenantStore.list();
  const summaries = allTenants.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    plan: t.plan,
    status: t.status,
    whatsappConnected: !!(t.whatsappAccessToken && t.whatsappPhoneNumberId),
    bookingCount: bookings.values(t.id).length,
    userCount: users.list(t.id).length,
    createdAt: t.createdAt,
  }));
  res.json(summaries);
});

app.get("/api/platform/tenants/:id", requireAuth("platform_admin"), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const tenant = tenantStore.getById(id);
  if (!tenant) return res.status(404).json({ error: "Not found" });
  // whatsappAccessToken is a real secret — never returned to any client,
  // including the platform admin's own dashboard (same principle as
  // password_hash never appearing in a users API response).
  const { whatsappAccessToken, ...safeTenant } = tenant;
  res.json(safeTenant);
});

app.post("/api/platform/tenants", requireAuth("platform_admin"), (req, res) => {
  const { name, slug, plan, billingEmail } = req.body || {};
  if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "name is required." });
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: "slug is required and must contain only lowercase letters, numbers, and dashes." });
  }
  try {
    const tenant = tenantStore.create({ name: name.trim(), slug, plan, billingEmail });
    tenantWorkflowStore.seedDefaultsForTenant(tenant.id); // same starter catalog self-signup gets — see POST /api/signup
    recordAudit(tenant.id, req.user, "tenant.create", { name: tenant.name, slug: tenant.slug });
    log("INFO", `${req.user.email} created tenant "${tenant.name}" (${tenant.slug})`);
    res.status(201).json(tenant);
  } catch (err) {
    if (err.code === "DUPLICATE_SLUG") return res.status(409).json({ error: err.message });
    throw err;
  }
});

// Section 8.6 — the tenant lifecycle itself: pending -> active -> suspended
// -> cancelled. requireAuth()'s tenant-status check (above) is what
// actually enforces "a suspended tenant's own users can't do anything" —
// this route is just what moves a tenant between those states.
const TENANT_STATUSES = new Set(["pending", "active", "suspended", "cancelled"]);
app.patch("/api/platform/tenants/:id/status", requireAuth("platform_admin"), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const { status } = req.body || {};
  if (!TENANT_STATUSES.has(status)) {
    return res.status(400).json({ error: `status must be one of: ${[...TENANT_STATUSES].join(", ")}` });
  }
  const existing = tenantStore.getById(id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const updated = tenantStore.setStatus(id, status);
  recordAudit(id, req.user, "tenant.status_change", { from: existing.status, to: status });
  log("INFO", `${req.user.email} changed tenant ${id} (${existing.slug}) status: ${existing.status} -> ${status}`);
  const { whatsappAccessToken, ...safeTenant } = updated;
  res.json(safeTenant);
});

// Section 8.4 — per-tenant config: branding shown in bot copy/dashboard
// chrome, feature flags (payments/calendar sync on/off — groundwork for
// Sections 9/10, not consulted anywhere yet), and an optional bring-your-
// own Groq key for higher-plan tenants. Also where a tenant's own WhatsApp
// number gets connected (Section 8.3's tenant-resolution depends on this
// being set correctly).
app.patch("/api/platform/tenants/:id/config", requireAuth("platform_admin"), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const existing = tenantStore.getById(id);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const { branding, featureFlags, groqApiKey, whatsappPhoneNumberId, whatsappBusinessAccountId, whatsappAccessToken } = req.body || {};
  let updated = existing;
  if (branding !== undefined || featureFlags !== undefined || groqApiKey !== undefined) {
    updated = tenantStore.updateConfig(id, { branding, featureFlags, groqApiKey });
  }
  if (whatsappPhoneNumberId !== undefined || whatsappBusinessAccountId !== undefined || whatsappAccessToken !== undefined) {
    // setWhatsAppCredentials encrypts the access token (secretsEncryption.js)
    // and throws a specific, actionable error if APP_ENCRYPTION_KEY isn't
    // set — found live hitting this endpoint before that env var was
    // configured: without this catch it fell through to the generic global
    // error handler as an opaque 500 "Internal server error", which told
    // the platform_admin nothing about what to actually fix.
    try {
      updated = tenantStore.setWhatsAppCredentials(id, {
        phoneNumberId: whatsappPhoneNumberId ?? existing.whatsappPhoneNumberId,
        businessAccountId: whatsappBusinessAccountId ?? existing.whatsappBusinessAccountId,
        accessToken: whatsappAccessToken !== undefined ? whatsappAccessToken : existing.whatsappAccessToken,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  recordAudit(id, req.user, "tenant.config_update", { fields: Object.keys(req.body || {}) });
  const { whatsappAccessToken: _omit, ...safeTenant } = updated;
  res.json(safeTenant);
});

// ---------------------------------------------------------------------------
// Section 14 — Public API (/api/v1/*). A tenant's own website/backend can
// call these directly, authenticated with an API key (requireApiKey
// above) rather than a dashboard session — e.g. a "Check availability"
// widget embedded on the tenant's own site, or a confirmation page that
// looks up a booking by id after a customer completes one elsewhere.
//
// Deliberately READ-ONLY for this pass — no POST /api/v1/bookings to
// create or cancel a booking through this API yet. Every write this
// project makes today goes through src/engine/workflowEngine.js's
// recordBooking(), which is coupled to a conversational session (step
// validation, provider/date/time selection state) in a way that isn't
// yet factored into a reusable, session-independent "create one valid
// booking" function. Building that safely — without either duplicating
// workflowEngine's validation logic (a second copy that could drift) or
// risking a booking that skips a check the WhatsApp flow enforces — is
// real, separate design work, not something to rush through here.
// Flagged explicitly rather than silently shipping a write path that
// looks equivalent to the conversational one but isn't.
app.get("/api/v1/availability", requireApiKey, (req, res) => {
  const { workflowId, providerId, date } = req.query;
  if (typeof workflowId !== "string" || typeof providerId !== "string" || typeof date !== "string") {
    return res.status(400).json({ error: "workflowId, providerId, and date (YYYY-MM-DD) are required query params." });
  }
  const workflow = tenantWorkflowStore.get(req.apiTenantId, workflowId);
  if (!workflow) return res.status(404).json({ error: "Unknown workflowId." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must be in YYYY-MM-DD format." });

  const slots = getAvailableSlots(req.apiTenantId, workflow, providerId, date);
  res.json({ workflowId, providerId, date, slots });
});

app.get("/api/v1/bookings/:bookingId", requireApiKey, (req, res) => {
  // The tenant-issued bookingId (e.g. "APT-20260101-XY12"), not this
  // app's internal numeric row id — the same identifier a customer's own
  // confirmation message already shows them, since this route exists for
  // a tenant's own site to look up a booking a customer already has.
  const booking = bookings.getByBookingId(req.apiTenantId, req.params.bookingId);
  if (!booking) return res.status(404).json({ error: "Booking not found." });
  const { waId: _omit, ...publicBooking } = booking; // the customer's phone number stays internal-only, even to the tenant's own integration
  res.json(publicBooking);
});

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
    checkWhatsAppTokenValidity().catch((err) => log("WARN", `WhatsApp token check threw unexpectedly: ${err.message}`));
  });
}

module.exports = app;
