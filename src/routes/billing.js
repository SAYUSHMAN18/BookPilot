const express = require("express");
const { log } = require("../infra/logger");
const { asyncHandler } = require("../infra/asyncHandler");
const { requireAuth } = require("./auth");
const tenantStore = require("../store/tenantStore");
const subscriptionOrders = require("../store/subscriptionOrderStore");
const razorpay = require("../infra/paymentProviders/razorpayProvider");
const { recordAudit } = require("../store/auditLog");
const { activateTenantOnboarding } = require("../infra/onboarding");
const { PLANS } = require("../infra/plans");

// New plan, Stream 2 — the one step between self-signup and the
// onboarding queue: a logged-in admin whose tenant is "awaiting_payment"
// picks a plan here. Outcomes depend on the plan's price (see infra/
// plans.js's own comment on why these numbers are what they are):
//   - Starter/Growth (a real amount): a real Razorpay payment link. POST
//     /api/payments/webhook (src/routes/webhook.js) is what actually
//     advances the tenant once Razorpay confirms the charge — never this
//     route directly, same "webhook is the only source of truth"
//     discipline booking payments already follow. (Starter used to be
//     ₹0/free and skip Razorpay entirely via the amount===0 branch below
//     — kept for any future amount:0 plan, but no current plan hits it.)
//   - Enterprise (no self-serve amount): rejected here. The real path is
//     the plan-selection page's own "Email us" / "WhatsApp us" links
//     (same contact details as the marketing site's own Enterprise
//     card) — this is sales-assisted by design, not something a
//     checkout endpoint should ever auto-charge.

const router = express.Router();

router.get("/api/billing/plans", (req, res) => {
  res.json(Object.entries(PLANS).map(([id, p]) => ({ id, label: p.label, amount: p.amount, currency: "INR" })));
});

router.post(
  "/api/billing/checkout",
  requireAuth("admin", { allowAwaitingPayment: true }),
  asyncHandler(async (req, res) => {
    const tenant = await tenantStore.getById(req.user.tenantId);
    if (!tenant || tenant.status !== "awaiting_payment") {
      return res.status(409).json({ error: "This account has already selected a plan." });
    }
    const { plan } = req.body || {};
    const planConfig = PLANS[plan];
    if (!planConfig) {
      return res.status(400).json({ error: `Unknown plan. Choose one of: ${Object.keys(PLANS).join(", ")}.` });
    }
    if (planConfig.amount === null) {
      return res.status(400).json({ error: "Enterprise is sales-assisted — please email or WhatsApp us to get set up." });
    }

    if (planConfig.amount === 0) {
      await activateTenantOnboarding(tenant, plan, 0, req.user);
      log("INFO", `Free-plan signup activated for tenant ${tenant.id} (${tenant.slug}) — queued for onboarding, no payment needed.`);
      return res.json({ ok: true, activated: true, plan });
    }

    if (!razorpay.isConfigured()) {
      return res.status(503).json({ error: "Payments are not configured on this server yet — contact support to activate your account manually." });
    }

    // Found live (audit pass) — clicking checkout more than once (a
    // different plan, or a retry) left every earlier unpaid attempt
    // sitting around forever. See subscriptionOrderStore's own comment
    // on why this is safe even if an old link somehow still gets paid.
    await subscriptionOrders.markPendingSuperseded(tenant.id);
    const order = await subscriptionOrders.create(tenant.id, plan, { amount: planConfig.amount, currency: "INR" });
    let checkout;
    try {
      checkout = await razorpay.createSubscriptionCheckout({
        tenantId: tenant.id,
        plan,
        amount: planConfig.amount,
        billingEmail: tenant.billingEmail,
      });
    } catch (err) {
      await subscriptionOrders.markFailed(order.id, err.message);
      throw err;
    }
    // The order row is looked up again later purely by provider_order_id
    // (the webhook has no other handle on it) — persist it now rather than
    // trying to thread the DB id through Razorpay's own opaque order/receipt.
    await subscriptionOrders.setProviderOrderId(order.id, checkout.orderId);

    await recordAudit(tenant.id, req.user, "subscription.checkout_started", { plan, amount: planConfig.amount });
    log("INFO", `Billing checkout started for tenant ${tenant.id} (${tenant.slug}), plan "${plan}".`);
    res.json({ ok: true, paymentUrl: checkout.paymentUrl, plan, amount: planConfig.amount });
  })
);

module.exports = { router, PLANS };
