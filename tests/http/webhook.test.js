// Item 2 — HTTP-level WhatsApp webhook coverage: signature verification
// (src/infra/verifySignature.js's HMAC check, exercised through the real
// route rather than calling isValidSignature() directly) and duplicate
// delivery handling (Meta's own documented at-least-once retry behavior
// — src/infra/dedupe.js is what stops the same message.id being processed
// twice). Where a test needs proof processing actually happened, it
// checks a real, public side effect (a booking landing in bookingStore)
// rather than reaching into session-store internals that aren't part of
// this codebase's own documented module API.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const request = require("supertest");
const { freshApp } = require("./_setup");

const APP_SECRET = "test-whatsapp-app-secret";
let msgCounter = 0;
function nextMessageId() {
  msgCounter += 1;
  return `wamid.test-${msgCounter}-${Date.now()}`;
}

function webhookPayload({ messageId, text, from = "919000001234", phoneNumberId = "TEST-PHONE-ID" }) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "TEST-WABA-ID",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001234", phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: "Test Customer" }, wa_id: from }],
              messages: [{ from, id: messageId, timestamp: String(Math.floor(Date.now() / 1000)), text: { body: text }, type: "text" }],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}

function sign(rawBody) {
  return "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");
}

// Posts one message through the REAL /webhook route (not /api/simulate-whatsapp)
// with a correctly-signed body — the actual path a real WhatsApp delivery
// takes. Waits a beat after each send since the route acks 200 immediately
// and processes the message asynchronously (Meta needs a fast ack).
async function sendWebhookMessage(app, { text, from, messageId }) {
  const raw = JSON.stringify(webhookPayload({ messageId: messageId || nextMessageId(), text, from }));
  const resp = await request(app).post("/webhook").set("Content-Type", "application/json").set("X-Hub-Signature-256", sign(raw)).send(raw);
  await new Promise((r) => setTimeout(r, 250));
  return resp;
}

test("POST /webhook rejects a missing signature with 403 when WHATSAPP_APP_SECRET is set", async () => {
  const app = freshApp({ webhookAppSecret: APP_SECRET });
  const raw = JSON.stringify(webhookPayload({ messageId: nextMessageId(), text: "hello" }));
  const resp = await request(app).post("/webhook").set("Content-Type", "application/json").send(raw);
  assert.equal(resp.status, 403);
});

test("POST /webhook rejects a wrong/forged signature with 403", async () => {
  const app = freshApp({ webhookAppSecret: APP_SECRET });
  const raw = JSON.stringify(webhookPayload({ messageId: nextMessageId(), text: "hello" }));
  const resp = await request(app)
    .post("/webhook")
    .set("Content-Type", "application/json")
    .set("X-Hub-Signature-256", "sha256=" + "0".repeat(64))
    .send(raw);
  assert.equal(resp.status, 403);
});

test("a correctly-signed webhook delivery, driven through a full conversation, produces a real booking", async () => {
  const app = freshApp({ webhookAppSecret: APP_SECRET });
  const bookingStore = require("../../src/store/bookingStore");
  const from = "919000009999";
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  for (const text of ["I need a haircut", "p1", tomorrow, "10:00 am", "Webhook Test Customer"]) {
    const resp = await sendWebhookMessage(app, { text, from });
    assert.equal(resp.status, 200);
  }
  const confirmResp = await sendWebhookMessage(app, { text: "confirm", from });
  assert.equal(confirmResp.status, 200);

  const created = bookingStore.values(1).filter((b) => b.waId === from);
  assert.equal(created.length, 1, "expected exactly one booking created through the real signed webhook route");
  assert.equal(created[0].customerName, "Webhook Test Customer");
});

test("POST /webhook processes a duplicate message.id only once — replaying the confirming message does not double-book", async () => {
  const app = freshApp({ webhookAppSecret: APP_SECRET });
  const bookingStore = require("../../src/store/bookingStore");
  const from = "919000008888";
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  for (const text of ["I need a haircut", "p1", tomorrow, "10:00 am", "Dedup Test Customer"]) {
    await sendWebhookMessage(app, { text, from });
  }

  const confirmMessageId = nextMessageId();
  await sendWebhookMessage(app, { text: "confirm", from, messageId: confirmMessageId });
  const afterFirst = bookingStore.values(1).filter((b) => b.waId === from).length;
  assert.equal(afterFirst, 1);

  // Re-deliver the EXACT same message.id — Meta's own documented
  // at-least-once retry behavior. src/infra/dedupe.js must make this a
  // no-op, not a second booking attempt against an already-booked slot.
  await sendWebhookMessage(app, { text: "confirm", from, messageId: confirmMessageId });
  const afterReplay = bookingStore.values(1).filter((b) => b.waId === from).length;
  assert.equal(afterReplay, 1, "a replayed message.id must not create a second booking");
});

test("POST /webhook with no WHATSAPP_APP_SECRET configured skips signature verification (documented dev-mode behavior)", async () => {
  const app = freshApp(); // no webhookAppSecret — matches a fresh/dev install
  const raw = JSON.stringify(webhookPayload({ messageId: nextMessageId(), text: "hello" }));
  const resp = await request(app).post("/webhook").set("Content-Type", "application/json").send(raw);
  assert.equal(resp.status, 200);
});

test("GET /webhook (Meta's verification handshake) echoes the challenge only when the verify token matches", async () => {
  const app = freshApp();
  const wrong = await request(app).get("/webhook").query({ "hub.mode": "subscribe", "hub.verify_token": "wrong-token", "hub.challenge": "12345" });
  assert.equal(wrong.status, 403);

  const right = await request(app).get("/webhook").query({ "hub.mode": "subscribe", "hub.verify_token": "test-verify-token", "hub.challenge": "12345" });
  assert.equal(right.status, 200);
  assert.equal(right.text, "12345");
});
