const { log } = require("../infra/logger");
const { capForAI } = require("../infra/textLimits");
const { groqChatCompletion, GROQ_MODEL } = require("./groqClient");

// The full set of intents this module can return.  Callers should handle
// every value — a new intent added here that a caller ignores falls through
// to the default "unclear" path, which is always safe.
const INTENTS = {
  CANCEL_BOOKING: "cancel_booking",
  CHECK_STATUS: "check_status",
  RESTART: "restart",
  QUESTION: "question",
  COMPLAINT: "complaint",
  BOOKING_INTENT: "booking_intent",
  GREETING: "greeting",
  UNCLEAR: "unclear",
};

const VALID_INTENTS = new Set(Object.values(INTENTS));

// Regex-based fallback used when no GROQ_API_KEY is configured, or when
// the API call fails.  Deliberately coarse — it only catches the patterns
// that are clearly unambiguous so the caller stays safe even on a miss.
// English + common Hindi/Hinglish phrasing — this platform targets the
// Indian market (see the ~23-language voice feature), and a customer
// typing in Hinglish is the normal case, not an edge case. "krdo"/"kar do"
// (do it), "hata do"/"hatao" (remove it), "band karo" (stop/close it) are
// all real cancel phrasing seen in practice, same for booking/date/time
// words customers actually type.
const CANCEL_RE =
  /\b(cancel|cancell?ation|stop|drop|remove|don['']?t want|delete)\b.{0,40}\b(booking|appointment|slot|reserv|this|it|that)\b|\b(cancel|cancell?ation)\b|\b(cancel|band|radd)\s*(kar\s*do|karo|kardo)\b|\bhata\s*(do|o)\b|\bhatao\b/i;
// Found live: bare `where`/`when` matched ANY message containing that
// word, including plain location questions like "where are you located" —
// STATUS_RE wins an unconditional override over the LLM (see the
// CANCEL_RE/STATUS_RE override comment below), so a location question was
// swallowed as a status check before QUESTION_RE (or the LLM, or the
// dedicated location-lookup quick action) ever got a chance to answer it.
// Scoped to require "where"/"when"/"what time"/"what day" to actually be
// asking about a booking/appointment/order, the same way
// "my (booking|appointment)" already was — bare "what time"/"what day"
// had the identical bug (e.g. "what time do you close" is a QUESTION_RE
// business-hours question, not a status check, but STATUS_RE's override
// preempted it every time).
const STATUS_RE =
  /\b(status)\b|\b(where|when|what time|what day)\b.{0,25}\b(my|booking|appointment|order|slot|table)\b|\bmy (booking|appointment)\b|\btrack\b|\bcheck.{0,15}booking\b|\bkab\s*(hai|h)\b|\bkitne\s*baje\b|\bstatus\s*bata/i;
const RESTART_RE = /\b(restart|start over|start again|new booking|book something else|reset|menu|exit)\b/i;
const QUESTION_RE = /\b(how much|price|fee|cost|hour|open|close|location|address|where are you|do you have|available|what (do|is|are)|can you|tell me about)\b/i;
const COMPLAINT_RE = /\b(frustrated|angry|upset|terrible|horrible|awful|this (is|was) (bad|wrong)|not working|wasted|useless|ridiculous|mess)\b/i;
// Symptom phrasing (English + Hindi/Hinglish) that should read as wanting
// medical help, even without the word "doctor" or "appointment" —
// "MUJHE BUKHAR HUA HAI" (I have a fever) is exactly this case: it names
// a symptom, not a business, so classify.js's business-keyword match
// alone wouldn't catch it without this.
const SYMPTOM_RE =
  /\b(fever|bukhar|cough|khansi|pain|dard|headache|sar\s*dard|stomach\s*ache|cold|jukam|zukam|vomit|ulti|injury|chot|rash)\b/i;

const GREETING_RE =
  /^(hi|hello|hey|hiya|hii|hiii|good\s+(morning|afternoon|evening)|namaste|namaskar|raam\s*raam|ram\s*ram|kya\s*hal|kaise\s*ho|radhe\s*radhe|jai\s*shree\s*ram|pranam|sat\s*sri|adaab|khamma\s*ghani)[\s!,.?]*$/i;

