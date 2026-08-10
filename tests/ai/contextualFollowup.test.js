// Section 1.5, seeded from the real transcript scenario: "IS IT FOR TODAY
// OR ANY OTHER DAY" right after a STATUS reply used to get the exact same
// static STATUS block repeated verbatim. Two bugs were found chasing
// this, both covered here: (1) the follow-up gets classified CHECK_STATUS
// again by the LLM, which used to always re-run the static command
// instead of answering the specific question; (2) the first fix for that
// answered confidently WRONG ("it is for today") for a three-week-out
// booking, because the model was never told what "today" actually is.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { tryAnswerAboutBooking } = require("../../src/ai/factualQA");

test("tryAnswerAboutBooking: returns null (safe no-op) without GROQ_API_KEY, never throws", async () => {
  // Save/restore rather than a bare delete — this file's later tests need
  // the real key, and node:test runs every test in this file in the same
  // process, so a permanent delete here would silently zero out coverage
  // for everything after it (which is exactly what happened the first
  // time this test was written).
  const savedKey = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  try {
    const booking = { bookingId: "APT-1", providerName: "Dr. X", visitDate: "2026-08-25", visitDateLabel: "Tue, 25 Aug", visitTime: "11:00", status: "booked" };
    const answer = await tryAnswerAboutBooking("is it today", booking, []);
    assert.equal(answer, null);
  } finally {
    if (savedKey) process.env.GROQ_API_KEY = savedKey;
  }
});

// Requires a real GROQ_API_KEY — skipped automatically if one isn't
// configured (e.g. CI without the secret), since this specifically tests
// LLM date reasoning, not something a keyword regex can stand in for.
const hasGroqKey = !!process.env.GROQ_API_KEY;
test(
  "tryAnswerAboutBooking: correctly distinguishes a future booking from today (live Groq)",
  { skip: !hasGroqKey && "GROQ_API_KEY not set" },
  async () => {
    const now = new Date();
    const future = new Date(now);
    future.setDate(future.getDate() + 19);
    const futureIso = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;

    const booking = {
      bookingId: "APT-FUTURE",
      providerName: "Dr. Rajesh Sharma",
      visitDate: futureIso,
      visitDateLabel: futureIso,
      visitTime: "11:00",
      status: "booked",
    };
    const answer = await tryAnswerAboutBooking("IS IT FOR TODAY OR ANY OTHER DAY", booking, [
      { text: "STATUS", reply: `Your next appointment is on ${futureIso} at 11:00 with Dr. Rajesh Sharma.` },
    ]);
    assert.ok(answer, "expected a real answer, not a NO_ANSWER null");
    assert.doesNotMatch(answer.toLowerCase(), /^it is for today\.?$/, "must not confidently claim a 19-day-out booking is today");
  }
);

test(
  "tryAnswerAboutBooking: correctly confirms a same-day booking IS today (live Groq)",
  { skip: !hasGroqKey && "GROQ_API_KEY not set" },
  async () => {
    const now = new Date();
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const booking = {
      bookingId: "APT-TODAY",
      providerName: "Dr. Neha Mehta",
      visitDate: todayIso,
      visitDateLabel: todayIso,
      visitTime: "15:00",
      status: "booked",
    };
    const answer = await tryAnswerAboutBooking("is this today or a different day", booking, []);
    assert.ok(answer, "expected a real answer");
    assert.match(answer.toLowerCase(), /today/, "expected the answer to confirm it's today");
  }
);
