// Regression coverage for the new self-service "connect your own WhatsApp
// number" routes (src/routes/dashboard.js). The underlying infrastructure
// (tenantStore.setWhatsAppCredentials, webhook.js routing by
// phone_number_id) already existed and was platform-admin-only; these
// tests are for the new tenant-facing layer on top of it: plan gating,
// the "who owns this number already" collision check, and disconnect.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { freshApp, signupAndActivate } = require("./_setup");

async function adminSession(app, email) {
  return signupAndActivate(app, request, { businessName: "WA Number Test Biz", email });
}

test("a Starter tenant cannot connect their own number — plan-gated", async () => {
  const app = await freshApp();
  const { cookie } = await adminSession(app, "starter-wa@example.com");

  const status = await request(app).get("/api/dashboard/whatsapp-number/status").set("Cookie", cookie);
  assert.equal(status.status, 200);
  assert.equal(status.body.eligible, false, "a fresh (Starter/free) tenant should not be eligible");
  assert.equal(status.body.connected, false);

  const resp = await request(app).post("/api/dashboard/whatsapp-number/connect").set("Cookie", cookie).send({
    phoneNumberId: "109876543210987", accessToken: "test-token",
  });
  assert.equal(resp.status, 403);
  assert.match(resp.body.error, /Growth-plan/);
});

test("a Growth tenant can connect their own number, and it shows as connected", async () => {
  const app = await freshApp();
  const { cookie, tenantId } = await adminSession(app, "growth-wa@example.com");
  const tenantStore = require("../../src/store/tenantStore");
  await tenantStore.setPlan(tenantId, "growth");

  const connectResp = await request(app).post("/api/dashboard/whatsapp-number/connect").set("Cookie", cookie).send({
    phoneNumberId: "109876543210987", businessAccountId: "123456789012345", accessToken: "a-real-looking-token",
  });
  assert.equal(connectResp.status, 200, JSON.stringify(connectResp.body));
  assert.equal(connectResp.body.phoneNumberId, "109876543210987");

  const status = await request(app).get("/api/dashboard/whatsapp-number/status").set("Cookie", cookie);
  assert.equal(status.body.connected, true);
  assert.equal(status.body.phoneNumberId, "109876543210987");
  // The access token itself must never come back out through this route.
  assert.equal(JSON.stringify(status.body).includes("a-real-looking-token"), false);
});

test("connecting requires both phoneNumberId and accessToken", async () => {
  const app = await freshApp();
  const { cookie, tenantId } = await adminSession(app, "missing-fields-wa@example.com");
  const tenantStore = require("../../src/store/tenantStore");
  await tenantStore.setPlan(tenantId, "growth");

  const resp = await request(app).post("/api/dashboard/whatsapp-number/connect").set("Cookie", cookie).send({ phoneNumberId: "109876543210987" });
  assert.equal(resp.status, 400);
});

test("two different tenants cannot connect the same phoneNumberId — the second is rejected, not silently stolen", async () => {
  const app = await freshApp();
  const tenantStore = require("../../src/store/tenantStore");

  const first = await adminSession(app, "first-owner-wa@example.com");
  await tenantStore.setPlan(first.tenantId, "growth");
  const firstConnect = await request(app).post("/api/dashboard/whatsapp-number/connect").set("Cookie", first.cookie).send({
    phoneNumberId: "555000111222", accessToken: "first-token",
  });
  assert.equal(firstConnect.status, 200);

  const second = await adminSession(app, "second-claimant-wa@example.com");
  await tenantStore.setPlan(second.tenantId, "growth");
  const secondConnect = await request(app).post("/api/dashboard/whatsapp-number/connect").set("Cookie", second.cookie).send({
    phoneNumberId: "555000111222", accessToken: "second-token",
  });
  assert.equal(secondConnect.status, 409);
  assert.match(secondConnect.body.error, /already connected/i);

  // The first tenant's connection must be completely untouched by the
  // second tenant's rejected attempt.
  const firstStatus = await request(app).get("/api/dashboard/whatsapp-number/status").set("Cookie", first.cookie);
  assert.equal(firstStatus.body.phoneNumberId, "555000111222");
});

test("disconnect clears the number back to null, falling back to the shared platform number", async () => {
  const app = await freshApp();
  const { cookie, tenantId } = await adminSession(app, "disconnect-wa@example.com");
  const tenantStore = require("../../src/store/tenantStore");
  await tenantStore.setPlan(tenantId, "growth");

  await request(app).post("/api/dashboard/whatsapp-number/connect").set("Cookie", cookie).send({
    phoneNumberId: "109876543210987", accessToken: "a-token",
  });
  const disconnectResp = await request(app).post("/api/dashboard/whatsapp-number/disconnect").set("Cookie", cookie).send({});
  assert.equal(disconnectResp.status, 200);

  const status = await request(app).get("/api/dashboard/whatsapp-number/status").set("Cookie", cookie);
  assert.equal(status.body.connected, false);
  assert.equal(status.body.phoneNumberId, null);
});

test("disconnecting with nothing connected returns a clear 404, not a crash", async () => {
  const app = await freshApp();
  const { cookie, tenantId } = await adminSession(app, "nothing-to-disconnect-wa@example.com");
  const tenantStore = require("../../src/store/tenantStore");
  await tenantStore.setPlan(tenantId, "growth");

  const resp = await request(app).post("/api/dashboard/whatsapp-number/disconnect").set("Cookie", cookie).send({});
  assert.equal(resp.status, 404);
});
