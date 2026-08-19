// Found live, real conversation testing (not a synthetic case): a customer
// mid-booking who asks a genuine question the business's own data can't
// ground an answer for (factualQA.js correctly replies NO_ANSWER rather
// than inventing one) used to get executeOrchestratedPlan's ANSWER_QUESTION
// branch returning `false` — which then fell through to the CURRENT STEP's
// own validation-error copy (e.g. select_provider's "Sorry, I didn't
// recognize that provider — please tap one from the list"). That flatly
// misdescribes what happened: they asked a real question, not a garbled
// provider name. Fixed in workflowEngine.js's ANSWER_QUESTION branch to
// always send an honest reply (grounded answer, or an "I don't have that
// info" acknowledgment) before re-prompting the step — this pins it down
// so it can't silently regress.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const http = require("node:http");
const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");

test("a mid-booking question with no grounded answer gets an honest reply, not the step's raw validation error", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bookpilot-midflow-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.SESSION_SECRET = "test-secret";
  process.env.GROQ_API_KEY = "test-key-not-real";
  await createIsolatedTestDatabase();

  // One mock server for both Groq calls this turn needs (orchestrator's
  // planNextAction, factualQA's tryAnswerFactually) — routed by a distinct
  // phrase each one's own system prompt is known to contain (see
  // src/ai/orchestrator.js and src/ai/factualQA.js).
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const systemContent = parsed.messages.find((m) => m.role === "system")?.content || "";
      let content;
      if (systemContent.includes("route a customer's mid-booking")) {
        content = '{"action":"answer_question"}';
      } else if (systemContent.includes("answering a customer's factual question")) {
        content = "NO_ANSWER"; // nothing in this business's data grounds an answer
      } else {
        content = '{"action":"retry_step"}';
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.GROQ_API_URL = `http://127.0.0.1:${server.address().port}/`;

  for (const mod of ["../../src/ai/groqClient", "../../src/ai/classify", "../../src/ai/intentDetector", "../../src/ai/factualQA", "../../src/ai/orchestrator", "../../src/engine/workflowEngine", "../../src/infra/whatsapp", "../../src/store/db", "../../src/store/bookingStore", "../../src/store/sessionStore", "../../src/engine/loadWorkflows"]) {
    delete require.cache[require.resolve(mod)];
  }
  const { handleIncomingMessage } = require("../../src/engine/workflowEngine");
  const { beginReplyCapture, endStructuredReplyCapture } = require("../../src/infra/whatsapp");
  const { loadWorkflows } = require("../../src/engine/loadWorkflows");
  const workflows = loadWorkflows();

  try {
    const waId = "919000000888";
    // Both of these are deterministic, keyword-matched turns (no Groq
    // call) — greet, then pick the "hair" business by its exact reply
    // code, landing on the select_provider step with a real provider list
    // already shown. This is the same two-turn path the live manual test
    // that found this bug used.
    await handleIncomingMessage(1, waId, "hi", workflows);
    await handleIncomingMessage(1, waId, "hair", workflows);

    // Now the actual scenario: a genuine question the business's data
    // can't answer, asked while still on the select_provider step.
    beginReplyCapture(waId);
    await handleIncomingMessage(1, waId, "do you also do beard trims?", workflows);
    const replies = endStructuredReplyCapture(waId).map((r) => r.text);

    assert.equal(replies.length, 2, "expected the honest fallback reply, then the re-prompted step");
    assert.match(replies[0], /don't have specific information/i);
    assert.doesNotMatch(replies[0], /didn't recognize that provider/i, "a real question must never be misreported as a bad provider name");
    // Re-prompts the SAME step they were on — the question didn't corrupt
    // or advance the booking state.
    assert.match(replies[1], /salon options/i);
  } finally {
    server.close();
    delete process.env.GROQ_API_URL;
    delete process.env.GROQ_API_KEY;
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
});
