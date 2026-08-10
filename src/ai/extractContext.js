const { log } = require("../infra/logger");
const { capForAI } = require("../infra/textLimits");
const { groqChatCompletion } = require("./groqClient");

// After we know which workflow a message belongs to, this makes one more
// Groq call to see if the customer already answered some of that
// workflow's questions in their opening message (e.g. "book a haircut with
// Barber Co tomorrow" names both a provider and a date) — so the bot can
// skip straight past whatever was already said instead of re-asking.
//
// Deliberately NOT extracted: time-of-day. Matching a free-text phrase like
// "5pm" against a generated list of slot strings is failure-prone (wrong
// format, ambiguous am/pm, etc.) — better to just show the tappable list
// than silently guess wrong on something this consequential.
//
// Safety property: this extraction is never trusted blindly, in two layers.
// (1) Every extracted value is matched against something real downstream
// (an actual provider/hotel name, a real generated date option) — a
// provider name the AI hallucinates that isn't in the real list simply
// fails to match. (2) That alone wasn't enough — verified live that a
// 5000-char garbage string got a *real* provider name hallucinated onto it
// (the model picked one that happened to exist), so workflowEngine.js's
// tryAutoFillStep also requires the extracted name to actually appear in
// the customer's real message before accepting it. Free-text fields
// (customerName, checkInDate) go through the exact same validation a
// manually-typed answer would either way.
async function extractContext(text, workflow) {
  if (!process.env.GROQ_API_KEY) return {};

  const providerEntities = workflow.providers || [];
  const names = providerEntities.map((p) => p.name).concat((workflow.hotels || []).map((h) => h.name));
  if (names.length === 0) return {};

  // Include each provider's specialty/attribute, not just their name — a
  // symptom report ("mujhe bukhar hai" / "I have a fever") only tells the
  // model which provider fits if it can see that Dr. Sharma is the
  // General Physician and Dr. Khan is the Dermatologist. Names alone gave
  // it no way to reason about that, so a fever could surface any of the
  // three doctors with no relevance filtering at all.
  const providerDescriptions = providerEntities
    .map((p) => `${p.name}${p.attribute ? ` (${p.attribute})` : ""}`)
    .join(", ");

  try {
    const { data } = await groqChatCompletion({
      model: "llama-3.1-8b-instant",
      temperature: 0,
      max_tokens: 150,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You extract booking details a customer already stated in one WhatsApp message, for a booking bot. " +
            `The only valid providers are: ${providerDescriptions || names.join(", ")}. ` +
            'Return ONLY a JSON object with any of these keys the message CLEARLY states — omit any key it does not mention, never guess: ' +
            '"providerName" (must be one of the exact names listed above, or omit — the specialty shown in ' +
            "parentheses is context to help match a name the customer DID say, e.g. matching a misspelling or " +
            'partial name to the right doctor; it is not enough on its own — the customer must have named someone), ' +
            '"dateHint" ("today", "tomorrow", or a date phrase like "12 Aug", or omit), ' +
            '"customerName" (a person\'s name explicitly given for the booking — not the sender\'s own casual sign-off — or omit). ' +
            "If the message is just a symptom, service request, or greeting with no such details, return {}.",
        },
        { role: "user", content: capForAI(text) },
      ],
    });
    const raw = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    log("WARN", `Context extraction failed (${err.message}) — starting from the first step instead.`);
    return {};
  }
}

module.exports = { extractContext };
