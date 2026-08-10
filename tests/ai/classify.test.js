const { test } = require("node:test");
const assert = require("node:assert/strict");
const { couldBeADifferentBusiness } = require("../../src/ai/classify");

const workflows = {
  medical: { id: "medical", keywords: ["doctor", "fever", "appointment"] },
  hair: { id: "hair", keywords: ["haircut", "salon", "stylist"] },
};

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
