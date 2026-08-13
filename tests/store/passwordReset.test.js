// Section 6 — self-serve password reset. Before this, a lost password
// meant an admin had to re-create the account via users.create() — which
// doesn't even work for the one admin on a single-admin install. Proves
// the actual security properties: a token works exactly once, an expired
// token is rejected, and consuming a token really does change the
// password an old one will no longer verify against.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");

let users, createResetToken, consumeResetToken, query;

before(async () => {
  process.env.SESSION_SECRET = "test-secret";
  await createIsolatedTestDatabase();
  for (const mod of ["../../src/store/db", "../../src/store/userStore", "../../src/store/passwordResetStore", "../../src/infra/auth"]) {
    delete require.cache[require.resolve(mod)];
  }
  users = require("../../src/store/userStore");
  ({ createResetToken, consumeResetToken } = require("../../src/store/passwordResetStore"));
  ({ query } = require("../../src/store/db"));
});

function makeUser(email) {
  return users.create({ email, password: "OriginalPass123", role: "admin", name: "Reset Tester" });
}

test("a valid token resolves to the right user and lets the password actually change", async () => {
  const user = await makeUser("reset-test-1@example.com");
  const token = await createResetToken(user.id);

  const resolvedUserId = await consumeResetToken(token);
  assert.equal(resolvedUserId, user.id);

  await users.setPassword(user.id, "BrandNewPass456");
  assert.ok(await users.verifyCredentials(user.email, "BrandNewPass456"), "new password should verify");
  assert.equal(await users.verifyCredentials(user.email, "OriginalPass123"), null, "old password must no longer work");
});

test("a token can only be consumed once — a second use fails", async () => {
  const user = await makeUser("reset-test-2@example.com");
  const token = await createResetToken(user.id);

  assert.equal(await consumeResetToken(token), user.id);
  assert.equal(await consumeResetToken(token), null, "reusing the same token must fail");
});

test("an unknown/garbage token is rejected, not treated as valid", async () => {
  assert.equal(await consumeResetToken("not-a-real-token"), null);
  assert.equal(await consumeResetToken(""), null);
  assert.equal(await consumeResetToken(undefined), null);
});

test("an expired token is rejected even though it was never used", async () => {
  const user = await makeUser("reset-test-3@example.com");
  const token = await createResetToken(user.id);

  // Reach into the table directly to simulate time passing, rather than
  // waiting a real hour in a test.
  await query("UPDATE password_reset_tokens SET expires_at = $1 WHERE user_id = $2", [Date.now() - 1000, user.id]);

  assert.equal(await consumeResetToken(token), null, "an expired token must be rejected even if otherwise well-formed and unused");
});

test("two different users' tokens never resolve to each other", async () => {
  const userA = await makeUser("reset-test-4a@example.com");
  const userB = await makeUser("reset-test-4b@example.com");
  const tokenA = await createResetToken(userA.id);
  const tokenB = await createResetToken(userB.id);

  assert.equal(await consumeResetToken(tokenA), userA.id);
  assert.equal(await consumeResetToken(tokenB), userB.id);
});
