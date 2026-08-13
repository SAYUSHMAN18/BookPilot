const crypto = require("crypto");
const { log } = require("../logger");

// Section 9.1 — Razorpay (UPI/cards/netbanking, the plan's own pick for
// the Indian market this project targets). Implements the contract
// documented in ./PaymentProvider.js. Uses Node's built-in fetch/crypto —
// no new dependency, same "no native modules, minimal deps" stance as the
// rest of this codebase (src/infra/auth.js's password hashing, session
// signing).
//
// Platform-level credentials (RAZORPAY_KEY_ID/KEY_SECRET/WEBHOOK_SECRET),
// not per-tenant — unlike WhatsApp, the plan never asked for every tenant
// to bring their own Razorpay merchant account (that's a materially
// bigger onboarding burden — real KYC with a payment processor — and
// Section 8.4's per-tenant "payments on/off" feature flag is about
// whether a tenant USES this platform-level integration, not about them
// having their own). Documented here as a deliberate scope decision.
//
// IMPORTANT, stated plainly: this implements Razorpay's real, documented
// API shape (Orders API, webhook signature scheme, Refunds API) correctly
// as far as it can be verified from documentation alone, but — unlike
// every other integration finished in this session — it has NOT been
// verified live against a real Razorpay account, because no such account
// or API credentials exist for this project. Treat this as "ready to
// test against a sandbox account," not "proven working."

const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";

function credentials() {
  return {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
  };
}

function isConfigured() {
  const { keyId, keySecret } = credentials();
  return !!(keyId && keySecret);
}

