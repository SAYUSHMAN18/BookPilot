// Date/time helpers for the select_date, select_time_slot, and hotel
// date-range steps. The business runs in IST (India) — every function
// below is written to be correct in IST regardless of what timezone the
// server process itself happens to be running in.

// Found live (QA pass, real production incident): a customer messaged at
// real IST 3:58pm and was offered — and successfully booked — "2:00 pm",
// already in the past by their own clock. Root cause: this file used to
// build/read Date objects via plain `new Date()` + local getters/setters
// (`.getHours()`, `.setHours()`, `new Date(y,m,d)`, ...), which resolve
// against the PROCESS's own OS timezone — on Render (this app's actual
// host) that's UTC, not IST. A workflow's `businessHours.start: "09:00"`
// (meant as 9am IST) was being constructed as 9am UTC = 2:30pm IST, so
// every generated slot label was shifted by exactly the UTC/IST offset
// (5.5h) relative to what its own text claimed — self-consistent
// internally (no real double-booking), but every DISPLAYED time was
// wrong relative to real IST wall-clock time, and "Today" vs "Tomorrow"
// was wrong for the ~5.5 real IST hours each evening (6:30pm–midnight)
// where the UTC calendar date hasn't rolled over yet but the real IST
// date already has. src/infra/logger.js's own nowIST() already solved
// this exact class of bug for LOG DISPLAY (Intl.DateTimeFormat with
// timeZone: "Asia/Kolkata") — this file needed the same fix for the
// actual booking logic, not just what gets printed to a log line.
//
// IST is a fixed UTC+5:30 offset with no daylight saving (unlike almost
// any other timezone you'd need to handle this way) — that fixed-offset
// property is what makes toISTFields()/istDate() below correct with
// simple arithmetic, no timezone library required. toISTFields(d) takes
// any real moment (a `new Date()`, or a Date built from a stored epoch
// like booking.createdAt) and shifts it so its UTC-prefixed getters
// (getUTCHours, getUTCDate, ...) read as IST wall-clock fields — every
// function below that needs to READ a calendar/clock field goes through
// this. istDate(y, m, d, h, mi) is the inverse: given IST wall-clock
// components, returns the real Date instant they refer to — every
// function below that needs to CONSTRUCT a specific IST moment (e.g.
// "today's business hours start") goes through this.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toISTFields(d) {
  return new Date(d.getTime() + IST_OFFSET_MS);
}

function istDate(y, m, d, h = 0, mi = 0, s = 0, ms = 0) {
  return new Date(Date.UTC(y, m, d, h, mi, s, ms) - IST_OFFSET_MS);
}

function isoDate(d) {
  const ist = toISTFields(d);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const day = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Midnight IST of whatever real moment `d` falls on, as a real instant —
// the IST-aware counterpart to the old "just zero out the local time
// fields" version.
function startOfDay(d) {
  const ist = toISTFields(d);
  return istDate(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
}

// Parses a stored "YYYY-MM-DD" string back into IST midnight — the
// counterpart to isoDate(). Never use `new Date(isoString)` directly for a
// date-only string: the spec parses it as UTC midnight, which mismatches
// every other Date in this file and throws off date-range/boundary
// comparisons by a further, separate offset on top of the IST/UTC one.
function parseIsoDate(isoString) {
  const [y, m, d] = isoString.split("-").map(Number);
  return istDate(y, m - 1, d);
}

// Pure display formatting — Intl's own `timeZone` option handles this
// directly, no need to construct a shifted Date for it.
function formatLongDate(d) {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
}

function formatTime(d) {
  const ist = toISTFields(d);
  let h = ist.getUTCHours();
  const m = ist.getUTCMinutes();
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
    const title = i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
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

  // dateOptionIso is the IST calendar day this step is generating slots
  // for; businessHours.start/end are IST wall-clock times — istDate()
  // constructs the real instants they both refer to.
  const [y, m, d] = dateOptionIso.split("-").map(Number);
  const cursor = istDate(y, m - 1, d, startH, startM);
  const end = istDate(y, m - 1, d, endH, endM);

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
    const cursorIST = toISTFields(cursor);
    const cursorMinutes = cursorIST.getUTCHours() * 60 + cursorIST.getUTCMinutes();
    const inBlockedRange = blockedRanges.some((r) => cursorMinutes >= r.startMin && cursorMinutes < r.endMin);
    if ((!isToday || cursor > now) && !excludeSlots.has(label) && !inBlockedRange) {
      slots.push(label);
    }
    // A fixed-minute increment changes the real underlying instant by
    // exactly slotMinutes * 60000ms regardless of which timezone's lens
    // reads it back — safe to keep as a plain local setMinutes(), no IST
    // awareness needed for the increment itself, only for construction
    // (above) and reading (formatTime/cursorIST above).
    cursor.setMinutes(cursor.getMinutes() + slotMinutes);
  }
  return slots;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Lenient parser for free-text dates like hotel check-in ("12 Aug",
// "2026-08-12", "today", "tomorrow"). Returns a Date (IST midnight of the
// resolved calendar day) or null if it couldn't make sense of the input —
// callers should treat null as "ask the customer to rephrase," not crash.
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
      const nowIST = toISTFields(now);
      const year = nowIST.getUTCFullYear();
      let candidate = istDate(year, monthIdx, day);
      if (candidate < startOfDay(now)) candidate = istDate(year + 1, monthIdx, day);
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
// block"). Pure string parsing — no Date object involved, no timezone
// concern.
function labelToMinutes(label) {
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec((label || "").trim());
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toLowerCase() === "pm") h += 12;
  return h * 60 + parseInt(m[2], 10);
}

module.exports = { dateOptions, timeSlotsFor, parseFlexibleDate, startOfDay, isoDate, parseIsoDate, formatLongDate, formatTime, labelToMinutes, istDate, toISTFields };
