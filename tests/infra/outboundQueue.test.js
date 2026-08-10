// Section 5.3 — the durable outbound retry queue. Three things actually
// need proving here, not just "a row gets inserted": (1) sendWithRetry()
// falls back to the durable queue once its own immediate attempts are
// exhausted, (2) the background worker (processOutboundQueue) actually
// drains a queued item and marks it sent once the send succeeds, and
// (3) an item that keeps failing eventually gets marked 'failed' instead
// of retrying forever.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bookpilot-outbound-test-"));
for (const mod of ["../../src/store/db", "../../src/store/outboundQueueStore", "../../src/infra/whatsapp"]) {
  delete require.cache[require.resolve(mod)];
}
const outboundQueueStore = require("../../src/store/outboundQueueStore");
const { sendWithRetry, processOutboundQueue } = require("../../src/infra/whatsapp");
const TENANT = 1; // the default tenant, created by db.js's own migration

const originalFetch = global.fetch;
const originalToken = process.env.WHATSAPP_TOKEN;
const originalPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;

function useLiveModeCreds() {
  // sendWhatsAppText only calls the real Graph API (and thus can actually
  // fail) when both creds are set — otherwise it's always "simulated" and
  // always returns true, which would make failure-path tests meaningless.
  process.env.WHATSAPP_TOKEN = "test-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone-id";
}

test.after(() => {
  global.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.WHATSAPP_TOKEN;
  else process.env.WHATSAPP_TOKEN = originalToken;
  if (originalPhoneId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  else process.env.WHATSAPP_PHONE_NUMBER_ID = originalPhoneId;
});

test("sendWithRetry enqueues into the durable queue once immediate attempts are exhausted", async () => {
  useLiveModeCreds();
  global.fetch = async () => ({ ok: false, status: 500, text: async () => "simulated outage" });

  const waId = "919000000101";
  const body = "You're next! (durable-queue test)";
  const sent = await sendWithRetry(TENANT, waId, body, { retries: 0, delayMs: 1 });

  assert.equal(sent, false);
  const due = outboundQueueStore.dueItems();
  const match = due.find((item) => item.waId === waId && item.body === body);
  assert.ok(match, "expected the failed send to have been enqueued for durable retry");
  assert.equal(match.status, "pending");
});

test("processOutboundQueue delivers a queued item once the send succeeds and marks it sent", async () => {
  useLiveModeCreds();
  const waId = "919000000102";
  const body = "Completion + feedback request (durable-queue test)";
  outboundQueueStore.enqueue(TENANT, waId, body);

  global.fetch = async () => ({ ok: false, status: 500, text: async () => "still down" });
  const stillPending = outboundQueueStore.dueItems().find((i) => i.waId === waId);
  assert.ok(stillPending);

  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  const processed = await processOutboundQueue();
  assert.ok(processed >= 1);

  const recent = outboundQueueStore.listRecent(TENANT).find((i) => i.waId === waId && i.body === body);
  assert.ok(recent, "expected the queued item to still exist in listRecent()");
  assert.equal(recent.status, "sent");
  assert.ok(!outboundQueueStore.dueItems().some((i) => i.waId === waId && i.body === body));
});

test("an item that exhausts max_attempts is marked failed instead of retried forever", () => {
  const waId = "919000000103";
  const body = "Arrival alert that never delivers (durable-queue test)";
  outboundQueueStore.enqueue(TENANT, waId, body);
  const item = outboundQueueStore.dueItems().find((i) => i.waId === waId && i.body === body);
  assert.ok(item);
  assert.equal(item.maxAttempts, 5);

  let current = item;
  for (let i = 0; i < 5; i++) {
    outboundQueueStore.markFailedAttempt(current, `simulated failure ${i + 1}`);
    current = outboundQueueStore.listRecent(TENANT).find((r) => r.id === item.id);
  }

  assert.equal(current.status, "failed");
  assert.equal(current.attempts, 5);
  assert.ok(!outboundQueueStore.dueItems().some((i) => i.id === item.id));
});
