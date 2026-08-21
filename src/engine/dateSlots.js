// Date/time helpers for the select_date, select_time_slot, and hotel
// date-range steps. Assumes the server runs in the business's own timezone
// (fine for a single-region MVP — a multi-timezone deployment would need
// real per-workflow timezone handling).

// Uses LOCAL date components, not .toISOString() (which converts to UTC
// first — for any timezone ahead of UTC, a local-midnight Date rolls back
// to the previous UTC day, silently corrupting every date comparison).
function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfDay(d) {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

// Parses a stored "YYYY-MM-DD" string back into local midnight — the
// counterpart to isoDate(). Never use `new Date(isoString)` directly for a
// date-only string: the spec parses it as UTC midnight, which mismatches
// every other Date in this file (all built from local y/m/d components) and
// throws off date-range/boundary comparisons by the UTC offset.
function parseIsoDate(isoString) {
  const [y, m, d] = isoString.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatLongDate(d) {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
}

function formatTime(d) {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
}

// The nearest thing to "a calendar" WhatsApp's standard interactive
// messages can actually do — a tappable list, since there's no native
// date-picker component here (that exists only in WhatsApp Flows, a
// separate, much larger feature requiring Meta review and a hosted data-
// exchange endpoint — out of scope for this). `days` is capped at 10,
// WhatsApp's list row limit; the id IS the ISO date, so it's directly
// usable everywhere else a date is compared.
function dateOptions(days = 7) {
  const count = Math.min(days, 10);
  const options = [];
  for (let i = 0; i < count; i++) {
    const d = startOfDay(new Date(Date.now() + i * 24 * 60 * 60 * 1000));
    const iso = isoDate(d);
    const title = i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" });
    options.push({ id: iso, title, iso, label: formatLongDate(d) });
  }
  return options;
}

// Slots within workflow.businessHours, every workflow.slotMinutes. If the
// chosen day is today, slots already in the past are skipped. Slots in
// `excludeSlots` (already booked by someone else, matched by exact label —
// bookings always use the same 12h label format this function generates)
// are left out too — this is what stops two customers double-booking the
// same provider/time. `blockedRanges` ([{startMin, endMin}], minute-of-day,
// end exclusive) additionally excludes anything a provider blocked off —
// this is the range-aware check Section 2 added; it runs HERE, in the
// same generator that produces what WhatsApp actually offers, rather than
// as a separate filter a caller could forget to apply. Capped at 10
// (WhatsApp interactive lists max out at 10 rows).
function timeSlotsFor(workflow, dateOptionIso, excludeSlots = new Set(), blockedRanges = []) {
  const hours = workflow.businessHours || { start: "09:00", end: "18:00" };
  const slotMinutes = workflow.slotMinutes || 30;
  const [startH, startM] = hours.start.split(":").map(Number);
  const [endH, endM] = hours.end.split(":").map(Number);

  const cursor = new Date();
  cursor.setHours(startH, startM, 0, 0);
  const end = new Date();
  end.setHours(endH, endM, 0, 0);

  const isToday = dateOptionIso === isoDate(new Date());
  const now = new Date();

  // Found live (QA pass) — the loop bound used to be just `cursor < end`,
  // which only checks that a slot STARTS before closing, never that it
  // FINISHES by closing. Fine when slotMinutes evenly divides the
  // businessHours window (every test fixture so far happens to), but a
  // window like 09:00-10:00 at 45-min slots offered "9:45 am" — a slot
  // that runs until 10:30, thirty minutes past close. slotEndMs is the
  // actual boundary check: only offer a slot that fully fits before end.
  const slotMs = slotMinutes * 60 * 1000;
  const slots = [];
  while (cursor.getTime() + slotMs <= end.getTime() && slots.length < 10) {
    const label = formatTime(cursor);
    const cursorMinutes = cursor.getHours() * 60 + cursor.getMinutes();
    const inBlockedRange = blockedRanges.some((r) => cursorMinutes >= r.startMin && cursorMinutes < r.endMin);
    if ((!isToday || cursor > now) && !excludeSlots.has(label) && !inBlockedRange) {
      slots.push(label);
    }
    cursor.setMinutes(cursor.getMinutes() + slotMinutes);
  }
  return slots;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Lenient parser for free-text dates like hotel check-in ("12 Aug",
// "2026-08-12", "today", "tomorrow"). Returns a Date (midnight, local time)
// or null if it couldn't make sense of the input — callers should treat
// null as "ask the customer to rephrase," not crash.
function parseFlexibleDate(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return null;

  const now = new Date();
  if (t === "today") return startOfDay(now);
  if (t === "tomorrow") return startOfDay(new Date(now.getTime() + 24 * 60 * 60 * 1000));

  const dayMonth = t.match(/^(\d{1,2})[\s-]+([a-z]+)$/);
  if (dayMonth) {
    const day = parseInt(dayMonth[1], 10);
    const monthIdx = MONTH_NAMES.findIndex((m) => dayMonth[2].startsWith(m));
    if (monthIdx >= 0 && day >= 1 && day <= 31) {
      const year = now.getFullYear();
      let candidate = new Date(year, monthIdx, day);
      if (candidate < startOfDay(now)) candidate = new Date(year + 1, monthIdx, day);
      return candidate;
    }
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const candidate = parseIsoDate(t);
    return isNaN(candidate.getTime()) ? null : candidate;
  }

  return null;
}

// Inverse of formatTime() — turns a generated/chosen slot label ("9:30
// am", "2:00 pm") back into minute-of-day, so a specific already-picked
// slot can be checked against a blocked range the same way generation
// does. Returns null for anything that doesn't parse as a slot label
// (defensive — callers should treat that as "can't determine, don't
// block").
function labelToMinutes(label) {
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec((label || "").trim());
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toLowerCase() === "pm") h += 12;
  return h * 60 + parseInt(m[2], 10);
}

module.exports = { dateOptions, timeSlotsFor, parseFlexibleDate, startOfDay, isoDate, parseIsoDate, formatLongDate, labelToMinutes };
