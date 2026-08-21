// HTTP-level coverage for handleVoiceMessage (src/routes/webhook.js) — a
// real gap found while deep-testing the voice pipeline: only the TYPED
// "reply in voice" request path (VOICE_REQUEST_RE) and the TTS text
// sanitizer (stripMarkdownForSpeech, tests/infra/voice.test.js) had any
// coverage at all; the incoming-voice-NOTE path had none. The three
// guard clauses tested here (no SARVAM_API_KEY, wrong plan, missing
// media id) are exactly the ones reachable WITHOUT a real Sarvam network
// call — freshApp() deliberately blanks SARVAM_API_KEY for every test in
// this suite (_setup.js), and a real transcribeAudio/synthesizeSpeech
// round trip needs network mocking this test harness's require-cache-
// busting design doesn't support cleanly (see the comment on
// freshApp() — it busts every src/ module fresh on each call, discarding
// any mock set up beforehand). The full happy path was verified manually
// against a real Sarvam key instead (see this session's own notes) —
// this file covers what CAN be pinned down deterministically.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { freshApp } = require("./_setup");

function audioWebhookPayload({ messageId, from, phoneNumberId = "TEST-PHONE-ID", audio }) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "TEST-WABA-ID",
      changes: [{
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "15550001234", phone_number_id: phoneNumberId },
          contacts: [{ profile: { name: "Voice Test Customer" }, wa_id: from }],
          messages: [{ from, id: messageId, timestamp: String(Math.floor(Date.now() / 1000)), type: "audio", audio }],
        },
        field: "messages",
      }],
    }],
  };
}

async function postVoiceNote(app, waId, audio, msgId) {
  const { beginReplyCapture, endReplyCapture } = require("../../src/infra/whatsapp");
  beginReplyCapture(waId);
  await request(app).post("/webhook").set("Content-Type", "application/json")
    .send(audioWebhookPayload({ messageId: msgId, from: waId, audio }));
  await new Promise((r) => setTimeout(r, 250)); // ack is immediate; processing is async
  return endReplyCapture(waId);
}

test("a voice note with no SARVAM_API_KEY configured gets a graceful text fallback, not silence or a crash", async () => {
  const app = await freshApp(); // SARVAM_API_KEY is blanked by freshApp() itself — the default/common case
  const waId = "919888855001";
  const reply = await postVoiceNote(app, waId, { id: "media-id-1" }, "wamid.voice-test-1");
  assert.match(reply, /can't listen to voice notes right now/i);
});

test("a voice note on a non-Growth plan gets the plan-upgrade message, even with SARVAM_API_KEY set", async () => {
  const app = await freshApp();
  process.env.SARVAM_API_KEY = "fake-test-key-not-real"; // bypass the isVoiceEnabled() guard without ever reaching a real network call — tenantHasFeature returns false first
  const waId = "919888855002";
  const reply = await postVoiceNote(app, waId, { id: "media-id-2" }, "wamid.voice-test-2");
  assert.match(reply, /Growth-plan feature/i);
});

test("a voice note with no media id at all is silently ignored, not a crash", async () => {
  const app = await freshApp();
  process.env.SARVAM_API_KEY = "fake-test-key-not-real";
  const tenantStore = require("../../src/store/tenantStore");
  await tenantStore.setPlan(1, "growth"); // clears the plan guard so this reaches the actual mediaId check
  const waId = "919888855003";
  const reply = await postVoiceNote(app, waId, {}, "wamid.voice-test-3"); // audio object present, no .id
  assert.equal(reply, "", "no mediaId means handleVoiceMessage returns before sending anything at all");
});
