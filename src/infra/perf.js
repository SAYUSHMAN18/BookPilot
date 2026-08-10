// In-memory response-time samples (message received -> handler finished,
// covering every reply sent during that call). Deliberately not persisted
// to SQLite: this is operational telemetry for spotting a regression
// while the process is running, not business data — resetting on restart
// is fine, and avoids a schema/migration for numbers nobody needs history
// of beyond "is it slow right now."
const samples = [];
const MAX_SAMPLES = 500;

function recordResponseTime(ms) {
  samples.push(ms);
  if (samples.length > MAX_SAMPLES) samples.shift();
}

function percentile(p) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function getResponseTimeStats() {
  return {
    p50: percentile(50),
    p95: percentile(95),
    max: samples.length ? Math.max(...samples) : null,
    sampleSize: samples.length,
  };
}

module.exports = { recordResponseTime, getResponseTimeStats };
