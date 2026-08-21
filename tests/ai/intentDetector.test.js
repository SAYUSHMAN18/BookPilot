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

// Found live (adversarial testing): a genuine complaint that happens to
// mention "my booking" ("...my booking got messed up, im really
// frustrated") unambiguously matches STATUS_RE's `\bmy (booking|
// appointment)\b` clause, and the CANCEL_RE/STATUS_RE override above
// (added for a real cancel false-negative) blindly overrode the LLM's
// correct "complaint" read with "check_status" — routing a frustrated
// customer to "No active booking found." instead of any acknowledgment.
// This exercises the LLM path itself (a mocked Groq server, not the
// keyword-only fallback the rest of this file uses) since the bug lives in
// the override logic that only runs after a successful LLM call.
test("1.2 regression: a complaint mentioning 'my booking' is not silently overridden to check_status", async () => {
  const http = require("node:http");
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "complaint" } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.GROQ_API_URL = `http://127.0.0.1:${server.address().port}/`;
  process.env.GROQ_API_KEY = "test-key-not-real";
  delete require.cache[require.resolve("../../src/ai/groqClient")];
  delete require.cache[require.resolve("../../src/ai/intentDetector")];
  const { detectGeneralIntent: detectWithLlm, INTENTS: I2 } = require("../../src/ai/intentDetector");
  try {
    const intent = await detectWithLlm("this is the third time my booking got messed up, im really frustrated", true);
    assert.equal(intent, I2.COMPLAINT);
  } finally {
    server.close();
    delete process.env.GROQ_API_URL;
    delete process.env.GROQ_API_KEY;
    delete require.cache[require.resolve("../../src/ai/groqClient")];
    delete require.cache[require.resolve("../../src/ai/intentDetector")];
  }
});
