const { log } = require("./logger");
const { sendEmail } = require("./emailSender");
const tenantStore = require("../store/tenantStore");
const onboardingRequests = require("../store/onboardingRequestStore");
const { recordAudit } = require("../store/auditLog");

// The one place a tenant actually crosses from "chose a plan" to "queued
// for the onboarding team" — shared by two callers that reach this same
// outcome through different doors: the Razorpay webhook (a paid plan,
// after payment.captured) and POST /api/billing/checkout itself (the
// free Starter plan, which has nothing to charge and so never touches
// Razorpay at all — see billing.js's own comment on why). Factored out
// so both stay byte-for-byte consistent instead of two copies of
// "flip status, open the queue row, send the email" drifting apart.
async function activateTenantOnboarding(tenant, plan, amount, actor) {
  await tenantStore.setPlan(tenant.id, plan);
  await tenantStore.setStatus(tenant.id, "onboarding_pending");
  await onboardingRequests.create(tenant.id, { plan, amount });
  await recordAudit(tenant.id, actor, "subscription.activated", { plan, amount });
  log("INFO", `Tenant ${tenant.id} (${tenant.slug}) activated on plan "${plan}" — queued for onboarding.`);
  if (tenant.billingEmail) {
    try {
      await sendEmail(
        tenant.billingEmail,
        "You're all set — BookPilot AI onboarding",
        `Thanks for choosing the ${plan} plan! Our onboarding team has been notified and will reach out shortly to get "${tenant.name}" set up. No further action is needed from you right now.`
      );
    } catch (err) {
      log("WARN", `Onboarding-queue email failed for tenant ${tenant.id}: ${err.message}`);
    }
  }
}

module.exports = { activateTenantOnboarding };
