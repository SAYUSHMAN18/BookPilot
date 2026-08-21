const { pool } = require("./db");

// Backs every sliding-window limiter in src/infra/rateLimit.js with a real
// table instead of an in-process Map. Found live (self-audit): every limiter
// in that file was a plain Map keyed by sender/IP/email — correct on
// Render's current single free-tier instance, but silently WRONG the moment
// a second instance runs (each process has its own Map, so the real combined
// rate across both instances is never actually enforced — an abusive sender
// gets 2x the intended ceiling for free, with no error, nothing to notice).
// A shared Postgres table is the natural fix here: this app already moved
// off SQLite specifically so more than one process could share state
// (db.js's own comment), and every limiter's actual traffic volume (tens of
// hits/minute per key, worst case) is nowhere near where a table scan would
// be a real cost — same "no heavy deps, reuse Postgres" posture as
// dashboardEvents.js and outboundQueueStore.js.
//
// One row per hit (not a running counter) — mirrors the exact sliding-window
// semantics the old Map-based version had (count hits with ts > now-window),
// rather than switching to a fixed-window approximation that would let a
// burst straddling a window boundary double past the real limit.

async function recordHit(category, key, windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  // Prune this key's own stale rows inline, on every hit, rather than a
  // separate cron/worker tick — cheap with the index below, and keeps the
  // table from growing unbounded between hits for the exact same reason
  // outboundQueueStore.js's own row-per-attempt design doesn't need a
  // separate GC pass either.
  await pool.query("DELETE FROM rate_limit_hits WHERE category = $1 AND key = $2 AND ts < $3", [category, key, cutoff]);
  await pool.query("INSERT INTO rate_limit_hits (category, key, ts) VALUES ($1, $2, $3)", [category, key, now]);
  const rows = await pool.query("SELECT COUNT(*)::int AS count FROM rate_limit_hits WHERE category = $1 AND key = $2 AND ts >= $3", [
    category,
    key,
    cutoff,
  ]);
  return rows.rows[0].count;
}

module.exports = { recordHit };
