// Section 14 — the Public API's own auth mechanism. Locks down the
// things that matter for a credential store: the raw key is never
// recoverable after creation, a revoked key stops verifying immediately,
// and verification never leaks which tenant a WRONG key might have
// belonged to (it just returns null either way).
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");

let apiKeys;
const TENANT = 1;
const OTHER_TENANT = 2;

before(async () => {
  await createIsolatedTestDatabase();
  for (const mod of ["../../src/store/db", "../../src/store/apiKeyStore"]) {
    delete require.cache[require.resolve(mod)];
  }
  apiKeys = require("../../src/store/apiKeyStore");
});

test("create returns a real bpk_-prefixed key and a safe record with no secret in it", async () => {
  const { key, record } = await apiKeys.create(TENANT, "Website integration");
  assert.match(key, /^bpk_/);
  assert.equal(record.name, "Website integration");
  assert.equal(record.keyPrefix, key.slice(0, 12));
  assert.equal(record.revoked, false);
  assert.equal(JSON.stringify(record).includes(key), false, "the full raw key must never appear in the storable record");
});

test("verify resolves a freshly-created key back to its owning tenant", async () => {
  const { key } = await apiKeys.create(TENANT, "Test key A");
  assert.equal(await apiKeys.verify(key), TENANT);
});

test("verify never confuses two different tenants' keys", async () => {
  const a = await apiKeys.create(TENANT, "Tenant A key");
  const b = await apiKeys.create(OTHER_TENANT, "Tenant B key");
  assert.equal(await apiKeys.verify(a.key), TENANT);
  assert.equal(await apiKeys.verify(b.key), OTHER_TENANT);
});

test("verify rejects a revoked key immediately", async () => {
  const { key, record } = await apiKeys.create(TENANT, "Revoke me");
  assert.equal(await apiKeys.verify(key), TENANT);
  await apiKeys.revoke(TENANT, record.id);
  assert.equal(await apiKeys.verify(key), null);
});

test("verify rejects garbage input without throwing", async () => {
  assert.equal(await apiKeys.verify("not-a-real-key"), null);
  assert.equal(await apiKeys.verify(""), null);
  assert.equal(await apiKeys.verify(null), null);
  assert.equal(await apiKeys.verify(undefined), null);
  assert.equal(await apiKeys.verify("bpk_" + "a".repeat(40)), null, "a well-formed but never-issued key must not verify");
});

test("listForTenant only returns that tenant's own keys, revoked or not, and never the full raw secret", async () => {
  const { key: fullKey1 } = await apiKeys.create(TENANT, "List test 1");
  const { record: toRevoke } = await apiKeys.create(TENANT, "List test 2");
  await apiKeys.revoke(TENANT, toRevoke.id);
  await apiKeys.create(OTHER_TENANT, "Should not appear");

  const list = await apiKeys.listForTenant(TENANT);
  assert.ok(list.every((k) => k.tenantId === TENANT));
  assert.ok(list.some((k) => k.revoked === true));
  // keyPrefix (a short, non-secret fragment) legitimately contains the
  // "bpk_" marker — what must never appear is the FULL 32-byte secret.
  assert.ok(!JSON.stringify(list).includes(fullKey1), "listing must never include a full raw key, active or revoked");
});

test("revoking a key only affects that tenant's own row — a tenant can't revoke another tenant's key by id", async () => {
  const { key, record } = await apiKeys.create(OTHER_TENANT, "Not yours");
  await apiKeys.revoke(TENANT, record.id); // wrong tenant attempting the revoke
  assert.equal(await apiKeys.verify(key), OTHER_TENANT, "the key must still work — the cross-tenant revoke attempt must be a no-op");
});
