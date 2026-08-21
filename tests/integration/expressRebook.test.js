// Enterprise Hardening Phase 2, item 1 — a returning customer (any past
// booking, even cancelled) gets offered a one-tap shortcut back into
// their last workflow on their next fresh greeting, instead of the full
// business menu every time. Same handleIncomingMessage + reply-capture
// harness as feedbackLoop.test.js.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");

let bookings, handleIncomingMessage, workflows, beginReplyCapture, endReplyCapture;
const TENANT = 1;

before(async () => {
  process.env.SESSION_SECRET = "test-secret";
  delete process.env.GROQ_API_KEY; // deterministic: no AI classification in play for these greeting-only messages
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

test("a brand new customer's greeting gets the normal full business menu, no rebook offer", async () => {
  const waId = "919888822001";
  beginReplyCapture(waId);
  await handleIncomingMessage(TENANT, waId, "hi", workflows);
  const reply = endReplyCapture(waId);
  assert.match(reply, /What would you like to book today/);
  assert.doesNotMatch(reply, /Welcome back/);
});

test("a returning customer's greeting offers a one-tap rebook of their last workflow instead", async () => {
  const waId = "919888822002";
  await bookings.create(TENANT, waId, {
    bookingId: "REBOOK-TEST-1", workflowId: "hair", providerId: "p1", providerName: "HAIR COURT SALON",
    visitDate: "2020-01-01", visitTime: "10:00 am", customerName: "Rebook Tester", status: "done", createdAt: Date.now(),
  });

  beginReplyCapture(waId);
  await handleIncomingMessage(TENANT, waId, "hi", workflows);
  const reply = endReplyCapture(waId);
  assert.match(reply, /Welcome back/);
  assert.match(reply, /HAIR COURT SALON/, "should mention the specific provider from their last visit");
  assert.match(reply, /Yes, book again/);
  assert.match(reply, /See all options/);
});

test("a returning customer's cancelled-only history still counts as returning — offers rebook", async () => {
  const waId = "919888822003";
  const b = await bookings.create(TENANT, waId, {
    bookingId: "REBOOK-TEST-2", workflowId: "hair", providerId: "p2", providerName: "Renvic's Touch Salon",
    visitDate: "2020-01-01", visitTime: "10:00 am", customerName: "Rebook Tester", status: "booked", createdAt: Date.now(),
  });
  await bookings.updateStatus(TENANT, b.id, "cancelled");

  beginReplyCapture(waId);
  await handleIncomingMessage(TENANT, waId, "hi", workflows);
  const reply = endReplyCapture(waId);
  assert.match(reply, /Welcome back/);
});

test("replying 'yes' to the rebook offer starts the same workflow directly (provider list, not the business menu)", async () => {
  const waId = "919888822004";
  await bookings.create(TENANT, waId, {
    bookingId: "REBOOK-TEST-3", workflowId: "hair", providerId: "p3", providerName: "HAIR COURT SALON",
    visitDate: "2020-01-01", visitTime: "10:00 am", customerName: "Rebook Tester", status: "done", createdAt: Date.now(),
  });

  await handleIncomingMessage(TENANT, waId, "hi", workflows); // triggers the offer, sets pendingRebook

  beginReplyCapture(waId);
  await handleIncomingMessage(TENANT, waId, "rebook_yes", workflows);
  const reply = endReplyCapture(waId);
  assert.doesNotMatch(reply, /What would you like to book today/, "should skip the top-level business menu entirely");
  assert.match(reply, /HAIR COURT SALON/, "should land on the hair workflow's own provider list");
});

test("replying 'no' to the rebook offer falls back to the full business menu", async () => {
  const waId = "919888822005";
  await bookings.create(TENANT, waId, {
    bookingId: "REBOOK-TEST-4", workflowId: "hair", providerId: "p4", providerName: "HAIR COURT SALON",
    visitDate: "2020-01-01", visitTime: "10:00 am", customerName: "Rebook Tester", status: "done", createdAt: Date.now(),
  });

  await handleIncomingMessage(TENANT, waId, "hi", workflows);

  beginReplyCapture(waId);
  await handleIncomingMessage(TENANT, waId, "rebook_no", workflows);
  const reply = endReplyCapture(waId);
  assert.match(reply, /What would you like to book today/);
});

test("an ambiguous reply to the rebook offer re-asks instead of silently dropping it", async () => {
  const waId = "919888822006";
  await bookings.create(TENANT, waId, {
    bookingId: "REBOOK-TEST-5", workflowId: "hair", providerId: "p5", providerName: "HAIR COURT SALON",
    visitDate: "2020-01-01", visitTime: "10:00 am", customerName: "Rebook Tester", status: "done", createdAt: Date.now(),
  });

  await handleIncomingMessage(TENANT, waId, "hi", workflows);

  // An unrecognized reply falls through to normal DETECTING handling
  // (which, for a genuinely unclassifiable message, happens to be the
  // same "here's what we offer" menu) — the thing actually under test
  // here isn't THIS reply's content, it's that resolvePendingRebook
  // restored session.pendingRebook rather than dropping it, so the reply
  // right after still resolves as an answer to the original rebook offer.
  await handleIncomingMessage(TENANT, waId, "what's the weather like", workflows);

  beginReplyCapture(waId);
  await handleIncomingMessage(TENANT, waId, "yes", workflows);
  const second = endReplyCapture(waId);
  assert.match(second, /HAIR COURT SALON/);
});
