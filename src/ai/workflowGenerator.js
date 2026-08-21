const { log } = require("../infra/logger");
const { capForAI } = require("../infra/textLimits");
const { groqChatCompletion, GROQ_MODEL } = require("./groqClient");

// Turns a plain-language business description into a draft workflow JSON
// matching the exact shape workflows/*.json already uses — same schema
// classify.js, extractContext.js, and workflowEngine.js already know how
// to run, so a generated workflow needs zero engine changes to work.
//
// This drafts, it doesn't decide: the caller (POST /api/dashboard/
// workflows/generate) never writes anything to disk — the admin sees the
// draft in the same Add Business modal used for hand-written JSON, can
// edit it, and only saving still goes through the existing
// validateWorkflowShape() check in server.js. A bad or malformed AI
// output is just a bad draft, not a bad save.
const SCHEMA_PROMPT = `You write a single JSON object describing a WhatsApp booking workflow. Output ONLY the JSON object, no markdown fences, no commentary.

Fields:
- id: lowercase, letters/numbers/dashes/underscores only, no spaces. Short and specific to the business (e.g. "zen-spa").
- label: human-readable business name (e.g. "Zen Massage & Spa").
- description: a phrase describing what this business is for, used to help an AI classifier route customer messages here (e.g. "massage, therapy, relaxation, wellness services").
- matchLabel: short phrase completing "it looks like you need ___" (e.g. "a massage therapist").
- keywords: array of 4-8 lowercase words/phrases a customer might type that should route to this business (used as a fallback if the AI classifier is unavailable).
- bookingIdPrefix: 3-5 uppercase letters used in generated booking IDs (e.g. "SPA").
- businessHours: OPTIONAL {"start":"HH:MM","end":"HH:MM"} 24h, defaults to 09:00-18:00 if omitted.
- slotMinutes: OPTIONAL number, minutes per appointment slot, defaults to 30 if omitted.
- Either "providers" (a person/service/room booked directly) OR "hotels" (multi-room properties) — never both:
  - providers: array of {"id":"p1","name":"...","attribute":"short role/spec, e.g. 'General Physician'","fee": number}
  - hotels: array of {"id":"h1","name":"...","location":"...","rooms":[{"id":"h1-r1","name":"...","attribute":"...","fee": number per night}]}
- steps: an ordered array driving the WhatsApp conversation. Use ONLY these step types, in a sensible order for this business:
  - {"type":"select_provider","prompt":"..."} — required first step for a providers-based business (omit for hotels).
  - {"type":"select_hotel","prompt":"..."} then {"type":"select_room","prompt":"..."} — required first two steps for a hotels-based business instead of select_provider.
  - {"type":"select_date","field":"visitDate","prompt":"..."} — a tappable calendar. For hotels use field "checkInDate" and add "days":10.
  - {"type":"select_time_slot","field":"visitTime","dateField":"visitDate","prompt":"..."} — only for providers (not hotels — hotels use nights instead).
  - {"type":"select_option","field":"nights","prompt":"How many nights?","options":["1","2","3"]} — only for hotels, right after select_date.
  - {"type":"text_input","field":"customerName","prompt":"What name should I book this under?","validate":"required","validationError":"Please share a name."} — ALWAYS include exactly one of these for the customer's name, every workflow needs it.
  - {"type":"text_input","field":"...","prompt":"...","validate":"required","validationError":"..."} — for any other required detail specific to this business (e.g. "reason" for a medical visit). Keep to 0-2 of these beyond name — don't make the customer answer too many questions.
  - {"type":"review_confirm","prompt":"Please review your booking.","template":"a WhatsApp message summarizing the booking using {provider.name}, {provider.attribute}, {visitDateLabel}, {visitTime}, {customerName}, {provider.fee} or the hotel equivalents {hotel.name}, {checkInIso}, {nights} — pick whichever apply"} — ALWAYS the last step, every workflow needs it.
- confirmationTemplate: the final WhatsApp message sent after booking, using the same {placeholder} fields as above plus {bookingId}. Always mention "Reply STATUS anytime to check your appointment."

Match the field-naming conventions and step ordering shown above exactly — the engine looks up these exact field names.`;

// Found live: every other AI call site (classify, intent detection,
// factual Q&A, the orchestrator) goes through groqClient.js's
// groqChatCompletion(), which wraps every request in a hard AbortController
// timeout — this was the one call site that hit Groq directly instead,
// so a hung response here could hang the admin's "generate a business"
// dashboard request indefinitely, the exact failure mode Section 0's
// shared timeout exists to rule out everywhere else. Given a much larger
// max_tokens (2000, vs. 60-400 elsewhere) genuinely needs more time to
// complete than the module's 5s default, this passes an explicit longer
// timeout rather than either accepting spurious failures on normal-sized
// generations or silently keeping the old "no timeout at all" behavior.
const GENERATE_TIMEOUT_MS = 15000;

async function generateWorkflowFromDescription(description) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set — the AI workflow generator needs it (same key used for message classification).");
  }

  const { data } = await groqChatCompletion(
    {
      model: GROQ_MODEL,
      temperature: 0.3,
      max_tokens: 2000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SCHEMA_PROMPT },
        { role: "user", content: `Business description: ${capForAI(description)}` },
      ],
    },
    { timeoutMs: GENERATE_TIMEOUT_MS }
  );
  const raw = data.choices?.[0]?.message?.content || "";

  let workflow;
  try {
    workflow = JSON.parse(raw);
  } catch (err) {
    log("ERROR", `AI workflow generator returned invalid JSON: ${err.message}`);
    throw new Error("The AI's draft wasn't valid JSON — try rephrasing the description, or try again.", { cause: err });
  }

  return workflow;
}

module.exports = { generateWorkflowFromDescription };
