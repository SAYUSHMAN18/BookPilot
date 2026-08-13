// Shared Postgres test-isolation helper.
//
// Before the Postgres migration, every test file got its own throwaway
// SQLite file via `fs.mkdtempSync` + a fresh `DATA_DIR` — cheap, synchronous,
// and trivially isolated from every other test file's own temp file. Now
// that src/store/db.js talks to a real Postgres server (needed for Cloud
// Run — see its own comment), "isolated" has to mean "its own DATABASE",
// created (and torn down) via a separate maintenance connection, since a
// single shared `bookpilot` database would mean every test file's
// runMigrations() (CREATE TABLE/ALTER TABLE/CREATE TRIGGER — all
// lock-taking DDL) and every test file's own tenant id=1 race every OTHER
// test file's, given `node --test` runs files as separate parallel
// processes by default.
//
// Usage (mirrors the old `process.env.DATA_DIR = fs.mkdtempSync(...)`
// pattern exactly, just async):
//
//   const { createIsolatedTestDatabase } = require("../helpers/isolatedDb");
//   ...
//   await createIsolatedTestDatabase(); // sets process.env.DATABASE_URL
//   delete require.cache[require.resolve("../../src/store/db")];
//   const { runMigrations } = require("../../src/store/db"); // picks up the new URL
//
// Safe to call more than once per process (e.g. a file that needs two
// fully-separate isolated instances) — each call creates a distinct
// `bookpilot_test_<hex>` database and points process.env.DATABASE_URL at
// the newest one. All databases created by this file get dropped together
// in a single node:test after() hook, registered lazily on first use.
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");

// Resolves to the exact same absolute path no matter which test directory
// calls createIsolatedTestDatabase() (tests/http, tests/integration,
// tests/store, ...), since it's derived from THIS file's own location
// rather than the caller's relative "../../src/store/db"-style path.
// Used only to look up an already-`require()`d src/store/db in Node's
// module cache (require.cache is keyed by absolute path) — never to
// require() it fresh ourselves, since only the caller knows whether it
// wants that module's cache busted first.
const DB_MODULE_PATH = path.join(__dirname, "..", "..", "src", "store", "db.js");

require("dotenv").config();

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set — tests/helpers/isolatedDb.js needs it (from .env) as a " +
      "template for host/port/credentials to create per-test-file databases under. See .env.example."
  );
}

// Captured once, at first load, BEFORE any call below ever overwrites
// process.env.DATABASE_URL with a freshly-created test database's own URL.
// Every call in this same process — including a second/third
// createIsolatedTestDatabase() in one file — still needs the ORIGINAL
// host/port/credentials to open its maintenance connection, not whatever
// test database happens to be "current" in process.env at that point.
const TEMPLATE_DATABASE_URL = process.env.DATABASE_URL;

