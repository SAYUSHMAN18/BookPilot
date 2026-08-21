// QA pass fixes — two related bugs found via a real live-demo conversation:
//
// 1. select_time_slot's applyStepInput used ONE message ("that slot isn't
//    available — someone may have just taken it") for both a genuine
//    booking-collision race AND for completely unrecognized input
//    ("asdkjfh gibberish"), which is actively misleading for the second
//    case — no such slot was ever in play.
// 2. A genuine question during select_provider ("do you have a general
//    physician?") fell through to the step's own raw validation error
//    ("Sorry, I didn't recognize that provider...") instead of an honest
//    acknowledgment, when the orchestrator's own AI classification missed
//    it (RETRY_STEP). keywordIntent's QUESTION_RE is now a deterministic
//    safety net underneath the orchestrator for exactly this case.
//
// Same handleIncomingMessage + reply-capture harness as
// cancellationRecovery.test.js/expressRebook.test.js.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");

let handleIncomingMessage, workflows, beginReplyCapture, endReplyCapture;
const TENANT = 1;

before(async () => {
  process.env.SESSION_SECRET = "test-secret";
  delete process.env.GROQ_API_KEY; // deterministic: keyword fallback throughout, no live AI call
  await createIsolatedTestDatabase();
  for (const mod of ["../../src/store/db", "../../src/engine/workflowEngine", "../../src/engine/loadWorkflows", "../../src/infra/whatsapp"]) {
    delete require.cache[require.resolve(mod)];
  }
  ({ handleIncomingMessage } = require("../../src/engine/workflowEngine"));
  ({ beginReplyCapture, endReplyCapture } = require("../../src/infra/whatsapp"));
  const { loadWorkflows } = require("../../src/engine/loadWorkflows");
  workflows = loadWorkflows();
});

async function reachTimeSlotStep(waId) {
  await handleIncomingMessage(TENANT, waId, "I need a haircut", workflows); // -> select_provider
  await handleIncomingMessage(TENANT, waId, "p1", workflows); // -> select_date
  await handleIncomingMessage(TENANT, waId, "1", workflows); // "Today" -> select_time_slot
}

test("unrecognized input at the time-slot step says 'didn't recognize', not the misleading 'someone took it'", async () => {
  const waId = "919888844101";
  await reachTimeSlotStep(waId);

  beginReplyCapture(waId);
  await handleIncomingMessage(TENANT, waId, "asdkjfh gibberish 12345", workflows);
  const reply = endReplyCapture(waId);
  assert.match(reply, /didn't recognize/i);
  assert.doesNotMatch(reply, /someone may have just taken it/i, "gibberish was never a real slot — must not imply a collision that never happened");
});

test("a well-formed but unavailable time still gets the 'someone may have taken it' message (genuine-attempt case unchanged)", async () => {
  const waId = "919888844102";
  await reachTimeSlotStep(waId);

  beginReplyCapture(waId);
  // hair.json's business hours don't include 3am — a real time-label format, never actually offered.
  await handleIncomingMessage(TENANT, waId, "3:00 am", workflows);
  const reply = endReplyCapture(waId);
  assert.match(reply, /someone may have just taken it/i, "a real time-label-shaped attempt should keep the original wording");
});

test("a genuine question during select_provider gets an honest answer, not the raw 'didn't recognize that provider' error", async () => {
  const waId = "919888844103";
  await handleIncomingMessage(TENANT, waId, "I need a haircut", workflows); // -> select_provider

  beginReplyCapture(waId);
  await handleIncomingMessage(TENANT, waId, "do you have a unisex salon available?", workflows); // QUESTION_RE: "do you have"
  const reply = endReplyCapture(waId);
  assert.doesNotMatch(reply, /didn't recognize that provider/i, "a genuine question must not be misreported as an invalid provider name");
  // No GROQ_API_KEY -> tryAnswerFactually can't ground a real answer -> the honest fallback line.
  assert.match(reply, /I don't have specific information on that|let's continue with your booking/i);
});

test("the select_provider step is re-prompted after the honest answer, so the customer can still pick", async () => {
  const waId = "919888844104";
  await handleIncomingMessage(TENANT, waId, "I need a haircut", workflows);

  beginReplyCapture(waId);
  await handleIncomingMessage(TENANT, waId, "do you have weekend hours?", workflows);
  const reply = endReplyCapture(waId);
  assert.match(reply, /salon|hair court|renvic|aashi/i, "the provider list should be shown again, not dropped");
});
