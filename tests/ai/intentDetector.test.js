// Regression tests seeded directly from the real transcript that surfaced
// these gaps (Section 1.2, 1.10).
const { test } = require("node:test");
const assert = require("node:assert/strict");

delete process.env.GROQ_API_KEY; // exercise the deterministic keyword path directly
delete require.cache[require.resolve("../../src/ai/intentDetector")];
const { detectGeneralIntent, INTENTS } = require("../../src/ai/intentDetector");

test("1.2: 'cancel whatever bookings are under my name' (Hinglish) -> cancel_booking", async () => {
  const intent = await detectGeneralIntent("JITNE V BOOKING AHIA MERE NAAM PE SAB CANCEL KRDO", true);
  assert.equal(intent, INTENTS.CANCEL_BOOKING);
});

test("1.2: plain 'CANCEL' -> cancel_booking via keyword path", async () => {
  assert.equal(await detectGeneralIntent("CANCEL", true), INTENTS.CANCEL_BOOKING);
});

test("1.2: 'band karo' / 'hata do' Hindi cancel phrasing -> cancel_booking", async () => {
  assert.equal(await detectGeneralIntent("mera booking band karo", true), INTENTS.CANCEL_BOOKING);
  assert.equal(await detectGeneralIntent("booking hata do please", true), INTENTS.CANCEL_BOOKING);
});

test("1.2: 'STATUS' and Hindi equivalents -> check_status", async () => {
  assert.equal(await detectGeneralIntent("STATUS", true), INTENTS.CHECK_STATUS);
  assert.equal(await detectGeneralIntent("mera appointment kab hai", true), INTENTS.CHECK_STATUS);
});

test("1.10: Hindi fever symptom -> booking_intent (routes to classifyBusiness, not dropped as unclear)", async () => {
  assert.equal(await detectGeneralIntent("MUJHE BUKHAR HUA HAI", false), INTENTS.BOOKING_INTENT);
});

test("1.10: English symptom phrasing without the word 'doctor' still reads as a booking intent", async () => {
  assert.equal(await detectGeneralIntent("I have a bad cough and cold", false), INTENTS.BOOKING_INTENT);
});
