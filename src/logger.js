const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "..", "logs", "app.log");
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

function log(level, message) {
  const line = `[${nowIST()}] [${level}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

module.exports = { log };
