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

// Self-audit finding: shouldAlert() crossing threshold used to only ever
// produce one more log line, indistinguishable from any other line to
// anyone not actively watching. logger.js's sendAlertWebhook() now POSTs a
// plain {"text": "..."} JSON body (works unmodified as a Slack/Discord
// incoming webhook) to ALERT_WEBHOOK_URL when set — proven here against a
// stubbed fetch, same pattern tests/infra/outboundQueue.test.js already
// uses for stubbing outbound HTTP without a real network call.
test("crossing the alert threshold POSTs to ALERT_WEBHOOK_URL when one is configured", async () => {
  alerting._resetForTests();
  const originalFetch = global.fetch;
  const originalUrl = process.env.ALERT_WEBHOOK_URL;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, text: async () => "ok" };
  };
  process.env.ALERT_WEBHOOK_URL = "https://hooks.example.test/alert";
  try {
    delete require.cache[require.resolve("../../src/infra/logger")];
    const { log } = require("../../src/infra/logger");
    for (let i = 0; i < alerting.ERROR_THRESHOLD; i++) log("ERROR", `simulated failure ${i}`);

    // The webhook POST is fire-and-forget (same posture as shipToLogDrain) —
    // give its already-resolved stubbed fetch a tick to actually run.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.length, 1, "expected exactly one webhook POST for the one threshold crossing");
    assert.equal(calls[0].url, "https://hooks.example.test/alert");
    const body = JSON.parse(calls[0].opts.body);
    assert.match(body.text, /errors in the last/);
  } finally {
    global.fetch = originalFetch;
    process.env.ALERT_WEBHOOK_URL = originalUrl;
  }
});

test("no webhook call is made when ALERT_WEBHOOK_URL is not set", async () => {
  alerting._resetForTests();
  const originalFetch = global.fetch;
  const originalUrl = process.env.ALERT_WEBHOOK_URL;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: true, text: async () => "ok" };
  };
  delete process.env.ALERT_WEBHOOK_URL;
  try {
    delete require.cache[require.resolve("../../src/infra/logger")];
    const { log } = require("../../src/infra/logger");
    for (let i = 0; i < alerting.ERROR_THRESHOLD; i++) log("ERROR", `simulated failure ${i}`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0, "unconfigured ALERT_WEBHOOK_URL must mean zero outbound calls, same as LOG_DRAIN_URL's own convention");
  } finally {
    global.fetch = originalFetch;
    process.env.ALERT_WEBHOOK_URL = originalUrl;
  }
});
