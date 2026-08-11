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
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, "bookpilot.db");

const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

// Section 8 — real multi-tenancy. Every table below that used to be
// implicitly single-business gets a tenant_id column, scoping bookings,
// users, sessions, etc. to one of potentially many independent businesses
// running on this same install. tenant_id is a plain INTEGER, not a
// declared FOREIGN KEY — matching this schema's existing convention for
// workflow_id/provider_id (also plain TEXT, not FK-constrained — a
// provider is a key inside a workflow's JSON definition, not its own row;
// see tenant_workflows below for where the definition itself now lives),
// not a new stricter pattern introduced partway through.
//
// id=1 is always "the default tenant" — created explicitly with that id
// (not left to autoincrement) specifically so every ensureColumn() call
// below can safely say `DEFAULT 1`: an existing single-tenant install
// upgrading to this schema gets every one of its existing rows correctly
// attributed to the default tenant automatically, via SQLite's own
// ALTER-TABLE-ADD-COLUMN-with-DEFAULT semantics, with no separate backfill
// UPDATE pass needed.
db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended', 'cancelled')),
    billing_email TEXT,
    branding_json TEXT, -- {logo, primaryColor, businessName?} shown in bot copy + dashboard chrome
    feature_flags_json TEXT, -- {payments: false, calendarSync: false, ...}
    whatsapp_phone_number_id TEXT UNIQUE, -- resolves an incoming webhook to this tenant (Section 8.3)
    whatsapp_business_account_id TEXT,
    whatsapp_access_token_encrypted TEXT, -- src/infra/secretsEncryption.js — never plaintext
    groq_api_key_encrypted TEXT, -- optional bring-your-own-key override for higher-plan tenants
    created_at INTEGER NOT NULL
  );
`);
const defaultTenantExists = db.prepare("SELECT 1 FROM tenants WHERE id = 1").get();
if (!defaultTenantExists) {
  db.prepare("INSERT INTO tenants (id, name, slug, plan, status, created_at) VALUES (1, 'Default', 'default', 'free', 'active', ?)").run(Date.now());
}

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
// `defaultSql`, when given, is appended as `DEFAULT <defaultSql>` — used
// for tenant_id (Section 8) so an ALTER on an existing table backfills
// every current row to the default tenant (id 1) as part of the same
// statement, with no separate UPDATE pass needed. Must be a SQL literal
// (e.g. `"1"`), not a subquery — that's a SQLite limitation on column
// defaults added via ALTER TABLE, not something worth working around here.
function ensureColumn(table, column, type, defaultSql) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!existing.some((col) => col.name === column)) {
    const defaultClause = defaultSql !== undefined ? ` DEFAULT ${defaultSql}` : "";
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}${defaultClause}`);
  }
}
ensureColumn("bookings", "age", "TEXT");
ensureColumn("bookings", "gender", "TEXT");
ensureColumn("bookings", "reason", "TEXT");
ensureColumn("bookings", "tenant_id", "INTEGER NOT NULL", "1");
// Provider-action columns: track who cancelled/rescheduled and why,
// so the dashboard can show an audit trail and the WhatsApp notification
// can include the new date/time when a provider reschedules.
ensureColumn("bookings", "cancelled_by", "TEXT");
ensureColumn("bookings", "rescheduled_date", "TEXT");
ensureColumn("bookings", "rescheduled_time", "TEXT");
ensureColumn("bookings", "reschedule_note", "TEXT");


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

// Section 6 — the hotel-stay equivalent of the UNIQUE index above. A date
// RANGE overlap ("does 3 nights starting the 5th collide with 2 nights
// starting the 6th?") isn't expressible as a plain UNIQUE index — SQLite
// has no exclusion-constraint feature the way Postgres does — so this is a
// BEFORE INSERT trigger instead. Same reason it needs to exist at all: the
// JS-level pre-check (workflowEngine.js's hasDateRangeConflict()) runs
// possibly whole conversation turns before the actual INSERT — the
// customer is asked to confirm their name, review the booking, etc. in
// between — leaving a real multi-second-to-multi-minute window for a
// second customer's request to land and pass the same stale check. The
// trigger is the backstop that actually closes it, evaluated atomically
// with the INSERT itself.
db.exec("DROP TRIGGER IF EXISTS trg_no_hotel_range_overlap;");
db.exec(`
  CREATE TRIGGER trg_no_hotel_range_overlap
  BEFORE INSERT ON bookings
  WHEN NEW.check_in_iso IS NOT NULL AND NEW.nights IS NOT NULL AND NEW.status != 'cancelled'
  BEGIN
    SELECT RAISE(ABORT, 'HOTEL_RANGE_CONFLICT')
    WHERE EXISTS (
      SELECT 1 FROM bookings
      WHERE workflow_id = NEW.workflow_id
        AND provider_id IS NEW.provider_id
        AND check_in_iso IS NOT NULL AND nights IS NOT NULL
        AND status != 'cancelled'
        AND date(check_in_iso) < date(NEW.check_in_iso, '+' || NEW.nights || ' days')
        AND date(NEW.check_in_iso) < date(check_in_iso, '+' || nights || ' days')
    );
  END;
`);

