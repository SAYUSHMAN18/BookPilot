const { log } = require("../infra/logger");
const { calendarConnections, calendarEventLinks } = require("../store/calendarStore");
const google = require("../infra/calendarProviders/googleCalendarProvider");
const { labelToMinutes } = require("./dateSlots");

// Section 10 — push-only sync: a booking on BookPilot creates/updates/
// deletes an event on the provider's own Google Calendar, so a doctor who
// actually lives in their calendar app sees appointments there without
// re-entering them. Deliberately NOT two-way: pulling events the other
// direction (something the provider adds directly in Google Calendar
// blocking a BookPilot slot) is a materially different feature — a
// polling or push-notification listener, plus reconciling external
// events back into `blocked_slots` — and isn't implemented here. Flagged
// as a known, deliberate gap rather than silently half-built.
//
// Scope: time-slot bookings only (workflow steps with a `visitTime`) —
// same boundary Section 3's queue position and Section 4's no-show
// estimate already draw. A hotel stay's date-RANGE has no clean single
// "event" shape here yet (all-day multi-day event vs. two datetime
// events for check-in/check-out are both defensible choices that need an
// actual product decision, not a default guessed by this pass).
//
// Every function here is fire-and-forget from the caller's perspective —
// same "the booking succeeds regardless of what a downstream integration
// does" posture as Section 9's payment-link creation. A calendar sync
// failure is logged loudly, never thrown back into the booking flow.

const IST_OFFSET = "+05:30"; // this project is India-only, matching every other IST-fixed date/time helper (formatIST, etc.)

function eventWindow(booking, workflow) {
  const minutes = labelToMinutes(booking.visitTime);
  if (minutes === null || !booking.visitDate) return null;
  const slotMinutes = workflow?.slotMinutes || 30;
  const startIso = `${booking.visitDate}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00${IST_OFFSET}`;
  const endMinutes = minutes + slotMinutes;
  const endIso = `${booking.visitDate}T${String(Math.floor(endMinutes / 60) % 24).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}:00${IST_OFFSET}`;
  return { startIso, endIso };
}

// Any access token less than 2 minutes from expiry is treated as already
// expired — avoids a real request landing right on the boundary and
// getting a 401 mid-flight instead of refreshing proactively.
const EXPIRY_SAFETY_MARGIN_MS = 2 * 60 * 1000;

async function getValidAccessToken(connection) {
  const stillValid = connection.accessToken && connection.accessTokenExpiresAt && connection.accessTokenExpiresAt - Date.now() > EXPIRY_SAFETY_MARGIN_MS;
  if (stillValid) return connection.accessToken;

  try {
    const { accessToken, expiresAt } = await google.refreshAccessToken(connection.refreshToken);
    calendarConnections.updateTokens(connection.id, { accessToken, accessTokenExpiresAt: expiresAt });
    return accessToken;
  } catch (err) {
    if (err.isInvalidGrant) {
      calendarConnections.markNeedsReconnect(connection.id);
      log("WARN", `Calendar connection ${connection.id} needs reconnecting — refresh token was rejected (revoked or expired).`);
    }
    throw err;
  }
}

function eventSummaryFor(booking, workflow) {
  return `${workflow?.label || "Appointment"}: ${booking.customerName || "Customer"}`;
}

function eventDescriptionFor(booking) {
  const lines = [`BookPilot booking ${booking.bookingId}`];
  if (booking.reason) lines.push(`Reason: ${booking.reason}`);
  if (booking.waId) lines.push(`Customer WhatsApp: ${booking.waId}`);
  return lines.join("\n");
}

async function syncBookingCreated(tenantId, booking, workflow) {
  if (!booking.visitTime) return; // hotel stay — out of scope, see file header
  const connection = calendarConnections.getForProvider(tenantId, booking.workflowId, booking.providerId);
  if (!connection || connection.status !== "connected") return;

  const window = eventWindow(booking, workflow);
  if (!window) return;

  try {
    const accessToken = await getValidAccessToken(connection);
    const { externalEventId } = await google.createEvent(accessToken, {
      calendarId: connection.externalCalendarId || "primary",
      summary: eventSummaryFor(booking, workflow),
      description: eventDescriptionFor(booking),
      ...window,
    });
    calendarEventLinks.upsert(booking.id, connection.id, externalEventId);
  } catch (err) {
    log("ERROR", `Calendar sync (create) failed for booking ${booking.bookingId}: ${err.message}`);
  }
}

async function syncBookingRescheduled(tenantId, booking, workflow) {
  if (!booking.visitTime) return;
  const connection = calendarConnections.getForProvider(tenantId, booking.workflowId, booking.providerId);
  if (!connection || connection.status !== "connected") return;

  const link = calendarEventLinks.get(booking.id, connection.id);
  if (!link) {
    // No existing event (connected after the booking was made, or the
    // original create sync failed) — treat a reschedule as a fresh create
    // rather than silently doing nothing.
    return syncBookingCreated(tenantId, booking, workflow);
  }

  const window = eventWindow(booking, workflow);
  if (!window) return;

  try {
    const accessToken = await getValidAccessToken(connection);
    await google.updateEvent(accessToken, {
      calendarId: connection.externalCalendarId || "primary",
      externalEventId: link.externalEventId,
      summary: eventSummaryFor(booking, workflow),
      description: eventDescriptionFor(booking),
      ...window,
    });
  } catch (err) {
    log("ERROR", `Calendar sync (reschedule) failed for booking ${booking.bookingId}: ${err.message}`);
  }
}

async function syncBookingCancelled(tenantId, booking) {
  if (!booking.visitTime) return;
  const connection = calendarConnections.getForProvider(tenantId, booking.workflowId, booking.providerId);
  if (!connection || connection.status !== "connected") return;

  const link = calendarEventLinks.get(booking.id, connection.id);
  if (!link) return; // nothing was ever synced — nothing to remove

  try {
    const accessToken = await getValidAccessToken(connection);
    await google.deleteEvent(accessToken, { calendarId: connection.externalCalendarId || "primary", externalEventId: link.externalEventId });
    calendarEventLinks.delete(booking.id, connection.id);
  } catch (err) {
    log("ERROR", `Calendar sync (cancel) failed for booking ${booking.bookingId}: ${err.message}`);
  }
}

module.exports = { syncBookingCreated, syncBookingRescheduled, syncBookingCancelled, eventWindow, getValidAccessToken };
