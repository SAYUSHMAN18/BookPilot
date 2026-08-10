const { EventEmitter } = require("events");

// Section 11 — the in-process pub/sub backing the dashboard's live-update
// stream (server.js's GET /api/dashboard/events, Server-Sent Events). One
// process-wide EventEmitter, not a per-tenant one — a single install
// serves every tenant from this one Node process (Section 8), and
// filtering by tenantId happens at the SSE route's subscription callback,
// not by maintaining N separate emitters. No external broker (Redis
// pub/sub, etc.) — same "no heavy deps unless the plan calls for it"
// stance as everywhere else in this codebase; revisit if this ever runs
// as more than one process.
//
// A publish() call is fire-and-forget infrastructure, same posture as
// Section 9/10's payment/calendar side effects: a dashboard tab that
// isn't open to receive an event is not an error, and publish() itself
// never throws (EventEmitter.emit() only throws if the SPECIFIC event
// name is "error" with no listener, which this module never emits).
const bus = new EventEmitter();
bus.setMaxListeners(0); // unbounded — one listener per open dashboard SSE connection, not a fixed pool

// payload should be JSON-serializable and never include a raw secret
// (token, password hash, etc.) — it's written directly into an SSE frame
// sent to a browser tab.
function publish(tenantId, type, payload) {
  bus.emit("dashboard-event", { tenantId, type, payload, at: Date.now() });
}

// Registers a listener for every dashboard event across all tenants; the
// caller (the SSE route) is responsible for filtering to its own
// tenantId/workflowId/providerId before forwarding to the browser — this
// module has no concept of "who's allowed to see what," same separation
// as every other store/infra module leaving authorization to server.js.
function subscribe(listener) {
  bus.on("dashboard-event", listener);
  return () => bus.off("dashboard-event", listener);
}

module.exports = { publish, subscribe };