// Same scoping requirement for provider availability blocks (a doctor
// blocking their calendar shouldn't touch a same-id salon's calendar).
db.exec(`
  CREATE TABLE IF NOT EXISTS blocked_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT, -- NULL means the whole day is blocked; otherwise the range's start (24h "HH:MM")
    reason TEXT,
    created_at INTEGER NOT NULL
  );
`);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_blocked_provider_date ON blocked_slots(workflow_id, provider_id, date);
`);

// Range-based blocking (Section 2). NULL end_time on an existing row means
// "block exactly this one slot" (the original single-timestamp behavior,
// preserved for any block created before this column existed) rather than
// a range. Found and fixed in the same pass as adding this: the OLD single
// -slot blocking never actually worked at all — blocked_slots.time was
// stored in 24h format straight from the dashboard's <input type="time">,
// but the WhatsApp-facing slot list is generated and compared in 12h
// labels ("9:30 am"), so the exact-string match in the old
// blockedTimesForDay() could never succeed. Both bugs share one fix:
// src/availabilityStore.js now converts everything to minute-of-day
// integers for comparison, which is also what makes range overlap
// ([start, end)) actually correct instead of another exact-string match.
ensureColumn("blocked_slots", "end_time", "TEXT");
ensureColumn("blocked_slots", "tenant_id", "INTEGER NOT NULL", "1");

// Section 3 — live queue position. `serving` (provider is with this
// customer right now) and `done` (finished) extend the existing status
// enum (booked/arrived/cancelled/rescheduled) rather than a new table —
// queue position is just "how many bookings ahead of me, same provider,
// same day, aren't done or cancelled yet" (src/queueStore.js), so it only
// ever needs the one status field to already be accurate.
// alerted_next tracks whether this booking already got its "you're next"
// WhatsApp ping, so a customer can't be re-pinged every time someone else
// ahead of them gets marked done (Section 3.5's rate-limit requirement).
ensureColumn("bookings", "alerted_next", "INTEGER");

// Section 3.5 — a customer can opt out of proactive position alerts
// ("STOP ALERTS") without affecting anything else about their booking.
// Keyed by wa_id directly (not a booking) since the preference is about
// the PERSON, outliving any single booking.
db.exec(`
  CREATE TABLE IF NOT EXISTS customer_preferences (
    wa_id TEXT PRIMARY KEY,
    alerts_opted_out INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
`);

// Section 4 — post-appointment provider notes + feedback loop.
// feedback_requested_at marks "we're expecting this customer's next
// free-text reply to be feedback, not a new booking attempt" — checked
// early in workflowEngine.js's message handler, before intent detection
// even runs, reusing the same "don't misroute a reply that means
// something specific" principle as Section 1.5's conversation history
// rather than building a second context mechanism for it. Nullable/unset
// once consumed (a real reply arrives) so it's a one-time ask, matching
// "one nudge, then drop it" — there's no scheduled re-ask.
ensureColumn("bookings", "provider_note", "TEXT");
ensureColumn("bookings", "feedback_requested_at", "INTEGER");

// Section 6 — payments schema groundwork only. No payment gateway
// integration exists yet (that's Phase 2's Section 9); this just gives
// that future work a real column to land on instead of a fresh migration,
// and lets a workflow config declare `requiresPayment`/`depositAmount` per
// provider today without anything actually enforcing or collecting it.
// Every booking gets 'not_required' explicitly at creation (bookingStore.js)
// rather than staying NULL forever, so the column has a real, queryable
// value from day one instead of two different "no payment involved" states
// (NULL vs 'not_required') for Section 9 to have to reconcile later.
ensureColumn("bookings", "payment_status", "TEXT");

db.exec(`
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL,
    wa_id TEXT NOT NULL,
    rating INTEGER,
    comment TEXT,
    created_at INTEGER NOT NULL
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_booking ON feedback(booking_id);`);
ensureColumn("feedback", "tenant_id", "INTEGER NOT NULL", "1");
// Denormalized from the booking this feedback is about (src/store/feedbackStore.js
// sets it once at creation, alongside tenant_id) — avoids a JOIN back to
// bookings for every listForWorkflow()/averageRatingForWorkflow() read.
// NULL on any pre-existing row from before this column existed; those
// just won't surface in a workflow-scoped list (they still do in listAll()).
ensureColumn("feedback", "workflow_id", "TEXT");

// Section 5.2 — conversation sessions move off the JSON file into here.
// The JSON approach (src/store/sessionStore.js, now legacy) had a real race in
// any multi-instance deployment: two processes could each load the WHOLE
// file, modify a DIFFERENT customer's session, and write the WHOLE file
// back — whichever write lands second silently reverts the first
// process's change, a lost update. One row per customer here means two
// processes updating two different customers' sessions touch two
// different rows and can never clobber each other.
//
// Section 8 — wa_id alone can no longer be the primary key. Each tenant
// gets their own WhatsApp Business number (Section 8.3), but the same
// real customer phone number can message TWO different tenants' numbers
// — under a wa_id-only key, that second tenant's conversation would land
// in and corrupt the first tenant's session for that phone number. The
// key is now the pair (tenant_id, wa_id): the same real person can have
// one independent, non-colliding conversation with each tenant they talk
// to. SQLite can't ALTER a PRIMARY KEY, so — same rename-recreate-copy-drop
// pattern as migrateToMultiBookingSchema()/migrateUsersRoleCheck() above —
// existing sessions (all implicitly the default tenant, since this table
// predates multi-tenancy) get tenant_id=1 explicitly on copy.
const SESSIONS_COLUMNS_SQL = `
    tenant_id INTEGER NOT NULL,
    wa_id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, wa_id)
