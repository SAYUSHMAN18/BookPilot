// Section 11 — the pub/sub backing the dashboard's SSE stream. Now backed
// by real Postgres LISTEN/NOTIFY (see dashboardEvents.js's own comment for
// why: an in-process EventEmitter alone silently drops every event for a
// subscriber connected to a DIFFERENT instance than the one that
// published). Delivery is a real network round-trip through Postgres now,
// not a synchronous same-tick EventEmitter call — every test below waits
// on an actual received event via a promise instead of asserting
// immediately after publish() returns.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");

let dashboardEvents;

async function setup() {
  // Close the PREVIOUS test's own LISTEN connection first — otherwise it's
  // orphaned (still open, still holding an 'error' listener that schedules
  // a reconnect) rather than actually closed, and every orphaned instance
  // from earlier in this file gets force-terminated all at once when
  // isolatedDb.js's own after() hook drops every created database at file
  // end, each one independently retrying against its own already-dropped
  // database. Mirrors closePreviousPoolIfAny()'s reasoning in
  // isolatedDb.js for the exact same class of bug on the main pool.
  if (dashboardEvents) await dashboardEvents._resetForTests();
  await createIsolatedTestDatabase();
  const modulePath = require.resolve("../../src/infra/dashboardEvents");
  delete require.cache[modulePath];
  dashboardEvents = require("../../src/infra/dashboardEvents");
  await dashboardEvents.whenReady();
}

function waitForEvent(predicate = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("timed out waiting for a dashboard-event"));
    }, timeoutMs);
    const unsubscribe = dashboardEvents.subscribe((evt) => {
      if (!predicate(evt)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(evt);
    });
  });
}

after(async () => {
  if (dashboardEvents) await dashboardEvents._resetForTests();
});

test("a subscriber receives a published event with tenantId, type, and payload intact", async () => {
  await setup();
  const pending = waitForEvent((evt) => evt.type === "booking.created");
  await dashboardEvents.publish(1, "booking.created", { bookingId: "APT-1" });
  const evt = await pending;
  assert.equal(evt.tenantId, 1);
  assert.equal(evt.type, "booking.created");
  assert.deepEqual(evt.payload, { bookingId: "APT-1" });
  assert.ok(typeof evt.at === "number");
});

test("unsubscribe stops delivery to that listener without affecting others", async () => {
  await setup();
  const receivedA = [];
  const unsubA = dashboardEvents.subscribe((evt) => receivedA.push(evt));
  const pendingB1 = waitForEvent((evt) => evt.type === "unsub-test-1");
  await dashboardEvents.publish(1, "unsub-test-1", {});
  await pendingB1;
  unsubA();

  const pendingB2 = waitForEvent((evt) => evt.type === "unsub-test-2");
  await dashboardEvents.publish(1, "unsub-test-2", {});
  await pendingB2;

  assert.equal(receivedA.length, 1, "A should only have seen the event before it unsubscribed");
});

test("publish never throws even with zero subscribers", async () => {
  await setup();
  await assert.doesNotReject(dashboardEvents.publish(999, "booking.created", { anything: true }));
});

test("multiple tenants' events all reach a subscriber — filtering is the subscriber's job, not the bus's", async () => {
  await setup();
  const seenTenantIds = new Set();
  const pending = new Promise((resolve) => {
    const unsubscribe = dashboardEvents.subscribe((evt) => {
      if (evt.type !== "multi-tenant-test") return;
      seenTenantIds.add(evt.tenantId);
      if (seenTenantIds.has(1) && seenTenantIds.has(2)) {
        unsubscribe();
        resolve();
      }
    });
  });
  await dashboardEvents.publish(1, "multi-tenant-test", {});
  await dashboardEvents.publish(2, "multi-tenant-test", {});
  await pending;
  assert.ok(seenTenantIds.has(1) && seenTenantIds.has(2));
});

test("a payload too large for a single NOTIFY still reaches this instance's own subscribers", async () => {
  await setup();
  const pending = waitForEvent((evt) => evt.type === "oversized-test");
  const hugePayload = { blob: "x".repeat(8100) }; // JSON.stringify(evt) exceeds the 7800-byte NOTIFY cap
  await dashboardEvents.publish(1, "oversized-test", hugePayload);
  const evt = await pending;
  assert.equal(evt.payload.blob.length, 8100);
});
