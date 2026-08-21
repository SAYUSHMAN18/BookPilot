// Real production incident — a customer messaged at real IST 3:58pm and
// was offered, and successfully booked, "2:00 pm": already in the past by
// their own clock. Root cause: dateSlots.js built/read Date objects via
// plain `new Date()` + local getters/setters, which resolve against the
// PROCESS's own OS timezone (UTC on this app's actual host, Render), not
// IST — a workflow's businessHours (meant as IST wall-clock hours) got
// silently shifted by the UTC/IST offset (5.5h) relative to what the
// generated labels claimed. This file pins the fix: the core IST-aware
// primitives (istDate/toISTFields/isoDate/formatTime) against fixed,
// timezone-independent epoch inputs, and the exact reported bug scenario
// against a faked clock (node:test's mock.timers, which can fake `Date`
// in this Node version) — proof this doesn't regress, not just "the
// arithmetic looks right."
const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const { istDate, toISTFields, isoDate, formatTime, parseIsoDate, dateOptions, timeSlotsFor } = require("../../src/engine/dateSlots");

test("istDate/toISTFields round-trip: a specific IST wall-clock moment reads back the same fields", () => {
  // 21 Aug 2026, 2:00 pm IST.
  const d = istDate(2026, 7, 21, 14, 0); // month is 0-indexed (7 = August)
  const back = toISTFields(d);
  assert.equal(back.getUTCFullYear(), 2026);
  assert.equal(back.getUTCMonth(), 7);
  assert.equal(back.getUTCDate(), 21);
  assert.equal(back.getUTCHours(), 14);
  assert.equal(back.getUTCMinutes(), 0);
});

test("istDate produces the correct real UTC instant (2pm IST = 8:30am UTC)", () => {
  const d = istDate(2026, 7, 21, 14, 0);
  assert.equal(d.toISOString(), "2026-08-21T08:30:00.000Z");
});

test("isoDate reads the IST calendar day, not the UTC one, for a moment where they differ", () => {
  // 21 Aug 2026, 11:30pm IST = 18:00 UTC on 21 Aug — same UTC day here,
  // so use a moment just after IST midnight instead, where UTC is still
  // the PREVIOUS day: 22 Aug 2026, 00:30 IST = 21 Aug 2026, 19:00 UTC.
  const d = new Date("2026-08-21T19:00:00.000Z");
  assert.equal(isoDate(d), "2026-08-22", "IST calendar day (22nd) must win, not UTC's (21st)");
});

test("formatTime labels a real instant by its true IST clock hour, not the host's local hour", () => {
  // 2026-08-21T08:30:00Z is exactly 2:00pm IST.
  const d = new Date("2026-08-21T08:30:00.000Z");
  assert.equal(formatTime(d), "2:00 pm");
});

test("parseIsoDate + isoDate round-trip for a plain calendar-day string", () => {
  assert.equal(isoDate(parseIsoDate("2026-08-21")), "2026-08-21");
});

test("dateOptions' first entry is IST 'Today', not the host's local today", (t) => {
  // 2026-08-21T19:00:00Z = 2026-08-22, 00:30 IST — IST's calendar day has
  // already rolled over to the 22nd even though UTC is still on the 21st.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-21T19:00:00.000Z") });
  const options = dateOptions(3);
  assert.equal(options[0].id, "2026-08-22", "IST's calendar day (22nd) must be 'Today', not UTC's (21st)");
  assert.equal(options[0].title, "Today");
});

test("REGRESSION — the exact reported incident: at real IST 3:58pm, '2:00 pm' is never offered as a slot", (t) => {
  // Real IST 2026-08-21 15:58 = UTC 2026-08-21 10:28.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-21T10:28:00.000Z") });
  const workflow = { businessHours: { start: "09:00", end: "21:00" }, slotMinutes: 30 };
  const slots = timeSlotsFor(workflow, "2026-08-21");
  assert.ok(!slots.includes("2:00 pm"), "2:00 pm IST has already passed at real IST 3:58pm and must not be offered");
  assert.ok(slots.includes("4:00 pm"), "a slot after the real current IST time should still be offered");
});

test("a business day starting at 09:00 IST offers its first slot at 9:00 am, not 2:30 pm", (t) => {
  // Well before business hours, real IST — no past-slot filtering should exclude anything.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-21T02:00:00.000Z") }); // 7:30am IST
  const workflow = { businessHours: { start: "09:00", end: "21:00" }, slotMinutes: 30 };
  const slots = timeSlotsFor(workflow, "2026-08-21");
  assert.equal(slots[0], "9:00 am", "businessHours.start ('09:00') must mean 9am IST, not 9am UTC (which would render as '2:30 pm')");
});
