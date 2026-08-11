const bookings = require("../store/bookingStore");

// New plan, Block 12 — a minimal billing/usage skeleton, matching the
// marketing site's own existing pricing tiers (README's Pricing section):
// Starter (free, up to 100 bookings/mo), Growth (unlimited), Enterprise
// (unlimited). Deliberately just the plan/limit/usage shape, not real
// recurring payment collection — see README for why that's a separate,
// larger piece of work than this pass.
const PLAN_LIMITS = {
  free: { label: "Starter", maxBookingsPerMonth: 100 },
  growth: { label: "Growth", maxBookingsPerMonth: Infinity },
  enterprise: { label: "Enterprise", maxBookingsPerMonth: Infinity },
};

function planConfig(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

// Computed live from the real booking rows every call, the same
// "computed on read, not a running counter" philosophy analytics.js
// already documents and uses — a counter that could drift from what it's
// summarizing is a worse problem than the scan it would save at this
// data size. Calendar-month boundary in the server's own local time,
// same as every other "this month"/"today" boundary in this codebase
// (e.g. dateSlots.js's isToday check).
function getUsageSummary(tenantId, plan) {
  const config = planConfig(plan);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const bookingsThisMonth = bookings.values(tenantId).filter((b) => b.createdAt >= monthStart).length;

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
  };
}

module.exports = { PLAN_LIMITS, getUsageSummary };