// Payment Links, not the Orders API — Orders are for embedding Razorpay's
// checkout.js in a web page, which doesn't exist here; a WhatsApp bot
// needs a plain URL it can send as a text message, which is exactly what
// the Payment Links API returns (a short_url). The webhook events fired
// for a paid Payment Link still carry a `payment.entity` shaped the same
// way orders' payments do, so parseWebhookEvent() below needs no special
// case for this — Razorpay's own webhook payload doesn't distinguish.
async function createOrder({ amount, currency = "INR", receipt, notes, customerPhone }) {
  const { keyId, keySecret } = credentials();
  if (!keyId || !keySecret) {
    throw new Error("RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are not set — cannot create a real payment link.");
  }

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const body = {
    amount,
    currency,
    reference_id: receipt,
    notes,
    notify: { sms: false, email: false }, // this app does its own notification, over WhatsApp
  };
  if (customerPhone) body.customer = { contact: customerPhone };

  const resp = await fetch(`${RAZORPAY_API_BASE}/payment_links`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Razorpay payment link creation failed: ${resp.status} ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  // `orderId` here is the payment link's own id (Razorpay calls it
  // plink_...) — that's what a webhook callback for this link's payment
  // can be matched back against via payments.provider_order_id, same as
  // a real order id would be.
  return { orderId: data.id, amount: data.amount, currency: data.currency, paymentUrl: data.short_url, raw: data };
}

// Razorpay signs webhook payloads with HMAC-SHA256 over the raw request
// body, using a separate webhook secret (configured in the Razorpay
// dashboard, not the API key/secret) — same discipline as
// src/infra/verifySignature.js's handling of Meta's X-Hub-Signature-256,
// deliberately reused rather than inventing a second verification scheme.
function verifyWebhookSignature(rawBody, signatureHeader) {
  const { webhookSecret } = credentials();
  if (!webhookSecret || !signatureHeader || !rawBody) return false;

  const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

// Maps Razorpay's actual webhook event shape
// (https://razorpay.com/docs/webhooks/payloads/payments/) to this
// project's own normalized shape. Returns null for any event type this
// integration has no opinion about — Razorpay fires webhooks for many
// events (subscription.*, settlement.*, etc.) this app never asked for.
// NOTE on orderId resolution — genuinely uncertain without a live account
// to confirm against: this app stores the Payment Link's own id
// (`plink_...`, from createOrder()'s returned `orderId`) as
// payments.provider_order_id. Razorpay's webhook payload for a paid
// Payment Link is documented to include `payload.payment_link.entity.id`
// (that same plink_ id) alongside `payload.payment.entity` (the actual
// payment, whose own `.order_id` points at an internally auto-created
// Order — a DIFFERENT id this app never sees or stores). This function
// prefers `payment_link.entity.id` when present, since that's what
// actually matches what was stored; falls back to `payment.entity.order_id`
// for a plain Orders-API integration if this ever moves off Payment Links.
// Verify this exact field against a real Razorpay webhook payload before
// trusting it in production — it's implemented per documentation, not
// proven against a live event.
function parseWebhookEvent(parsedBody) {
  const eventType = parsedBody?.event;
  const paymentEntity = parsedBody?.payload?.payment?.entity;
  const paymentLinkEntity = parsedBody?.payload?.payment_link?.entity;
  const refundEntity = parsedBody?.payload?.refund?.entity;
  const resolvedOrderId = paymentLinkEntity?.id || paymentEntity?.order_id;

  if (eventType === "payment.captured" && paymentEntity) {
    return {
      type: "payment.captured",
      orderId: resolvedOrderId,
      paymentId: paymentEntity.id,
      amount: paymentEntity.amount,
      currency: paymentEntity.currency,
      raw: parsedBody,
    };
  }
  if (eventType === "payment.failed" && paymentEntity) {
    return {
      type: "payment.failed",
      orderId: resolvedOrderId,
      paymentId: paymentEntity.id,
      amount: paymentEntity.amount,
      currency: paymentEntity.currency,
      failureReason: paymentEntity.error_description || paymentEntity.error_reason || "unknown",
      raw: parsedBody,
    };
  }
  if (eventType === "refund.processed" && refundEntity) {
    return {
      type: "refund.processed",
      paymentId: refundEntity.payment_id,
      refundId: refundEntity.id,
      amount: refundEntity.amount,
      raw: parsedBody,
    };
  }

  log("INFO", `Razorpay webhook event "${eventType}" is not handled by this integration — acknowledging and ignoring.`);
  return null;
}

// Plan-subscription checkout — deliberately built on the SAME Payment
// Links call as createOrder() above, not Razorpay's separate Subscriptions
// API (which would mean recurring mandates, a distinct set of webhook
// events, and a second untested integration surface). This app doesn't yet
// have a live Razorpay account to verify anything against — reusing the
// one already-documented, already-working shape (see the big NOTE at the
// top of this file) keeps the new billing/checkout route on a path that's
// at least internally consistent with what's already here. Recurring
// auto-renewal (charging the SAME card again next cycle without the
// customer re-visiting a link) is real, separate work this intentionally
// doesn't attempt yet — swap this function's body for the real
// Subscriptions API later without touching any caller, since both return
// the same { orderId, paymentUrl } shape.
async function createSubscriptionCheckout({ tenantId, plan, amount, billingEmail, customerPhone }) {
  return createOrder({
    amount,
    currency: "INR",
    receipt: `sub-${tenantId}-${plan}-${Date.now()}`,
    notes: { tenantId: String(tenantId), plan, billingEmail: billingEmail || "" },
    customerPhone,
  });
}

async function createRefund({ providerPaymentId, amount }) {
  const { keyId, keySecret } = credentials();
  if (!keyId || !keySecret) {
    throw new Error("RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are not set — cannot create a real refund.");
  }

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const body = amount ? { amount } : {}; // omitted amount = full refund, per Razorpay's own API
  const resp = await fetch(`${RAZORPAY_API_BASE}/payments/${providerPaymentId}/refund`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Razorpay refund failed: ${resp.status} ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  return { refundId: data.id, status: data.status, raw: data };
}

module.exports = { isConfigured, createOrder, createSubscriptionCheckout, verifyWebhookSignature, parseWebhookEvent, createRefund };
