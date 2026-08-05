const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

// Real embedded database (SQLite, built into Node — no native module to
// compile, no separate server to run) replacing the JSON-file booking
// store. The point isn't "SQLite is fancy" — it's that a UNIQUE index can
// enforce "no two bookings for the same provider/slot" at the storage
// layer itself, which is safe even across multiple server processes
// sharing this file. A hand-rolled JSON file with a JS-level pre-check can
// never guarantee that once there's more than one process writing to it.
// Overridable so tests (and anyone running multiple instances) don't have
// to share — and risk corrupting — the same on-disk database.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, "bookpilot.db");

const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

const BOOKINGS_COLUMNS_SQL = `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_id TEXT NOT NULL,
    booking_id TEXT NOT NULL,
    booking_code TEXT,
    workflow_id TEXT NOT NULL,
    provider_id TEXT,
    provider_name TEXT,
    hotel_id TEXT,
    hotel_name TEXT,
    visit_date TEXT,
    visit_date_label TEXT,
    visit_time TEXT,
    check_in_iso TEXT,
    nights INTEGER,
    customer_name TEXT,
    age TEXT,
    gender TEXT,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'booked',
    created_at INTEGER NOT NULL
`;

// Real gap, fixed here: `wa_id` used to be the PRIMARY KEY, meaning a
// customer's second booking silently overwrote their first — the dashboard
// (and STATUS) could only ever see the most recent booking per customer,
// never their actual history. Migrates an existing table (old schema has
// no `id` column) by rename-recreate-copy-drop, since SQLite can't ALTER
// away a PRIMARY KEY directly. Safe for a fresh install too — just skips.
function migrateToMultiBookingSchema() {
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bookings'").get();
  if (!tableExists) return;

  const columns = db.prepare("PRAGMA table_info(bookings)").all();
  const alreadyMigrated = columns.some((c) => c.name === "id");
  if (alreadyMigrated) return;

  db.exec("ALTER TABLE bookings RENAME TO bookings_old_single;");
  db.exec(`CREATE TABLE bookings (${BOOKINGS_COLUMNS_SQL});`);
  db.exec(`
    INSERT INTO bookings (
      wa_id, booking_id, booking_code, workflow_id, provider_id, provider_name,
      hotel_id, hotel_name, visit_date, visit_date_label, visit_time,
      check_in_iso, nights, customer_name, status, created_at
    )
    SELECT
      wa_id, booking_id, booking_code, workflow_id, provider_id, provider_name,
      hotel_id, hotel_name, visit_date, visit_date_label, visit_time,
      check_in_iso, nights, customer_name, status, created_at
    FROM bookings_old_single;
  `);
  db.exec("DROP TABLE bookings_old_single;");
}
migrateToMultiBookingSchema();

db.exec(`CREATE TABLE IF NOT EXISTS bookings (${BOOKINGS_COLUMNS_SQL});`);

// Safe migration for a database that already existed before age/gender/
// reason were added — CREATE TABLE IF NOT EXISTS above is a no-op against
// an existing table, so a fresh install gets these columns from the
// CREATE above, but an existing data/bookpilot.db needs them ALTERed in.
// (This was a real gap: patient details were being shown in the WhatsApp
// confirmation message and then discarded — never queryable afterward,
// e.g. for a dashboard.)
function ensureColumn(table, column, type) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!existing.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
ensureColumn("bookings", "age", "TEXT");
ensureColumn("bookings", "gender", "TEXT");
ensureColumn("bookings", "reason", "TEXT");

db.exec(`CREATE INDEX IF NOT EXISTS idx_bookings_wa_id ON bookings(wa_id);`);

// The actual double-booking guarantee: SQLite refuses a second non-cancelled
// row for the same provider/date/time, full stop — enforced by the engine,
// not by application code that could race or simply be wrong.
//
// Scoped by (workflow_id, provider_id) together, NOT provider_id alone —
// provider ids like "p1" are only unique WITHIN a workflow's own JSON file
// (medical.json's p1 is a doctor, hair.json's p1 is a totally different
// salon). Verified live that indexing on provider_id alone let booking one
// doctor block an unrelated hair stylist's identical time slot, purely
// because they happened to share the id "p1".
//
// Explicit DROP + CREATE (not CREATE ... IF NOT EXISTS) because an existing
// data/bookpilot.db from before this fix would already have an index named
// idx_no_double_slot with the OLD (buggy) definition — IF NOT EXISTS would
// silently keep it as-is instead of correcting it.
db.exec("DROP INDEX IF EXISTS idx_no_double_slot;");
db.exec(`
  CREATE UNIQUE INDEX idx_no_double_slot
  ON bookings(workflow_id, provider_id, visit_date, visit_time)
  WHERE status != 'cancelled' AND visit_time IS NOT NULL AND visit_date IS NOT NULL;
`);

// Same scoping requirement for provider availability blocks (a doctor
// blocking their calendar shouldn't touch a same-id salon's calendar).
db.exec(`
  CREATE TABLE IF NOT EXISTS blocked_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT, -- NULL means the whole day is blocked
    reason TEXT,
    created_at INTEGER NOT NULL
  );
`);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_blocked_provider_date ON blocked_slots(workflow_id, provider_id, date);
`);

module.exports = { db };
