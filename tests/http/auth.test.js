// Item 2 (+ new plan Section 2's OTP/activation flow) — HTTP-level auth
// coverage: signup, OTP verification, the pending-until-activated gate,
// login, and session-gated access, exercised through real Express routes
// via supertest rather than calling store functions directly. This is the
// first file to prove server.js is actually requirable/testable at all
// (see docs/ARCHITECTURE.md "Why server.js isn't split into src/routes/"
// — this is that prerequisite).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { freshApp, signupAndActivate } = require("./_setup");

function otpFor(email) {
  return require("../../src/store/signupOtpStore").createOtp(email);
}

test("POST /api/signup rejects a missing or wrong OTP, and succeeds with the correct one", async () => {
  const app = freshApp();
  const email = "owner@example.com";
  const body = { businessName: "Test Salon HTTP", ownerName: "Owner Name", email, password: "password123" };

  const noOtp = await request(app).post("/api/signup").send(body);
  assert.equal(noOtp.status, 400);

  const wrongOtp = await request(app).post("/api/signup").send({ ...body, otp: "000000" });
  assert.equal(wrongOtp.status, 400);

  const otp = otpFor(email);
  const resp = await request(app).post("/api/signup").send({ ...body, otp });
  assert.equal(resp.status, 201);
  assert.equal(resp.body.pending, true);
  assert.equal(resp.body.user.email, email);
  assert.equal(resp.body.user.role, "admin");
});

test("an OTP is single-use — the same code verifies once and never again", () => {
  freshApp(); // establishes a fresh DB for signupOtpStore to write into
  const { verifyOtp } = require("../../src/store/signupOtpStore");
  const email = "single-use@example.com";
  const otp = otpFor(email);

  assert.equal(verifyOtp(email, otp), true);
  assert.equal(verifyOtp(email, otp), false, "replaying the exact same code must fail the second time");
});

test("requesting a new OTP for the same email invalidates the earlier unused one", () => {
  freshApp();
  const { verifyOtp } = require("../../src/store/signupOtpStore");
  const email = "resend@example.com";
  const first = otpFor(email);
  const second = otpFor(email);

  assert.equal(verifyOtp(email, first), false, "the first code should have been invalidated by requesting a second");
  assert.equal(verifyOtp(email, second), true);
});

test("POST /api/signup/request-otp actually stores a code for that email (never returned in the response, by design)", async () => {
  const app = freshApp();
  const email = "requested@example.com";
  const requested = await request(app).post("/api/signup/request-otp").send({ email });
  assert.equal(requested.status, 200);
  assert.ok(!JSON.stringify(requested.body).match(/\d{6}/), "the raw code must never appear in the HTTP response");

  const { db } = require("../../src/store/db");
  const row = db.prepare("SELECT * FROM signup_otps WHERE email = ?").get(email);
  assert.ok(row, "expected the request-otp route to have stored a code for this email");
  assert.ok(!row.used_at);
});

test("POST /api/signup/request-otp is rate-limited per email after repeated requests", async () => {
  const app = freshApp();
  const email = "otp-flood@example.com";
  let lastStatus;
  for (let i = 0; i < 6; i++) {
    const resp = await request(app).post("/api/signup/request-otp").send({ email });
    lastStatus = resp.status;
  }
  assert.equal(lastStatus, 429);
});

test("a freshly signed-up (pending) tenant's admin session is blocked from dashboard routes until activated", async () => {
  const app = freshApp();
  const email = "pending@example.com";
  const otp = otpFor(email);
  const resp = await request(app).post("/api/signup").send({ businessName: "Pending Biz", email, password: "password123", otp });
  const cookie = resp.headers["set-cookie"];
  const tenantId = resp.body.user.tenantId;

  const blocked = await request(app).get("/api/dashboard/providers").set("Cookie", cookie);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.pendingActivation, true);

  // The exact same session cookie — no new login — starts working the
  // moment a platform_admin activates the tenant. Proves the gate is
  // purely the tenant's status, not anything about the session itself.
  const tenantStore = require("../../src/store/tenantStore");
  tenantStore.setStatus(tenantId, "active");
  const nowAllowed = await request(app).get("/api/dashboard/providers").set("Cookie", cookie);
  assert.equal(nowAllowed.status, 200);
});

