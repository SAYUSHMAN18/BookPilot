const { log } = require("../infra/logger");
const { groqChatCompletion } = require("./groqClient");

// Sarvam's own language codes, mapped to a readable name for the
// translation prompt — the model doesn't reliably know what "or-IN" means,
// but does know "Odia". Kept in sync with voice.js's TTS_SUPPORTED set:
// translating into a language Sarvam can't actually synthesize would be
// wasted work, so this only ever gets called for a language TTS supports.
const LANGUAGE_NAMES = {
  "bn-IN": "Bengali",
  "en-IN": "English",
  "gu-IN": "Gujarati",
  "hi-IN": "Hindi",
  "kn-IN": "Kannada",
  "ml-IN": "Malayalam",
  "mr-IN": "Marathi",
  "od-IN": "Odia",
  "pa-IN": "Punjabi",
  "ta-IN": "Tamil",
  "te-IN": "Telugu",
};

// Translates an English bot reply into the customer's spoken language
// before speech synthesis. Voice replies are where this matters most
// urgently: without it, synthesizeSpeech() was handed English text and
// told to speak it through whatever voice model matched the customer's
// DETECTED language (e.g. hi-IN) — English words read in Hindi phonetics,
// not a natural reply in the customer's own language. That's worse than
// the text-only fallback this codebase already uses for genuinely
// unsupported languages, so closing this gap was the higher-priority half
// of the broader "replies never match input language" finding — matching
// TEXT replies to input language too is a larger, separate effort (every
// hardcoded English string in workflowEngine.js), not attempted here.
//
// Fails open: any problem (no GROQ_API_KEY, a timeout, an already-English
// reply) returns the original text unchanged, so a translation hiccup
// degrades to "spoken in English" — never blocks the reply outright.
async function translateForVoice(text, languageCode) {
  if (!text || !languageCode || languageCode === "en-IN" || !process.env.GROQ_API_KEY) return text;
  const languageName = LANGUAGE_NAMES[languageCode];
  if (!languageName) return text;

  try {
    const { data, elapsedMs } = await groqChatCompletion({
      model: "llama-3.1-8b-instant",
      temperature: 0,
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content:
            `Translate the following WhatsApp booking-bot reply into natural, conversational ${languageName}, ` +
            "the way it would actually be spoken aloud. Keep names, dates, times, prices, and booking codes " +
            "unchanged. Reply with ONLY the translation, nothing else.",
        },
        // Sarvam's TTS caps input length (see voice.js's synthesizeSpeech) —
        // no point translating text past what would actually get spoken.
        { role: "user", content: text.slice(0, 1500) },
      ],
    });
    log("INFO", `translateForVoice (${languageName}) took ${elapsedMs}ms`);
    const translated = (data.choices?.[0]?.message?.content || "").trim();
    return translated || text;
  } catch (err) {
    log("WARN", `Voice reply translation failed (${err.message}) — speaking the English text instead.`);
    return text;
  }
}

const LANG_CODE_MAP = {
  hi: "Hindi",
  ur: "Urdu",
  bn: "Bengali",
  ta: "Tamil",
  te: "Telugu",
  mr: "Marathi",
  pa: "Punjabi",
  gu: "Gujarati",
  kn: "Kannada",
  ml: "Malayalam",
  en: "English",
};

// Translates an outgoing WhatsApp text reply into the customer's selected language
async function translateText(text, targetLang) {
  if (!text || !targetLang || targetLang === "en" || !process.env.GROQ_API_KEY) return text;
  const langName = LANG_CODE_MAP[targetLang] || targetLang;
  if (langName === "English") return text;

  try {
    const { data } = await groqChatCompletion({
      model: "llama-3.1-8b-instant",
      temperature: 0.1,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content:
            `You are a translator. Translate the following WhatsApp booking-bot message into natural ${langName}. ` +
            "Keep emojis, numbers, prices, workflow names, IDs, dates, and times unchanged. " +
            "Reply ONLY with the translated text, no explanations.",
        },
        { role: "user", content: text },
      ],
    });
    const translated = (data.choices?.[0]?.message?.content || "").trim();
    return translated || text;
  } catch (err) {
    log("WARN", `translateText (${langName}) failed: ${err.message}`);
    return text;
  }
}

module.exports = { translateForVoice, translateText, LANG_CODE_MAP };

