// Item 2 — HTTP-level auth coverage: signup, login, and session-gated
// access, exercised through real Express routes via supertest rather than
// calling store functions directly. This is the first file to prove
// server.js is actually requirable/testable at all (see docs/ARCHITECTURE.md
// "Why server.js isn't split into src/routes/" — this is that prerequisite).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { freshApp } = require("./_setup");

test("POST /api/signup creates a tenant + admin account and sets a working session cookie", async () => {
  const app = freshApp();
  const resp = await request(app)
    .post("/api/signup")
    .send({ businessName: "Test Salon HTTP", ownerName: "Owner Name", email: "owner@example.com", password: "password123" });

  assert.equal(resp.status, 201);
  assert.equal(resp.body.user.email, "owner@example.com");
  assert.equal(resp.body.user.role, "admin");
  const cookie = resp.headers["set-cookie"];
  assert.ok(cookie && cookie.length > 0, "expected a Set-Cookie header");

  // The session the signup response set must actually work against a
  // protected route — proves the whole chain (hash, sign, cookie, verify
  // on the next request), not just that the DB rows got created.
  const me = await request(app).get("/api/dashboard/providers").set("Cookie", cookie);
  assert.equal(me.status, 200);
  assert.ok(Array.isArray(me.body));
});

test("POST /api/signup rejects a duplicate email with 409, and a short password with 400", async () => {
  const app = freshApp();
  await request(app).post("/api/signup").send({ businessName: "First Biz", email: "dup@example.com", password: "password123" });

  const dup = await request(app).post("/api/signup").send({ businessName: "Second Biz", email: "dup@example.com", password: "password123" });
  assert.equal(dup.status, 409);

  const shortPw = await request(app).post("/api/signup").send({ businessName: "Third Biz", email: "another@example.com", password: "short" });
  assert.equal(shortPw.status, 400);
});

test("POST /api/auth/login succeeds with correct credentials and fails with wrong password", async () => {
  const app = freshApp();
  await request(app).post("/api/signup").send({ businessName: "Login Test Biz", email: "login@example.com", password: "correct-password" });

  const bad = await request(app).post("/api/auth/login").send({ email: "login@example.com", password: "wrong-password" });
  assert.equal(bad.status, 401);
  assert.ok(!bad.headers["set-cookie"], "a failed login must not set a session cookie");

  const good = await request(app).post("/api/auth/login").send({ email: "login@example.com", password: "correct-password" });
  assert.equal(good.status, 200);
  assert.equal(good.body.user.email, "login@example.com");
});

test("protected dashboard routes reject an unauthenticated request with 401, not a redirect or a 500", async () => {
  const app = freshApp();
  const resp = await request(app).get("/api/dashboard/providers");
  assert.equal(resp.status, 401);
});

test("login is rate-limited after repeated failures from the same IP+email", async () => {
  const app = freshApp();
  await request(app).post("/api/signup").send({ businessName: "Rate Limit Biz", email: "ratelimit@example.com", password: "correct-password" });

  let lastStatus;
  for (let i = 0; i < 7; i++) {
    const resp = await request(app).post("/api/auth/login").send({ email: "ratelimit@example.com", password: "wrong-password" });
    lastStatus = resp.status;
  }
  assert.equal(lastStatus, 429);
});

test("a provider-role session cannot reach an admin-only route", async () => {
  const app = freshApp();
  const signup = await request(app)
    .post("/api/signup")
    .send({ businessName: "Role Check Biz", email: "roleadmin@example.com", password: "password123" });
  const adminCookie = signup.headers["set-cookie"];

  const created = await request(app)
    .post("/api/dashboard/users")
    .set("Cookie", adminCookie)
    .send({ email: "provider@example.com", password: "password123", role: "provider", name: "P One", workflowId: "hair", providerId: "p1" });
  assert.equal(created.status, 201);

  const providerLogin = await request(app).post("/api/auth/login").send({ email: "provider@example.com", password: "password123" });
  const providerCookie = providerLogin.headers["set-cookie"];

  const forbidden = await request(app).post("/api/dashboard/users").set("Cookie", providerCookie).send({ email: "x@example.com", password: "password123", role: "provider", name: "X", workflowId: "hair", providerId: "p2" });
  assert.equal(forbidden.status, 403);
});