test("PATCH /api/platform/tenants/:id/status is how a real platform_admin activates a pending tenant end to end", async () => {
  const app = freshApp();
  const users = require("../../src/store/userStore");
  users.create({ email: "platform@example.com", password: "password123", role: "platform_admin", tenantId: null });
  const platformLogin = await request(app).post("/api/auth/login").send({ email: "platform@example.com", password: "password123" });
  assert.equal(platformLogin.status, 200);
  const platformCookie = platformLogin.headers["set-cookie"];

  const email = "activate-me@example.com";
  const otp = otpFor(email);
  const signup = await request(app).post("/api/signup").send({ businessName: "Activate Me Biz", email, password: "password123", otp });
  const tenantId = signup.body.user.tenantId;
  const adminCookie = signup.headers["set-cookie"];

  const stillBlocked = await request(app).get("/api/dashboard/providers").set("Cookie", adminCookie);
  assert.equal(stillBlocked.status, 403);

  const activate = await request(app)
    .patch(`/api/platform/tenants/${tenantId}/status`)
    .set("Cookie", platformCookie)
    .send({ status: "active" });
  assert.equal(activate.status, 200);
  assert.equal(activate.body.status, "active");

  const nowAllowed = await request(app).get("/api/dashboard/providers").set("Cookie", adminCookie);
  assert.equal(nowAllowed.status, 200);
});

test("POST /api/signup rejects a duplicate email with 409, and a short password with 400", async () => {
  const app = freshApp();
  await request(app).post("/api/signup").send({ businessName: "First Biz", email: "dup@example.com", password: "password123", otp: otpFor("dup@example.com") });

  const dup = await request(app).post("/api/signup").send({ businessName: "Second Biz", email: "dup@example.com", password: "password123", otp: otpFor("dup@example.com") });
  assert.equal(dup.status, 409);

  const shortPw = await request(app).post("/api/signup").send({ businessName: "Third Biz", email: "another@example.com", password: "short", otp: otpFor("another@example.com") });
  assert.equal(shortPw.status, 400);
});

test("POST /api/auth/login succeeds with correct credentials and fails with wrong password", async () => {
  const app = freshApp();
  const email = "login@example.com";
  await request(app).post("/api/signup").send({ businessName: "Login Test Biz", email, password: "correct-password", otp: otpFor(email) });

  const bad = await request(app).post("/api/auth/login").send({ email, password: "wrong-password" });
  assert.equal(bad.status, 401);
  assert.ok(!bad.headers["set-cookie"], "a failed login must not set a session cookie");

  const good = await request(app).post("/api/auth/login").send({ email, password: "correct-password" });
  assert.equal(good.status, 200);
  assert.equal(good.body.user.email, email);
});

test("protected dashboard routes reject an unauthenticated request with 401, not a redirect or a 500", async () => {
  const app = freshApp();
  const resp = await request(app).get("/api/dashboard/providers");
  assert.equal(resp.status, 401);
});

test("login is rate-limited after repeated failures from the same IP+email", async () => {
  const app = freshApp();
  const email = "ratelimit@example.com";
  await request(app).post("/api/signup").send({ businessName: "Rate Limit Biz", email, password: "correct-password", otp: otpFor(email) });

  let lastStatus;
  for (let i = 0; i < 7; i++) {
    const resp = await request(app).post("/api/auth/login").send({ email, password: "wrong-password" });
    lastStatus = resp.status;
  }
  assert.equal(lastStatus, 429);
});

test("a provider-role session cannot reach an admin-only route", async () => {
  const app = freshApp();
  const { cookie: adminCookie } = await signupAndActivate(app, request, { businessName: "Role Check Biz", email: "roleadmin@example.com" });

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
