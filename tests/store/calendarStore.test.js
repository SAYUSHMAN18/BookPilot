// Section 10 — calendar_connections stores a real OAuth refresh token, so
// this locks down the same things Section 8's secretsEncryption tests
// already established for WhatsApp tokens: it round-trips through
// encryption correctly, and a public view never leaks it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bookpilot-calendarstore-test-"));
process.env.APP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
for (const mod of ["../../src/store/db", "../../src/store/calendarStore"]) {
  delete require.cache[require.resolve(mod)];
}
const { calendarConnections, calendarEventLinks } = require("../../src/store/calendarStore");

const TENANT = 1;

test("a created connection's tokens round-trip through encryption correctly", () => {
  const conn = calendarConnections.create(TENANT, "medical", "p1", {
    calendarType: "google",
    refreshToken: "refresh_token_abc123",
    accessToken: "access_token_xyz789",
    accessTokenExpiresAt: Date.now() + 3600_000,
  });
  assert.equal(conn.refreshToken, "refresh_token_abc123");
  assert.equal(conn.accessToken, "access_token_xyz789");
  assert.equal(conn.status, "connected");

  const fetched = calendarConnections.getForProvider(TENANT, "medical", "p1");
  assert.equal(fetched.refreshToken, "refresh_token_abc123");
  assert.equal(fetched.id, conn.id);
});

test("the raw DB row never stores the token in plaintext", () => {
  calendarConnections.create(TENANT, "medical", "p2", {
    calendarType: "google",
    refreshToken: "super-secret-refresh-token",
    accessToken: "super-secret-access-token",
    accessTokenExpiresAt: Date.now() + 3600_000,
  });
  const { db } = require("../../src/store/db");
  const row = db.prepare("SELECT * FROM calendar_connections WHERE workflow_id = ? AND provider_id = ?").get("medical", "p2");
  assert.ok(!row.refresh_token_encrypted.includes("super-secret-refresh-token"));
  assert.ok(!row.access_token_encrypted.includes("super-secret-access-token"));
});

test("toPublicView never exposes tokens, encrypted or not", () => {
  const conn = calendarConnections.create(TENANT, "medical", "p3", {
    calendarType: "google",
    refreshToken: "another-secret-token",
    accessTokenExpiresAt: null,
  });
  const publicView = calendarConnections.toPublicView(conn);
  assert.equal(publicView.refreshToken, undefined, "the dashboard must never see a token, encrypted or not");
  assert.equal(publicView.accessToken, undefined, "the dashboard must never see a token, encrypted or not");
  assert.equal(publicView.status, "connected");
  assert.equal(publicView.calendarType, "google", "non-secret fields the UI needs (which provider, status) are fine to expose");
});

test("getForProvider is tenant-scoped — one tenant's connection is invisible to another", () => {
  const OTHER_TENANT = 2;
  calendarConnections.create(OTHER_TENANT, "medical", "p1", {
    calendarType: "google",
    refreshToken: "other-tenant-token",
    accessTokenExpiresAt: null,
  });
  const fromTenant1 = calendarConnections.getForProvider(TENANT, "medical", "p1");
  const fromTenant2 = calendarConnections.getForProvider(OTHER_TENANT, "medical", "p1");
  assert.notEqual(fromTenant1.id, fromTenant2.id);
  assert.equal(fromTenant1.refreshToken, "refresh_token_abc123");
  assert.equal(fromTenant2.refreshToken, "other-tenant-token");
});

test("disconnect flips status and getForProvider no longer returns it", () => {
  const conn = calendarConnections.create(TENANT, "hair", "p1", {
    calendarType: "google",
    refreshToken: "hair-token",
    accessTokenExpiresAt: null,
  });
  calendarConnections.disconnect(TENANT, conn.id);
  assert.equal(calendarConnections.getForProvider(TENANT, "hair", "p1"), undefined);
  const stillThere = calendarConnections.getById(TENANT, conn.id);
  assert.equal(stillThere.status, "disconnected", "disconnect is a status flip, not a delete — an audit trail, not silently erased");
});

test("markNeedsReconnect flips status without touching tokens", () => {
  const conn = calendarConnections.create(TENANT, "makeup", "p1", {
    calendarType: "google",
    refreshToken: "makeup-token",
    accessTokenExpiresAt: null,
  });
  calendarConnections.markNeedsReconnect(conn.id);
  const updated = calendarConnections.getById(TENANT, conn.id);
  assert.equal(updated.status, "needs_reconnect");
  assert.equal(updated.refreshToken, "makeup-token");
});

test("calendarEventLinks: upsert/get/delete round-trip, and re-upserting the same booking+connection replaces rather than duplicates", () => {
  const conn = calendarConnections.create(TENANT, "service", "p1", { calendarType: "google", refreshToken: "svc-token", accessTokenExpiresAt: null });
  calendarEventLinks.upsert(999, conn.id, "google_event_1");
  assert.equal(calendarEventLinks.get(999, conn.id).externalEventId, "google_event_1");

  calendarEventLinks.upsert(999, conn.id, "google_event_2"); // reschedule scenario — same booking, new event id would only happen via a delete+recreate, but upsert itself must not error on a repeat key
  assert.equal(calendarEventLinks.get(999, conn.id).externalEventId, "google_event_2");

  calendarEventLinks.delete(999, conn.id);
  assert.equal(calendarEventLinks.get(999, conn.id), undefined);
});
