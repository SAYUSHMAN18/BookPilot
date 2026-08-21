// Enterprise Hardening Phase 1, item 3 — logger.js redacts phone-number-
// shaped digit runs before they reach any of its four sinks (console,
// app.log, app.jsonl, log drain). Same "call the real log() and read the
// real files back" pattern tests/infra/alerting.test.js already uses for
// this module — there's no per-test log path override, LOG_FILE/
// STRUCTURED_LOG_FILE are fixed paths under the real logs/ directory.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const LOG_FILE = path.join(__dirname, "..", "..", "logs", "app.log");
const STRUCTURED_LOG_FILE = path.join(__dirname, "..", "..", "logs", "app.jsonl");

// Alphanumeric, not a raw Date.now() digit run — a 13-digit epoch
// timestamp would itself be long enough to match the phone-number-shaped
// redaction regex and get masked, breaking the "read back the exact line
// we just wrote" sanity check below for a reason unrelated to what these
// tests actually check.
function uniqueMarker(label) {
  return `${label}-${Math.random().toString(36).slice(2, 10)}`;
}

// Finds OUR line by its unique marker rather than assuming it's the
// file's last line — logs/app.log and app.jsonl are real, fixed-path
// files shared across every test file in the suite (node --test runs
// files as separate parallel processes by default), so another file's
// own log() call landing between our write and this read is a genuine
// race, not a hypothetical one (caught live: this flaked intermittently
// under the full suite before this fix).
function findLineContaining(filePath, marker) {
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(marker)) return lines[i];
  }
  return undefined;
}

test("log() masks a phone-number-shaped digit run in the human-readable log line", () => {
  delete require.cache[require.resolve("../../src/infra/logger")];
  const { log } = require("../../src/infra/logger");

  const marker = uniqueMarker("redact-test");
  log("INFO", `${marker} Message from 919876543210 [tenant=1]: "hi"`);

  const line = findLineContaining(LOG_FILE, marker);
  assert.ok(line, "expected to find the line we just wrote, by its unique marker");
  assert.doesNotMatch(line, /919876543210/, "the raw phone number must not appear in the log line");
  assert.match(line, /91\*{6}3210/, "expected the masked form (head + 6 asterisks + tail)");
});

test("log() also masks the same digit run in the structured JSONL sink", () => {
  delete require.cache[require.resolve("../../src/infra/logger")];
  const { log } = require("../../src/infra/logger");

  const marker = uniqueMarker("redact-test-jsonl");
  log("INFO", `${marker} Message from 917000011122 [tenant=1]: "hello"`);

  const line = findLineContaining(STRUCTURED_LOG_FILE, marker);
  assert.ok(line, "expected to find the line we just wrote, by its unique marker");
  const entry = JSON.parse(line);
  assert.ok(entry.message.includes(marker));
  assert.doesNotMatch(entry.message, /917000011122/);
  assert.match(entry.message, /91\*{6}1122/);
});

test("log() leaves ordinary short numbers (not phone-number-shaped) untouched", () => {
  delete require.cache[require.resolve("../../src/infra/logger")];
  const { log } = require("../../src/infra/logger");

  const marker = uniqueMarker("redact-test-short");
  log("INFO", `${marker} booking fee is 500, slot 3 of 10`);

  const line = findLineContaining(LOG_FILE, marker);
  assert.ok(line, "expected to find the line we just wrote, by its unique marker");
  assert.ok(line.includes("500") && line.includes("3 of 10"), "short numbers that aren't phone-number-shaped should be left alone");
});
