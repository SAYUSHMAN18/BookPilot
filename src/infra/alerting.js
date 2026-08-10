// Section 5.4 — a basic, local error-rate alert. Deliberately not a real
// APM/alerting integration (PagerDuty, Sentry, etc.) — there are no
// credentials for one, and bolting on a SaaS dependency nobody's paying
// for isn't "hardening," it's scope creep. What this gives an operator
// tailing logs (or polling the dashboard) is a single loud line the
// moment errors start clustering, instead of having to notice a slow
// drip of ERROR lines scroll by on their own.
const WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const ERROR_THRESHOLD = 10; // errors within the window before it's "a cluster," not noise
const ALERT_COOLDOWN_MS = 15 * 60 * 1000; // don't re-alert every single error once already over threshold

let errorTimestamps = [];
let lastAlertAt = 0;

function recordError() {
  const now = Date.now();
  errorTimestamps.push(now);
  errorTimestamps = errorTimestamps.filter((t) => now - t <= WINDOW_MS);
}

function getErrorRate() {
  const now = Date.now();
  errorTimestamps = errorTimestamps.filter((t) => now - t <= WINDOW_MS);
  return { count: errorTimestamps.length, windowMs: WINDOW_MS, threshold: ERROR_THRESHOLD };
}

// True at most once per ALERT_COOLDOWN_MS even while the threshold stays
// crossed continuously — a real outage should log one alert, not one per
// error for as long as it lasts.
function shouldAlert() {
  const { count } = getErrorRate();
  if (count < ERROR_THRESHOLD) return false;
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) return false;
  lastAlertAt = now;
  return true;
}

// Test-only — the module-level counters would otherwise leak state
// between unrelated test files sharing one process.
function _resetForTests() {
  errorTimestamps = [];
  lastAlertAt = 0;
}

module.exports = { recordError, getErrorRate, shouldAlert, _resetForTests, WINDOW_MS, ERROR_THRESHOLD };
