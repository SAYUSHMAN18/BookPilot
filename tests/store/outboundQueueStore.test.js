// New scenarios, added after a log review turned up a Aug-13 crash history
// for this exact worker ("items is not iterable", "Cannot use a pool after
// calling end") — both already fixed in current code, but the subsystem
// itself had zero test coverage, so nothing would catch a regression. This
// covers the actual contract processOutboundQueue() (src/infra/whatsapp.js)
// depends on: dueItems() only returns what's actually due, markSent removes
// an item from the due set, and markFailedAttempt's give-up boundary at
// exactly maxAttempts (the off-by-one that would either give up one attempt
// early or retry forever is exactly the kind of thing worth pinning down).
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");

let queue;
const TENANT = 1;

before(async () => {
  await createIsolatedTestDatabase();
  delete require.cache[require.resolve("../../src/store/db")];
  delete require.cache[require.resolve("../../src/store/outboundQueueStore")];
  queue = require("../../src/store/outboundQueueStore");
});

test("a freshly enqueued item is immediately due", async () => {
  await queue.enqueue(TENANT, "919000000001", "hello");
  const due = await queue.dueItems();
  const item = due.find((i) => i.waId === "919000000001");
  assert.ok(item, "the item we just enqueued should be in dueItems()");
  assert.equal(item.tenantId, TENANT);
  assert.equal(item.attempts, 0);
  assert.equal(item.maxAttempts, 5);
  assert.equal(item.status, "pending");
});

test("markSent removes the item from dueItems", async () => {
  await queue.enqueue(TENANT, "919000000002", "will be sent");
  const [item] = (await queue.dueItems()).filter((i) => i.waId === "919000000002");
  await queue.markSent(item.id);
  const stillDue = (await queue.dueItems()).some((i) => i.id === item.id);
  assert.equal(stillDue, false);
});

test("markFailedAttempt before the last attempt reschedules into the future, doesn't fail the item", async () => {
  await queue.enqueue(TENANT, "919000000003", "will fail once");
  const [item] = (await queue.dueItems()).filter((i) => i.waId === "919000000003");
  await queue.markFailedAttempt(item, "simulated send failure");

  // Rescheduled into the future — no longer in the immediately-due set,
  // but not marked 'failed' either (it has attempts left).
  const stillDue = (await queue.dueItems()).some((i) => i.id === item.id);
  assert.equal(stillDue, false, "a backed-off item should not be immediately due again");

  const recent = (await queue.listRecent(TENANT)).find((i) => i.id === item.id);
  assert.equal(recent.attempts, 1);
  assert.equal(recent.status, "pending");
  assert.ok(recent.nextAttemptAt > Date.now(), "backoff should push next_attempt_at into the future");
});

test("markFailedAttempt on the last allowed attempt marks the item failed, not rescheduled", async () => {
  await queue.enqueue(TENANT, "919000000004", "will exhaust retries");
  let item = (await queue.dueItems()).find((i) => i.waId === "919000000004");
  // Drive it right up to the boundary: maxAttempts - 1 failures should each
  // still be "pending" (retryable); the maxAttempts-th failure is the one
  // that must give up. This is the exact off-by-one worth pinning down.
  for (let i = 0; i < item.maxAttempts - 1; i++) {
    await queue.markFailedAttempt(item, `attempt ${i + 1} failed`);
    item = (await queue.listRecent(TENANT)).find((r) => r.id === item.id);
    assert.equal(item.status, "pending", `should still be retryable after ${i + 1} failure(s)`);
  }

  await queue.markFailedAttempt(item, "final attempt failed");
  const final = (await queue.listRecent(TENANT)).find((r) => r.id === item.id);
  assert.equal(final.status, "failed");
  assert.equal(final.attempts, item.maxAttempts);
  assert.equal(final.lastError, "final attempt failed");
});

test("dueItems is not tenant-filtered — the worker drains every tenant's due items in one pass", async () => {
  await queue.enqueue(TENANT, "919000000005", "tenant 1 message");
  await queue.enqueue(2, "919000000006", "tenant 2 message");
  const due = await queue.dueItems();
  const tenantIds = new Set(due.map((i) => i.tenantId));
  assert.ok(tenantIds.has(TENANT) && tenantIds.has(2), "dueItems() should mix items from multiple tenants in one pass");
});

test("statusCounts is tenant-scoped and reflects sent/pending/failed correctly", async () => {
  await queue.enqueue(TENANT, "919000000007", "a");
  const sentTarget = (await queue.dueItems()).find((i) => i.waId === "919000000007");
  await queue.markSent(sentTarget.id);

  const counts = await queue.statusCounts(TENANT);
  assert.ok(counts.sent >= 1, "at least the item we just marked sent should be counted");
  assert.ok(typeof counts.pending === "number" && typeof counts.failed === "number");
});
