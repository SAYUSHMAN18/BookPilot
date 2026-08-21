// Found live (adversarial testing): a garbled/nonsensical message reaching
// handleAiChat's freeform fallback (src/engine/workflowEngine.js) got a
// confident, fully invented answer — specific claims about the customer's
// own reasons/intentions, made up out of nothing. tryAnswerFactually (the
// OTHER, grounded Q&A path) already refuses to guess when ungrounded; this
// pins down that handleAiChat's system prompt carries the same explicit
// anti-fabrication instruction, so it can't silently regress. Can't assert
// on the actual (mocked) completion content — that's the LLM's call, not
// this codebase's — so this asserts on what THIS codebase controls: the
// instruction it sends the model.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const http = require("node:http");
const { freshApp } = require("./_setup");

test("handleAiChat's system prompt instructs the model not to invent facts it doesn't have", async () => {
  let capturedSystemPrompts = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const systemContent = parsed.messages.find((m) => m.role === "system")?.content || "";
      let content;
      if (systemContent.includes("into EXACTLY ONE intent")) {
        content = "question"; // route straight past classification into the Q&A branch
      } else if (systemContent.includes("classify a customer's WhatsApp message into exactly one business category")) {
        content = "unclear";
      } else if (systemContent.includes("answering a customer's factual question")) {
        content = "NO_ANSWER"; // nothing grounded — forces the freeform AI Chat fallback
      } else if (systemContent.includes("friendly AI assistant for a booking platform")) {
        capturedSystemPrompts.push(systemContent);
        content = "I'm not sure — could you tell me more?";
      } else {
        content = "unclear";
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.GROQ_API_URL = `http://127.0.0.1:${server.address().port}/`;

  try {
    const app = await freshApp();
    process.env.GROQ_API_KEY = "test-key-not-real";

    const resp = await request(app).post("/api/simulate-whatsapp").send({
      from: "919000033333",
      text: "Why he would like to book a haircut appointment for tomorrow please?",
      tenantId: 1,
    });
    assert.equal(resp.status, 200);

    assert.equal(capturedSystemPrompts.length, 1, "expected handleAiChat's Groq call to actually fire");
    assert.match(
      capturedSystemPrompts[0],
      /never invent specific facts/i,
      "handleAiChat's system prompt must explicitly forbid inventing facts it doesn't have"
    );
    assert.match(
      capturedSystemPrompts[0],
      /don't actually know/i,
      "handleAiChat's system prompt must scope that instruction to things the model doesn't actually know"
    );
  } finally {
    server.close();
    delete process.env.GROQ_API_URL;
    delete process.env.GROQ_API_KEY;
  }
});
