const { log } = require("./logger");

// Found live (black-box security pass): express.json()'s body-parser
// throws for malformed JSON and for bodies over the configured size limit
// (both server.js and marketingServer.js cap at 100kb) — those errors
// never reach a route handler, they land straight here. Before this, they
// fell through to the generic 500 branch below: a client sending broken
// JSON or an oversized body got "Internal server error" (and got logged
// at ERROR level, as if the SERVER had faulted) instead of the 400/413
// that actually describes whose mistake it was. Matched on `err.type`
// (body-parser's own precise signal — 'entity.parse.failed' /
// 'entity.too.large'), with `err.status`/`err.statusCode` as a fallback
// in case some other client-facing error sets those without `type`.
function finalErrorHandler(err, req, res, next) {
  const status = err.status || err.statusCode;
  if (err.type === "entity.too.large" || status === 413) {
    return res.status(413).json({ error: "Request body too large." });
  }
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({ error: "Malformed JSON body." });
  }

  // Final safety net — Express's own default error handler would otherwise
  // send an HTML page (and, outside NODE_ENV=production, a stack trace) for
  // any error a route handler didn't catch itself. This keeps every response
  // this API sends as JSON and never leaks internals to the client, while
  // the real detail still goes to the log.
  log("ERROR", `Unhandled error on ${req.method} ${req.path}: ${err.stack || err.message}`);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error." });
}

module.exports = { finalErrorHandler };
