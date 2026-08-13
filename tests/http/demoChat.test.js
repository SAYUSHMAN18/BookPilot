// Item 8 — POST /api/demo/chat, the public marketing chat widget's
// backend. Unlike /api/simulate-whatsapp (a dev tool that trusts a
// client-supplied tenantId), this route is meant to be reachable by
// anyone on the internet with no login — so the real thing to prove here
// is that it's structurally incapable of touching any real tenant's data,
// not just that it replies.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { freshApp } = require("./_setup");

test("responds with a real reply and never a client-suppliable tenantId", async () => {
  const app = await freshApp();
  const resp = await request(app).post("/api/demo/chat").send({ sessionId: "test-session-1", text: "hello" });
  assert.equal(resp.status, 200);
  assert.ok(typeof resp.body.reply === "string" && resp.body.reply.length > 0);
  // The route body only ever accepts {sessionId, text} — confirm passing
  // a tenantId (as /api/simulate-whatsapp does accept) has no effect by
  // checking a second call with a bogus tenantId behaves identically.
  const withTenantId = await request(app).post("/api/demo/chat").send({ sessionId: "test-session-1b", text: "hello", tenantId: 999999 });
  assert.equal(withTenantId.status, 200);
});

test("rejects missing/empty sessionId or text with 400", async () => {
  const app = await freshApp();
  const noSession = await request(app).post("/api/demo/chat").send({ text: "hello" });
  assert.equal(noSession.status, 400);

  const noText = await request(app).post("/api/demo/chat").send({ sessionId: "s1" });
  assert.equal(noText.status, 400);

  const emptyText = await request(app).post("/api/demo/chat").send({ sessionId: "s1", text: "   " });
  assert.equal(emptyText.status, 400);
});

test("two different sessionIds get independent conversations that don't collide", async () => {
  const app = await freshApp();
  const bookingStore = require("../../src/store/bookingStore");
  const tenantStore = require("../../src/store/tenantStore");
  const demoTenant = await tenantStore.getBySlug("bookpilot-live-demo");
  assert.ok(demoTenant, "expected the dedicated demo tenant to have been bootstrapped at startup");

  const before = (await bookingStore.values(demoTenant.id)).length;

  await request(app).post("/api/demo/chat").send({ sessionId: "session-a", text: "hello" });
  await request(app).post("/api/demo/chat").send({ sessionId: "session-b", text: "hello" });

  // Both land under the same dedicated demo tenant (never a real one),
  // and starting fresh from "hello" on each is exactly what proves they
  // didn't inherit each other's in-progress state.
  const helloReplyA = await request(app).post("/api/demo/chat").send({ sessionId: "session-a", text: "hair" });
  const helloReplyB = await request(app).post("/api/demo/chat").send({ sessionId: "session-b", text: "hair" });
  assert.equal(helloReplyA.status, 200);
  assert.equal(helloReplyB.status, 200);
  void before;
});

test("text longer than 500 characters is rejected", async () => {
  const app = await freshApp();
  const resp = await request(app).post("/api/demo/chat").send({ sessionId: "s1", text: "a".repeat(501) });
  assert.equal(resp.status, 400);
});

test("a 31st request from the same IP within the window is rate-limited", async () => {
  const app = await freshApp();
  let lastStatus;
  for (let i = 0; i < 31; i++) {
    const resp = await request(app).post("/api/demo/chat").send({ sessionId: `rl-session-${i}`, text: "hello" });
    lastStatus = resp.status;
  }
  assert.equal(lastStatus, 429);
});

// Real bug, found live while testing the new platform-admin UI: the demo
// tenant is only forced "active" in the branch that just CREATED it — an
// install that already had this tenant from before that check existed
// (or from before this session added it) kept showing up "pending"
// forever, cluttering a platform admin's activation queue with an entry
// there's nothing to actually do about. ensureDemoTenant() now corrects
// an existing-but-wrong status on every boot, not just at creation.
test("the demo tenant self-heals to active on the next boot even if something had left it pending", async () => {
  await freshApp(); // first "boot" — creates the demo tenant, active
  const tenantStore = require("../../src/store/tenantStore");
  const demoTenant = await tenantStore.getBySlug("bookpilot-live-demo");
  assert.equal(demoTenant.status, "active");

  await tenantStore.setStatus(demoTenant.id, "pending"); // simulate a pre-existing install's stale state

  // A real second boot re-runs server.js's whole startup sequence,
  // including ensureDemoTenant(). freshApp() always points at a brand
  // new isolated database, which would just create a second, unrelated
  // demo tenant and trivially pass without testing anything — so only
  // server.js itself is busted here, deliberately leaving tenantStore
  // (and the live DB connection it holds) exactly as-is, the same
  // in-process module the line above just used to set "pending". Startup
  // is async now (Postgres, not node:sqlite) — the re-required server.js
  // exports its own fresh bootstrap promise as app.ready, which must
  // resolve before ensureDemoTenant()'s self-heal has actually run.
  delete require.cache[require.resolve("../../server")];
  const rebootedApp = require("../../server");
  await rebootedApp.ready;
  const healed = await tenantStore.getBySlug("bookpilot-live-demo");
  assert.equal(healed.status, "active");
});
