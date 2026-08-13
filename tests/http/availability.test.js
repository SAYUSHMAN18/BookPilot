// Item 2 — HTTP-level availability CRUD: blocking/unblocking provider
// slots through the real routes, including the role-scoping rule (a
// provider session can only touch their own availability, even by id).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { freshApp, signupAndActivate } = require("./_setup");

async function adminSession(app, email = "avail-admin@example.com") {
  return signupAndActivate(app, request, { businessName: "Availability HTTP Test Biz", email });
}

test("GET availability is empty for a fresh provider, then reflects a POSTed block", async () => {
  const app = await freshApp();
  const { cookie } = await adminSession(app);

  const empty = await request(app).get("/api/dashboard/availability?workflowId=hair&providerId=p1").set("Cookie", cookie);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, []);

  const created = await request(app)
    .post("/api/dashboard/availability")
    .set("Cookie", cookie)
    .send({ workflowId: "hair", providerId: "p1", date: "2026-09-01", time: "10:00 am", reason: "Out sick" });
  assert.equal(created.status, 201);

  const after = await request(app).get("/api/dashboard/availability?workflowId=hair&providerId=p1").set("Cookie", cookie);
  assert.equal(after.status, 200);
  assert.equal(after.body.length, 1);
  assert.equal(after.body[0].reason, "Out sick");
});

test("POST availability validates date format and rejects an unknown workflowId", async () => {
  const app = await freshApp();
  const { cookie } = await adminSession(app);

  const badDate = await request(app).post("/api/dashboard/availability").set("Cookie", cookie).send({ workflowId: "hair", providerId: "p1", date: "not-a-date" });
  assert.equal(badDate.status, 400);

  const badWorkflow = await request(app).post("/api/dashboard/availability").set("Cookie", cookie).send({ workflowId: "not-a-real-workflow", providerId: "p1", date: "2026-09-01" });
  assert.equal(badWorkflow.status, 400);
});

test("DELETE availability removes the block, and a second delete 404s", async () => {
  const app = await freshApp();
  const { cookie } = await adminSession(app);
  const created = await request(app)
    .post("/api/dashboard/availability")
    .set("Cookie", cookie)
    .send({ workflowId: "hair", providerId: "p1", date: "2026-09-05" });
  const list = await request(app).get("/api/dashboard/availability?workflowId=hair&providerId=p1").set("Cookie", cookie);
  const id = list.body[0].id;

  const del = await request(app).delete(`/api/dashboard/availability/${id}`).set("Cookie", cookie);
  assert.equal(del.status, 200);

  const delAgain = await request(app).delete(`/api/dashboard/availability/${id}`).set("Cookie", cookie);
  assert.equal(delAgain.status, 404);
});

test("a provider can only delete their own availability block, never another provider's", async () => {
  const app = await freshApp();
  const { cookie: adminCookie } = await adminSession(app);
  await request(app).post("/api/dashboard/availability").set("Cookie", adminCookie).send({ workflowId: "hair", providerId: "p2", date: "2026-09-06" });
  const list = await request(app).get("/api/dashboard/availability?workflowId=hair&providerId=p2").set("Cookie", adminCookie);
  const otherProvidersBlockId = list.body[0].id;

  await request(app).post("/api/dashboard/users").set("Cookie", adminCookie).send({ email: "p1-provider@example.com", password: "password123", role: "provider", name: "P1", workflowId: "hair", providerId: "p1" });
  const providerLogin = await request(app).post("/api/auth/login").send({ email: "p1-provider@example.com", password: "password123" });

  const forbidden = await request(app).delete(`/api/dashboard/availability/${otherProvidersBlockId}`).set("Cookie", providerLogin.headers["set-cookie"]);
  assert.equal(forbidden.status, 403);
});

test("unauthenticated requests to every availability route are rejected", async () => {
  const app = await freshApp();
  assert.equal((await request(app).get("/api/dashboard/availability?workflowId=hair&providerId=p1")).status, 401);
  assert.equal((await request(app).post("/api/dashboard/availability").send({ workflowId: "hair", providerId: "p1", date: "2026-09-01" })).status, 401);
  assert.equal((await request(app).delete("/api/dashboard/availability/1")).status, 401);
});
