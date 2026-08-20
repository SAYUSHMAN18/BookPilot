// Single source of truth for plan ids/pricing — POST /api/billing/checkout
// (src/routes/billing.js) and the platform-admin manual plan lever
// (PATCH /api/platform/tenants/:id/plan, src/routes/platformAdmin.js) both
// need to agree on what a "plan" is; splitting this into two independently
// maintained lists is exactly how they'd silently drift apart.
//
// Prices match the marketing site's own pricing section
// (public/marketing/index.html #pricing).
//
//   starter    — ₹199/mo, a real minimum listing fee (requested directly:
//                Starter was previously ₹0/free — amount: 0, which made
//                POST /api/billing/checkout skip Razorpay entirely and
//                activate straight into onboarding with nothing charged.
//                Now a real amount, it flows through the exact same
//                self-serve Razorpay checkout branch growth already uses
//                below — no branching logic needed, just this number).
//   growth     — ₹1,999/mo, real self-serve Razorpay checkout. Also the
//                plan a tenant needs to be on to connect their own
//                WhatsApp Business number instead of the shared one
//                (billing.js's ownWhatsAppNumber feature).
//   enterprise — amount: null means "not self-serve" — POST /api/billing/
//                checkout rejects it outright; the marketing site's own
//                Enterprise card (and this app's plan-selection page)
//                point to a real human instead (mailto: / WhatsApp),
//                matching index.html's existing "✉️ Email us" / "💬
//                WhatsApp us" pattern for multi-location/custom deals.
const PLANS = {
  starter: { label: "Starter", amount: 19900 },
  growth: { label: "Growth", amount: 199900 },
  enterprise: { label: "Enterprise", amount: null },
};

// "free" isn't a real customer-facing plan id (see "starter" above, which
// now covers that role) — kept only as a platform-admin-only manual
// override (e.g. a comped legacy account) alongside the real plan ids.
const ADMIN_ASSIGNABLE_PLAN_IDS = new Set(["free", ...Object.keys(PLANS)]);

module.exports = { PLANS, ADMIN_ASSIGNABLE_PLAN_IDS };
