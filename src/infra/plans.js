// Single source of truth for plan ids/pricing — POST /api/billing/checkout
// (src/routes/billing.js) and the platform-admin manual plan lever
// (PATCH /api/platform/tenants/:id/plan, src/routes/platformAdmin.js) both
// need to agree on what a "plan" is; splitting this into two independently
// maintained lists is exactly how they'd silently drift apart.
//
// Prices match the marketing site's own pricing section
// (public/marketing/index.html #pricing) — found live during an audit
// pass that an earlier version of this file used different placeholder
// numbers (and no free tier at all) that directly contradicted the
// landing page's own hero copy ("Start free — no card needed"). The
// landing page is the real, deliberately-designed pricing; this file was
// wrong, not the other way around.
//
//   starter    — the actual free tier. amount: 0 means POST /api/billing/
//                checkout skips Razorpay entirely (see billing.js) and
//                activates the tenant straight into the onboarding queue
//                — there's nothing to charge, so there's no payment step.
//   growth     — ₹1,999/mo, real self-serve Razorpay checkout.
//   enterprise — amount: null means "not self-serve" — POST /api/billing/
//                checkout rejects it outright; the marketing site's own
//                Enterprise card (and this app's plan-selection page)
//                point to a real human instead (mailto: / WhatsApp),
//                matching index.html's existing "✉️ Email us" / "💬
//                WhatsApp us" pattern for multi-location/custom deals.
const PLANS = {
  starter: { label: "Starter", amount: 0 },
  growth: { label: "Growth", amount: 199900 },
  enterprise: { label: "Enterprise", amount: null },
};

// "free" isn't a real customer-facing plan id (see "starter" above, which
// now covers that role) — kept only as a platform-admin-only manual
// override (e.g. a comped legacy account) alongside the real plan ids.
const ADMIN_ASSIGNABLE_PLAN_IDS = new Set(["free", ...Object.keys(PLANS)]);

module.exports = { PLANS, ADMIN_ASSIGNABLE_PLAN_IDS };
