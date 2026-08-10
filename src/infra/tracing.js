const { AsyncLocalStorage } = require("node:async_hooks");
const crypto = require("node:crypto");

// Section 15 — every log line from a single incoming request (the
// WhatsApp webhook, a dashboard API call, a Public API call) gets tagged
// with the same requestId, so grepping logs/app.jsonl for one id pulls
// the complete story of what happened for that one request — across
// every async hop (a Groq call, a DB write, a WhatsApp send) — instead of
// having to reconstruct it from timestamps and guesswork. Uses Node's
// built-in AsyncLocalStorage rather than threading a requestId parameter
// through every function signature in the codebase (which would be a
// much larger, invasive change for the same result) — the context
// travels implicitly through the async call chain a request triggers.
const als = new AsyncLocalStorage();

function newRequestId() {
  return crypto.randomUUID();
}

// Runs `fn` with a fresh (or caller-supplied) requestId in context —
// used by server.js's tracing middleware to wrap an entire request, and
// by anything that starts its own async chain outside a request (a
// scheduled backup, the outbound-queue worker) that still wants its own
// logs correlated together.
function runWithRequestId(fn, requestId = newRequestId()) {
  return als.run({ requestId }, fn);
}

// Returns the current request's id, or undefined outside any tracked
// context (e.g. code running before the app finishes starting up) —
// callers must treat that as normal, not an error.
function getRequestId() {
  return als.getStore()?.requestId;
}

module.exports = { runWithRequestId, getRequestId, newRequestId };