`;
function migrateSessionsCompositeKey() {
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get();
  if (!tableExists) return;

  const columns = db.prepare("PRAGMA table_info(sessions)").all();
  const tenantIdCol = columns.find((c) => c.name === "tenant_id");
  // Checking column EXISTENCE alone isn't enough here — an earlier,
  // simpler pass (a plain ensureColumn("sessions", "tenant_id", ...) with
  // no primary-key change, before this recreate-based migration replaced
  // it) could leave a real install with a tenant_id column that exists
  // but isn't actually part of the primary key yet. Only a tenant_id
  // that's genuinely IN the primary key (pk > 0) means this migration
  // already fully ran.
  const alreadyMigrated = tenantIdCol && tenantIdCol.pk > 0;
  if (alreadyMigrated) return;

  db.exec("ALTER TABLE sessions RENAME TO sessions_old_single_key;");
  db.exec(`CREATE TABLE sessions (${SESSIONS_COLUMNS_SQL});`);
  // COALESCE(tenant_id, 1): copies a real tenant_id value forward if the
  // stale intermediate state above already had one; falls back to the
  // default tenant for a genuinely pre-Section-8 table that never had
  // this column at all.
  db.exec(`
    INSERT INTO sessions (tenant_id, wa_id, data, updated_at)
    SELECT COALESCE(${tenantIdCol ? "tenant_id" : "NULL"}, 1), wa_id, data, updated_at FROM sessions_old_single_key;
  `);
  db.exec("DROP TABLE sessions_old_single_key;");
}
migrateSessionsCompositeKey();

db.exec(`CREATE TABLE IF NOT EXISTS sessions (${SESSIONS_COLUMNS_SQL});`);

// Section 5.3 — the real durable outbound retry queue, generalizing
// Section 3's in-memory-only sendWithRetry() stopgap. That version's
// retry state lived in a local variable inside one function call: if the
// process restarted between attempts, the retry was just gone, silently.
// A row here survives a restart — a background worker (src/
// outboundQueueStore.js + the poll loop in server.js) picks up anything
// still `pending` on next boot the same as if the process had never
// stopped. Business-initiated proactive sends (arrival alerts, booking
// cancellation/reschedule/completion notices) go through this after their
// fast-path immediate attempt fails; normal conversational replies don't
// — a customer's own next message is effectively its own retry
// opportunity for those, and queuing every reply would make the bot feel
// slow for no benefit.
db.exec(`
  CREATE TABLE IF NOT EXISTS outbound_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_id TEXT NOT NULL,
    body TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_outbound_queue_pending ON outbound_queue(status, next_attempt_at);`);
ensureColumn("outbound_queue", "tenant_id", "INTEGER NOT NULL", "1");

// Dashboard accounts. Replaces the old single shared DASHBOARD_ACCESS_KEY
// (one secret, no identity, no way to scope who could see what) — every
// login is now a real person with a role. Providers are pinned to exactly
// one workflow_id+provider_id so the API layer can enforce "you only ever
// see your own bookings" against this row, not a client-supplied claim.
//
// tenant_id is nullable here specifically (every other tenant-scoped
// table's tenant_id is NOT NULL) — a 'platform_admin' (Section 8.5)
// manages every tenant, so they're deliberately not pinned to one. An
// 'admin'/'provider' row always has a real tenant_id; only a
// platform_admin's is ever NULL. Not worth a CHECK constraint enforcing
// that pairing given SQLite's limited ALTER support for adding one later
// — the application layer (src/store/userStore.js) is what actually
// creates these rows and enforces it at creation time.
const USERS_COLUMNS_SQL = `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'provider', 'platform_admin')),
    name TEXT,
    workflow_id TEXT, -- providers only; NULL for admins/platform_admins
    provider_id TEXT, -- providers only; NULL for admins/platform_admins
    tenant_id INTEGER, -- NULL only for platform_admin — see comment above
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
`;

// SQLite bakes a CHECK constraint into the table at CREATE time — there's
// no ALTER TABLE that can loosen it, so adding 'platform_admin' to the
// allowed roles needs the same rename-recreate-copy-drop pattern as
// migrateToMultiBookingSchema() above. Detects the old CHECK by absence of
// the tenant_id column (both changes shipped in the same migration, so
// "has tenant_id" and "has the updated CHECK" are equivalent here) —
// safe for a fresh install too, which never has a `users` table yet and
// just skips straight to CREATE TABLE IF NOT EXISTS below.
function migrateUsersRoleCheck() {
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (!tableExists) return;

  const columns = db.prepare("PRAGMA table_info(users)").all();
  const alreadyMigrated = columns.some((c) => c.name === "tenant_id");
  if (alreadyMigrated) return;

  db.exec("ALTER TABLE users RENAME TO users_old_no_tenant;");
  db.exec(`CREATE TABLE users (${USERS_COLUMNS_SQL});`);
  db.exec(`
    INSERT INTO users (id, email, password_hash, role, name, workflow_id, provider_id, tenant_id, active, created_at)
    SELECT id, email, password_hash, role, name, workflow_id, provider_id, 1, active, created_at
    FROM users_old_no_tenant;
  `);
  db.exec("DROP TABLE users_old_no_tenant;");
}
migrateUsersRoleCheck();

db.exec(`CREATE TABLE IF NOT EXISTS users (${USERS_COLUMNS_SQL});`);

// Section 6 — self-serve password reset. Only the SHA-256 hash of the
// reset token is ever stored (same discipline as password_hash above) —
// a leaked row from this table alone can't be used to reset anyone's
// password, the raw token only ever exists in the (simulated, see
// src/emailSender.js) email itself. used_at makes every token single-use;
// expires_at (1h from creation, src/passwordResetStore.js) bounds how
// long a leaked-but-unused token stays dangerous.
db.exec(`
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);`);

// "Especially admin actions" — who did what, when. Append-only by
// convention (nothing in this codebase updates or deletes a row here).
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_email TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT, -- JSON-stringified context, free-form per action
    created_at INTEGER NOT NULL
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at);`);

