const { log } = require("./logger");
const { sendWithRetry } = require("./whatsapp");
const bookings = require("../store/bookingStore");
const tenantStore = require("../store/tenantStore");
const { isTerminal } = require("../engine/bookingStateMachine");
const { parseIsoDate, labelToMinutes } = require("../engine/dateSlots");

// New plan, Block 13 — pre-appointment reminders. Reuses the existing
// delivery machinery end to end rather than building a second one:
// sendWithRetry() (a couple of immediate attempts, then the durable
// outboundQueueStore) is already this codebase's one real "delivery
// state machine" (Section 3.6/the queue-position "you're next" alerts
// use the exact same function) — a reminder that fails to send
// immediately gets the identical retry/queue treatment, not a bespoke
// one just for this feature.
//
// Two independent thresholds, not a single "send if within 24h" check:
// a booking made 90 minutes before its slot should still get the 2h
// reminder (it was never eligible for the 24h one — that window already
// passed by the time it was created) and a booking that already got its
// 24h reminder must still get the separate 2h one later. Each fires
// once a booking crosses INTO its window and hasn't been sent that
// specific reminder yet (bookingStore.markReminderSent) — not an exact
// instant, since this only runs periodically (scheduleReminders below).
const WINDOW_24H_MS = 24 * 60 * 60 * 1000;
const WINDOW_2H_MS = 2 * 60 * 60 * 1000;

// A time-slot booking's exact appointment instant (visitDate + visitTime
// combined) — the same 12h-label parsing dateSlots.js's own slot
// generator already uses, so a reminder always agrees with what the
// customer was actually offered and confirmed.
function appointmentInstant(booking) {
  if (booking.checkInIso) {
    return parseIsoDate(booking.checkInIso).getTime(); // hotel stays: start of check-in day
  }
  if (!booking.visitDate || !booking.visitTime) return null; // nothing to remind about
  const minutes = labelToMinutes(booking.visitTime);
  if (minutes === null) return null;
  return parseIsoDate(booking.visitDate).getTime() + minutes * 60 * 1000;
}

function reminderMessage(booking, which) {
  const whenLabel = booking.checkInIso
    ? `your check-in on ${booking.visitDateLabel || booking.checkInIso}`
    : `your ${booking.visitTime} appointment${booking.providerName ? ` with ${booking.providerName}` : ""}`;

  if (which === "24h") {
    return `⏰ Reminder: ${whenLabel} is coming up tomorrow. Reply STATUS for details, or CANCEL if your plans changed.`;
  }

  const instant = appointmentInstant(booking);
  const remainingMs = Math.max(0, instant - Date.now());
  const remainingMinutes = Math.max(1, Math.round(remainingMs / 60000));

  let lead;

  if (remainingMinutes < 60) {
    lead = `in about ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}`;
  } else {
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;

    if (minutes === 0) {
      lead = `in about ${hours} hour${hours === 1 ? "" : "s"}`;
    } else {
      lead = `in about ${hours} hour${hours === 1 ? "" : "s"} ${minutes} minute${minutes === 1 ? "" : "s"}`;
    }
  }

  return `⏰ Reminder: ${whenLabel} is ${lead}. Reply STATUS for details, or CANCEL if your plans changed.`;
}

// Exported for tests — the pure "is this booking due for this reminder
// right now" decision, with no I/O, so the actual window-boundary logic
// can be tested directly instead of only through a real send.
function isDue(booking, which, now = Date.now()) {
  if (isTerminal(booking.status) || booking.status === "serving") return false;
  // A hotel stay's "appointment instant" is midnight of check-in day (see
  // appointmentInstant below) — a "2h" reminder against that would read
  // as a confusing, wrong-shaped notice for a stay rather than a slot,
  // so hotel bookings only ever get the 24h ("tomorrow") reminder.
  if (booking.checkInIso && which === "2h") return false;
  const instant = appointmentInstant(booking);
  if (instant === null || instant <= now) return false; // no time info, or already past
  const alreadySent = which === "24h" ? booking.reminder24hSentAt : booking.reminder2hSentAt;
  if (alreadySent) return false;
  const msUntil = instant - now;
  if (which === "24h") return msUntil <= WINDOW_24H_MS && msUntil > WINDOW_2H_MS;
  return msUntil <= WINDOW_2H_MS;
}

async function checkAndSendReminders() {
  const now = Date.now();
  const allBookings = await bookings.valuesAllTenants();
  for (const booking of allBookings) {
    for (const which of ["24h", "2h"]) {
      if (!isDue(booking, which, now)) continue;

      const tenant = await tenantStore.getById(booking.tenantId);
      if (!tenant || tenant.status !== "active") continue; // Section 8.6 — a suspended/cancelled tenant's bot stays quiet, same rule the webhook itself already enforces

      await bookings.markReminderSent(booking.tenantId, booking.id, which); // mark first — never re-attempt-storm the same reminder if the send itself throws
      const sent = await sendWithRetry(booking.tenantId, booking.waId, reminderMessage(booking, which));
      if (!sent) log("WARN", `${which} reminder for booking ${booking.bookingId} queued for durable retry after immediate attempts failed.`);
    }
  }
}

let scheduledTimer = null;
// .unref()'d, same as scheduleBackups()/startOutboundQueueWorker() —
// this timer alone must never keep the Node process alive (relevant for
// a clean `node server.js` shutdown, and for any script that requires
// server.js without wanting to hang).
function scheduleReminders(intervalMs = 10 * 60 * 1000) {
  if (scheduledTimer) return;
  scheduledTimer = setInterval(() => {
    checkAndSendReminders().catch((err) => log("ERROR", `Reminder check failed: ${err.stack || err.message}`));
  }, intervalMs);
  scheduledTimer.unref?.();
}

module.exports = { checkAndSendReminders, scheduleReminders, isDue, appointmentInstant };
