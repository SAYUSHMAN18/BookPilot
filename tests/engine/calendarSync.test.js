// Section 10 — calendarSync.js's pure pieces (event-window computation,
// the "still valid or needs a refresh" decision) plus its integration
// with a fake connection through syncBookingCreated/Rescheduled/Cancelled.
// The actual Google API calls are stubbed here (this file owns no real
// Google Cloud OAuth client, same reason
// tests/infra/razorpayProvider.test.js doesn't call createOrder() for
// real) — what's under test is BookPilot's own logic: does it call the
// provider with the right event shape, does it store the resulting link,
// does a failure degrade without throwing back into the booking flow.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bookpilot-calendarsync-test-"));
process.env.APP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
for (const mod of [
  "../../src/store/db",
  "../../src/store/calendarStore",
  "../../src/infra/calendarProviders/googleCalendarProvider",
  "../../src/engine/calendarSync",
]) {
  delete require.cache[require.resolve(mod)];
}
const { calendarConnections, calendarEventLinks } = require("../../src/store/calendarStore");
const google = require("../../src/infra/calendarProviders/googleCalendarProvider");
const calendarSync = require("../../src/engine/calendarSync");

const TENANT = 1;
const workflow = { id: "medical", label: "Doctor Appointment", slotMinutes: 30 };

test("eventWindow computes a 30-minute IST window from visitDate/visitTime", () => {
  const window = calendarSync.eventWindow({ visitDate: "2099-06-15", visitTime: "9:00 am" }, workflow);
  assert.equal(window.startIso, "2099-06-15T09:00:00+05:30");
  assert.equal(window.endIso, "2099-06-15T09:30:00+05:30");
});

test("eventWindow respects a non-default slotMinutes", () => {
  const window = calendarSync.eventWindow({ visitDate: "2099-06-15", visitTime: "2:15 pm" }, { slotMinutes: 45 });
  assert.equal(window.startIso, "2099-06-15T14:15:00+05:30");
  assert.equal(window.endIso, "2099-06-15T15:00:00+05:30");
});

test("eventWindow returns null for a hotel-style booking with no visitTime", () => {
  assert.equal(calendarSync.eventWindow({ visitDate: "2099-06-15", visitTime: null }, workflow), null);
});

test("getValidAccessToken reuses a still-valid token without calling the provider", async () => {
  const conn = { id: 1, accessToken: "still-good", accessTokenExpiresAt: Date.now() + 10 * 60 * 1000, refreshToken: "rt" };
  const token = await calendarSync.getValidAccessToken(conn);
  assert.equal(token, "still-good");
});

test("getValidAccessToken refreshes when the token is within the safety margin of expiring", async () => {
  const conn = calendarConnections.create(TENANT, "medical", "p-refresh-test", {
    calendarType: "google", refreshToken: "refresh-me", accessToken: "about-to-expire", accessTokenExpiresAt: Date.now() + 30 * 1000,
  });
  const originalRefresh = google.refreshAccessToken;
  google.refreshAccessToken = async (rt) => {
    assert.equal(rt, "refresh-me");
    return { accessToken: "brand-new-token", expiresAt: Date.now() + 3600_000 };
  };
  try {
    const token = await calendarSync.getValidAccessToken(conn);
    assert.equal(token, "brand-new-token");
    const reloaded = calendarConnections.getById(TENANT, conn.id);
    assert.equal(reloaded.accessToken, "brand-new-token", "the refreshed token must be persisted, not just returned");
  } finally {
    google.refreshAccessToken = originalRefresh;
  }
});

test("getValidAccessToken marks the connection needs_reconnect when the refresh token was revoked", async () => {
  const conn = calendarConnections.create(TENANT, "medical", "p-revoked-test", {
    calendarType: "google", refreshToken: "revoked-token", accessToken: null, accessTokenExpiresAt: null,
  });
  const originalRefresh = google.refreshAccessToken;
  google.refreshAccessToken = async () => {
    const err = new Error("invalid_grant");
    err.isInvalidGrant = true;
    throw err;
  };
  try {
    await assert.rejects(() => calendarSync.getValidAccessToken(conn));
    const reloaded = calendarConnections.getById(TENANT, conn.id);
    assert.equal(reloaded.status, "needs_reconnect");
  } finally {
    google.refreshAccessToken = originalRefresh;
  }
});

test("syncBookingCreated creates a real-shaped event and records the link when a connection exists", async () => {
  calendarConnections.create(TENANT, "medical", "p-create-test", {
    calendarType: "google", refreshToken: "rt", accessToken: "valid-token", accessTokenExpiresAt: Date.now() + 3600_000,
  });
  const originalCreate = google.createEvent;
  let capturedArgs;
  google.createEvent = async (accessToken, args) => {
    capturedArgs = { accessToken, ...args };
    return { externalEventId: "google_evt_1" };
  };
  try {
    const booking = { id: 501, bookingId: "APT-TEST-1", workflowId: "medical", providerId: "p-create-test", visitDate: "2099-06-15", visitTime: "9:00 am", customerName: "Test Patient", reason: "checkup", waId: "919999000001" };
    await calendarSync.syncBookingCreated(TENANT, booking, workflow);
    assert.equal(capturedArgs.accessToken, "valid-token");
    assert.equal(capturedArgs.summary, "Doctor Appointment: Test Patient");
    assert.ok(capturedArgs.description.includes("APT-TEST-1"));
    assert.equal(capturedArgs.startIso, "2099-06-15T09:00:00+05:30");

    const conn = calendarConnections.getForProvider(TENANT, "medical", "p-create-test");
    const link = calendarEventLinks.get(501, conn.id);
    assert.equal(link.externalEventId, "google_evt_1");
  } finally {
    google.createEvent = originalCreate;
  }
});

