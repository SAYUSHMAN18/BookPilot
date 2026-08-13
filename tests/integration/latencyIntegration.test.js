// Full-pipeline test: with Groq completely unreachable (every call hangs),
// does an incoming WhatsApp message still get a reply within a bounded
// time, or does it hang forever? This is Section 0's actual definition of
// done, exercised end to end rather than against one isolated function.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const http = require("node:http");
const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");

test("handleIncomingMessage completes within the timeout window even when Groq hangs entirely", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bookpilot-latency-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.SESSION_SECRET = "test-secret";
  process.env.GROQ_API_KEY = "test-key-not-real";
  process.env.GROQ_TIMEOUT_MS = "300"; // fast test, not the 5s production default
  await createIsolatedTestDatabase();

  const server = http.createServer(() => {}); // accepts, never responds
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.GROQ_API_URL = `http://127.0.0.1:${server.address().port}/`;

  // Fresh module graph so every file picks up the env vars set above —
  // several of these modules cache config at require-time.
  for (const mod of ["../../src/ai/groqClient", "../../src/ai/classify", "../../src/ai/intentDetector", "../../src/ai/factualQA", "../../src/ai/orchestrator", "../../src/engine/workflowEngine", "../../src/store/db", "../../src/store/bookingStore", "../../src/store/sessionStore", "../../src/engine/loadWorkflows"]) {
    delete require.cache[require.resolve(mod)];
  }
  const { handleIncomingMessage } = require("../../src/engine/workflowEngine");
  const { loadWorkflows } = require("../../src/engine/loadWorkflows");
  const workflows = loadWorkflows();

  // try/finally so a thrown assertion or a bug in the pipeline itself
  // can never leave the hanging-response server open — an open server
  // keeps the whole `node --test` process alive well past this one
  // test finishing, which is exactly what happened the first time this
  // test caught a real bug (an unguarded workflow.keywords.some() crash):
  // the test correctly failed fast, but the leaked server then stalled
  // the entire suite for the rest of the run.
  try {
    const startedAt = Date.now();
    // "I need a doctor" with no active booking runs the worst-case chain:
    // detectGeneralIntent -> classifyBusiness -> tryAnswerFactually, all
    // three hitting the hanging server before falling back to keywords.
    await handleIncomingMessage(1, "919000000999", "I need to see a doctor please", workflows);
    const elapsed = Date.now() - startedAt;

    // Three sequential 300ms-timeout calls, worst case — generous bound
    // well under what an indefinite hang would produce.
    assert.ok(elapsed < 3000, `expected the full pipeline to resolve well under 3s, took ${elapsed}ms`);
  } finally {
    server.close();
    delete process.env.GROQ_API_URL;
    delete process.env.GROQ_TIMEOUT_MS;
    // dataDir here is DATA_DIR (src/infra/uploads.js's local-upload
    // directory), unrelated to the actual Postgres database now — best-
    // effort cleanup only, same as every other test file's own mkdtempSync
    // temp dir.
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
});
