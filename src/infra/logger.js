const fs = require("fs");
const path = require("path");
const alerting = require("./alerting");
const { getRequestId } = require("./tracing");

const LOG_FILE = path.join(__dirname, "..", "..", "logs", "app.log");
// Same events, machine-readable — one JSON object per line (JSONL), for
// whatever actually ships these to a real log backend later (Section 5.4
// scopes this repo's half as "structured logging exists and is queryable
// locally," not "already wired to a specific SaaS with no credentials to
// configure one").
const STRUCTURED_LOG_FILE = path.join(__dirname, "..", "..", "logs", "app.jsonl");
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

const istFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

// Business runs in IST, so logs should read in IST too — not the server's
// own timezone (which may not even be IST if this ever gets deployed to a
// US/EU-region host).
function nowIST() {
  const parts = Object.fromEntries(istFormatter.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} IST`;
}

// `meta` is optional structured context (e.g. { waId, bookingId }) — kept
// out of the human-readable line (which every existing call site already
// composes as one free-text string) but preserved in the JSONL file for
// anything that queries logs programmatically later.
function log(level, message, meta) {
  // Section 15 — tags the line with the current request's id (if this
  // log call happened inside one — see src/infra/tracing.js), a short
  // 8-char slice for readability in the human-readable line, the full
  // UUID in the structured JSONL where it's actually grepped/joined on.
  const requestId = getRequestId();
  const reqTag = requestId ? ` [${requestId.slice(0, 8)}]` : "";
  const line = `[${nowIST()}] [${level}]${reqTag} ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
  fs.appendFileSync(STRUCTURED_LOG_FILE, JSON.stringify({ ts: Date.now(), level, message, requestId, ...meta }) + "\n");

  if (level === "ERROR") {
    alerting.recordError();
    if (alerting.shouldAlert()) {
      const { count, windowMs, threshold } = alerting.getErrorRate();
      const alertLine = `[${nowIST()}] [ALERT] ${count} errors in the last ${Math.round(windowMs / 60000)} minute(s) (threshold ${threshold}) — investigate.`;
      console.error(alertLine);
      fs.appendFileSync(LOG_FILE, alertLine + "\n");
    }
  }
}

module.exports = { log };
