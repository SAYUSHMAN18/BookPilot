// Section 5.4 — proving the threshold/cooldown logic itself, not just
// "a function exists." Two things matter: an alert only fires once
// enough errors land inside the window (not on error #1), and it doesn't
// re-fire on every subsequent error once already over threshold (a real
// outage should log one alert, not thousands).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const alerting = require("../../src/infra/alerting");

test("shouldAlert stays false until the error count reaches the threshold", () => {
  alerting._resetForTests();
  for (let i = 0; i < alerting.ERROR_THRESHOLD - 1; i++) {
    alerting.recordError();
    assert.equal(alerting.shouldAlert(), false, `should not alert after only ${i + 1} error(s)`);
  }
});

test("shouldAlert fires exactly once when the threshold is crossed, then respects the cooldown", () => {
  alerting._resetForTests();
  for (let i = 0; i < alerting.ERROR_THRESHOLD; i++) alerting.recordError();

  assert.equal(alerting.shouldAlert(), true, "expected an alert once the threshold is reached");
  assert.equal(alerting.shouldAlert(), false, "expected no repeat alert immediately after (cooldown)");

  alerting.recordError();
  assert.equal(alerting.shouldAlert(), false, "still within cooldown even with more errors landing");
});

test("getErrorRate reports the current count and configured threshold", () => {
  alerting._resetForTests();
  alerting.recordError();
  alerting.recordError();
  const rate = alerting.getErrorRate();
  assert.equal(rate.count, 2);
  assert.equal(rate.threshold, alerting.ERROR_THRESHOLD);
  assert.ok(rate.windowMs > 0);
});

test("logger.js records an ERROR-level log() call into the shared alerting counters", () => {
  alerting._resetForTests();
  delete require.cache[require.resolve("../../src/infra/logger")];
  const { log } = require("../../src/infra/logger");

  log("ERROR", "simulated failure for alerting test");
  assert.equal(alerting.getErrorRate().count, 1);

  log("INFO", "an info line should not count toward the error rate");
  assert.equal(alerting.getErrorRate().count, 1);
});
