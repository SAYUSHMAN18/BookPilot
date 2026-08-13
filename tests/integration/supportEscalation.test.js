const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");

const { isBotIdentityQuestion, isExplicitComplaint, isPriceObjection } = require("../../src/ai/intentDetector");

test("1.6: price objections recognized in English and Hinglish", () => {
  assert.equal(isPriceObjection("PAISE JADA HAI YEH"), true);
  assert.equal(isPriceObjection("this is too expensive"), true);
  assert.equal(isPriceObjection("can you give a discount"), true);
  assert.equal(isPriceObjection("continue"), false);
});

test("1.8: bot identity questions are recognized regardless of phrasing", () => {
  for (const q of ["are you a bot", "is this an AI", "am I talking to a human", "ARE YOU REAL PERSON"]) {
    assert.equal(isBotIdentityQuestion(q), true, `expected "${q}" to be recognized`);
  }
  assert.equal(isBotIdentityQuestion("what time do you open"), false);
});

test("1.7: isExplicitComplaint only true for actual frustration words", () => {
  assert.equal(isExplicitComplaint("this is terrible service"), true);
  assert.equal(isExplicitComplaint("can I speak to support"), false);
  assert.equal(isExplicitComplaint("CAN I SPEAK TO SUPPORT"), false);
});

test("1.4: support_requests table records an escalation and can be resolved", async () => {
  await createIsolatedTestDatabase();
  delete require.cache[require.resolve("../../src/store/db")];
  delete require.cache[require.resolve("../../src/store/supportRequestStore")];
  const supportRequests = require("../../src/store/supportRequestStore");
  const TENANT = 1; // the default tenant, created by db.js's own migration

  const created = await supportRequests.create(TENANT, "919888800000", "medical", "let me talk to someone please");
  assert.equal(created.waId, "919888800000");
  assert.equal(created.workflowId, "medical");
  assert.equal(created.resolved, false);

  const forWorkflow = await supportRequests.listForWorkflow(TENANT, "medical");
  assert.equal(forWorkflow.length, 1);
  assert.equal(forWorkflow[0].id, created.id);

  // A different workflow's provider must not see this request.
  assert.equal((await supportRequests.listForWorkflow(TENANT, "hair")).length, 0);

  const resolved = await supportRequests.setResolved(TENANT, created.id, true);
  assert.equal(resolved.resolved, true);
});
