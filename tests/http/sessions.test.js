// New plan, Block 14 — session list/revoke. Tokens stay stateless bearer
// credentials (signature + expiry, unchanged), but every one now carries
// a session id checked against a small revocation table — these tests
// prove the revocation actually takes effect on the session's very next
// request, not just that the routes return the right JSON shape.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { freshApp, signupAndActivate } = require("./_setup");

test("GET /api/auth/sessions lists the caller's own sessions and correctly flags the current one", async () => {
  const app = await freshApp();
  const { cookie } = await signupAndActivate(app, request, { businessName: "Sessions Biz", email: "sessions@example.com" });

  const resp = await request(app).get("/api/auth/sessions").set("Cookie", cookie);
  assert.equal(resp.status, 200);
  assert.equal(resp.body.length, 1);
  assert.equal(resp.body[0].isCurrent, true);
});

test("logging in from a second \"device\" creates an independent second session — both listed, neither is the other's current", async () => {
  const app = await freshApp();
  const { cookie: cookieA } = await signupAndActivate(app, request, { businessName: "Two Device Biz", email: "twodevice@example.com" });
  const login2 = await request(app).post("/api/auth/login").send({ email: "twodevice@example.com", password: "password123" });
  const cookieB = login2.headers["set-cookie"];

  const listFromA = await request(app).get("/api/auth/sessions").set("Cookie", cookieA);
  assert.equal(listFromA.body.length, 2);
  const currentInA = listFromA.body.find((s) => s.isCurrent);
  const otherInA = listFromA.body.find((s) => !s.isCurrent);
  assert.ok(currentInA && otherInA);

  const listFromB = await request(app).get("/api/auth/sessions").set("Cookie", cookieB);
  assert.equal(listFromB.body.length, 2);
  // The session B sees as "current" must be the one A saw as "other".
  const currentInB = listFromB.body.find((s) => s.isCurrent);
  assert.equal(currentInB.id, otherInA.id);
});

test("DELETE /api/auth/sessions/:id revokes that session — its cookie stops working on the very next request", async () => {
  const app = await freshApp();
  const { cookie: cookieA } = await signupAndActivate(app, request, { businessName: "Revoke Biz", email: "revoke@example.com" });
  const login2 = await request(app).post("/api/auth/login").send({ email: "revoke@example.com", password: "password123" });
  const cookieB = login2.headers["set-cookie"];

  const listFromA = await request(app).get("/api/auth/sessions").set("Cookie", cookieA);
  const sessionBId = listFromA.body.find((s) => !s.isCurrent).id;

  const revoke = await request(app).delete(`/api/auth/sessions/${sessionBId}`).set("Cookie", cookieA);
  assert.equal(revoke.status, 200);

  // Session B's own cookie is now dead, even though it never expired and
  // was never explicitly logged out by whoever was using it.
  const stillWorks = await request(app).get("/api/dashboard/providers").set("Cookie", cookieB);
  assert.equal(stillWorks.status, 401);

  // Session A (the one that did the revoking) is completely unaffected.
  const aStillWorks = await request(app).get("/api/dashboard/providers").set("Cookie", cookieA);
  assert.equal(aStillWorks.status, 200);
});

test("a user cannot revoke another user's session by guessing its id", async () => {
  const app = await freshApp();
  const tenantA = await signupAndActivate(app, request, { businessName: "Cross Revoke A", email: "cross-revoke-a@example.com" });
  const tenantB = await signupAndActivate(app, request, { businessName: "Cross Revoke B", email: "cross-revoke-b@example.com" });

  const listB = await request(app).get("/api/auth/sessions").set("Cookie", tenantB.cookie);
  const sessionBId = listB.body[0].id;

  // A's attempt "succeeds" (200 — the route doesn't leak whether the id
  // exists) but must be a structural no-op: it's scoped to A's own
  // user_id, so it can never match B's row.
  await request(app).delete(`/api/auth/sessions/${sessionBId}`).set("Cookie", tenantA.cookie);

  const bStillWorks = await request(app).get("/api/dashboard/providers").set("Cookie", tenantB.cookie);
  assert.equal(bStillWorks.status, 200, "tenant B's own session must be completely unaffected by tenant A's revoke attempt");
});

test("POST /api/auth/logout revokes the session server-side, not just the client-side cookie", async () => {
  const app = await freshApp();
  const { cookie } = await signupAndActivate(app, request, { businessName: "Logout Revoke Biz", email: "logout-revoke@example.com" });

  const logout = await request(app).post("/api/auth/logout").set("Cookie", cookie);
  assert.equal(logout.status, 200);

  // Simulates a leaked/copied cookie value being replayed after the
  // legitimate owner logged out — must be rejected, not still honored
  // for the rest of its 12h natural lifetime.
  const replay = await request(app).get("/api/dashboard/providers").set("Cookie", cookie);
  assert.equal(replay.status, 401);
});
