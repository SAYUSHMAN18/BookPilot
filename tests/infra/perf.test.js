const { test } = require("node:test");
const assert = require("node:assert/strict");
const { recordResponseTime, getResponseTimeStats } = require("../../src/infra/perf");

test("getResponseTimeStats: null percentiles with no samples", () => {
  delete require.cache[require.resolve("../../src/infra/perf")];
  const fresh = require("../../src/infra/perf");
  const stats = fresh.getResponseTimeStats();
  assert.equal(stats.p50, null);
  assert.equal(stats.sampleSize, 0);
});

test("getResponseTimeStats: p50/p95 computed correctly over known samples", () => {
  delete require.cache[require.resolve("../../src/infra/perf")];
  const fresh = require("../../src/infra/perf");
  for (const ms of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]) {
    fresh.recordResponseTime(ms);
  }
  const stats = fresh.getResponseTimeStats();
  assert.equal(stats.sampleSize, 10);
  assert.equal(stats.max, 1000);
  assert.ok(stats.p50 >= 400 && stats.p50 <= 600, `p50 should be near the middle, got ${stats.p50}`);
  assert.ok(stats.p95 >= 900, `p95 should be near the top, got ${stats.p95}`);
});
