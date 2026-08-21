// Enterprise Hardening Phase 1, item 4 — validateEnv() in server.js must
// refuse to boot in production when SESSION_SECRET/APP_ENCRYPTION_KEY are
// missing, not just log a warning nobody's watching. Uses _setup.js's
// `envOverrides` (added alongside this test) to opt OUT of freshApp()'s
// normally-safe hardcoded SESSION_SECRET/NODE_ENV — every other test file
// keeps getting those defaults unchanged.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./_setup");

test("freshApp() rejects when NODE_ENV=production and SESSION_SECRET is missing", async () => {
  await assert.rejects(
    freshApp({ envOverrides: { nodeEnv: "production", sessionSecret: "" } }),
    /Refusing to boot in production.*SESSION_SECRET/
  );
});

test("freshApp() rejects when NODE_ENV=production and APP_ENCRYPTION_KEY is missing", async () => {
  await assert.rejects(
    freshApp({ envOverrides: { nodeEnv: "production", appEncryptionKey: "" } }),
    /Refusing to boot in production.*APP_ENCRYPTION_KEY/
  );
});

test("freshApp() still boots fine in production when both are actually set", async () => {
  const app = await freshApp({ envOverrides: { nodeEnv: "production" } });
  await app.ready; // must not throw
});

test("a missing SESSION_SECRET outside production still only warns, doesn't block boot (unchanged local-dev behavior)", async () => {
  const app = await freshApp({ envOverrides: { nodeEnv: "", sessionSecret: "" } });
  await app.ready; // must not throw — NODE_ENV isn't "production" here
});
