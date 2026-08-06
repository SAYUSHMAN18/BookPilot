const { log } = require("./logger");

// Multilingual voice via Sarvam AI: WhatsApp voice note -> text (STT),
// and bot reply -> spoken audio (TTS) in the customer's own language.
//
// Deliberately a thin translation layer around the EXISTING text pipeline
// rather than a parallel voice flow: a transcribed voice note is handed to
// the same handleIncomingMessage() a typed message goes through, so voice
// customers get identical validation, slot locking, and double-booking
// protection. Nothing about booking correctness depends on the audio path.

const SARVAM_BASE = "https://api.sarvam.ai";

// Sarvam TTS supports a narrower set than STT — anything transcribed in a
// language not listed here still gets a correct TEXT reply, just not a
// spoken one. Mapping to a supported neighbour would put words in a
// customer's mouth in the wrong language, which is worse than text.
const TTS_SUPPORTED = new Set([
  "bn-IN", "en-IN", "gu-IN", "hi-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN",
]);

function sarvamKey() {
  return process.env.SARVAM_API_KEY;
}

function isVoiceEnabled() {
  return !!sarvamKey();
}

// Downloads a WhatsApp media object. Two hops by Meta's design: the
// webhook only carries a media id, which must be resolved to a short-lived
// signed URL, which is then fetched with the same bearer token.
async function downloadWhatsAppMedia(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error("WHATSAPP_TOKEN is not set — can't download voice notes.");

  const metaResp = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaResp.ok) throw new Error(`Media lookup failed: ${metaResp.status} ${await metaResp.text()}`);
  const meta = await metaResp.json();

  const fileResp = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!fileResp.ok) throw new Error(`Media download failed: ${fileResp.status}`);

  return {
    buffer: Buffer.from(await fileResp.arrayBuffer()),
    mimeType: meta.mime_type || "audio/ogg",
  };
}

// Speech -> text. Returns { transcript, languageCode } so the caller can
// reply in whatever language the customer actually spoke.
async function transcribeAudio(buffer, mimeType) {
  const key = sarvamKey();
  if (!key) throw new Error("SARVAM_API_KEY is not set.");

  // WhatsApp voice notes are OGG/Opus; Sarvam accepts that directly.
  const extension = mimeType.includes("mp4") || mimeType.includes("m4a") ? "m4a" : mimeType.includes("mpeg") ? "mp3" : "ogg";
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), `voice.${extension}`);
  form.append("model", "saaras:v3");

  const resp = await fetch(`${SARVAM_BASE}/speech-to-text`, {
    method: "POST",
    headers: { "api-subscription-key": key },
    body: form,
  });
  if (!resp.ok) throw new Error(`Sarvam STT failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);

  const data = await resp.json();
  return {
    transcript: (data.transcript || "").trim(),
    languageCode: data.language_code || null,
  };
}

// Text -> speech. Returns a Buffer of WAV audio, or null when the language
// isn't supported for synthesis (caller falls back to a text-only reply).
async function synthesizeSpeech(text, languageCode) {
  const key = sarvamKey();
  if (!key) return null;
  const lang = TTS_SUPPORTED.has(languageCode) ? languageCode : null;
  if (!lang) {
    log("INFO", `No Sarvam TTS voice for "${languageCode}" — replying with text only.`);
    return null;
  }

  // Sarvam caps input length; a long confirmation message is truncated
  // for the spoken version only — the full text reply is always sent too,
  // so nothing is actually lost to the customer.
  const resp = await fetch(`${SARVAM_BASE}/text-to-speech`, {
    method: "POST",
    headers: { "api-subscription-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, 1500), target_language_code: lang }),
  });
  if (!resp.ok) {
    log("ERROR", `Sarvam TTS failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    return null;
  }

  const data = await resp.json();
  const base64 = data.audios?.[0];
  return base64 ? Buffer.from(base64, "base64") : null;
}

module.exports = {
  isVoiceEnabled,
  downloadWhatsAppMedia,
  transcribeAudio,
  synthesizeSpeech,
  TTS_SUPPORTED,
};