function keywordIntent(text) {
  const t = text.toLowerCase().trim();

  if (CANCEL_RE.test(t)) return INTENTS.CANCEL_BOOKING;
  if (STATUS_RE.test(t)) return INTENTS.CHECK_STATUS;
  if (RESTART_RE.test(t)) return INTENTS.RESTART;
  if (QUESTION_RE.test(t)) return INTENTS.QUESTION;
  if (COMPLAINT_RE.test(t)) return INTENTS.COMPLAINT;

  if (GREETING_RE.test(t)) return INTENTS.GREETING;

  if (SYMPTOM_RE.test(t)) return INTENTS.BOOKING_INTENT;

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
    const { data, elapsedMs } = await groqChatCompletion({
      model: GROQ_MODEL,
      temperature: 0,
      max_tokens: 40,
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
            "- greeting: simple greeting such as hi, hello, hey, good morning, namaste\n" +
            "- unclear: random noise or genuinely ambiguous request\n\n" +
            "If the message could be cancel_booking OR booking_intent, prefer cancel_booking when the customer HAS an existing booking.\n" +
            "Reply with ONLY one of: cancel_booking, check_status, restart, question, complaint, booking_intent, greeting, unclear",
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
    });
    log("INFO", `detectGeneralIntent Groq call took ${elapsedMs}ms`);
    const raw = (data.choices?.[0]?.message?.content || "").trim().toLowerCase();

    // Validate — never trust an unrecognized string from the model.
    const intent = [...VALID_INTENTS].find((i) => raw.includes(i));
    if (!intent) {
      log("WARN", `intentDetector returned unrecognized value "${raw}" — using keyword fallback.`);
      return keywordIntent(text);
    }

    // The keyword regexes run regardless of whether the AI call succeeded
    // — not just as a failure fallback. If CANCEL_RE/STATUS_RE matches
    // unambiguously and the LLM disagreed, the keyword signal wins for
    // these two specifically. Found live: "cancel whatever bookings are
    // under my name" contains the literal word "cancel" — CANCEL_RE would
    // have matched it correctly, but the LLM returned "complaint" instead
    // and that's what won. A false negative on cancel/status (silently
    // NOT cancelling, or NOT showing status, when the customer clearly
    // asked) is worse than a false positive on the softer intents
    // (question/complaint/restart/booking_intent), where being wrong just
    // means one extra clarifying turn — so only these two get this
    // override, not every intent.
    // Found live (adversarial testing): "this is the third time my booking
    // got messed up, im really frustrated" — the LLM correctly read this as
    // complaint, but STATUS_RE's `\bmy (booking|appointment)\b` clause
    // matches it too (any sentence that mentions "my booking" at all, not
    // just an actual status question), so the override above forced
    // check_status and the customer got a flat "No active booking found."
    // instead of any acknowledgment of what they were upset about. Unlike
    // the cancel/status false-negative this override exists to prevent, a
    // false negative on complaint here isn't silent — the STATUS branch
    // still replies, just with the wrong tone entirely. Narrowed to not
    // fire when the LLM said complaint AND the customer actually used real
    // frustration language (isExplicitComplaint) — that combination is
    // strong enough evidence to trust over the keyword match.
    const keywordGuess = keywordIntent(text);
    const explicitComplaintOverride =
      keywordGuess === INTENTS.CHECK_STATUS && intent === INTENTS.COMPLAINT && isExplicitComplaint(text);
    if (
      (keywordGuess === INTENTS.CANCEL_BOOKING || keywordGuess === INTENTS.CHECK_STATUS) &&
      intent !== keywordGuess &&
      !explicitComplaintOverride
    ) {
      log("INFO", `Keyword override: LLM said "${intent}" but CANCEL_RE/STATUS_RE unambiguously matched "${keywordGuess}" — using the keyword signal.`);
      return keywordGuess;
    }

    log("INFO", `Intent detected: "${intent}" for message: "${text.slice(0, 80)}"`);
    return intent;
  } catch (err) {
    log("WARN", `intentDetector failed (${err.message}) — using keyword fallback.`);
    return keywordIntent(text);
  }
}

// Exported so a caller that already knows the intent is COMPLAINT can
// tell "customer actually used a frustration word" apart from "the LLM
// alone called it a complaint" — the difference between a genuinely
// upset customer and a neutral "can I speak to support" (Section 1.7).
function isExplicitComplaint(text) {
  return COMPLAINT_RE.test(text);
}

// Hardcoded, not LLM-graded — a direct "are you a bot/human/AI" question
// gets one honest, consistent answer regardless of phrasing or what an
// LLM might guess that turn (Section 1.8).
const BOT_IDENTITY_RE = /\b(are you (a |an )?(bot|robot|ai|human|real person|machine)|is this (a |an )?(bot|automated|ai)|talking to (a |an )?(bot|ai|human))\b/i;
function isBotIdentityQuestion(text) {
  return BOT_IDENTITY_RE.test(text);
}

// English + Hindi/Hinglish price objections — "PAISE JADA HAI YEH" (this
// fee is too much) is exactly this case. Checked specifically at the
// confirm-card/review-confirm steps (Section 1.6), where the customer's
// text won't match the tappable button choices and would otherwise just
// get "please tap Continue or Choose Another" with no acknowledgment.
const PRICE_OBJECTION_RE = /\b(too (expensive|much|costly|high)|can't afford|discount|cheaper|less price|reduce.{0,10}price)\b|\b(jada|jyada|zyada)\s*(hai|h)?\b.{0,10}\b(paise|price|fee|cost)\b|\b(paise|price|fee|cost)\b.{0,10}\b(jada|jyada|zyada)\b|\bmehenga\b/i;
function isPriceObjection(text) {
  return PRICE_OBJECTION_RE.test(text);
}

// A bare "ok"/"thanks"/"no thanks" isn't a request for anything — found
// live: it was falling through to the same "Looks like you already have a
// booking..." nudge + full business menu as a genuine unmatched request
// ("I want relaxation"), which reads as robotic when all the customer did
// was acknowledge the bot's last message. Deliberately anchored with
// ^...$ (the whole message, allowing only trailing punctuation/whitespace)
// so it never fires on a real sentence that happens to contain "ok"
// somewhere in it.
const ACKNOWLEDGMENT_RE = /^(ok(ay)?|k|kk|got it|sure|cool|alright|fine|thanks?( you)?|thank you|no thanks?|nope|no|nah|ty|thx|👍|👌)[.!\s]*$/i;
function isPlainAcknowledgment(text) {
  return ACKNOWLEDGMENT_RE.test(text.trim());
}

module.exports = { detectGeneralIntent, INTENTS, isExplicitComplaint, isBotIdentityQuestion, isPriceObjection, isPlainAcknowledgment, GREETING_RE, keywordIntent };
