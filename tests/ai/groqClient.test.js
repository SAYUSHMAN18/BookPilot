const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

// A server that accepts the connection but never sends a response —
// simulates a genuinely hung Groq call (not a slow-but-eventual one,
// which a timeout test could pass against for the wrong reason).
function startHangingServer() {
  return new Promise((resolve) => {
    const server = http.createServer(() => {
      // Deliberately never call res.end() / res.write().
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("groqChatCompletion aborts a hung call within the configured timeout", async () => {
  const server = await startHangingServer();
  const { port } = server.address();
  process.env.GROQ_API_URL = `http://127.0.0.1:${port}/`;
  process.env.GROQ_API_KEY = "test-key-not-real";
  delete require.cache[require.resolve("../../src/ai/groqClient")];
  const { groqChatCompletion } = require("../../src/ai/groqClient");

  const startedAt = Date.now();
  await assert.rejects(
    () => groqChatCompletion({ model: "x", messages: [] }, { timeoutMs: 300 }),
    (err) => {
      assert.equal(err.code, "GROQ_TIMEOUT");
      return true;
    }
  );
  const elapsed = Date.now() - startedAt;

  // Generous upper bound (timeout + scheduling slack), not a tight
  // assertion on exact timing — the point is "it aborted near the
  // configured deadline," not "it aborted at exactly 300ms."
  assert.ok(elapsed < 1500, `expected abort near 300ms, took ${elapsed}ms`);

  server.close();
  delete process.env.GROQ_API_URL;
});

test("groqChatCompletion rejects immediately when GROQ_API_KEY is unset", async () => {
  delete process.env.GROQ_API_KEY;
  delete require.cache[require.resolve("../../src/ai/groqClient")];
  const { groqChatCompletion } = require("../../src/ai/groqClient");
  await assert.rejects(() => groqChatCompletion({ model: "x", messages: [] }));
});
