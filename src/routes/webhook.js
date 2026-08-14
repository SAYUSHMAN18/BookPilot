const crypto = require("crypto");
const express = require("express");
const { log } = require("../infra/logger");
const { handleIncomingMessage } = require("../engine/workflowEngine");
const { isValidSignature } = require("../infra/verifySignature");
const { isDuplicate } = require("../infra/dedupe");
const bookings = require("../store/bookingStore");
const tenantStore = require("../store/tenantStore");
const tenantWorkflowStore = require("../store/tenantWorkflowStore");
const paymentStore = require("../store/paymentStore");
const subscriptionOrders = require("../store/subscriptionOrderStore");
const { activateTenantOnboarding } = require("../infra/onboarding");
const razorpay = require("../infra/paymentProviders/razorpayProvider");
const { recordAudit } = require("../store/auditLog");
const { publishBookingEvent } = require("../infra/publishBookingEvent");
const { syncBookingCreated } = require("../engine/calendarSync");
const { isVoiceEnabled, downloadWhatsAppMedia, transcribeAudio, synthesizeSpeech } = require("../infra/voice");
const { translateForVoice } = require("../ai/translate");
const {
  sendWhatsAppText,
  sendWhatsAppAudio,
  sendTypingIndicator,
  beginReplyCapture,
  endReplyCapture,
} = require("../infra/whatsapp");
const { asyncHandler } = require("../infra/asyncHandler");

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
    await handleIncomingMessage(tenantId, waId, transcript, await tenantWorkflowStore.listForTenant(tenantId));
  } finally {
    const replyText = endReplyCapture(waId);
    if (replyText && languageCode) {
      try {
        // Translate before speaking — see translate.js's own comment for
        // why: without this, an English reply got spoken through a
        // non-English voice model (English words in Hindi phonetics),
        // which is worse than staying text-only.
        const spokenText = await translateForVoice(replyText, languageCode);
        const audio = await synthesizeSpeech(spokenText, languageCode);
        if (audio) await sendWhatsAppAudio(tenantId, waId, audio, "audio/mpeg");
      } catch (err) {
        log("ERROR", `Voice synthesis failed for ${waId}: ${err.message}`);
      }
    }
  }
}

// New plan, Stream 2 — the moment a plan-subscription checkout is
// confirmed paid, this is the ONLY thing that advances a tenant past
// awaiting_payment (same "webhook is the sole source of truth" discipline
// as the booking-payment branch above it) — never the checkout route
// itself, which only ever creates the order and hands back a payment URL.
async function handleSubscriptionWebhookEvent(event, subscriptionOrder) {
  const tenant = await tenantStore.getById(subscriptionOrder.tenantId);
  if (!tenant) {
    log("ERROR", `Razorpay webhook "${event.type}" for subscription order ${subscriptionOrder.id} references tenant ${subscriptionOrder.tenantId}, which no longer exists.`);
    return;
  }

  if (event.type === "payment.captured") {
    await subscriptionOrders.markPaid(subscriptionOrder.id, event.paymentId);
    if (tenant.status === "awaiting_payment") {
      await activateTenantOnboarding(tenant, subscriptionOrder.plan, subscriptionOrder.amount, { email: "razorpay-webhook", role: "system" });
    } else {
      // Already past awaiting_payment (e.g. a duplicate webhook delivery,
      // which Razorpay's own docs say to expect and de-dupe defensively
      // against) — the order itself is still marked paid above, but the
      // tenant's lifecycle state must not be stomped backward.
      log("INFO", `Subscription payment captured for tenant ${tenant.id}, but tenant is already "${tenant.status}" — order marked paid, lifecycle unchanged.`);
    }
  } else if (event.type === "payment.failed") {
    await subscriptionOrders.markFailed(subscriptionOrder.id, event.failureReason);
    // Tenant stays awaiting_payment — same "no auto-cancel, let them retry
    // the link" reasoning as a failed booking deposit.
    await recordAudit(tenant.id, { email: "razorpay-webhook", role: "system" }, "subscription.payment_failed", { plan: subscriptionOrder.plan, reason: event.failureReason });
    log("WARN", `Subscription payment failed for tenant ${tenant.id}: ${event.failureReason}`);
  }
}

