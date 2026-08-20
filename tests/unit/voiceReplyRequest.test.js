// Requested directly: a customer who TYPES "can you send that as a voice
// note?" got nothing but text back — TTS only ever ran off the language
// Sarvam detected from an incoming VOICE note, so a typed request for a
// spoken reply had no trigger at all. Verified live via a real webhook
// POST + real Sarvam TTS call (produced a 157KB mp3, logged as
// "[SIMULATED AUDIO -> ...]") before writing this — this pins the
// detection regex specifically: matches genuine requests, doesn't misfire
// on a business named "Voice & Co." or an unrelated "voice mail" question.
//
// webhook.js pulls in src/store/db.js (via tenantStore/outboundQueueStore)
// at require time, which throws immediately if DATABASE_URL isn't set —
// createIsolatedTestDatabase() is only here to satisfy that require chain
// for a test that otherwise has nothing to do with the database.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");

let VOICE_REQUEST_RE;

before(async () => {
  await createIsolatedTestDatabase();
  ({ VOICE_REQUEST_RE } = require("../../src/routes/webhook"));
});

const shouldMatch = [
  "can you send that as a voice note?",
  "please reply in voice",
  "speak this out loud",
  "speak it loud",
  "say that out loud please",
  "send me an audio message",
  "reply with voice",
  "could you send an audio reply",
];

const shouldNotMatch = [
  "do you have any voice mail",
  "Voice & Co salon",
  "I need a haircut tomorrow",
  "hi",
  "what's your address",
];

test("VOICE_REQUEST_RE matches genuine requests for a spoken reply", () => {
  for (const text of shouldMatch) {
    assert.ok(VOICE_REQUEST_RE.test(text), `expected a match for: "${text}"`);
  }
});

test("VOICE_REQUEST_RE does not misfire on unrelated messages", () => {
  for (const text of shouldNotMatch) {
    assert.equal(VOICE_REQUEST_RE.test(text), false, `expected no match for: "${text}"`);
  }
});
