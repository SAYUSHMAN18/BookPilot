// Voice bug report — Sarvam TTS was narrating WhatsApp's own markdown
// literally ("asterisk asterisk...") instead of the intended emphasis,
// because the exact text built for the WhatsApp bubble was handed to TTS
// unchanged. stripMarkdownForSpeech() (src/infra/voice.js) is the fix —
// unit-tested directly rather than through synthesizeSpeech() itself,
// since that needs a real SARVAM_API_KEY and a live network call.
const { test } = require("node:test");
const assert = require("node:assert/strict");
// voice.js requires tenantStore -> db.js, which needs DATABASE_URL set —
// nothing in this file otherwise touches the database (stripMarkdownForSpeech
// is a pure string function), but requiring the module at all needs this.
require("dotenv").config();
const { stripMarkdownForSpeech } = require("../../src/infra/voice");

test("strips the exact reported bug case: bulleted *bold* provider names", () => {
  const input =
    "Sure! The nearest workout studios in Noida include:\n\n" +
    "- *FitZone Gym & Fitness Studio* – general gym with trainers (free booking).\n" +
    "- *PowerHouse CrossFit Box* – CrossFit training (free booking).\n" +
    "- *Shanti Yoga Studio* – yoga sessions (free booking).";
  const spoken = stripMarkdownForSpeech(input);
  assert.doesNotMatch(spoken, /\*/, "no literal asterisks should remain anywhere");
  assert.match(spoken, /FitZone Gym & Fitness Studio/);
  assert.match(spoken, /PowerHouse CrossFit Box/);
  assert.match(spoken, /Shanti Yoga Studio/);
  assert.doesNotMatch(spoken, /^-\s/m, "no line should still start with a bullet dash");
});

test("strips *bold*, _italic_, and ~strikethrough~ markers, keeping the inner text", () => {
  assert.equal(stripMarkdownForSpeech("Your *booking* is _confirmed_ — ~pending~"), "Your booking is confirmed — pending");
});

test("does not touch a real hyphen mid-sentence (only a leading bullet dash is stripped)", () => {
  assert.equal(stripMarkdownForSpeech("Open 9am-6pm, walk-ins welcome"), "Open 9am-6pm, walk-ins welcome");
});

test("does not touch a dash-formatted booking code mid-sentence (only a leading bullet dash is stripped)", () => {
  // Real booking codes in this app are dash-separated, e.g. SAL-20260821-2LLY
  // (bookingIdPrefix + date + random suffix) — never at the start of a line.
  assert.equal(stripMarkdownForSpeech("Your booking code is SAL-20260821-2LLY"), "Your booking code is SAL-20260821-2LLY");
});

test("a plain sentence with no markdown at all passes through unchanged (aside from trim)", () => {
  assert.equal(stripMarkdownForSpeech("Your appointment is confirmed for 3pm tomorrow."), "Your appointment is confirmed for 3pm tomorrow.");
});

test("multiple bold spans on the same line are all stripped, not just the first", () => {
  assert.equal(stripMarkdownForSpeech("*Dr. Sharma* is available at *4pm* and *5pm*"), "Dr. Sharma is available at 4pm and 5pm");
});
