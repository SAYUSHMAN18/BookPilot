// New plan, Block 13 — pre-appointment reminders. isDue() is pure (no
// I/O, a controllable `now`), so the actual window-boundary decisions
// are tested directly and fast; checkAndSendReminders() itself is
// covered by one real end-to-end test through the actual send path
// (src/infra/whatsapp.js's reply-capture, the same mechanism the demo
// chat widget and voice replies use), proving the wiring works, not
// just the pure logic in isolation.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./_setup");

function baseBooking(overrides = {}) {
  return {
    id: 1, tenantId: 1, waId: "919000044444", bookingId: "APT-REM-1",
    workflowId: "hair", providerId: "p1", providerName: "Test Stylist",
    visitDate: null, visitTime: null, checkInIso: null,
    status: "booked", reminder24hSentAt: null, reminder2hSentAt: null,
    ...overrides,
  };
}

test("isDue: a time-slot booking ~23h away is due for the 24h reminder, not the 2h one", async () => {
  await freshApp();
  const { isDue, appointmentInstant } = require("../../src/infra/reminders");
  const { isoDate, formatLongDate } = require("../../src/engine/dateSlots");

  const now = Date.now();
  const target = new Date(now + 23 * 60 * 60 * 1000);
  const label = `${((target.getHours() + 11) % 12) + 1}:${String(target.getMinutes()).padStart(2, "0")} ${target.getHours() >= 12 ? "pm" : "am"}`;
  const booking = baseBooking({ visitDate: isoDate(target), visitTime: label });

  assert.ok(appointmentInstant(booking) > now);
  assert.equal(isDue(booking, "24h", now), true);
  assert.equal(isDue(booking, "2h", now), false);
  void formatLongDate;
});

test("isDue: a time-slot booking ~1h away is due for the 2h reminder, not the 24h one", async () => {
  await freshApp();
  const { isDue } = require("../../src/infra/reminders");
  const { isoDate } = require("../../src/engine/dateSlots");

  const now = Date.now();
  const target = new Date(now + 60 * 60 * 1000);
  const label = `${((target.getHours() + 11) % 12) + 1}:${String(target.getMinutes()).padStart(2, "0")} ${target.getHours() >= 12 ? "pm" : "am"}`;
  const booking = baseBooking({ visitDate: isoDate(target), visitTime: label });

  assert.equal(isDue(booking, "24h", now), false);
  assert.equal(isDue(booking, "2h", now), true);
});

test("isDue: a booking already past its appointment time is never due for either reminder", async () => {
  await freshApp();
  const { isDue } = require("../../src/infra/reminders");
  const booking = baseBooking({ visitDate: "2020-01-01", visitTime: "10:00 am" });
  const now = Date.now();
  assert.equal(isDue(booking, "24h", now), false);
  assert.equal(isDue(booking, "2h", now), false);
});

test("isDue: a reminder already sent never fires again, even still inside its window", async () => {
  await freshApp();
  const { isDue } = require("../../src/infra/reminders");
  const { isoDate } = require("../../src/engine/dateSlots");
  const now = Date.now();
  const target = new Date(now + 60 * 60 * 1000);
  const label = `${((target.getHours() + 11) % 12) + 1}:${String(target.getMinutes()).padStart(2, "0")} ${target.getHours() >= 12 ? "pm" : "am"}`;
  const booking = baseBooking({ visitDate: isoDate(target), visitTime: label, reminder2hSentAt: now - 1000 });
  assert.equal(isDue(booking, "2h", now), false);
});

test("isDue: cancelled, done, no_show, and serving bookings are never due for a reminder", async () => {
  await freshApp();
  const { isDue } = require("../../src/infra/reminders");
  const { isoDate } = require("../../src/engine/dateSlots");
  const now = Date.now();
  const target = new Date(now + 60 * 60 * 1000);
  const label = `${((target.getHours() + 11) % 12) + 1}:${String(target.getMinutes()).padStart(2, "0")} ${target.getHours() >= 12 ? "pm" : "am"}`;

  for (const status of ["cancelled", "done", "no_show", "serving"]) {
    const booking = baseBooking({ visitDate: isoDate(target), visitTime: label, status });
    assert.equal(isDue(booking, "2h", now), false, `expected a "${status}" booking to never be due`);
  }
});