function createWebhookRouter() {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // WhatsApp Cloud API webhook (Meta)
  // ---------------------------------------------------------------------------

  // Verification handshake — Meta calls this once when you save the webhook URL.
  router.get("/webhook", (req, res) => {
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
  router.post("/webhook", asyncHandler(async (req, res) => {
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
      const matchedTenant = await tenantStore.getByPhoneNumberId(incomingPhoneNumberId);
      if (matchedTenant) {
        tenantId = matchedTenant.id;
      } else if (!(await tenantStore.getById(1))?.whatsappPhoneNumberId) {
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
      const currentTenant = await tenantStore.getById(tenantId);
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

      if (text) await handleIncomingMessage(tenantId, waId, text, await tenantWorkflowStore.listForTenant(tenantId));
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
  router.post("/api/payments/webhook", asyncHandler(async (req, res) => {
    const signature = req.get("X-Razorpay-Signature");
    if (!razorpay.verifyWebhookSignature(req.rawBody, signature)) {
      log("WARN", "Rejected Razorpay webhook: invalid or missing signature.");
      return res.sendStatus(403);
    }
    res.sendStatus(200); // ack fast, same reasoning as the WhatsApp webhook

    const event = razorpay.parseWebhookEvent(req.body);
    if (!event) return; // an event type this integration has no opinion about

    // Two independent kinds of Razorpay order can hit this one webhook: a
    // booking deposit (payments table) or a plan-subscription checkout
    // (subscription_orders table, Stream 2) — both use the same Payment
    // Links mechanism under the hood (see razorpayProvider.js's
    // createSubscriptionCheckout comment), so Razorpay's payload shape
    // gives no signal which kind this is; the order id is looked up
    // against both tables to find out.
    const subscriptionOrder = event.orderId ? await subscriptionOrders.getByOrderId(event.orderId) : null;
    if (subscriptionOrder) {
      await handleSubscriptionWebhookEvent(event, subscriptionOrder);
      return;
    }

    const payment = event.orderId ? await paymentStore.getByOrderId(event.orderId) : null;
    if (!payment) {
      log("WARN", `Razorpay webhook "${event.type}" for order ${event.orderId} matches no known payment or subscription order — ignoring.`);
      return;
    }
    const booking = await bookings.getById(payment.tenantId, payment.bookingId);
    if (!booking) {
      log("ERROR", `Razorpay webhook "${event.type}" for payment ${payment.id} references booking ${payment.bookingId}, which no longer exists.`);
      return;
    }

    if (event.type === "payment.captured") {
      await paymentStore.markPaid(payment.id, event.paymentId);
      await bookings.updateStatus(payment.tenantId, booking.id, "booked");
      await bookings.updatePaymentStatus(payment.tenantId, booking.id, "paid");
      await recordAudit(payment.tenantId, { email: "razorpay-webhook", role: "system" }, "payment.captured", { bookingId: booking.bookingId, paymentId: event.paymentId, amount: event.amount });
      log("INFO", `Payment captured for booking ${booking.bookingId} (₹${event.amount / 100}) — booking confirmed.`);
      try {
        await sendWhatsAppText(payment.tenantId, booking.waId, `✅ Payment received! Your booking (${booking.bookingId}) is now confirmed. Reply STATUS anytime to check it.`);
      } catch (err) {
        log("WARN", `Payment-confirmed WhatsApp notification failed for ${booking.bookingId}: ${err.message}`);
      }
      await syncBookingCreated(payment.tenantId, booking, await tenantWorkflowStore.get(payment.tenantId, booking.workflowId));
      publishBookingEvent(payment.tenantId, "booking.updated", { ...booking, status: "booked", paymentStatus: "paid" });
    } else if (event.type === "payment.failed") {
      await paymentStore.markFailed(payment.id, event.failureReason);
      await bookings.updatePaymentStatus(payment.tenantId, booking.id, "failed");
      // Booking stays payment_pending (NOT auto-cancelled) — Razorpay
      // payment links allow a retry on the same link, so cancelling the
      // slot here would yank it out from under a customer mid-retry. The
      // slot is released explicitly if/when the customer or provider
      // actually cancels, same as any other booking.
      await recordAudit(payment.tenantId, { email: "razorpay-webhook", role: "system" }, "payment.failed", { bookingId: booking.bookingId, reason: event.failureReason });
      log("WARN", `Payment failed for booking ${booking.bookingId}: ${event.failureReason}`);
      publishBookingEvent(payment.tenantId, "booking.updated", { ...booking, paymentStatus: "failed" });
    } else if (event.type === "refund.processed") {
      log("INFO", `Refund processed for payment ${event.paymentId}, refund ${event.refundId} (₹${event.amount / 100}).`);
      // The refund itself was already recorded in `payments` at the point
      // it was INITIATED (the manual-refund dashboard route / the
      // cancellation-triggered refund) — this webhook confirms it actually
      // completed on Razorpay's side, which is worth logging but doesn't
      // need a second DB write for what this app already tracks.
    }
  }));

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

  router.post("/api/simulate-whatsapp", asyncHandler(async (req, res) => {
    if (!simulateEndpointEnabled) return res.sendStatus(404);

    const { from, text, tenantId } = req.body || {};
    if (typeof from !== "string" || !from.trim() || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "from and text are required and must be non-empty strings" });
    }
    // Defaults to the default tenant (id 1) — optional so every existing
    // curl/test call site from before Section 8 keeps working unchanged.
    const effectiveTenantId = Number.isInteger(tenantId) ? tenantId : 1;
    try {
      await handleIncomingMessage(effectiveTenantId, from, text, await tenantWorkflowStore.listForTenant(effectiveTenantId));
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

  return router;
}

module.exports = { createWebhookRouter };