test("syncBookingCreated is a silent no-op when there's no connection for that provider", async () => {
  const booking = { id: 502, bookingId: "APT-TEST-2", workflowId: "medical", providerId: "p-no-connection", visitDate: "2099-06-15", visitTime: "9:00 am", customerName: "Nobody" };
  await assert.doesNotReject(() => calendarSync.syncBookingCreated(TENANT, booking, workflow));
});

test("syncBookingCreated is a silent no-op for a hotel-style booking (no visitTime)", async () => {
  calendarConnections.create(TENANT, "hotel", "h1-r1", { calendarType: "google", refreshToken: "rt", accessToken: "at", accessTokenExpiresAt: Date.now() + 3600_000 });
  const originalCreate = google.createEvent;
  let called = false;
  google.createEvent = async () => { called = true; return { externalEventId: "should-not-happen" }; };
  try {
    const booking = { id: 503, bookingId: "HTL-TEST-1", workflowId: "hotel", providerId: "h1-r1", checkInIso: "2099-06-15", nights: 2, visitTime: null };
    await calendarSync.syncBookingCreated(TENANT, booking, { id: "hotel", label: "Hotel" });
    assert.equal(called, false, "a hotel stay has no clean single-event shape yet — must not call the provider at all");
  } finally {
    google.createEvent = originalCreate;
  }
});

test("syncBookingCreated degrades silently (never throws) when the provider call fails", async () => {
  calendarConnections.create(TENANT, "medical", "p-fail-test", {
    calendarType: "google", refreshToken: "rt", accessToken: "valid-token", accessTokenExpiresAt: Date.now() + 3600_000,
  });
  const originalCreate = google.createEvent;
  google.createEvent = async () => { throw new Error("Google Calendar is down"); };
  try {
    const booking = { id: 504, bookingId: "APT-TEST-3", workflowId: "medical", providerId: "p-fail-test", visitDate: "2099-06-15", visitTime: "9:00 am", customerName: "Test" };
    await assert.doesNotReject(() => calendarSync.syncBookingCreated(TENANT, booking, workflow), "a calendar sync failure must never block/throw back into the booking flow");
  } finally {
    google.createEvent = originalCreate;
  }
});

test("syncBookingCancelled deletes the linked event and removes the link", async () => {
  calendarConnections.create(TENANT, "medical", "p-cancel-test", {
    calendarType: "google", refreshToken: "rt", accessToken: "valid-token", accessTokenExpiresAt: Date.now() + 3600_000,
  });
  const conn = calendarConnections.getForProvider(TENANT, "medical", "p-cancel-test");
  calendarEventLinks.upsert(505, conn.id, "google_evt_to_delete");

  const originalDelete = google.deleteEvent;
  let deletedArgs;
  google.deleteEvent = async (accessToken, args) => { deletedArgs = { accessToken, ...args }; };
  try {
    const booking = { id: 505, bookingId: "APT-TEST-4", workflowId: "medical", providerId: "p-cancel-test", visitTime: "9:00 am" };
    await calendarSync.syncBookingCancelled(TENANT, booking);
    assert.equal(deletedArgs.externalEventId, "google_evt_to_delete");
    assert.equal(calendarEventLinks.get(505, conn.id), undefined, "the link must be removed once the event is deleted");
  } finally {
    google.deleteEvent = originalDelete;
  }
});

test("syncBookingRescheduled updates the existing event in place rather than creating a duplicate", async () => {
  calendarConnections.create(TENANT, "medical", "p-resched-test", {
    calendarType: "google", refreshToken: "rt", accessToken: "valid-token", accessTokenExpiresAt: Date.now() + 3600_000,
  });
  const conn = calendarConnections.getForProvider(TENANT, "medical", "p-resched-test");
  calendarEventLinks.upsert(506, conn.id, "google_evt_existing");

  const originalUpdate = google.updateEvent;
  const originalCreate = google.createEvent;
  let updateArgs;
  let createCalled = false;
  google.updateEvent = async (accessToken, args) => { updateArgs = args; };
  google.createEvent = async () => { createCalled = true; return { externalEventId: "should-not-be-created" }; };
  try {
    const booking = { id: 506, bookingId: "APT-TEST-5", workflowId: "medical", providerId: "p-resched-test", visitDate: "2099-07-01", visitTime: "3:00 pm", customerName: "Rescheduled Patient" };
    await calendarSync.syncBookingRescheduled(TENANT, booking, workflow);
    assert.equal(updateArgs.externalEventId, "google_evt_existing");
    assert.equal(updateArgs.startIso, "2099-07-01T15:00:00+05:30");
    assert.equal(createCalled, false, "an existing link means update, never a second create");
  } finally {
    google.updateEvent = originalUpdate;
    google.createEvent = originalCreate;
  }
});
