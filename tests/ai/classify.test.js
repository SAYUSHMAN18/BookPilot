const { test } = require("node:test");
const assert = require("node:assert/strict");
const { couldBeADifferentBusiness, classifyBusiness } = require("../../src/ai/classify");

const workflows = {
  medical: { id: "medical", label: "Doctor Appointment", keywords: ["doctor", "fever", "appointment"] },
  hair: { id: "hair", label: "Haircut / Grooming", keywords: ["haircut", "salon", "stylist"] },
};

// classifyBusiness() with GROQ_API_KEY unset takes its own documented
// no-AI-configured shortcut straight to keywordClassify() — the same
// fallback code path used when a real Groq call fails/returns unparseable
// output, so this exercises exactly what a customer hits in that case,
// without needing to mock a Groq failure.
async function keywordFallback(text) {
  const had = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  try {
    return await classifyBusiness(text, workflows);
  } finally {
    if (had !== undefined) process.env.GROQ_API_KEY = had;
  }
}

test("keyword fallback: a bare one-word message matching a workflow's own id still classifies — not just a keyword phrase", () => {
  // Found live: every keyword is a multi-word phrase ("hair color",
  // "hairstyle"), so q.includes(keyword) can never match when q itself is
  // shorter than the keyword — a customer who just types the business's
  // own id/name got no match at all and landed on a dead-end reply
  // instead of the real booking flow.
  return keywordFallback("hair").then((result) => {
    assert.equal(result.workflowId, "hair");
    assert.equal(result.source, "keyword-fallback");
  });
});

test("keyword fallback: a message matching a workflow's own label still classifies", () => {
  return keywordFallback("Haircut / Grooming please").then((result) => {
    assert.equal(result.workflowId, "hair");
  });
});

test("keyword fallback: an actual keyword phrase still matches as before", () => {
  return keywordFallback("I need a haircut").then((result) => {
    assert.equal(result.workflowId, "hair");
  });
});

test("keyword fallback: genuinely unrelated text still returns no match", () => {
  return keywordFallback("asdkjhasd").then((result) => {
    assert.equal(result.workflowId, null);
    assert.equal(result.source, "no-match");
  });
});

test("couldBeADifferentBusiness: true when another workflow's keyword appears", () => {
  assert.equal(couldBeADifferentBusiness("actually I need a haircut", workflows, "medical"), true);
});

test("couldBeADifferentBusiness: false for text with no keyword overlap at all", () => {
  assert.equal(couldBeADifferentBusiness("asdkjhasd", workflows, "medical"), false);
});

test("couldBeADifferentBusiness: ignores the current workflow's own keywords", () => {
  // "fever" belongs to medical itself — shouldn't count as "a different business"
  assert.equal(couldBeADifferentBusiness("I still have a fever", workflows, "medical"), false);
});
