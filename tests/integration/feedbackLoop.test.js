// Section 4 — completing a booking with a note sends a real WhatsApp
// message, and a subsequent free-text reply from that customer is
// captured as feedback against the correct booking (the DoD's own
// wording), not misrouted into normal intent detection/business
// classification.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bookpilot-feedback-test-"));
process.env.SESSION_SECRET = "test-secret";
process.env.GROQ_API_KEY = "test-key-not-real"; // present but any Groq call should never fire in this path
for (const mod of ["../../src/store/db", "../../src/store/bookingStore", "../../src/store/feedbackStore", "../../src/engine/workflowEngine", "../../src/engine/loadWorkflows"]) {
  delete require.cache[require.resolve(mod)];
}
const bookings = require("../../src/store/bookingStore");
const feedback = require("../../src/store/feedbackStore");
const { handleIncomingMessage } = require("../../src/engine/workflowEngine");
const { loadWorkflows } = require("../../src/engine/loadWorkflows");
const workflows = loadWorkflows();
const TENANT = 1; // the default tenant, created by db.js's own migration

test("a booking marked done with feedback_requested_at set captures the customer's next reply as feedback", async () => {
  const waId = "919888800001";
  const booking = bookings.create(TENANT, waId, {
    bookingId: "FB-TEST-1",
    workflowId: "medical",
    providerId: "p1",
    providerName: "Dr. Test",
    visitDate: "2020-01-01", // safely in the past, irrelevant to this path
    visitTime: "10:00 am",
    customerName: "Feedback Tester",
    status: "done",
    createdAt: Date.now(),
  });
  // Simulates what server.js's "complete" action does: mark done +
  // request feedback in one update.
  bookings.updateWithMeta(TENANT, booking.id, { status: "done", feedbackRequestedAt: Date.now() });

  await handleIncomingMessage(TENANT, waId, "5 stars, great service!", workflows);

  const captured = feedback.listForBooking(TENANT, booking.id);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].rating, 5);
  assert.equal(captured[0].comment, "5 stars, great service!");

  // One-shot: the flag is cleared, so a SECOND message from the same
  // customer must NOT also be captured as feedback (Section 4.5, "one
  // nudge, then drop it").
  const reloaded = bookings.getById(TENANT, booking.id);
  assert.equal(reloaded.feedbackRequestedAt, null);
});

test("after feedback is captured once, a follow-up message is NOT captured again", async () => {
  const waId = "919888800002";
  const booking = bookings.create(TENANT, waId, {
    bookingId: "FB-TEST-2",
    workflowId: "medical",
    providerId: "p2",
    providerName: "Dr. Test Two",
    visitDate: "2020-01-01",
    visitTime: "11:00 am",
    customerName: "Feedback Tester Two",
    status: "done",
    createdAt: Date.now(),
  });
  bookings.updateWithMeta(TENANT, booking.id, { status: "done", feedbackRequestedAt: Date.now() });

  await handleIncomingMessage(TENANT, waId, "it was okay", workflows);
  assert.equal(feedback.listForBooking(TENANT, booking.id).length, 1);

  // A second, unrelated message should NOT be captured as a second
  // feedback row — it should fall through to normal handling instead.
  await handleIncomingMessage(TENANT, waId, "actually one more thing", workflows);
  assert.equal(feedback.listForBooking(TENANT, booking.id).length, 1, "should still be exactly one feedback row, not two");
});

test("a customer with no completed booking awaiting feedback is unaffected — normal flow runs", async () => {
  const waId = "919888800003";
  // No booking at all for this waId — handleIncomingMessage must not
  // throw, and must not create a feedback row out of nowhere.
  await handleIncomingMessage(TENANT, waId, "hello", workflows);
  assert.equal(feedback.listAll(TENANT).filter((f) => f.waId === waId).length, 0);
});

test("parseRating handles common phrasings and rejects out-of-range/non-numeric text", () => {
  // Exercised indirectly via feedback.create in the tests above for the
  // happy path; this locks down the edge cases directly.
  const waId = "919888800004";
  const booking = bookings.create(TENANT, waId, {
    bookingId: "FB-TEST-4", workflowId: "medical", providerId: "p4", providerName: "Dr. Four",
    visitDate: "2020-01-01", visitTime: "9:00 am", customerName: "X", status: "done", createdAt: Date.now(),
  });
  assert.equal(feedback.create(TENANT, booking.id, "medical", waId, "4/5, would recommend").rating, 4);
  assert.equal(feedback.create(TENANT, booking.id, "medical", waId, "no rating just words").rating, null);
  assert.equal(feedback.create(TENANT, booking.id, "medical", waId, "9 out of 5 amazing").rating, null, "9 is out of the valid 1-5 range");
});
