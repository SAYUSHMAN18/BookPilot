// Item 9 regression — the AI_CHAT sub-mode variant. loopDetection.test.js
// covers the deterministic keyword-fallback path (GROQ_API_KEY blanked, per
// _setup.js's own documented reasoning) but that's exactly why it couldn't
// catch this: with a real Groq call in play, the FIRST unclassifiable
// message correctly escalorates the confusion counter and, staying under
// threshold, drops the session into subStage "AI_CHAT" — after which every
// subsequent message hit that subStage's dispatch branch directly, never
// re-checking maybeEscalateConfusion again. A customer who stayed confused
// past their first miss could never reach a human, no matter how many more
// unclear messages they sent. Driven through the real /api/simulate-whatsapp
// pipeline with a mocked Groq server (routed by each caller's own
// distinctive system-prompt phrase, same technique as
// tests/integration/midFlowQuestion.test.js), since the bug lives
// specifically in how workflowEngine.js's subStage dispatch interacts with
// a live AI path — not reproducible with the keyword-only fallback.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const http = require("node:http");
const { freshApp } = require("./_setup");

const GIBBERISH = "zzxxqqweewqzzxx"; // matches no workflow's keywords, no command word

function startMockGroqServer() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const systemContent = parsed.messages.find((m) => m.role === "system")?.content || "";
      let content;
      if (systemContent.includes("into EXACTLY ONE intent")) {
        content = "unclear";
      } else if (systemContent.includes("classify a customer's WhatsApp message into exactly one business category")) {
        content = "unclear";
      } else if (systemContent.includes("answering a customer's factual question") || systemContent.includes("factual")) {
        content = "NO_ANSWER";
      } else {
        // handleAiChat's own freeform system prompt ("friendly AI assistant
        // for a booking platform") — a plausible, unhelpful-but-plausible
        // reply, same shape as what a real stuck customer would get.
        content = "I'm not sure I understand — could you tell me more about what you're looking for?";
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return server;
}

test("3 consecutive unclassifiable messages escalate even after the first one drops the session into AI_CHAT sub-mode", async () => {
  const server = startMockGroqServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // GROQ_API_URL first, since groqClient.js reads it into a module-level
  // const at require() time — freshApp() re-requires the whole src/ tree,
  // so this must already be set before that call. GROQ_API_KEY is read via
  // process.env at CALL time everywhere it's checked, but freshApp() itself
  // unconditionally blanks it (its own documented default for every other
  // test in this suite) — so it has to be set back AFTER freshApp() returns.
  process.env.GROQ_API_URL = `http://127.0.0.1:${server.address().port}/`;

  try {
    const app = await freshApp();
    process.env.GROQ_API_KEY = "test-key-not-real";
    const supportRequests = require("../../src/store/supportRequestStore");
    const waId = "919000022222";

    for (let i = 0; i < 3; i++) {
      const resp = await request(app).post("/api/simulate-whatsapp").send({ from: waId, text: GIBBERISH, tenantId: 1 });
      assert.equal(resp.status, 200);
    }

    const requests = await supportRequests.listAll(1);
    assert.ok(
      requests.some((r) => r.waId === waId),
      "expected a support request after 3 consecutive unclear replies, even though GROQ_API_KEY routed the session into AI_CHAT sub-mode after the first one"
    );
  } finally {
    server.close();
    delete process.env.GROQ_API_URL;
    delete process.env.GROQ_API_KEY;
  }
});
