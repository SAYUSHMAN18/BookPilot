// Enterprise Hardening Phase 2, item 4 — a customer stuck past
// CONFUSION_ESCALATION_THRESHOLD unclear replies gets a support_requests
// row (already covered by supportEscalation.test.js) AND the bot pauses
// its own AI-conversational replies for that conversation until a
// provider resolves the request from the dashboard. Same
// handleIncomingMessage harness as feedbackLoop.test.js.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");

let supportRequests, handleIncomingMessage, clearHumanHandoff, isHumanHandoffActive, workflows;
const TENANT = 1;
const GIBBERISH = "zzxxqqwwee nonsense gibberish asdkjfh";

before(async () => {
  process.env.SESSION_SECRET = "test-secret";
  process.env.GROQ_API_KEY = "test-key-not-real"; // present but invalid — every call falls back to keyword classification
  await createIsolatedTestDatabase();
  for (const mod of ["../../src/store/db", "../../src/store/supportRequestStore", "../../src/engine/workflowEngine", "../../src/engine/loadWorkflows"]) {
    delete require.cache[require.resolve(mod)];
  }
  supportRequests = require("../../src/store/supportRequestStore");
  ({ handleIncomingMessage, clearHumanHandoff, isHumanHandoffActive } = require("../../src/engine/workflowEngine"));
  const { loadWorkflows } = require("../../src/engine/loadWorkflows");
  workflows = loadWorkflows();
});

test("three consecutive unclear replies escalate and pause the bot; more unclear replies don't pile up a second escalation", async () => {
  const waId = "919888811001";
  assert.equal(isHumanHandoffActive(TENANT, waId), false, "no session yet — must not throw or report active");

  for (let i = 0; i < 3; i++) {
    await handleIncomingMessage(TENANT, waId, GIBBERISH, workflows);
  }

  assert.equal(isHumanHandoffActive(TENANT, waId), true, "3rd unclear reply should trigger escalation and pause the bot");
  const afterFirstEscalation = (await supportRequests.listAll(TENANT)).filter((r) => r.waId === waId);
  assert.equal(afterFirstEscalation.length, 1);

  // While paused, more unclear (or any) messages must be dropped before
  // ever reaching handleDetecting again — confusionCount can't advance,
  // so no second escalation, no second support_requests row.
  for (let i = 0; i < 3; i++) {
    await handleIncomingMessage(TENANT, waId, GIBBERISH, workflows);
  }
  const stillOne = (await supportRequests.listAll(TENANT)).filter((r) => r.waId === waId);
  assert.equal(stillOne.length, 1, "the bot should be fully paused, not re-escalating on every subsequent message");
  assert.equal(isHumanHandoffActive(TENANT, waId), true);
});

test("clearHumanHandoff resumes the bot — a later stretch of unclear replies can escalate again", async () => {
  const waId = "919888811002";
  for (let i = 0; i < 3; i++) {
    await handleIncomingMessage(TENANT, waId, GIBBERISH, workflows);
  }
  assert.equal(isHumanHandoffActive(TENANT, waId), true);

  await clearHumanHandoff(TENANT, waId);
  assert.equal(isHumanHandoffActive(TENANT, waId), false);

  for (let i = 0; i < 3; i++) {
    await handleIncomingMessage(TENANT, waId, GIBBERISH, workflows);
  }
  assert.equal(isHumanHandoffActive(TENANT, waId), true, "the bot should be able to escalate again after being resumed");
  const rows = (await supportRequests.listAll(TENANT)).filter((r) => r.waId === waId);
  assert.equal(rows.length, 2, "a fresh stretch of confusion after resuming should log its own, separate escalation");
});

test("clearHumanHandoff on a wa_id with no session at all does not throw", async () => {
  await clearHumanHandoff(TENANT, "919888811099");
});

test("RESTART still works during a handoff — it isn't dropped by the pause", async () => {
  const waId = "919888811003";
  for (let i = 0; i < 3; i++) {
    await handleIncomingMessage(TENANT, waId, GIBBERISH, workflows);
  }
  assert.equal(isHumanHandoffActive(TENANT, waId), true);

  // RESTART deletes the session outright (see processMessage) — after
  // this, there's no session left for humanHandoffActive to be true on.
  await handleIncomingMessage(TENANT, waId, "restart", workflows);
  assert.equal(isHumanHandoffActive(TENANT, waId), false, "RESTART must escape a paused conversation, not be swallowed by it");
});