// Real bug fix, found live during an exhaustive platform_admin testing
// pass: this column was originally added as `INTEGER NOT NULL`, which
// directly contradicts src/store/auditLog.js's own documented design —
// recordAudit(tenantId, ...) is written to accept `null` for a
// platform_admin's genuinely platform-wide actions (login, logout,
// password reset, a manual full-database backup — see that file's own
// comment). Every one of those crashed with a NOT NULL constraint
// violation the instant a platform_admin actually performed one, because
// no test or manual verification pass in this project had ever exercised
// a platform_admin performing a logged action before this one did — every
// prior admin-role check used a tenant-scoped admin, which always has a
// real tenantId and never hit this path. `ALTER TABLE ... ALTER COLUMN`
// isn't a thing in SQLite, so relaxing an existing NOT NULL needs the
// same recreate-and-copy pattern as any other structural change here
// (see migrateSessionsCompositeKey above) — a plain ensureColumn() only
// ever ADDS a missing column, it can't loosen a constraint already baked
// into a live table.
function migrateAuditLogNullableTenantId() {
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'").get();
  if (!tableExists) return;
  const columns = db.prepare("PRAGMA table_info(audit_log)").all();
  const tenantIdCol = columns.find((c) => c.name === "tenant_id");
  // Column doesn't exist yet (a genuinely fresh install — ensureColumn
  // below adds it nullable from the start) or is already nullable
  // (this migration already ran, or a fresh install never had the NOT
  // NULL version at all) — either way, nothing to fix.
  if (!tenantIdCol || tenantIdCol.notnull === 0) return;

  db.exec("ALTER TABLE audit_log RENAME TO audit_log_old_notnull_tenant;");
  db.exec(`
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      actor_email TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    INSERT INTO audit_log (id, tenant_id, actor_email, actor_role, action, detail, created_at)
    SELECT id, tenant_id, actor_email, actor_role, action, detail, created_at FROM audit_log_old_notnull_tenant;
  `);
  db.exec("DROP TABLE audit_log_old_notnull_tenant;");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at);`);
}
migrateAuditLogNullableTenantId();
// Nullable, not NOT NULL — see the migration above for why. The "1"
// default only ever applies when an INSERT omits the column entirely
// (a genuinely pre-Section-8 row being backfilled); code that explicitly
// passes `null` for a platform-wide action still stores a real NULL.
ensureColumn("audit_log", "tenant_id", "INTEGER", "1");

// RAG-lite knowledge base — free-text FAQ/policy/pricing entries an admin
// or a provider adds per business, folded into the same context-stuffed
// prompt factualQA.js already builds from workflow config (businessHours,
// providers, fees). At this scale (a handful of businesses, each with a
// modest FAQ list) the whole knowledge base comfortably fits in a single
// prompt — true vector retrieval would add a dependency and a
// retrieval-miss failure mode this doesn't need yet. Scoped by workflow_id
// only, not provider_id: a clinic's "do you take insurance?" answer is
// shared by every doctor in it, the same way businessHours already is.
db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_workflow ON knowledge_documents(workflow_id);`);
ensureColumn("knowledge_documents", "tenant_id", "INTEGER NOT NULL", "1");

