// Single source of truth for plan ids/pricing — POST /api/billing/checkout
// (src/routes/billing.js) and the platform-admin manual plan lever
// (PATCH /api/platform/tenants/:id/plan, src/routes/platformAdmin.js) both
// need to agree on what a "plan" is; splitting this into two independently
// maintained lists is exactly how they'd silently drift apart.
//
// Prices are placeholders (no real pricing was specified) — figures in
// paise (Razorpay's base unit), first-cycle charge only. Swap these for
// the business's actual numbers before this goes live.
const PLANS = {
  starter: { label: "Starter", amount: 99900 },
  growth: { label: "Growth", amount: 299900 },
  enterprise: { label: "Enterprise", amount: 799900 },
};

// "free" isn't purchasable through checkout — kept as a platform-admin-only
// manual override (e.g. a comped account, a pre-existing legacy tenant)
// alongside the real, paid plan ids above.
const ADMIN_ASSIGNABLE_PLAN_IDS = new Set(["free", ...Object.keys(PLANS)]);

module.exports = { PLANS, ADMIN_ASSIGNABLE_PLAN_IDS };
