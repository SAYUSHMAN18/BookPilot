const fs = require("fs");
const path = require("path");
const { log } = require("./logger");

const STORE_FILE = path.join(__dirname, "..", "logs", "sessions.json");

// Sessions live in memory (workflowEngine owns the Map) but are mirrored to
// disk so a server restart doesn't drop everyone's in-progress booking.
// A single JSON file is enough at this traffic scale — no DB needed yet.
function loadSessions() {
  try {
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    return new Map(Object.entries(JSON.parse(raw)));
  } catch (err) {
    if (err.code !== "ENOENT") {
      log("WARN", `Could not read session store (${err.message}) — starting with no in-progress sessions.`);
    }
    return new Map();
  }
}

// Atomic write (write to temp file, then rename) so a crash mid-write can't
// leave a corrupted sessions.json behind.
function saveSessions(sessions) {
  const obj = Object.fromEntries(sessions);
  const tmpFile = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(obj));
  fs.renameSync(tmpFile, STORE_FILE);
}

module.exports = { loadSessions, saveSessions };
