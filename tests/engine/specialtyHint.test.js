const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// suggestSpecialtyProvider() itself is a pure function (workflow.providers
// in, a suggestion out — no DB reads/writes), but it lives in
// workflowEngine.js, which requires src/store/bookingStore (and
// transitively src/store/db) at module scope — db.js throws immediately
// at require() time if DATABASE_URL isn't already set. Every other test
// file that touches real data gets DATABASE_URL from
// tests/helpers/isolatedDb.js's own isolated-database setup; this file
// doesn't need an isolated database at all (it never reads/writes a
// single row), so it just needs the real .env's DATABASE_URL present so
// requiring workflowEngine doesn't throw — dotenv's config() only fills
// in keys that are absent, so this is a no-op everywhere else that
// already set DATABASE_URL itself.
require("dotenv").config();
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
