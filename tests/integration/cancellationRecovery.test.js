// Enterprise Hardening Phase 2, item 2 — cancelling a booking suggests a
// nearby open slot for the same provider, reusing getAvailableSlots (the
// same slot computation the conversational select_time_slot step and the
// Public API's availability endpoint already use). Same handleIncomingMessage
// + reply-capture harness as feedbackLoop.test.js/expressRebook.test.js.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");

let bookings, handleIncomingMessage, workflows, beginReplyCapture, endReplyCapture;
const TENANT = 1;

function tomorrowIso() {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

before(async () => {
  process.env.SESSION_SECRET = "test-secret";
  delete process.env.GROQ_API_KEY;
  await createIsolatedTestDatabase();
  for (const mod of ["../../src/store/db", "../../src/store/bookingStore", "../../src/engine/workflowEngine", "../../src/engine/loadWorkflows", "../../src/infra/whatsapp"]) {
    delete require.cache[require.resolve(mod)];
  }
  bookings = require("../../src/store/bookingStore");
  ({ handleIncomingMessage } = require("../../src/engine/workflowEngine"));
  ({ beginReplyCapture, endReplyCapture } = require("../../src/infra/whatsapp"));
  const { loadWorkflows } = require("../../src/engine/loadWorkflows");
  workflows = loadWorkflows();
});

test("cancelling a booking with an otherwise-open provider suggests a nearby alternative slot", async () => {
  const waId = "919888833001";
  await bookings.create(TENANT, waId, {
    bookingId: "CANCEL-REC-1", workflowId: "hair", providerId: "p1", providerName: "HAIR COURT SALON",
    visitDate: tomorrowIso(), visitTime: "11:00 am", customerName: "Cancel Tester", status: "booked", createdAt: Date.now(),
  });

  await handleIncomingMessage(TENANT, waId, "cancel", workflows); // single active booking -> beginCancelFlow asks to confirm

  beginReplyCapture(waId);
  await handleIncomingMessage(TENANT, waId, "yes", workflows);
  const reply = endReplyCapture(waId);
  assert.match(reply, /cancelled/i);
  assert.match(reply, /P\.S\./, "should proactively suggest an alternative since the provider is otherwise wide open");
  assert.match(reply, /HAIR COURT SALON/);
});

test("cancelling the only booking for a hotel workflow (no select_time_slot step) never suggests a slot", async () => {
  const waId = "919888833002";
  await bookings.create(TENANT, waId, {
    bookingId: "CANCEL-REC-2", workflowId: "hotel", hotelId: "h1", hotelName: "Test Hotel", providerId: "h1", providerName: "Test Hotel",
    checkInIso: tomorrowIso(), nights: 2, customerName: "Cancel Tester", status: "booked", createdAt: Date.now(),
  });

  await handleIncomingMessage(TENANT, waId, "cancel", workflows);

  beginReplyCapture(waId);
  await handleIncomingMessage(TENANT, waId, "yes", workflows);
  const reply = endReplyCapture(waId);
  assert.match(reply, /cancelled/i);
  assert.doesNotMatch(reply, /P\.S\./, "a date-range hotel booking has no single slot to suggest");
});
