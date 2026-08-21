// Section 4 — completing a booking with a note sends a real WhatsApp
// message, and a subsequent free-text reply from that customer is
// captured as feedback against the correct booking (the DoD's own
// wording), not misrouted into normal intent detection/business
// classification.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");

let bookings, feedback, handleIncomingMessage, workflows, beginReplyCapture, endReplyCapture;
const TENANT = 1; // the default tenant, created by db.js's own migration

before(async () => {
  process.env.SESSION_SECRET = "test-secret";
  process.env.GROQ_API_KEY = "test-key-not-real"; // present but any Groq call should never fire in this path
  await createIsolatedTestDatabase();
  for (const mod of ["../../src/store/db", "../../src/store/bookingStore", "../../src/store/feedbackStore", "../../src/engine/workflowEngine", "../../src/engine/loadWorkflows", "../../src/infra/whatsapp"]) {
    delete require.cache[require.resolve(mod)];
  }
  bookings = require("../../src/store/bookingStore");
  feedback = require("../../src/store/feedbackStore");
  ({ handleIncomingMessage } = require("../../src/engine/workflowEngine"));
  ({ beginReplyCapture, endReplyCapture } = require("../../src/infra/whatsapp"));
  const { loadWorkflows } = require("../../src/engine/loadWorkflows");
  workflows = loadWorkflows();
});

test("a booking marked done with feedback_requested_at set captures the customer's next reply as feedback", async () => {
  const waId = "919888800001";
  const booking = await bookings.create(TENANT, waId, {
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
  await bookings.updateWithMeta(TENANT, booking.id, { status: "done", feedbackRequestedAt: Date.now() });

  await handleIncomingMessage(TENANT, waId, "5 stars, great service!", workflows);

  const captured = await feedback.listForBooking(TENANT, booking.id);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].rating, 5);
  assert.equal(captured[0].comment, "5 stars, great service!");

  // One-shot: the flag is cleared, so a SECOND message from the same
  // customer must NOT also be captured as feedback (Section 4.5, "one
  // nudge, then drop it").
  const reloaded = await bookings.getById(TENANT, booking.id);
  assert.equal(reloaded.feedbackRequestedAt, null);
});

test("after feedback is captured once, a follow-up message is NOT captured again", async () => {
  const waId = "919888800002";
  const booking = await bookings.create(TENANT, waId, {
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
  await bookings.updateWithMeta(TENANT, booking.id, { status: "done", feedbackRequestedAt: Date.now() });

  await handleIncomingMessage(TENANT, waId, "it was okay", workflows);
  assert.equal((await feedback.listForBooking(TENANT, booking.id)).length, 1);

  // A second, unrelated message should NOT be captured as a second
  // feedback row — it should fall through to normal handling instead.
  await handleIncomingMessage(TENANT, waId, "actually one more thing", workflows);
  assert.equal((await feedback.listForBooking(TENANT, booking.id)).length, 1, "should still be exactly one feedback row, not two");
});

test("a customer with no completed booking awaiting feedback is unaffected — normal flow runs", async () => {
  const waId = "919888800003";
  // No booking at all for this waId — handleIncomingMessage must not
  // throw, and must not create a feedback row out of nowhere.
  await handleIncomingMessage(TENANT, waId, "hello", workflows);
  assert.equal((await feedback.listAll(TENANT)).filter((f) => f.waId === waId).length, 0);
});

test("parseRating handles common phrasings and rejects out-of-range/non-numeric text", async () => {
  // Exercised indirectly via feedback.create in the tests above for the
  // happy path; this locks down the edge cases directly.
  const waId = "919888800004";
  const booking = await bookings.create(TENANT, waId, {
    bookingId: "FB-TEST-4", workflowId: "medical", providerId: "p4", providerName: "Dr. Four",
    visitDate: "2020-01-01", visitTime: "9:00 am", customerName: "X", status: "done", createdAt: Date.now(),
  });
  assert.equal((await feedback.create(TENANT, booking.id, "medical", waId, "4/5, would recommend")).rating, 4);
  assert.equal((await feedback.create(TENANT, booking.id, "medical", waId, "no rating just words")).rating, null);
  assert.equal((await feedback.create(TENANT, booking.id, "medical", waId, "9 out of 5 amazing")).rating, null, "9 is out of the valid 1-5 range");
});

// Enterprise Hardening Phase 2, item 3 — a genuinely positive rating (4-5)
// nudges the customer toward a public review, when the workflow has one
// configured; a middling/low rating never does, and no reviewLink means
// no nudge either way.
test("reviewLink: a 5-star rating with reviewLink configured gets the review nudge appended", async () => {
  const waId = "919888800005";
  const booking = await bookings.create(TENANT, waId, {
    bookingId: "FB-TEST-5", workflowId: "medical", providerId: "p5", providerName: "Dr. Five",
    visitDate: "2020-01-01", visitTime: "9:00 am", customerName: "X", status: "done", createdAt: Date.now(),
  });
  await bookings.updateWithMeta(TENANT, booking.id, { status: "done", feedbackRequestedAt: Date.now() });

  const priorReviewLink = workflows.medical.reviewLink;
  workflows.medical.reviewLink = "https://g.page/r/test-review-link";
  try {
    beginReplyCapture(waId);
    await handleIncomingMessage(TENANT, waId, "5", workflows);
    const reply = endReplyCapture(waId);
    assert.match(reply, /Thank you for your 5\/5 rating/);
    assert.match(reply, /https:\/\/g\.page\/r\/test-review-link/);
  } finally {
    workflows.medical.reviewLink = priorReviewLink;
  }
});

test("reviewLink: a 3-star rating never gets the review nudge, even with reviewLink configured", async () => {
  const waId = "919888800006";
  const booking = await bookings.create(TENANT, waId, {
    bookingId: "FB-TEST-6", workflowId: "medical", providerId: "p6", providerName: "Dr. Six",
    visitDate: "2020-01-01", visitTime: "9:00 am", customerName: "X", status: "done", createdAt: Date.now(),
  });
  await bookings.updateWithMeta(TENANT, booking.id, { status: "done", feedbackRequestedAt: Date.now() });

  const priorReviewLink = workflows.medical.reviewLink;
  workflows.medical.reviewLink = "https://g.page/r/test-review-link";
  try {
    beginReplyCapture(waId);
    await handleIncomingMessage(TENANT, waId, "3", workflows);
    const reply = endReplyCapture(waId);
    assert.match(reply, /Thank you for your 3\/5 rating/);
    assert.doesNotMatch(reply, /g\.page/, "a middling rating should never be asked for a public review");
  } finally {
    workflows.medical.reviewLink = priorReviewLink;
  }
});

test("reviewLink: no nudge at all when the workflow has no reviewLink configured", async () => {
  const waId = "919888800007";
  const booking = await bookings.create(TENANT, waId, {
    bookingId: "FB-TEST-7", workflowId: "medical", providerId: "p7", providerName: "Dr. Seven",
    visitDate: "2020-01-01", visitTime: "9:00 am", customerName: "X", status: "done", createdAt: Date.now(),
  });
  await bookings.updateWithMeta(TENANT, booking.id, { status: "done", feedbackRequestedAt: Date.now() });

  assert.equal(workflows.medical.reviewLink, undefined, "sanity check — no reviewLink configured by default");
  beginReplyCapture(waId);
  await handleIncomingMessage(TENANT, waId, "5", workflows);
  const reply = endReplyCapture(waId);
  assert.match(reply, /Thank you for your 5\/5 rating! 🙏$/, "reply should end right after the rating line, no trailing nudge text");
});
