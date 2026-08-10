const { log } = require("../infra/logger");
const { capForAI } = require("../infra/textLimits");
const knowledgeStore = require("../store/knowledgeStore");
const { groqChatCompletion } = require("./groqClient");

// Per-document and total caps so an admin pasting a huge policy doc (or
// several businesses each with a full FAQ page) can't blow up the prompt
// this gets stuffed into — every workflow's data goes into every query
// regardless of which business the question is about, so the ceiling
// applies across all of them combined, not per business.
const MAX_DOC_CHARS = 1500;
const MAX_TOTAL_FAQ_CHARS = 6000;

// Builds a plain-text summary of only the REAL data each workflow actually
// has (hours, providers/rooms, fees, location, plus any admin/provider-
// added FAQ documents) — this is the entire "knowledge base" the model is
// allowed to answer from.
// tenantId is required (Section 8) even though `workflows` is already
// tenant-scoped by the caller — workflow ids are only unique WITHIN one
// tenant (two different tenants can each have their own "medical"
// workflow), so filtering knowledge_documents by workflow_id alone could
// match the wrong tenant's docs, not just miss the right one.
function buildKnowledgeBase(tenantId, workflows) {
  let faqBudget = MAX_TOTAL_FAQ_CHARS;

  return Object.values(workflows)
    .map((w) => {
      const lines = [`### ${w.label} (${w.id})`, w.description];
      if (w.businessName) lines.push(`Business name: ${w.businessName}`);
      if (w.businessHours) lines.push(`Hours: ${w.businessHours.start}–${w.businessHours.end}`);
      if (w.providers) {
        lines.push("Providers:");
        for (const p of w.providers) lines.push(`- ${p.name}: ${p.attribute}, fee ₹${p.fee}`);
      }
      if (w.hotels) {
        lines.push("Hotels:");
        for (const h of w.hotels) {
          lines.push(`- ${h.name}, ${h.location}, rating ${h.rating}`);
          for (const r of h.rooms) lines.push(`  - Room: ${r.name} (${r.attribute}), ₹${r.fee}/night`);
        }
      }

      const docs = knowledgeStore.listForWorkflow(tenantId, w.id);
      if (docs.length > 0 && faqBudget > 0) {
        lines.push("FAQs / policies:");
        for (const doc of docs) {
          const entry = `- ${doc.title}: ${doc.content.slice(0, MAX_DOC_CHARS)}`;
          if (entry.length > faqBudget) break;
          lines.push(entry);
          faqBudget -= entry.length;
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

// For messages that don't map to a booking intent, this is the difference
// between "here's a menu" every single time and actually answering a real
// question ("what are your clinic hours?", "how much is a haircut?").
//
// Safety property: the model is instructed to answer ONLY from the data
// block below and to say the literal string "NO_ANSWER" if it can't —
// never general knowledge, never invented facts. This is prompt-level
// discipline, not a hard technical guarantee the way the provider-name
// grounding check in extractContext.js is — worth knowing the difference:
// a model can still ignore instructions. Treat this as best-effort, and if
// it starts confidently answering things it shouldn't, that's a sign to
// tighten the prompt further, not that this method is fundamentally broken.
// `history` (optional): the last few {text, reply} turns from
// workflowEngine.js's session — Section 1.5. Without it, a direct
// follow-up like "is it for today or another day" right after a STATUS
// reply has no antecedent to resolve "it" against, and the bot either
// says NO_ANSWER or repeats the last static reply verbatim. Still bound
// by the same grounding rule as everything else here: the model may use
// history to understand what's being REFERRED to, never as a source of
// facts not already in the DATA block below.
async function tryAnswerFactually(tenantId, text, workflows, history = []) {
  if (!process.env.GROQ_API_KEY) return null;

  const knowledgeBase = buildKnowledgeBase(tenantId, workflows);
  const historyBlock = history.length
    ? `\n\nRECENT CONVERSATION (most recent last — use this ONLY to understand what a follow-up like "it"/"that"/"today or another day" refers to, never as a source of facts beyond what's in DATA):\n${history
        .map((h) => `Customer: ${h.text}\nBot: ${h.reply}`)
        .join("\n")}`
    : "";

  try {
    const { data, elapsedMs } = await groqChatCompletion({
      model: "llama-3.1-8b-instant",
      temperature: 0,
      max_tokens: 150,
      messages: [
        {
          role: "system",
          content:
            "You are a booking assistant answering a customer's factual question about the businesses below. " +
            "Answer ONLY using facts explicitly present in this data — never guess, never use general knowledge, " +
            "never invent a fact not written here. If the data doesn't contain the answer, or the message isn't " +
            'really a factual question (it\'s a greeting, small talk, or a booking request), reply with EXACTLY ' +
            '"NO_ANSWER" and nothing else. Keep real answers to 1-2 short sentences.\n\n' +
            `DATA:\n${knowledgeBase}${historyBlock}`,
        },
        { role: "user", content: capForAI(text) },
      ],
    });
    log("INFO", `tryAnswerFactually Groq call took ${elapsedMs}ms`);
    const answer = (data.choices?.[0]?.message?.content || "").trim();
    if (!answer || answer.toUpperCase().includes("NO_ANSWER")) return null;
    return answer;
  } catch (err) {
    log("WARN", `Factual Q&A failed (${err.message}) — falling back to the business menu.`);
    return null;
  }
}

// Answers a follow-up ABOUT the customer's own booking ("is it for today
// or another day?", "what time again?") — different data source than
// tryAnswerFactually above (this booking's own fields, not the business's
// general config), same safety discipline: grounded only in the booking's
// real fields, NO_ANSWER (-> null) if it can't answer from those, history
// used only to resolve what a follow-up refers to.
//
// This exists because of a real bug found live: "IS IT FOR TODAY OR ANY
// OTHER DAY" right after a STATUS reply got classified as CHECK_STATUS
// (reasonably — it does ask about a date) and handleStatusCommand() just
// re-sent the exact same static block, ignoring the actual question. A
// bare "STATUS"/"kab hai" should still get that block; anything with more
// content asking something SPECIFIC about it should get answered.
async function tryAnswerAboutBooking(text, booking, history = []) {
  if (!process.env.GROQ_API_KEY) return null;

  // Found live: without this, "is it for today or another day?" got
  // answered "It is for today" for a booking three weeks out — confidently
  // wrong, not a refusal. The model had a date to compare against but
  // nothing telling it what "today" actually IS, so it guessed. Same
  // local-date convention as dateSlots.js (isoDate()), not
  // toISOString() — that parses as UTC and would be a day off for any
  // timezone ahead of UTC, which is exactly the bug this codebase already
  // hit once with server-side date math.
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const bookingFacts = [
    `Today's date: ${todayIso}`,
    `Booking ID: ${booking.bookingId}`,
    booking.providerName ? `Provider: ${booking.providerName}` : null,
    booking.hotelName ? `Hotel: ${booking.hotelName}` : null,
    booking.checkInIso ? `Check-in: ${booking.checkInIso} (${booking.visitDateLabel || ""}), Nights: ${booking.nights}` : null,
    booking.visitDate ? `Date: ${booking.visitDate} (${booking.visitDateLabel || booking.visitDate})` : null,
    booking.visitTime ? `Time: ${booking.visitTime}` : null,
    `Status: ${booking.status}`,
  ]
    .filter(Boolean)
    .join("\n");

  const historyBlock = history.length
    ? `\n\nRECENT CONVERSATION (most recent last — use ONLY to understand what "it"/"that" refers to):\n${history
        .map((h) => `Customer: ${h.text}\nBot: ${h.reply}`)
        .join("\n")}`
    : "";

  try {
    const { data, elapsedMs } = await groqChatCompletion({
      model: "llama-3.1-8b-instant",
      temperature: 0,
      max_tokens: 100,
      messages: [
        {
          role: "system",
          content:
            "You are a booking assistant answering a customer's follow-up question about THEIR OWN booking below. " +
            "Answer ONLY using facts explicitly present in this booking's data — never guess, never invent a date/" +
            'time/name not listed. For any question about WHEN the booking is (today? which day?), compare the ' +
            "booking's Date/Check-in field against Today's date given below — do not guess, compute it from the " +
            'exact dates shown. If the question can\'t be answered from this data, reply with EXACTLY "NO_ANSWER" ' +
            "and nothing else. Keep the answer to 1 short sentence.\n\n" +
            `BOOKING:\n${bookingFacts}${historyBlock}`,
        },
        { role: "user", content: capForAI(text) },
      ],
    });
    log("INFO", `tryAnswerAboutBooking Groq call took ${elapsedMs}ms`);
    const answer = (data.choices?.[0]?.message?.content || "").trim();
    if (!answer || answer.toUpperCase().includes("NO_ANSWER")) return null;
    return answer;
  } catch (err) {
    log("WARN", `tryAnswerAboutBooking failed (${err.message}) — falling back to the standard status reply.`);
    return null;
  }
}

module.exports = { tryAnswerFactually, tryAnswerAboutBooking, MAX_DOC_CHARS };
