// Section 10.2 — the signed state token that carries a Google Calendar
// OAuth connection request's (tenant, workflow, provider) context across
// the redirect to Google and back, and doubles as CSRF protection on the
// callback. Pure HMAC math, no network — fully testable without a real
// Google Cloud OAuth client, same as tests/infra/razorpayProvider.test.js's
// webhook signature tests.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const originalSecret = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = "test-session-secret-for-oauth-state";
delete require.cache[require.resolve("../../src/infra/oauthState")];
const { signOAuthState, verifyOAuthState } = require("../../src/infra/oauthState");

test.after(() => {
  if (originalSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalSecret;
});

test("signOAuthState produces a token verifyOAuthState can round-trip", () => {
  const token = signOAuthState({ tenantId: 1, workflowId: "medical", providerId: "p1" });
  const payload = verifyOAuthState(token);
  assert.equal(payload.tenantId, 1);
  assert.equal(payload.workflowId, "medical");
  assert.equal(payload.providerId, "p1");
});

test("verifyOAuthState rejects a tampered token", () => {
  const token = signOAuthState({ tenantId: 1, workflowId: "medical", providerId: "p1" });
  const [, sig] = token.split(".");
  const tamperedBody = Buffer.from(JSON.stringify({ tenantId: 2, workflowId: "medical", providerId: "p1", exp: Date.now() + 60000 })).toString("base64url");
  assert.equal(verifyOAuthState(`${tamperedBody}.${sig}`), null, "a body that doesn't match the original signature must be rejected");
});

test("verifyOAuthState rejects garbage/malformed input without throwing", () => {
  assert.equal(verifyOAuthState("not-a-real-token"), null);
  assert.equal(verifyOAuthState(""), null);
  assert.equal(verifyOAuthState(null), null);
  assert.equal(verifyOAuthState(undefined), null);
});

test("verifyOAuthState rejects an expired token", () => {
  // Hand-construct an already-expired token using the same signing shape.
  const crypto = require("node:crypto");
  const body = Buffer.from(JSON.stringify({ tenantId: 1, workflowId: "medical", providerId: "p1", exp: Date.now() - 1000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", "test-session-secret-for-oauth-state").update(body).digest("base64url");
  assert.equal(verifyOAuthState(`${body}.${sig}`), null);
});

test("two different (workflow, provider) requests never verify as each other's state", () => {
  const tokenA = signOAuthState({ tenantId: 1, workflowId: "medical", providerId: "p1" });
  const tokenB = signOAuthState({ tenantId: 1, workflowId: "hair", providerId: "p2" });
  const payloadA = verifyOAuthState(tokenA);
  const payloadB = verifyOAuthState(tokenB);
  assert.notEqual(payloadA.workflowId, payloadB.workflowId);
  assert.notEqual(payloadA.providerId, payloadB.providerId);
});
