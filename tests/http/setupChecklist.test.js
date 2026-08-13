// Item 7 — GET/POST /api/dashboard/setup-checklist. Each item's "done" is
// computed from real state, so these tests prove the computation itself is
// correct (starts all-false except what a fresh signup already implies),
// not just that the route responds.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { freshApp, signupAndActivate } = require("./_setup");

async function adminSession(app, email, businessName) {
  return signupAndActivate(app, request, { businessName, email });
}

test("a brand new tenant's checklist starts not-dismissed with every item false", async () => {
  const app = await freshApp();
  const { cookie } = await adminSession(app, "fresh@example.com", "Fresh Checklist Biz");

  const resp = await request(app).get("/api/dashboard/setup-checklist").set("Cookie", cookie);
  assert.equal(resp.status, 200);
  assert.equal(resp.body.dismissed, false);
  assert.equal(resp.body.allDone, false);
  assert.equal(resp.body.items.length, 4);
  assert.ok(resp.body.items.every((i) => i.done === false));
});

test("editing a workflow flips 'customize-business' to done, and only for that tenant", async () => {
  const app = await freshApp();
  const tenantA = await adminSession(app, "custom-a@example.com", "Customize Tenant A");
  const tenantB = await adminSession(app, "custom-b@example.com", "Customize Tenant B");

  const before = await request(app).get("/api/dashboard/workflows").set("Cookie", tenantA.cookie);
  const edited = { ...before.body.hair, label: "My Real Salon Name" };
  await request(app).post("/api/dashboard/workflows").set("Cookie", tenantA.cookie).send(edited);

  const checklistA = await request(app).get("/api/dashboard/setup-checklist").set("Cookie", tenantA.cookie);
  assert.equal(checklistA.body.items.find((i) => i.id === "customize-business").done, true);

  const checklistB = await request(app).get("/api/dashboard/setup-checklist").set("Cookie", tenantB.cookie);
  assert.equal(checklistB.body.items.find((i) => i.id === "customize-business").done, false);
});

test("inviting a second team member flips 'invite-team' to done", async () => {
  const app = await freshApp();
  const { cookie } = await adminSession(app, "team@example.com", "Team Checklist Biz");

  const before = await request(app).get("/api/dashboard/setup-checklist").set("Cookie", cookie);
  assert.equal(before.body.items.find((i) => i.id === "invite-team").done, false);

  await request(app).post("/api/dashboard/users").set("Cookie", cookie).send({
    email: "provider1@example.com", password: "password123", role: "provider", workflowId: "hair", providerId: "p1",
  });

  const after = await request(app).get("/api/dashboard/setup-checklist").set("Cookie", cookie);
  assert.equal(after.body.items.find((i) => i.id === "invite-team").done, true);
});

test("a booking landing for the tenant flips 'first-booking' to done", async () => {
  const app = await freshApp();
  const { cookie, tenantId } = await adminSession(app, "booking@example.com", "Booking Checklist Biz");
  const bookingStore = require("../../src/store/bookingStore");

  const before = await request(app).get("/api/dashboard/setup-checklist").set("Cookie", cookie);
  assert.equal(before.body.items.find((i) => i.id === "first-booking").done, false);

  await bookingStore.create(tenantId, "919000009999", {
    bookingId: "APT-CHECKLIST-1", workflowId: "hair", providerId: "p1", providerName: "Test",
    visitDate: "2026-09-01", visitTime: "10:00 am", customerName: "Test", status: "booked", createdAt: Date.now(),
  });

  const after = await request(app).get("/api/dashboard/setup-checklist").set("Cookie", cookie);
  assert.equal(after.body.items.find((i) => i.id === "first-booking").done, true);
});

test("POST /api/dashboard/setup-checklist/dismiss persists dismissal for that tenant only", async () => {
  const app = await freshApp();
  const tenantA = await adminSession(app, "dismiss-a@example.com", "Dismiss Tenant A");
  const tenantB = await adminSession(app, "dismiss-b@example.com", "Dismiss Tenant B");

  const dismiss = await request(app).post("/api/dashboard/setup-checklist/dismiss").set("Cookie", tenantA.cookie);
  assert.equal(dismiss.status, 200);

  const afterA = await request(app).get("/api/dashboard/setup-checklist").set("Cookie", tenantA.cookie);
  assert.equal(afterA.body.dismissed, true);

  const afterB = await request(app).get("/api/dashboard/setup-checklist").set("Cookie", tenantB.cookie);
  assert.equal(afterB.body.dismissed, false);
});
