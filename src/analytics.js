const bookings = require("./bookingStore");
const { isoDate } = require("./dateSlots");

// Aggregates the bookings table into the numbers a business actually acts
// on: is demand growing, which slots fill first, who's not showing up.
//
// Computed on read rather than maintained as running counters — at this
// data size a full scan is microseconds, and a derived counter that can
// drift out of sync with the rows it summarizes is a worse problem than
// the scan it saves. Revisit if the bookings table reaches six figures.
//
// Scope: pass workflowId+providerId to get one provider's own numbers
// (what a provider dashboard shows), or omit both for platform-wide
// figures (admin). The caller is responsible for enforcing which of those
// a given session is allowed to ask for.
function computeAnalytics({ workflowId = null, providerId = null, days = 30 } = {}) {
  const all = bookings.values().filter((b) => {
    if (workflowId && b.workflowId !== workflowId) return false;
    if (providerId && b.providerId !== providerId) return false;
    return true;
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Bookings created per day over the window — the demand trend line.
  const perDay = [];
  const countsByDay = new Map();
  for (const b of all) {
    const key = isoDate(new Date(b.createdAt));
    countsByDay.set(key, (countsByDay.get(key) || 0) + 1);
  }
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = isoDate(d);
    perDay.push({ date: key, count: countsByDay.get(key) || 0 });
  }

  // Which time slots fill up — what staffing decisions hang on.
  const slotCounts = new Map();
  for (const b of all) {
    if (!b.visitTime) continue;
    slotCounts.set(b.visitTime, (slotCounts.get(b.visitTime) || 0) + 1);
  }
  const popularSlots = [...slotCounts.entries()]
    .map(([time, count]) => ({ time, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // Which weekdays are busiest (0 = Sunday).
  const weekdayCounts = new Array(7).fill(0);
  for (const b of all) {
    const dateStr = b.visitDate || b.checkInIso;
    if (!dateStr) continue;
    const [y, m, d] = dateStr.split("-").map(Number);
    if (!y || !m || !d) continue;
    weekdayCounts[new Date(y, m - 1, d).getDay()] += 1;
  }

  const byStatus = { booked: 0, arrived: 0, cancelled: 0 };
  for (const b of all) {
    if (byStatus[b.status] !== undefined) byStatus[b.status] += 1;
  }

  // Per-provider leaderboard — only meaningful platform-wide, so it's
  // omitted when the caller already scoped to a single provider.
  const providerCounts = new Map();
  if (!providerId) {
    for (const b of all) {
      const key = `${b.workflowId}::${b.providerId}`;
      const entry = providerCounts.get(key) || { workflowId: b.workflowId, providerId: b.providerId, providerName: b.providerName, total: 0, arrived: 0, cancelled: 0 };
      entry.total += 1;
      if (b.status === "arrived") entry.arrived += 1;
      if (b.status === "cancelled") entry.cancelled += 1;
      providerCounts.set(key, entry);
    }
  }

  // A booking that was never marked "arrived" AFTER its date has passed is
  // the closest thing to a no-show this data supports — the bot has no
  // attendance signal beyond the customer texting HERE. Future-dated
  // bookings are excluded, since "not arrived yet" isn't a no-show.
  const todayIso = isoDate(today);
  const past = all.filter((b) => {
    const dateStr = b.visitDate || b.checkInIso;
    return dateStr && dateStr < todayIso && b.status !== "cancelled";
  });
  const noShows = past.filter((b) => b.status !== "arrived").length;

  return {
    total: all.length,
    byStatus,
    perDay,
    popularSlots,
    weekdayCounts,
    providers: [...providerCounts.values()].sort((a, b) => b.total - a.total).slice(0, 10),
    noShowRate: past.length > 0 ? Math.round((noShows / past.length) * 100) : null,
    noShowSampleSize: past.length,
  };
}

module.exports = { computeAnalytics };
