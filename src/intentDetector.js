const { log } = require("./logger");
const { capForAI } = require("./textLimits");

// The full set of intents this module can return.  Callers should handle
// every value — a new intent added here that a caller ignores falls through
// to the default "unclear" path, which is always safe.
const INTENTS = {
  CANCEL_BOOKING: "cancel_booking", // wants to cancel an existing booking
  CHECK_STATUS: "check_status",   // wants to know their booking status
  RESTART: "restart",        // start fresh / book something else
  QUESTION: "question",       // factual question (hours, prices, policy)
  COMPLAINT: "complaint",      // frustrated / venting — needs empathy first
  BOOKING_INTENT: "booking_intent", // actively wants to book right now
  UNCLEAR: "unclear",        // greeting / small talk / truly ambiguous
};

const VALID_INTENTS = new Set(Object.values(INTENTS));

// Regex-based fallback used when no GROQ_API_KEY is configured, or when
// the API call fails.  Deliberately coarse — it only catches the patterns
// that are clearly unambiguous so the caller stays safe even on a miss.
const CANCEL_RE = /\b(cancel|cancell?ation|stop|drop|remove|don['']?t want|delete)\b.{0,40}\b(booking|appointment|slot|reserv|this|it|that)\b|\b(cancel|cancell?ation)\b/i;
const STATUS_RE = /\b(status|where|when|my (booking|appointment)|what time|what day|track|check.{0,15}booking)\b/i;
const RESTART_RE = /\b(restart|start over|start again|new booking|book something else|reset|menu|exit)\b/i;
const QUESTION_RE = /\b(how much|price|fee|cost|hour|open|close|location|address|where are you|do you have|available|what (do|is|are)|can you|tell me about)\b/i;
const COMPLAINT_RE = /\b(frustrated|angry|upset|terrible|horrible|awful|this (is|was) (bad|wrong)|not working|wasted|useless|ridiculous|mess)\b/i;

function keywordIntent(text) {
  const t = text.toLowerCase();
  if (CANCEL_RE.test(t)) return INTENTS.CANCEL_BOOKING;
  if (STATUS_RE.test(t)) return INTENTS.CHECK_STATUS;
  if (RESTART_RE.test(t)) return INTENTS.RESTART;
  if (QUESTION_RE.test(t)) return INTENTS.QUESTION;
  if (COMPLAINT_RE.test(t)) return INTENTS.COMPLAINT;
  return INTENTS.UNCLEAR;
}

// LLM-backed intent detection.  Returns one of the INTENTS values.
// Always falls back to the keyword classifier on any failure so the bot
// never breaks because of a transient API error or a missing API key.
async function detectGeneralIntent(text, hasActiveBooking) {
  if (!process.env.GROQ_API_KEY) {
    log("WARN", "GROQ_API_KEY not set — using keyword intent fallback.");
    return keywordIntent(text);
  }

  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        temperature: 0,
        max_tokens: 10,
        messages: [
          {
            role: "system",
            content:
              "You classify a WhatsApp customer message into EXACTLY ONE intent for a booking bot. " +
              `The customer ${hasActiveBooking ? "HAS an existing booking" : "has NO existing booking"}.\n\n` +
              "Intents (reply with ONLY the intent word, nothing else):\n" +
              "- cancel_booking: wants to cancel/delete/remove an existing booking or appointment\n" +
              "- check_status: wants to know their booking status, date, time, or details\n" +
              "- restart: wants to start over, book something different, or see the full menu\n" +
              "- question: asking a factual question about the business (hours, price, location, policy)\n" +
              "- complaint: expressing frustration, anger, or dissatisfaction with the service or bot\n" +
              "- booking_intent: actively trying to make a new booking right now\n" +
              "- unclear: greeting, small talk, random noise, or genuinely ambiguous\n\n" +
              "If the message could be cancel_booking OR booking_intent, prefer cancel_booking when the customer HAS an existing booking.\n" +
              "Reply with ONLY one of: cancel_booking, check_status, restart, question, complaint, booking_intent, unclear",
          },
          // Few-shot examples covering the exact failure patterns from the
          // real conversation — the model observed inventing intent names or
          // routing "CANCEL THAT" to booking_intent without these.
          { role: "user", content: "HELLO" },
          { role: "assistant", content: "unclear" },
          { role: "user", content: "CANCEL THAT" },
          { role: "assistant", content: "cancel_booking" },
          { role: "user", content: "STATUS" },
          { role: "assistant", content: "check_status" },
          { role: "user", content: "I WANT TO CANCEL MY OLD APPOINTMENT" },
          { role: "assistant", content: "cancel_booking" },
          { role: "user", content: "ok" },
          { role: "assistant", content: "unclear" },
          { role: "user", content: "BUT THE BOOKING IS CANCELLED HOW COME THERE'S STILL A BOOKING" },
          { role: "assistant", content: "complaint" },
          { role: "user", content: "how much does a haircut cost" },
          { role: "assistant", content: "question" },
          { role: "user", content: "book a doctor appointment" },
          { role: "assistant", content: "booking_intent" },
          { role: "user", content: "can I start over" },
          { role: "assistant", content: "restart" },
          { role: "user", content: capForAI(text) },
        ],
      }),
    });

    if (!resp.ok) throw new Error(`Groq API responded ${resp.status}`);
    const data = await resp.json();
    const raw = (data.choices?.[0]?.message?.content || "").trim().toLowerCase();

    // Validate — never trust an unrecognized string from the model.
    const intent = [...VALID_INTENTS].find((i) => raw.includes(i));
    if (!intent) {
      log("WARN", `intentDetector returned unrecognized value "${raw}" — using keyword fallback.`);
      return keywordIntent(text);
    }

    log("INFO", `Intent detected: "${intent}" for message: "${text.slice(0, 80)}"`);
    return intent;
  } catch (err) {
    log("WARN", `intentDetector failed (${err.message}) — using keyword fallback.`);
    return keywordIntent(text);
  }
}

module.exports = { detectGeneralIntent, INTENTS };
