// Found live: a real visitor navigated straight to the bare production
// domain (no path — the completely normal thing to do with a service's own
// domain, not a deep link) and got server.js's generic catch-all
// {"error":"Not found"} JSON blob instead of the dashboard, which read as
// "the whole site is broken." /dashboard already redirects to /app for
// exactly this reason (old bookmarks); root had no equivalent. Pins the fix.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { freshApp } = require("./_setup");

test("GET / redirects to /app instead of falling through to the 404 handler", async () => {
  const app = await freshApp();
  const resp = await request(app).get("/").redirects(0);
  assert.equal(resp.status, 302);
  assert.equal(resp.headers.location, "/app");
});
