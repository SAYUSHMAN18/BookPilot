// Item 9 — business-hours awareness. Before this, "Today" always appeared
// as a tappable date option regardless of whether any time slots were
// actually left in it — blocking out all of today's business hours (or
// simply messaging after closing time) still offered "Today", only to be
// told "No more slots available" one step later after tapping it. This
// drives a real conversation and inspects the actual WhatsApp list content
// via the same reply-capture mechanism server.js itself uses for voice
// replies (src/infra/whatsapp.js), since that's the only way to see
// exactly what was offered — /api/simulate-whatsapp itself only confirms
// "processed", not the content sent.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { freshApp } = require("./_setup");

async function adminSession(app, email, businessName) {
  const resp = await request(app).post("/api/signup").send({ businessName, email, password: "password123" });
  return { cookie: resp.headers["set-cookie"], tenantId: resp.body.user.tenantId };
}

test('"Today" is excluded from the date list once all of today\'s business hours are blocked', async () => {
  const app = freshApp();
  const { cookie, tenantId } = await adminSession(app, "hours@example.com", "Business Hours Biz");
  const { beginReplyCapture, endReplyCapture } = require("../../src/infra/whatsapp");

  const today = new Date().toISOString().slice(0, 10);
  const block = await request(app).post("/api/dashboard/availability").set("Cookie", cookie).send({
    workflowId: "hair", providerId: "p1", date: today, time: "10:00", endTime: "20:00",
  });
  assert.equal(block.status, 201);

  const waId = "919000022222";
  beginReplyCapture(waId);
  await request(app).post("/api/simulate-whatsapp").send({ from: waId, text: "I need a haircut", tenantId });
  await request(app).post("/api/simulate-whatsapp").send({ from: waId, text: "p1", tenantId });
  const captured = endReplyCapture(waId);

  assert.ok(!/\btoday\b/i.test(captured), `expected "Today" to be excluded from the date list once fully blocked, got: ${captured}`);
  assert.ok(/tomorrow/i.test(captured), `expected "Tomorrow" to still be offered, got: ${captured}`);
});

test('a hotel workflow\'s check-in date list is unaffected by time-slot logic — "Today" still offered', async () => {
  const app = freshApp();
  const { beginReplyCapture, endReplyCapture } = require("../../src/infra/whatsapp");

  // A hotel's checkInDate field has no matching select_time_slot step
  // (nights are picked separately, dateStepUsesTimeSlots() correctly says
  // false) — so even though "today" has no more TIME slots in any
  // time-slot workflow's business hours, that concept doesn't apply here
  // at all, and "Today" must still be offered as a valid check-in date.
  const waId = "919000022223";
  beginReplyCapture(waId);
  await request(app).post("/api/simulate-whatsapp").send({ from: waId, text: "I need a hotel room", tenantId: 1 });
  await request(app).post("/api/simulate-whatsapp").send({ from: waId, text: "h1", tenantId: 1 });
  await request(app).post("/api/simulate-whatsapp").send({ from: waId, text: "h1-r1", tenantId: 1 });
  const captured = endReplyCapture(waId);

  assert.ok(/today/i.test(captured), `expected "Today" to still be a valid check-in date option, got: ${captured}`);
});
