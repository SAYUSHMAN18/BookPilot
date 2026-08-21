const bookings = require("../store/bookingStore");
const tenantStore = require("../store/tenantStore");
const { istDate, toISTFields } = require("./dateSlots");

// New plan, Block 12 — a minimal billing/usage skeleton, matching the
// marketing site's own existing pricing tiers (README's Pricing section):
// Starter (₹199/mo minimum listing fee, up to 30 bookings/mo), Growth
// (unlimited), Enterprise (unlimited). Deliberately just the plan/limit/
// usage shape, not real recurring payment collection — see README for why
// that's a separate, larger piece of work than this pass.
//
// Requested directly: Starter used to be ₹0/free (internal key stays
// "free" — see planConfig/planFeatures' fallback below, and infra/plans.js's
// own comment on why the checkout-facing id "starter" and this internal
// key don't need to match). It's now a real minimum amount everyone pays
// to be listed and accept bookings at all, whether they use the shared
// platform WhatsApp number or (Growth+) their own.
//
// Found live (audit pass): the marketing site's pricing page already
// CLAIMED voice/multilingual AI, payments, and calendar sync as
// Growth-only, and a real Public API + unlimited team logins as
// Enterprise-only — but nothing in the code actually enforced any of it.
// Every one of those features was fully built and worked identically
// regardless of which plan a tenant was on. That's not "genuine and
// factual" pricing, it's aspirational copy — so this adds the actual
// enforcement (see the five call sites below: voice message handling,
// payment-requirement resolution, calendar connect, Public API auth,
// team-member creation, and — the newest — connecting a tenant's own
// WhatsApp number), not just better wording.
const PLAN_LIMITS = {
  free: { label: "Starter", maxBookingsPerMonth: 30 },
  growth: { label: "Growth", maxBookingsPerMonth: Infinity },
  enterprise: { label: "Enterprise", maxBookingsPerMonth: Infinity },
};

// One row per feature this plan actually gates in code — not a wishlist,
// a list every entry here has a real enforcement point for (grep this
// file's own comment block above for where). maxTeamMembers counts
// provider-role logins only (the tenant's own admin account is free on
// every plan — gating the one login that manages the tenant would be a
// different, much worse kind of paywall). ownWhatsAppNumber: a Starter
// tenant books through the shared platform number; Growth/Enterprise can
// connect their own WhatsApp Business number instead (src/routes/
// dashboard.js's /api/dashboard/whatsapp/connect), so only their
// business's own customers ever reach it.
const PLAN_FEATURES = {
  free: { voiceAI: false, payments: false, calendarSync: false, publicApi: false, ownWhatsAppNumber: false, maxTeamMembers: 2 },
  growth: { voiceAI: true, payments: true, calendarSync: true, publicApi: false, ownWhatsAppNumber: true, maxTeamMembers: 10 },
  enterprise: { voiceAI: true, payments: true, calendarSync: true, publicApi: true, ownWhatsAppNumber: true, maxTeamMembers: Infinity },
};

function planConfig(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

function planFeatures(plan) {
  return PLAN_FEATURES[plan] || PLAN_FEATURES.free;
}

// Convenience for call sites that only have a tenantId (most of them —
// plan isn't threaded through the conversational engine's function
// signatures today, and adding it everywhere would be a much larger,
// riskier change than one extra lookup at each of the handful of real
// gate points). Cheap: tenantStore.getById is already an indexed
// single-row lookup used throughout this codebase for exactly this.
async function tenantHasFeature(tenantId, feature) {
  const tenant = await tenantStore.getById(tenantId);
  return !!planFeatures(tenant?.plan)[feature];
}

// Computed live from the real booking rows every call, the same
// "computed on read, not a running counter" philosophy analytics.js
// already documents and uses — a counter that could drift from what it's
// summarizing is a worse problem than the scan it would save at this
// data size. Calendar-month boundary in IST (the business's own
// timezone), same as every other "this month"/"today" boundary in this
// codebase (dateSlots.js's isToday check) — found live (QA pass): this
// used to build the boundary from the SERVER's own local time (UTC on
// this app's actual host), miscounting bookings made in the first/last
// ~5.5 IST hours of a month into the wrong month's usage/quota.
async function getUsageSummary(tenantId, plan) {
  const config = planConfig(plan);
  const nowIST = toISTFields(new Date());
  const monthStart = istDate(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), 1).getTime();

  const allBookings = await bookings.values(tenantId);
  const bookingsThisMonth = allBookings.filter((b) => b.createdAt >= monthStart).length;

  const limit = config.maxBookingsPerMonth;
  const percentUsed = Number.isFinite(limit) && limit > 0 ? Math.min(100, Math.round((bookingsThisMonth / limit) * 100)) : 0;

  return {
    plan,
    planLabel: config.label,
    bookingsThisMonth,
    limit: Number.isFinite(limit) ? limit : null,
    percentUsed,
    // "Soft" — deliberately never blocks a real booking from being made
    // (the WhatsApp bot keeps working exactly as it does today past this
    // point); this is a signal for the dashboard to surface, not an
    // enforcement mechanism. A hard limit would mean rejecting a real
    // customer's booking attempt because of the OPERATOR's plan choice —
    // a materially different, much more consequential decision than
    // showing them a warning to upgrade.
    softLimitExceeded: Number.isFinite(limit) && bookingsThisMonth >= limit,
    features: planFeatures(plan),
  };
}

module.exports = { PLAN_LIMITS, PLAN_FEATURES, getUsageSummary, planFeatures, tenantHasFeature };
