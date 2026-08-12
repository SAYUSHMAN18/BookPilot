const dashboardEvents = require("./dashboardEvents");

// Section 11 — every route that mutates a booking publishes through this
// one helper so the payload shape (always workflowId + providerId
// alongside the booking, whatever the event type) stays consistent for the
// dashboard's SSE route to filter a provider session's events from
// everyone else's. Shared across the webhook (payment confirmations) and
// the dashboard API (manual booking actions) — both need the identical shape.
function publishBookingEvent(tenantId, type, booking) {
  dashboardEvents.publish(tenantId, type, { workflowId: booking.workflowId, providerId: booking.providerId, booking });
}

module.exports = { publishBookingEvent };