// Workflow template marketplace. A template is a frozen copy of a
// workflow's JSON config — installing one writes a NEW workflows/*.json
// under a fresh id, so editing the installed business never mutates the
// template it came from (and vice versa). Deliberately a copy, not a
// reference: a business that silently changed because someone edited a
// shared upstream template would be a nasty surprise mid-booking-season.
db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    industry TEXT,
    description TEXT,
    definition TEXT NOT NULL, -- JSON-stringified workflow config
    created_by TEXT,
    created_at INTEGER NOT NULL
  );
`);
// Deliberately global, not tenant_id-scoped, unlike every table below —
// this is the marketplace's shared catalog (Section "publish a business as
// a template"), meant to be browsable and installable by any tenant, the
// same way a template gallery works in other SaaS products. Installing a
// template deep-copies its definition into that installer's own
// tenant_workflows row (server.js's persistWorkflow) — the template itself
// is never mutated by, or exposed as belonging to, any one tenant.

// Item 5 — tenant-owned workflows. Business definitions used to live only
// in workflows/*.json — a single set of files on disk, loaded once at boot
// into one in-memory object every tenant's dashboard and webhook traffic
// read AND wrote through equally. That meant any tenant's admin could
// view, edit, or delete any OTHER tenant's business config just by
// knowing (or guessing) a workflow id like "hair" — a real cross-tenant
// isolation gap, not a theoretical one, since every new tenant used to
// start from — and so shared — that exact same global "hair"/"hotel"/etc.
// set. This table makes a workflow row-owned by exactly one tenant, the
// same pattern every other per-tenant table here already uses.
// workflows/*.json still exists, but now only as the read-only starter
// catalog copied into a brand new tenant at signup
// (src/store/tenantWorkflowStore.js's seedDefaultsForTenant) — no
// request-handling code reads or writes those files directly anymore.
db.exec(`
  CREATE TABLE IF NOT EXISTS tenant_workflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    workflow_id TEXT NOT NULL,
    definition TEXT NOT NULL, -- JSON-stringified workflow config, same shape workflows/*.json always used
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(tenant_id, workflow_id)
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tenant_workflows_tenant ON tenant_workflows(tenant_id);`);

// Human escalation used to be a dead end — a customer who asked for a
// person five different ways got the same canned refusal every time, with
// nothing anywhere for a provider/admin to ever see the request. This is
// what makes escalation land somewhere real: a row a human can actually
// act on, visible on the dashboard. workflow_id is nullable because a
// complaint can arrive before the customer's ever named a business.
db.exec(`
  CREATE TABLE IF NOT EXISTS support_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_id TEXT NOT NULL,
    workflow_id TEXT,
    message TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_support_requests_workflow ON support_requests(workflow_id);`);
ensureColumn("support_requests", "tenant_id", "INTEGER NOT NULL", "1");

// Section 9 — payments. One row per payment ATTEMPT tied to one booking
// (not one row per booking — a failed attempt followed by a successful
// retry is two rows, an honest record of what actually happened rather
// than one row silently overwritten). provider_payment_id/provider_order_id
// are what a webhook callback (src/infra/paymentProviders/*.js) uses to
// find the right row again — Razorpay's own ids, not this table's own
// auto-increment one, since the webhook payload only ever carries theirs.
// Booking correctness invariant: a booking that requires payment stays in
// `payment_pending` status (not `booked`) until a VERIFIED webhook (never
// a client-side claim) confirms it — see src/engine/workflowEngine.js's
// recordBooking() and server.js's payment webhook route.
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    booking_id INTEGER NOT NULL,
    amount INTEGER NOT NULL, -- smallest currency unit (paise for INR), matching Razorpay's own convention
    currency TEXT NOT NULL DEFAULT 'INR',
    status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed', 'refunded', 'partially_refunded')),
    provider TEXT NOT NULL DEFAULT 'razorpay',
    provider_order_id TEXT,
    provider_payment_id TEXT,
    refund_status TEXT,
    refund_amount INTEGER,
    failure_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(provider_order_id);`);

// Section 10 — calendar sync. One row per provider's connected calendar
// (a provider could have both Google and Outlook connected, hence keyed
// by (tenant_id, workflow_id, provider_id, calendar_type) rather than
// assuming one calendar per provider). refresh_token_encrypted uses the
// same src/infra/secretsEncryption.js as tenants.whatsapp_access_token_encrypted
// — never plaintext, same reasoning: this is a real credential capable of
// reading/writing someone's calendar.
db.exec(`
  CREATE TABLE IF NOT EXISTS calendar_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    workflow_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    calendar_type TEXT NOT NULL CHECK (calendar_type IN ('google', 'outlook')),
    external_calendar_id TEXT, -- which calendar within the account, once known
    refresh_token_encrypted TEXT NOT NULL,
    access_token_encrypted TEXT,
    access_token_expires_at INTEGER,
    status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'needs_reconnect', 'disconnected')),
    last_synced_at INTEGER,
    created_at INTEGER NOT NULL
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_calendar_connections_provider ON calendar_connections(tenant_id, workflow_id, provider_id);`);

// One row per booking<->calendar-event mapping — how a second sync pass
// knows "this booking already has an event, update it" instead of
// creating a duplicate every time. Deleting the calendar event on
// cancellation deletes this row too (src/infra/calendarSync.js), so a
// re-booking with the same booking id (never happens — ids are
// auto-increment — but defensively) can't inherit a stale mapping.
db.exec(`
  CREATE TABLE IF NOT EXISTS calendar_event_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL,
    calendar_connection_id INTEGER NOT NULL,
    external_event_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_event_links_booking ON calendar_event_links(booking_id, calendar_connection_id);`);

// Section 14 — the Public API's own auth mechanism, separate from the
// dashboard's session cookies: a tenant's own website/backend calls
// /api/v1/* with `Authorization: Bearer bpk_...`, not a logged-in human.
// Only the SHA-256 hash of the key is ever stored (same "never store the
// literal secret" discipline as password hashing in src/infra/auth.js
// and password-reset tokens in passwordResetStore.js) — the real key is
// shown to the tenant admin exactly once, at creation time, and is
// unrecoverable after that (revoke and issue a new one is the only way
// to "change" it, matching how every real API-key system works).
db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL, -- first 12 chars of the real key, shown in the dashboard list so an admin can tell keys apart without ever re-displaying the full secret
    key_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);`);

module.exports = { db, DB_FILE };
