// Section 15 — AsyncLocalStorage-based request correlation. Verifies the
// context actually survives real async hops (a promise chain, nested
// function calls) rather than only working for the trivial synchronous
// case, and that unrelated concurrent contexts never bleed into each
// other — the entire point of using ALS instead of a shared module-level
// variable.
const { test } = require("node:test");
const assert = require("node:assert/strict");

delete require.cache[require.resolve("../../src/infra/tracing")];
const { runWithRequestId, getRequestId, newRequestId } = require("../../src/infra/tracing");

test("getRequestId returns undefined outside any tracked context", () => {
  assert.equal(getRequestId(), undefined);
});

test("runWithRequestId makes the id available synchronously inside the callback", async () => {
  let seen;
  await runWithRequestId(async () => { seen = getRequestId(); }, "test-id-1");
  assert.equal(seen, "test-id-1");
});

test("the id survives real async hops (await, setTimeout, a promise chain)", async () => {
  let seenAfterAwait, seenAfterTimeout, seenInChain;
  await runWithRequestId(async () => {
    await new Promise((r) => setTimeout(r, 5));
    seenAfterTimeout = getRequestId();
    await Promise.resolve().then(() => { seenInChain = getRequestId(); });
    seenAfterAwait = getRequestId();
  }, "test-id-2");
  assert.equal(seenAfterTimeout, "test-id-2");
  assert.equal(seenInChain, "test-id-2");
  assert.equal(seenAfterAwait, "test-id-2");
});

test("newRequestId generates a real, unique UUID each call", () => {
  const a = newRequestId();
  const b = newRequestId();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test("two concurrent contexts never see each other's requestId", async () => {
  const results = [];
  await Promise.all([
    runWithRequestId(async () => {
      await new Promise((r) => setTimeout(r, 10));
      results.push(["A", getRequestId()]);
    }, "concurrent-A"),
    runWithRequestId(async () => {
      await new Promise((r) => setTimeout(r, 5));
      results.push(["B", getRequestId()]);
    }, "concurrent-B"),
  ]);
  const a = results.find((r) => r[0] === "A");
  const b = results.find((r) => r[0] === "B");
  assert.equal(a[1], "concurrent-A");
  assert.equal(b[1], "concurrent-B");
});

test("a fresh requestId is generated automatically when none is supplied", async () => {
  let seen;
  await runWithRequestId(async () => { seen = getRequestId(); });
  assert.ok(typeof seen === "string" && seen.length > 0);
});
