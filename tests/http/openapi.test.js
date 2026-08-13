// New plan, Block 19 — the Public API's OpenAPI spec is served as a
// plain static file (no new YAML dependency — the file itself IS the
// deliverable), unauthenticated, same as any other piece of API
// documentation a `curl` or a browser tab reaches with no key at all.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { freshApp } = require("./_setup");

test("GET /openapi.yaml serves the real spec, unauthenticated, describing the actual Public API", async () => {
  const app = await freshApp();
  const resp = await request(app).get("/openapi.yaml");
  assert.equal(resp.status, 200);
  assert.match(resp.headers["content-type"], /yaml|text|octet-stream/);
  assert.match(resp.text, /openapi: 3\.0\.3/);
  assert.match(resp.text, /\/v1\/availability/);
  assert.match(resp.text, /\/v1\/bookings\/\{bookingId\}/);
  assert.match(resp.text, /ApiKeyAuth/);
});
