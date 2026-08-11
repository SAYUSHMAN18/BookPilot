// Item 9 — loop detection. Before this, a customer sending unmatched/
// off-script replies with no active booking and no explicit complaint got
// the exact same "couldn't understand" + business menu forever, with no
// escalation. Driven through the real /api/simulate-whatsapp conversation
// pipeline (not workflowEngine internals directly) since that's the actual
// path a stuck customer's messages take.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { freshApp } = require("./_setup");

const GIBBERISH = "zzxxqqweewqzzxx"; // matches no workflow's keywords, no command word

test("3 consecutive unclassifiable messages escalate to a support request", async () => {
  const app = freshApp();
  const supportRequests = require("../../src/store/supportRequestStore");
  const waId = "919000011111";

  for (let i = 0; i < 3; i++) {
    const resp = await request(app).post("/api/simulate-whatsapp").send({ from: waId, text: GIBBERISH, tenantId: 1 });
    assert.equal(resp.status, 200);
  }

  const requests = supportRequests.listAll(1);
  assert.ok(requests.some((r) => r.waId === waId), "expected a support request to have been logged after 3 consecutive unclear replies");
});

test("only 2 consecutive unclassifiable messages do NOT escalate yet", async () => {
  const app = freshApp();
  const supportRequests = require("../../src/store/supportRequestStore");
  const waId = "919000011112";

  for (let i = 0; i < 2; i++) {
    await request(app).post("/api/simulate-whatsapp").send({ from: waId, text: GIBBERISH, tenantId: 1 });
  }

  const requests = supportRequests.listAll(1);
  assert.ok(!requests.some((r) => r.waId === waId), "should not escalate before the 3rd consecutive unclear reply");
});

test("a successful classification in between resets the streak — no escalation", async () => {
  const app = freshApp();
  const supportRequests = require("../../src/store/supportRequestStore");
  const waId = "919000011113";

  await request(app).post("/api/simulate-whatsapp").send({ from: waId, text: GIBBERISH, tenantId: 1 });
  await request(app).post("/api/simulate-whatsapp").send({ from: waId, text: GIBBERISH, tenantId: 1 });
  // A real classification — resets the streak counter.
  await request(app).post("/api/simulate-whatsapp").send({ from: waId, text: "I need a haircut", tenantId: 1 });
  await request(app).post("/api/simulate-whatsapp").send({ from: waId, text: GIBBERISH, tenantId: 1 });
  await request(app).post("/api/simulate-whatsapp").send({ from: waId, text: GIBBERISH, tenantId: 1 });

  const requests = supportRequests.listAll(1);
  assert.ok(!requests.some((r) => r.waId === waId), "the streak should have reset after the successful classification, so only 2 consecutive unclear replies follow it");
});
