const { log } = require("./logger");
const { capForAI } = require("./textLimits");

// Builds a plain-text summary of only the REAL data each workflow actually
// has (hours, providers/rooms, fees, location) — this is the entire
// "knowledge base" the model is allowed to answer from.
function buildKnowledgeBase(workflows) {
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
async function tryAnswerFactually(text, workflows) {
  if (!process.env.GROQ_API_KEY) return null;

  const knowledgeBase = buildKnowledgeBase(workflows);

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
              `DATA:\n${knowledgeBase}`,
          },
          { role: "user", content: capForAI(text) },
        ],
      }),
    });

    if (!resp.ok) throw new Error(`Groq API responded ${resp.status}`);
    const data = await resp.json();
    const answer = (data.choices?.[0]?.message?.content || "").trim();
    if (!answer || answer.toUpperCase().includes("NO_ANSWER")) return null;
    return answer;
  } catch (err) {
    log("WARN", `Factual Q&A failed (${err.message}) — falling back to the business menu.`);
    return null;
  }
}

module.exports = { tryAnswerFactually };
