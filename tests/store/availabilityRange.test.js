// Section 2 — verified exactly as the plan's 2.5 specifies: block
// 2:30-3:40, confirm every overlapping slot (2:30, 2:45, 3:00, 3:15, 3:30)
// is excluded from the actual WhatsApp-facing slot generator, and slots
// outside the range (2:15, 3:40+) are still offered. Runs through
// timeSlotsFor() itself, not a reimplementation of the overlap logic —
// this is "does the bot actually stop offering these," not just "does
// the range math look right in isolation."
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bookpilot-availability-test-"));
delete require.cache[require.resolve("../../src/store/db")];
delete require.cache[require.resolve("../../src/store/availabilityStore")];
const { blockSlot, blockedRangesForDay, timeToMinutes } = require("../../src/store/availabilityStore");
const { timeSlotsFor, labelToMinutes } = require("../../src/engine/dateSlots");
const TENANT = 1; // the default tenant, created by db.js's own migration

const workflow = {
  // Starts close to the test window on purpose — timeSlotsFor() caps at
  // 10 results (WhatsApp's list-row limit), so a 9am start with 15-min
  // slots would never even reach 2pm and every "still offered" assertion
  // below would be trivially/wrongly satisfied by truncation, not by the
  // range logic actually working.
  businessHours: { start: "14:00", end: "18:00" },
  slotMinutes: 15,
};
const FUTURE_DATE = "2099-01-01"; // always "not today" so the past-slot filter never interferes

test("2.5: a 2:30-3:40 range block excludes every overlapping slot and nothing else", () => {
  blockSlot(TENANT, "t", "p1", FUTURE_DATE, "14:30", "15:40", "lunch");
  const ranges = blockedRangesForDay(TENANT, "t", "p1", FUTURE_DATE);
  const slots = timeSlotsFor(workflow, FUTURE_DATE, new Set(), ranges);

  for (const shouldBeExcluded of ["2:30 pm", "2:45 pm", "3:00 pm", "3:15 pm", "3:30 pm"]) {
    assert.ok(!slots.includes(shouldBeExcluded), `expected "${shouldBeExcluded}" to be excluded, but it was offered`);
  }
  for (const shouldStillBeOffered of ["2:15 pm", "3:45 pm"]) {
    assert.ok(slots.includes(shouldStillBeOffered), `expected "${shouldStillBeOffered}" to still be offered, but it was excluded`);
  }
});

const morningWorkflow = { businessHours: { start: "09:00", end: "12:00" }, slotMinutes: 15 };

test("2.1/backward-compat: a legacy single-slot block (no end_time) still excludes exactly that slot", () => {
  blockSlot(TENANT, "t", "p2", FUTURE_DATE, "10:00", null, "old-style block");
  const ranges = blockedRangesForDay(TENANT, "t", "p2", FUTURE_DATE);
  const slots = timeSlotsFor(morningWorkflow, FUTURE_DATE, new Set(), ranges);
  assert.ok(!slots.includes("10:00 am"), "the exact blocked slot should be excluded");
  assert.ok(slots.includes("10:15 am"), "the very next slot should NOT be collaterally excluded");
});

test("regression: the original format-mismatch bug stays fixed (24h stored time correctly excludes the 12h-labeled slot)", () => {
  blockSlot(TENANT, "t", "p3", FUTURE_DATE, "09:30", null, null);
  const ranges = blockedRangesForDay(TENANT, "t", "p3", FUTURE_DATE);
  const slots = timeSlotsFor(morningWorkflow, FUTURE_DATE, new Set(), ranges);
  assert.ok(!slots.includes("9:30 am"), "9:30 am must be excluded — this was the bug where 24h/12h formats never matched");
});

test("labelToMinutes round-trips correctly for both am/pm and 12-hour edge cases", () => {
  assert.equal(labelToMinutes("12:00 am"), 0); // midnight
  assert.equal(labelToMinutes("12:30 pm"), 12 * 60 + 30); // noon-thirty
  assert.equal(labelToMinutes("1:00 pm"), 13 * 60);
  assert.equal(labelToMinutes("not a time"), null);
});

test("timeToMinutes parses 24h HH:MM correctly", () => {
  assert.equal(timeToMinutes("00:00"), 0);
  assert.equal(timeToMinutes("14:30"), 14 * 60 + 30);
  assert.equal(timeToMinutes("23:59"), 23 * 60 + 59);
});
