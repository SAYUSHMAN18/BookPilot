const { log } = require("./logger");
const { capForAI } = require("./textLimits");

// Agentic orchestration — the AI plans WHICH action to take when a
// customer says something that doesn't fit the step they're on, and the
// engine executes it.
//
// Deliberately NOT free-form tool calling against the database. The
// booking guarantees this system makes (no double-booking, validated
// fields, a confirmation step before anything is written) come from the
// deterministic engine owning every write. An LLM that could call
// "create_booking" directly would put those guarantees behind a model's
// judgment on every turn. So the agent plans within a closed set of
// navigation intents — it decides where the conversation should GO, and
// the existing engine still decides what actually happens when it gets
// there. Slot locking, validation, and persistence are untouched.
//
// This exists to fix a concrete failure: a customer mid-booking who says
// "actually make it Friday" or "wait, how much is this?" used to get
// "invalid input, please pick from the list" and could loop indefinitely.

// Every action the planner is allowed to return. Anything else is treated
// as a parse failure and falls back to the plain retry path.
const ACTIONS = {
  RETRY_STEP: "retry_step",       // genuinely just a wrong/unparseable answer
  ANSWER_QUESTION: "answer_question", // a real question — answer it, then re-prompt
  GO_TO_STEP: "go_to_step",       // wants to change an earlier answer
  CANCEL: "cancel",               // wants to abandon the booking
  RESTART: "restart",             // wants to start over from scratch
  HUMAN: "human",                 // wants a real person
};

const VALID_ACTIONS = new Set(Object.values(ACTIONS));

// Describes each step in terms of what it actually COLLECTS, not its
// internal type name. Verified live that labelling step 0 as
// "select_provider" made the planner route "wrong doctor, I wanted the
// dermatologist" to the date step instead — the model had no way to know
// select_provider is where a doctor gets chosen. Saying "which doctor /
// service provider" fixes it.
const STEP_DESCRIPTIONS = {
  select_provider: "which provider/doctor/stylist/service is being booked",
  select_hotel: "which hotel",
  select_room: "which room type",
  select_date: "the date of the booking",
  select_time_slot: "the time of the appointment",
  select_option: "a choice",
  review_confirm: "final review and confirmation",
};

function describeSteps(workflow, currentIndex) {
  return workflow.steps
    .map((s, i) => {
      const what = s.field
        ? `collects "${s.field}"${STEP_DESCRIPTIONS[s.type] ? ` — ${STEP_DESCRIPTIONS[s.type]}` : ""}`
        : STEP_DESCRIPTIONS[s.type] || s.type;
      const marker = i === currentIndex ? "   <-- CUSTOMER IS HERE NOW" : "";
      return `${i}: ${what}${marker}`;
    })
    .join("\n");
}

// Returns { action, stepIndex? } or null if planning failed/unavailable —
// callers must handle null by falling back to their existing behavior.
async function planNextAction(text, workflow, session) {
  if (!process.env.GROQ_API_KEY) return null;

  const currentIndex = session.stepIndex;
  const collected = Object.entries(session.data || {})
    .filter(([k]) => !k.endsWith("Iso"))
    .map(([k, v]) => `${k}=${v}`)
    .join(", ") || "(nothing yet)";

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
        max_tokens: 60,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You route a customer's mid-booking WhatsApp message to ONE action. The customer is partway " +
              "through a booking and just said something that did not match the step they're on.\n\n" +
              `BOOKING STEPS:\n${describeSteps(workflow, currentIndex)}\n\n` +
              `ALREADY COLLECTED: ${collected}\n\n` +
              'Reply with JSON: {"action": "...", "stepIndex": <number, only for go_to_step>}\n\n' +
              "Actions:\n" +
              '- "retry_step": they tried to answer the current step but it was invalid, unclear, or a typo. THIS IS THE DEFAULT — use it unless another action clearly applies.\n' +
              '- "answer_question": they asked a genuine question (price, hours, location, policy) instead of answering.\n' +
              '- "go_to_step": they want to CHANGE an answer they already gave (e.g. "actually make it Friday", "change the date", "wrong doctor"). Set stepIndex to the step that collects that field. Only use for steps at or before the current one.\n' +
              '- "cancel": they want to abandon this booking entirely.\n' +
              '- "restart": they want to start over / book something different.\n' +
              '- "human": they want to talk to a real person or customer support.\n\n' +
              'The "action" value MUST be exactly one of: retry_step, answer_question, go_to_step, cancel, restart, human. ' +
              "Never invent a different action name. Never add other fields.\n" +
              "Reply with ONLY the JSON object.",
          },
          // Few-shot: the model was observed inventing action names like
          // "change_doctor" for change requests (correctly rejected by
          // validation, but that meant falling back to a plain retry).
          // Concrete examples of mapping a change request onto go_to_step
          // stopped that.
          { role: "user", content: "change the doctor actually" },
          { role: "assistant", content: '{"action":"go_to_step","stepIndex":0}' },
          { role: "user", content: "whats the price" },
          { role: "assistant", content: '{"action":"answer_question"}' },
          { role: "user", content: "xyzabc" },
          { role: "assistant", content: '{"action":"retry_step"}' },
          { role: "user", content: capForAI(text) },
        ],
      }),
    });

    if (!resp.ok) throw new Error(`Groq API responded ${resp.status}`);
    const data = await resp.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");

    if (!VALID_ACTIONS.has(parsed.action)) {
      log("WARN", `Orchestrator returned unknown action "${parsed.action}" — falling back to retry.`);
      return null;
    }

    // A model-supplied step index is untrusted input: clamp it to a real
    // step, and never let it jump FORWARD past unanswered steps (which
    // would skip required fields and produce an incomplete booking).
    if (parsed.action === ACTIONS.GO_TO_STEP) {
      const idx = Number(parsed.stepIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx > currentIndex || idx >= workflow.steps.length) {
        log("WARN", `Orchestrator proposed out-of-range stepIndex ${parsed.stepIndex} — falling back to retry.`);
        return null;
      }
      return { action: ACTIONS.GO_TO_STEP, stepIndex: idx };
    }

    return { action: parsed.action };
  } catch (err) {
    log("WARN", `Orchestrator planning failed (${err.message}) — falling back to the normal retry path.`);
    return null;
  }
}

module.exports = { planNextAction, ACTIONS };
