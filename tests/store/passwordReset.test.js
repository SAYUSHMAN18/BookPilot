// Section 6 — self-serve password reset. Before this, a lost password
// meant an admin had to re-create the account via users.create() — which
// doesn't even work for the one admin on a single-admin install. Proves
// the actual security properties: a token works exactly once, an expired
// token is rejected, and consuming a token really does change the
// password an old one will no longer verify against.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bookpilot-pwreset-test-"));
process.env.SESSION_SECRET = "test-secret";
for (const mod of ["../../src/store/db", "../../src/store/userStore", "../../src/store/passwordResetStore", "../../src/infra/auth"]) {
  delete require.cache[require.resolve(mod)];
}
const users = require("../../src/store/userStore");
const { createResetToken, consumeResetToken } = require("../../src/store/passwordResetStore");

function makeUser(email) {
  return users.create({ email, password: "OriginalPass123", role: "admin", name: "Reset Tester" });
}

test("a valid token resolves to the right user and lets the password actually change", () => {
  const user = makeUser("reset-test-1@example.com");
  const token = createResetToken(user.id);

  const resolvedUserId = consumeResetToken(token);
  assert.equal(resolvedUserId, user.id);

  users.setPassword(user.id, "BrandNewPass456");
  assert.ok(users.verifyCredentials(user.email, "BrandNewPass456"), "new password should verify");
  assert.equal(users.verifyCredentials(user.email, "OriginalPass123"), null, "old password must no longer work");
});

test("a token can only be consumed once — a second use fails", () => {
  const user = makeUser("reset-test-2@example.com");
  const token = createResetToken(user.id);

  assert.equal(consumeResetToken(token), user.id);
  assert.equal(consumeResetToken(token), null, "reusing the same token must fail");
});

test("an unknown/garbage token is rejected, not treated as valid", () => {
  assert.equal(consumeResetToken("not-a-real-token"), null);
  assert.equal(consumeResetToken(""), null);
  assert.equal(consumeResetToken(undefined), null);
});

test("an expired token is rejected even though it was never used", () => {
  const user = makeUser("reset-test-3@example.com");
  const token = createResetToken(user.id);

  // Reach into the table directly to simulate time passing, rather than
  // waiting a real hour in a test.
  const { db } = require("../../src/store/db");
  db.prepare("UPDATE password_reset_tokens SET expires_at = ? WHERE user_id = ?").run(Date.now() - 1000, user.id);

  assert.equal(consumeResetToken(token), null, "an expired token must be rejected even if otherwise well-formed and unused");
});

test("two different users' tokens never resolve to each other", () => {
  const userA = makeUser("reset-test-4a@example.com");
  const userB = makeUser("reset-test-4b@example.com");
  const tokenA = createResetToken(userA.id);
  const tokenB = createResetToken(userB.id);

  assert.equal(consumeResetToken(tokenA), userA.id);
  assert.equal(consumeResetToken(tokenB), userB.id);
});