function urlForDatabase(name) {
  const url = new URL(TEMPLATE_DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

// The `postgres` database is Postgres's own always-present maintenance
// database — CREATE DATABASE / DROP DATABASE can't run against the
// database you're currently connected to, so every such call here goes
// through a separate connection to `postgres`, never to `bookpilot` (the
// real app database named in .env) and never to a `bookpilot_test_*`
// database while anything might still be using it.
function maintenanceConnectionString() {
  return urlForDatabase("postgres");
}

let cleanupRegistered = false;
const createdDatabaseNames = [];

// IMPORTANT: node:test's after() attaches to whatever test/context is
// CURRENTLY RUNNING at the moment it's called — calling it lazily from
// inside createIsolatedTestDatabase() (itself normally awaited from
// inside a `test(async (t) => {...})` body) registers it as that ONE
// test's own teardown, so it fires the instant that single test finishes
// instead of once at the true end of the file, dropping the database out
// from under every later test/hook in the same file. Registering it here,
// at module top-level — evaluated once when the file first
// `require()`s this module, before any test() callback has started
// running — attaches it to the file's root context instead, so it fires
// only once, after every test in the file has finished. The module-scope
// guard flag still protects against a double-registration if this module
// somehow gets require()'d fresh more than once in the same process.
function registerCleanupOnce() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  require("node:test").after(async () => {
    // The LAST createIsolatedTestDatabase() call's own database is still
    // "current" — closePreviousPoolIfAny() only ever closes off the
    // PREVIOUS pool on the NEXT call, so nothing has closed this final one
    // yet. Without this, DROP DATABASE ... WITH (FORCE) below force-severs
    // its still-open idle connections, and since `pg.Pool` has no error
    // listener attached (see closePreviousPoolIfAny()'s own comment), that
    // becomes an uncaught exception right as the test file is finishing.
    await closePreviousPoolIfAny();
    for (const name of createdDatabaseNames) {
      const client = new Client({ connectionString: maintenanceConnectionString() });
      try {
        await client.connect();
        // WITH (FORCE) is Postgres 13+ — auto-terminates any lingering
        // connections to the target database first, so callers never
        // need to manually close every pool they opened against it
        // before this runs.
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } catch (err) {
        console.error(`tests/helpers/isolatedDb.js: failed to drop database "${name}": ${err.message}`);
      } finally {
        await client.end().catch(() => {});
      }
    }
  });
}
registerCleanupOnce();

// A test FILE that calls createIsolatedTestDatabase() more than once
// (tests/http/_setup.js's freshApp(), called once per test) leaves the
// PREVIOUS call's src/store/db.js — and the live `pg.Pool` it opened
// against the database that call created — sitting in Node's module
// cache. The caller's own require-cache-busting loop only replaces the
// reference for its NEXT require("../../src/store/db") call; it does
// nothing to the actual open Pool object underneath, which keeps its
// idle connections open for the rest of the process's life since nothing
// else ever closes it. Once every database this file created gets
// DROPped (WITH FORCE) in the after() hook below, Postgres forcibly
// severs those still-open idle connections — and `pg.Pool` has no error
// listener attached (src/store/db.js never adds one, reasonably, since
// production never drops its own live database out from under itself),
// so each severed connection fires an unhandled 'error' event, which
// Node escalates to an uncaughtException, which server.js's own
// crash-safety handler (by design) turns into process.exit(1) — killing
// the rest of the test run. Closing off the PREVIOUS pool gracefully
// here, right before its database becomes orphaned, avoids ever leaving
// a live-but-abandoned Pool around to be surprised by that DROP later.
async function closePreviousPoolIfAny() {
  const cached = require.cache[DB_MODULE_PATH];
  if (cached?.exports?.pool && typeof cached.exports.pool.end === "function") {
    await cached.exports.pool.end().catch(() => {});
  }
}

async function createIsolatedTestDatabase() {
  await closePreviousPoolIfAny();

  const suffix = crypto.randomBytes(6).toString("hex");
  const name = `bookpilot_test_${suffix}`;

  const client = new Client({ connectionString: maintenanceConnectionString() });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }

  createdDatabaseNames.push(name);

  process.env.DATABASE_URL = urlForDatabase(name);

  // A brand new database has none of the app's tables yet — under the old
  // node:sqlite version, DatabaseSync ran runMigrations() synchronously at
  // db.js's own require() time, so simply pointing DATA_DIR at a fresh
  // temp file was enough to get a fully-migrated database "for free" on
  // the very next require("../../src/store/db"). Postgres's async Pool
  // can't do that at require-time (no top-level await in this CJS
  // codebase — see server.js's own comment on why bootstrap() exists at
  // all), so server.js now calls runMigrations() explicitly, once, inside
  // its async bootstrap(). Any test that goes through server.js (every
  // tests/http/*.test.js, via freshApp()) still gets that for free. Any
  // test that talks to a store module directly WITHOUT going through
  // server.js — every tests/integration, tests/store, tests/engine, and
  // tests/infra file in this suite — never had another module that would
  // call it, so this is done here instead: one call, right after the
  // fresh database exists, so `await createIsolatedTestDatabase()` alone
  // is enough to hand back a ready-to-use, fully-migrated database,
  // matching the old one-liner's ergonomics. Deliberately uses its OWN
  // fresh require of src/store/db (busting whatever was cached at
  // DB_MODULE_PATH first, so this doesn't accidentally run migrations
  // against a PREVIOUS call's database if this is the 2nd+ isolated
  // database this same file has created) rather than relying on the
  // caller's own require-cache-busting, which runs AFTER this returns —
  // migrations are DDL persisted in the database itself, not tied to
  // which Pool object created them, so it's harmless for the caller to
  // then bust and re-require src/store/db again right afterward, same as
  // every other store module it busts.
  delete require.cache[DB_MODULE_PATH];
  const migrationDb = require(DB_MODULE_PATH);
  await migrationDb.runMigrations();
  // This Pool served its one purpose (running the migrations) — closed
  // immediately rather than left open, since the caller is about to bust
  // and re-require src/store/db itself anyway (same as every other store
  // module in its own list) and get its OWN fresh Pool. Left open, this
  // one would become exactly the kind of abandoned, error-listener-less
  // Pool that closePreviousPoolIfAny() elsewhere in this file exists to
  // avoid — except nothing would ever close THIS one, since the caller's
  // own busting loop only deletes the cache entry, it doesn't end() the
  // Pool underneath it.
  await migrationDb.pool.end().catch(() => {});
  delete require.cache[DB_MODULE_PATH];

  return { name, databaseUrl: process.env.DATABASE_URL };
}

module.exports = { createIsolatedTestDatabase };
