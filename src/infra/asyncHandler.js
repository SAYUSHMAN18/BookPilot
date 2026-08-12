// Express 4 (what this project uses) has no built-in awareness of
// async/await — a rejected promise inside an `async (req, res) => {...}`
// handler does NOT reach the error-handling middleware the way a
// synchronous throw does; it becomes an unhandled rejection instead, and
// the client is left waiting on a response that will never come. Found
// live: a ReferenceError inside the bookings PATCH route hung a curl call
// for the full 2-minute timeout with nothing ever sent back. Every async
// route handler across every router in this app needs this wrapper (or
// its own complete try/catch) or it's vulnerable to the exact same silent
// hang — shared here so every route file uses the identical one.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { asyncHandler };
