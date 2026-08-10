const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bookpilot-specialty-test-"));
delete require.cache[require.resolve("../../src/engine/workflowEngine")];
const { suggestSpecialtyProvider } = require("../../src/engine/workflowEngine");

const workflow = {
  providers: [
    { id: "p1", name: "Dr. Rajesh Sharma", attribute: "General Physician" },
    { id: "p2", name: "Dr. Neha Mehta", attribute: "Orthopedic" },
    { id: "p3", name: "Dr. Imran Khan", attribute: "Dermatologist" },
  ],
};

test("1.10: Hindi fever symptom suggests the General Physician, not a random doctor", () => {
  const suggestion = suggestSpecialtyProvider("MUJHE BUKHAR HUA HAI", workflow);
  assert.equal(suggestion?.name, "Dr. Rajesh Sharma");
});

test("1.10: skin/rash symptom suggests the Dermatologist", () => {
  const suggestion = suggestSpecialtyProvider("I have a bad skin rash", workflow);
  assert.equal(suggestion?.name, "Dr. Imran Khan");
});

test("1.10: joint injury suggests the Orthopedic", () => {
  const suggestion = suggestSpecialtyProvider("hurt my knee, joint pain", workflow);
  assert.equal(suggestion?.name, "Dr. Neha Mehta");
});

test("1.10: no keyword match -> no suggestion (never guesses confidently on a miss)", () => {
  assert.equal(suggestSpecialtyProvider("hi there", workflow), null);
});

test("1.10: never throws when a workflow has no providers array (e.g. a hotel workflow)", () => {
  assert.equal(suggestSpecialtyProvider("I have a fever", { hotels: [] }), null);
});
