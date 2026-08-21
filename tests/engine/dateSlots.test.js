// QA pass — timeSlotsFor()'s loop bound used to be `cursor < end`, which
// only checks that a slot STARTS before closing, never that it FINISHES
// by closing. Correct when slotMinutes evenly divides the businessHours
// window (every existing fixture happened to), silently wrong otherwise:
// a 09:00-10:00 window at 45-min slots offered "9:45 am", a slot that
// runs until 10:30 — thirty minutes past close. Pure function, no DB
// needed (unlike tests/store/availabilityRange.test.js, which also
// exercises timeSlotsFor but always through a DB-backed blocked-range
// lookup).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { timeSlotsFor } = require("../../src/engine/dateSlots");

const FUTURE_DATE = "2099-01-01"; // always "not today" so the past-slot filter never interferes

test("a 45-min slot is never offered if it would run past closing (09:00-10:00, 45-min slots)", () => {
  const workflow = { businessHours: { start: "09:00", end: "10:00" }, slotMinutes: 45 };
  const slots = timeSlotsFor(workflow, FUTURE_DATE);
  assert.deepEqual(slots, ["9:00 am"], "9:45 am would run until 10:30 — past the 10:00 close — and must not be offered");
});

test("an evenly-divisible window still offers every slot, unchanged (09:00-10:00, 30-min slots)", () => {
  const workflow = { businessHours: { start: "09:00", end: "10:00" }, slotMinutes: 30 };
  const slots = timeSlotsFor(workflow, FUTURE_DATE);
  assert.deepEqual(slots, ["9:00 am", "9:30 am"]);
});

test("a window smaller than one slot offers nothing, without crashing (09:00-09:30, 45-min slots)", () => {
  const workflow = { businessHours: { start: "09:00", end: "09:30" }, slotMinutes: 45 };
  const slots = timeSlotsFor(workflow, FUTURE_DATE);
  assert.deepEqual(slots, []);
});

test("the closing time itself is never offered as a slot start (already-correct exclusive-end behavior)", () => {
  const workflow = { businessHours: { start: "09:00", end: "10:00" }, slotMinutes: 20 };
  const slots = timeSlotsFor(workflow, FUTURE_DATE);
  assert.deepEqual(slots, ["9:00 am", "9:20 am", "9:40 am"], "10:00 am itself must not appear — no room to run before close");
});