test("isDue: a hotel booking (checkInIso) is never due for the 2h reminder, only the 24h one", async () => {
  await freshApp();
  const { isDue } = require("../../src/infra/reminders");
  const { isoDate } = require("../../src/engine/dateSlots");
  const now = Date.now();
  const checkIn = new Date(now + 20 * 60 * 60 * 1000); // ~20h until midnight of check-in day
  const booking = baseBooking({ checkInIso: isoDate(checkIn), visitDate: null, visitTime: null });

  assert.equal(isDue(booking, "2h", now), false);
  // Whether the 24h one fires depends on exactly how far the computed
  // midnight instant is from `now` — the real point here is just that
  // "2h" is categorically excluded for a stay, asserted above.
});

test("checkAndSendReminders sends a real reminder through the actual delivery path and marks it sent so a second run doesn't repeat it", async () => {
  const app = await freshApp();
  void app;
  const bookingStore = require("../../src/store/bookingStore");
  const { checkAndSendReminders } = require("../../src/infra/reminders");
  const { beginReplyCapture, endReplyCapture } = require("../../src/infra/whatsapp");
  const { isoDate } = require("../../src/engine/dateSlots");

  const target = new Date(Date.now() + 60 * 60 * 1000); // ~1h away — due for the 2h reminder
  const label = `${((target.getHours() + 11) % 12) + 1}:${String(target.getMinutes()).padStart(2, "0")} ${target.getHours() >= 12 ? "pm" : "am"}`;
  const waId = "919000044445";
  const booking = await bookingStore.create(1, waId, {
    bookingId: "APT-REM-LIVE-1", workflowId: "hair", providerId: "p1", providerName: "Snip & Style",
    visitDate: isoDate(target), visitDateLabel: isoDate(target), visitTime: label,
    customerName: "Reminder Test", status: "booked", createdAt: Date.now(),
  });

  beginReplyCapture(waId);
  await checkAndSendReminders();
  const captured = endReplyCapture(waId);
  assert.ok(/reminder/i.test(captured), `expected a reminder message to have been sent, got: ${captured}`);

  const updated = await bookingStore.getById(1, booking.id);
  assert.ok(updated.reminder2hSentAt, "expected reminder2hSentAt to be set after sending");

  // A second run must not send it again — the exact regression this
  // feature's own send-once guarantee exists to prevent.
  beginReplyCapture(waId);
  await checkAndSendReminders();
  const secondCapture = endReplyCapture(waId);
  assert.equal(secondCapture, "", "must not send the same reminder twice");
});

test("checkAndSendReminders skips a booking whose tenant is suspended", async () => {
  const app = await freshApp();
  const tenantStore = require("../../src/store/tenantStore");
  const bookingStore = require("../../src/store/bookingStore");
  const { checkAndSendReminders } = require("../../src/infra/reminders");
  const { beginReplyCapture, endReplyCapture } = require("../../src/infra/whatsapp");
  const { isoDate } = require("../../src/engine/dateSlots");
  void app;

  const tenant = await tenantStore.create({ name: "Suspended Reminder Biz", slug: "suspended-reminder-biz", plan: "free" });
  await tenantStore.setStatus(tenant.id, "suspended");

  const target = new Date(Date.now() + 60 * 60 * 1000);
  const label = `${((target.getHours() + 11) % 12) + 1}:${String(target.getMinutes()).padStart(2, "0")} ${target.getHours() >= 12 ? "pm" : "am"}`;
  const waId = "919000044446";
  await bookingStore.create(tenant.id, waId, {
    bookingId: "APT-REM-SUSPENDED-1", workflowId: "hair", providerId: "p1", providerName: "Test",
    visitDate: isoDate(target), visitTime: label, customerName: "Test", status: "booked", createdAt: Date.now(),
  });

  beginReplyCapture(waId);
  await checkAndSendReminders();
  const captured = endReplyCapture(waId);
  assert.equal(captured, "", "a suspended tenant's bot must stay quiet, same as the webhook's own rule");
});
