const { log } = require("../infra/logger");
const { capForAI } = require("../infra/textLimits");
const { groqChatCompletion, GROQ_MODEL } = require("./groqClient");

// Keyword fallback: checks each workflow's own `keywords` list. Used when no
// Groq key is set, or the AI call fails/returns something unrecognized — the
// bot never breaks because of a missing/expired key. Returns workflowId:null
// when nothing matches — callers must NOT silently guess a business, or a
// plain "hii" ends up booking a haircut (this was a real bug).
function keywordClassify(text, workflows) {
  const q = text.toLowerCase();
  for (const workflow of Object.values(workflows)) {
    // Found live: a business created through the admin UI has no keywords[]
    // at all — it's not even a field that form exposes, only reachable by
    // hand-editing the raw JSON — so `.some()` on undefined threw a
    // TypeError the moment a tenant had 2+ such businesses and a customer
    // hit a reclassifiable step (couldBeADifferentBusiness below hits the
    // exact same gap). No keywords just means this workflow never matches
    // via the fallback path, same as an empty list would.
    if ((workflow.keywords || []).some((k) => q.includes(k))) {
      return { workflowId: workflow.id, source: "keyword-fallback" };
    }
  }
  return { workflowId: null, source: "no-match" };
}

// Business Detection Engine (MVP): classifies a free-text customer message
// into one of the loaded workflow ids, using every workflow's `description`
// as the hint for what that category covers — so the AI prompt updates
// automatically as workflows are added/removed, same as the categories list.
// Returns workflowId:null for greetings/small talk/anything that doesn't
// clearly indicate a business — the caller should ask a clarifying question
// rather than guess.
async function classifyBusiness(text, workflows) {
  if (!process.env.GROQ_API_KEY) {
    log("WARN", "GROQ_API_KEY not set — using keyword fallback classifier.");
    return keywordClassify(text, workflows);
  }

  const ids = Object.keys(workflows);
  const hints = Object.values(workflows)
    .map((w) => `"${w.id}" = ${w.description}`)
    .join(". ");

  try {
    const { data, elapsedMs } = await groqChatCompletion({
      model: GROQ_MODEL,
      temperature: 0,
      max_tokens: 40,
      messages: [
        {
          role: "system",
          content:
            `You classify a customer's WhatsApp message into exactly one business category: ${ids.join(", ")}, ` +
            `or "unclear" for anything else. ${hints}. ` +
            "Only classify into a category if the customer is clearly trying to BOOK or SCHEDULE something with " +
            "that business right now (e.g. \"I need a doctor\", \"book a haircut\", \"a room for 2 nights\"). " +
            "A question ABOUT a business — hours, prices, location, whether a specific provider exists — is " +
            "NOT a booking intent even if it names that business or provider by name; reply \"unclear\" for " +
            "those too, same as a greeting or small talk. Reply with ONLY the single category word (or " +
            '"unclear") and nothing else.',
        },
        { role: "user", content: capForAI(text) },
      ],
    });
    log("INFO", `classifyBusiness Groq call took ${elapsedMs}ms`);
    const raw = (data.choices?.[0]?.message?.content || "").trim().toLowerCase();

    // Trust the AI's explicit "unclear" as-is — do NOT fall back to keyword
    // matching here. Keywords are a coarse substring match with no concept
    // of intent, so re-running them after the AI correctly determined
    // "this mentions a provider name but isn't a booking request" would
    // undo that judgment (verified live: "how much does The Barber Co
    // charge?" — the AI correctly said unclear, but the keyword fallback
    // then matched "barber" and forced it into a hair booking anyway).
    // Keywords stay the fallback ONLY for when the AI call itself fails.
    if (raw.includes("unclear")) return { workflowId: null, source: "ai-unclear" };

    const workflowId = ids.find((id) => raw.includes(id));
    if (!workflowId) throw new Error(`Unrecognized AI output: "${raw}"`);
    return { workflowId, source: "groq-ai" };
  } catch (err) {
    log("ERROR", `AI classification failed (${err.message}) — falling back to keywords.`);
    return keywordClassify(text, workflows);
  }
}

// Cheap, synchronous pre-check used before paying for a classifyBusiness()
// Groq call mid-flow: is there ANY hint this message is about a business
// OTHER than the one already locked in? If not, skip the call entirely —
// a mistyped date or an out-of-range answer has no overlap with any other
// workflow, so the Groq call would almost always just confirm "no switch"
// at the cost of latency and quota. Conservative by design: any ambiguity
// (a match on ANYTHING below) still goes to the real classifier rather
// than this guessing on its own.
//
// Found live (real bug, real WhatsApp number): typing another business's
// own id/name verbatim mid-flow — exactly what a customer does after
// seeing it in an earlier list/menu — never matched here, because this
// only ever checked `keywords` (free-text description terms like "car
// service, auto repair"), never the id ("automobile-service") or label
// ("Automobile Service") a customer might just as easily type back. The
// customer stayed stuck in the wrong business's current step instead of
// switching. Checking id/label too closes that gap without waiting on the
// keywords fix alone (see the derive-from-description default in
// server.js's POST /api/dashboard/workflows) — either one matching is
// enough to trigger the real classifier.
function couldBeADifferentBusiness(text, workflows, currentWorkflowId) {
  const q = text.toLowerCase();
  return Object.values(workflows).some((w) => {
    if (w.id === currentWorkflowId) return false;
    if (q.includes(w.id.toLowerCase())) return true;
    if (w.label && q.includes(w.label.toLowerCase())) return true;
    return (w.keywords || []).some((k) => q.includes(k));
  });
}

module.exports = { classifyBusiness, couldBeADifferentBusiness };
