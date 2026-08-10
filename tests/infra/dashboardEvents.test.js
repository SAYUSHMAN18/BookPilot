// Section 11 — the in-process pub/sub backing the dashboard's SSE stream.
// Pure EventEmitter semantics, no network/DB involved — fast and fully
// deterministic to test directly.
const { test } = require("node:test");
const assert = require("node:assert/strict");

delete require.cache[require.resolve("../../src/infra/dashboardEvents")];
const { publish, subscribe } = require("../../src/infra/dashboardEvents");

test("a subscriber receives a published event with tenantId, type, and payload intact", () => {
  const received = [];
  const unsubscribe = subscribe((evt) => received.push(evt));
  try {
    publish(1, "booking.created", { bookingId: "APT-1" });
    assert.equal(received.length, 1);
    assert.equal(received[0].tenantId, 1);
    assert.equal(received[0].type, "booking.created");
    assert.deepEqual(received[0].payload, { bookingId: "APT-1" });
    assert.ok(typeof received[0].at === "number");
  } finally {
    unsubscribe();
  }
});

test("unsubscribe stops delivery to that listener without affecting others", () => {
  const receivedA = [];
  const receivedB = [];
  const unsubA = subscribe((evt) => receivedA.push(evt));
  const unsubB = subscribe((evt) => receivedB.push(evt));
  try {
    publish(1, "booking.created", {});
    unsubA();
    publish(1, "booking.updated", {});
    assert.equal(receivedA.length, 1, "A should only have seen the event before it unsubscribed");
    assert.equal(receivedB.length, 2, "B stayed subscribed for both events");
  } finally {
    unsubB();
  }
});

test("publish never throws even with zero subscribers", () => {
  assert.doesNotThrow(() => publish(999, "booking.created", { anything: true }));
});

test("multiple tenants' events all reach a subscriber — filtering is the subscriber's job, not the bus's", () => {
  const received = [];
  const unsubscribe = subscribe((evt) => received.push(evt));
  try {
    publish(1, "booking.created", {});
    publish(2, "booking.created", {});
    const tenantIds = received.map((e) => e.tenantId);
    assert.ok(tenantIds.includes(1) && tenantIds.includes(2));
  } finally {
    unsubscribe();
  }
});
