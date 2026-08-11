# Architecture

This is the source of truth for how BookPilot AI is put together — the
invariants a change must never break, the directory layout, and why the
pieces are split the way they are. `README.md` stays the feature-level
tour (what exists, how it was verified); this document is what to read
before changing code.

## System shape

One Node.js process (`server.js`) does everything: it's the WhatsApp
webhook receiver, the provider/admin dashboard's API, and the static file
server for the React dashboard (`public/app/`, built from `frontend/`).
There's no queue, no separate worker
process, no microservices — a single process is enough at this scale, and
splitting it apart before there's a real reason to would just be
distributed-systems complexity nobody's paying for yet. The two exceptions
are in-process background loops (not separate processes): a backup
scheduler and an outbound-message-retry worker, both started from
`server.js`'s `app.listen()` callback via `setInterval`.

Storage is a single SQLite file (`data/bookpilot.db`, via Node's built-in
`node:sqlite` — no native module to compile, no separate database server
to run). WAL mode is enabled so reads and writes overlap instead of
blocking each other file-wide.

## Directory layout

```
server.js              All HTTP routes (webhook + dashboard API) — see
                        "Why server.js isn't split into src/routes/" below.
src/
  ai/                   Anything that calls Groq (LLM classification,
                        intent detection, factual Q&A, orchestration) or
                        drafts config from a description (workflowGenerator).
                        Every module here degrades to a deterministic
                        fallback if the AI call fails or times out —
                        nothing in this app is AI-required to function.
  store/                Data access — one module per SQLite table (or
                        closely related group of tables), each exposing a
                        small, purpose-built interface (not a generic ORM).
                        db.js owns the schema and every migration.
  engine/               The booking conversation engine itself
                        (workflowEngine.js — the state machine that walks
                        a customer through a workflow's steps),
                        workflow-config loading, date/slot math, and
                        analytics (computed from store data, not its own
                        storage).
  infra/                Cross-cutting concerns with no booking-domain
                        knowledge of their own: logging, alerting, rate
                        limiting, dedup, auth/session tokens, backups,
                        secretsEncryption.js (AES-256-GCM for tenant
                        secrets at rest, Section 8), and the two
                        external-channel integrations (WhatsApp, Sarvam
                        voice) — both of which degrade to a
                        simulated/logged mode when their credentials
                        aren't configured, the same pattern
                        emailSender.js uses (see README's password-reset
                        section). WhatsApp specifically resolves creds
                        per-tenant (src/store/tenantStore.js) with a
                        fallback to these same global env vars for
                        upgrade continuity. paymentProviders/ (Section 9)
                        and calendarProviders/ (Section 10) each hold a
                        documentation-only interface module plus one real
                        implementation (Razorpay, Google Calendar) — a
                        second provider could be added to either without
                        touching any call site. oauthState.js signs the
                        short-lived `state` token Section 10's Google
                        OAuth flow carries through the redirect and back.
                        dashboardEvents.js (Section 11) is the in-process
                        pub/sub backing the dashboard's live-update
                        (SSE) stream. tracing.js (Section 15) is the
                        AsyncLocalStorage-based requestId propagation
                        every log() call picks up automatically.
src/types.js             Section 15 — JSDoc @typedefs for the core data
                        shapes (Booking, Payment, Tenant, User,
                        ApiKeyRecord). No runtime code — exists purely so
                        `// @ts-check`'d files (src/store/bookingStore.js
                        is the current worked example) get real editor/CI
                        type-checking without a TypeScript build step.
workflows/*.json         Business definitions — one file per bookable
                        business type, loaded by src/engine/loadWorkflows.js.
                        Adding a new industry means adding a JSON file
                        here, not writing code.
frontend/               The React/Vite dashboard — a separate npm project
                        (its own package.json, node_modules) that builds
                        into public/app/, served by server.js's
                        express.static at /app. This is the only
                        dashboard (Item 4 deleted the original hand-rolled
                        public/dashboard.html once this reached feature
                        parity with it); GET /dashboard just 302s to /app
                        for old links/bookmarks.
tests/
  ai/ store/ engine/ infra/   Unit tests, mirroring src/'s split — a test
                        here targets one module (or a couple of tightly
                        related ones) in that layer.
  integration/          Tests that deliberately span layers — a full
                        conversation through workflowEngine, a webhook
                        under concurrent load, a forced-timeout pipeline
                        test. If a test needs `ai/` fallback behavior AND
                        `store/` persistence AND `engine/` state to prove
                        something real, it belongs here, not force-fit
                        into one layer's folder.
docs/                   This file, plus SETUP.md.
```

### Why `server.js` isn't split into `src/routes/`

The rest of this reorg (moving `src/*.js` into `ai/store/engine/infra/`,
mirroring `tests/`) was a mechanical, low-risk change: every file move was
covered by the existing test suite, which caught the two real bugs the
move introduced (stale `__dirname`-relative paths in four files) within
minutes.

Splitting `server.js`'s ~40 routes into `src/routes/*.js` modules is a
fundamentally different kind of change — it's a semantic refactor (route
handlers, shared closures like the in-memory `workflows` object,
middleware ordering, Express Router mounting), not a mechanical one.

**Update:** `tests/http/*.test.js` now exists — real HTTP-level coverage via
`supertest` against the actual Express `app` (server.js exports it, and
only calls `app.listen()` when run as the process entry point, via
`require.main === module` — a test file can `require("../../server")` and
get the bare app, no real port bound, no background loops started). It
covers signup/login/session/role-gating, booking CRUD + conflict detection
(the `SlotTakenError` → 409 mapping), availability CRUD + role scoping,
and the webhook's signature verification + duplicate-delivery handling —
driven through a full real conversation via the actual signed `/webhook`
route, not just `/api/simulate-whatsapp`. That was the honest prerequisite
this section used to flag for splitting `server.js` safely; it's done, and
a route-mounting refactor is no longer flying blind. It's still real,
focused work of its own — not something to rush through at the tail end
of a different change.

## Core invariants

These are the guarantees a change must never break. If a change seems to
require breaking one of these, stop and reconsider the approach rather
than the invariant.

### 1. `(tenant_id, workflow_id, provider_id)` scoping

Section 8 added a layer above the pair below: BookPilot now runs multiple
independent businesses (tenants) on one install, each with their own
WhatsApp number, and workflow/provider ids are only unique **within one
tenant** — two different tenants can each have a workflow literally called
`"medical"`. Every tenant-scoped table (`bookings`, `blocked_slots`,
`users`, `sessions`, `support_requests`, `feedback`, `audit_log`,
`knowledge_documents`, `outbound_queue`) carries a `tenant_id` column, and
every query against one of them filters by it — not as an extra
convenience filter, but as the actual isolation boundary: `getById`-style
lookups filter `WHERE id = ? AND tenant_id = ?` together, so a request
that somehow got the right numeric id but the wrong tenant simply finds no
row, the same way a wrong password fails rather than partially succeeding.
`src/store/tenantStore.js` owns the `tenants` table itself (branding,
feature flags, per-tenant WhatsApp credentials — encrypted at rest via
`src/infra/secretsEncryption.js` — and an optional bring-your-own Groq key
override). A `platform_admin` role (distinct from any tenant's own
`admin`) manages tenants themselves through `/api/platform/*`; every
other `/api/dashboard/*` route stays scoped to the caller's own tenant,
enforced the same way `(workflow_id, provider_id)` scoping already was.

A provider id like `"p1"` is *also* only unique **within** one workflow's
own JSON file even inside a single tenant — `medical.json`'s `p1` is a
doctor, `hair.json`'s `p1` is an unrelated salon. Every query, index, and
permission check that touches bookings, availability blocks, or queue
position must scope by the full `(tenant_id, workflow_id, provider_id)`
together, never any one or two of them alone. The `(workflow_id,
provider_id)` half of this was a real, live-caught bug once (`src/store/db.js`'s
comment on `idx_no_double_slot` has the story): indexing on `provider_id`
alone let booking one doctor block an unrelated hair stylist's identical
time slot purely because they happened to share an id. `tenant_id` closes
the same class of bug one level up.

**Known gap, not yet closed**: `workflows/*.json` files themselves are
still a single global catalog, not yet tenant-scoped — every tenant
currently sees the same set of business definitions. This is the one
place Section 8's "fully isolated" guarantee doesn't yet reach; closing it
means deciding how workflow config becomes per-tenant (a subdirectory per
tenant slug is the natural fit, matching this file-based system's existing
philosophy) without disrupting the existing single-tenant install's
`workflows/*.json` layout. Flagged here deliberately rather than
silently left inconsistent with everything else in this section.

### 2. The engine owns every write; the LLM only navigates

`src/engine/workflowEngine.js` is a deterministic state machine. It is the
only thing that ever writes a booking. AI (`src/ai/*`) is consulted for
*navigation* decisions — which workflow the customer means, which
recovery action fits an off-script reply, whether a question is
answerable from the knowledge base — never for the decision to create,
modify, or cancel a booking. `src/ai/orchestrator.js`'s planner is
explicitly restricted to a closed set of navigation intents
(`retry_step`, `answer_question`, `go_to_step`, `cancel`, `restart`,
`human`) precisely so an LLM can never call the equivalent of
`create_booking` directly — the guarantees that matter here (no
double-booking, validated fields, confirmation before any write) come
from the deterministic engine, not from trusting a model's judgment on
every turn. Every AI call also has a hard timeout and a fallback path — an
AI outage degrades the experience, it never blocks it.

### 3. The `ensureColumn` / recreate-and-copy migration pattern

`src/store/db.js` owns the whole schema and every migration against it.
Two patterns cover everything:

- **Additive column** (the common case): `ensureColumn(table, column, type)`
  — idempotent, checks `PRAGMA table_info` before running `ALTER TABLE
  ADD COLUMN`, safe to call on every startup whether the column already
  exists or not.
- **Structural change** (e.g. removing a `PRIMARY KEY`, or — Section 8 —
  changing `sessions` from a single-column `wa_id` primary key to the
  composite `(tenant_id, wa_id)`, which SQLite's `ALTER TABLE` can't do
  directly either way): create the new table under a fresh `CREATE
  TABLE`, `INSERT INTO ... SELECT` the old data across, drop the old
  table, rename. `migrateToMultiBookingSchema()` and
  `migrateSessionsCompositeKey()` in `db.js` are the worked examples.

Every migration must be safe to run against **both** a fresh install
(empty/nonexistent table) and an existing `data/bookpilot.db` from before
the change — never a one-time script a human has to remember to run.
Don't introduce a second migration mechanism alongside this one.

**A real failure mode this pattern has to guard against, hit live during
Section 8**: a structural migration's "already migrated?" check must
verify the actual END STATE (e.g. "is `tenant_id` genuinely part of the
primary key?", checked via `PRAGMA table_info`'s `pk` field), never just
"does this column exist?". An earlier, simpler pass had already added a
plain `tenant_id` column to `sessions` via `ensureColumn` (no primary-key
change) before the composite-key migration was written; checking column
existence alone made the later migration see `tenant_id` already there
and skip itself, silently leaving a real install with a column that
existed but wasn't actually part of the primary key — `sessionStore.js`'s
`ON CONFLICT(tenant_id, wa_id)` then failed outright at startup, since no
constraint actually covered that pair. Caught immediately by restarting
against the real database (not just fresh-install tests) before shipping
the change — the concrete reason every schema change in this project gets
verified against a copy of the real `data/bookpilot.db`, not only a
throwaway temp one.

### 4. Payment state only ever changes via a verified webhook or an explicit admin action

Section 9 added real money to a system that previously only ever wrote
booking rows. The same discipline as invariant 2 (the engine owns every
write, never the AI) extends here: **nothing except a signature-verified
Razorpay webhook, or an authenticated admin hitting the manual refund
route, is ever allowed to mark a payment `paid` or `refunded`.** Not a
client-side redirect after payment (can be spoofed, or simply never fire
if the customer closes the tab before Razorpay redirects them back), not
an optimistic update when the payment link is created, not a guess based
on how much time has passed.

- `POST /api/payments/webhook` (`server.js`) verifies `X-Razorpay-Signature`
  (HMAC-SHA256 over the *raw* request body, `crypto.timingSafeEqual`) before
  parsing anything in the payload — the exact same shape as the WhatsApp
  webhook's own `isValidSignature()`, deliberately not a second, different
  verification scheme. An unsigned or wrongly-signed request gets a `403`
  and nothing downstream ever runs. Live-verified: a correctly-signed
  simulated `payment.captured` event flipped a real `payment_pending`
  booking to `booked`/`paid`; the identical payload with a tampered
  signature was rejected with `403` and changed nothing.
- `payments.provider_order_id` (the Razorpay Payment Link's own `plink_...`
  id) is the only key used to match an incoming webhook back to a row —
  never trust-on-request identifiers the client could supply.
- Every payment state transition — `created → paid`, `paid → refunded` /
  `partially_refunded`, `created → failed` — goes through
  `src/store/paymentStore.js`'s dedicated `markPaid`/`markFailed`/
  `markRefunded` methods, and the booking's own denormalized
  `payment_status` column is updated in the same code path, never
  separately (see `src/engine/paymentRefunds.js`'s `refundIfPaid()`,
  shared by every cancellation/no-show path so the policy is computed
  exactly once, not reimplemented per call site).
- **Fails open on infrastructure, fails closed on trust** — if Razorpay
  isn't configured, or the payment-link creation call throws, the booking
  still completes as a normal `booked` appointment (logged as `ERROR`, not
  silently swallowed) rather than leaving the customer stuck mid-flow. But
  a refund failure is caught and reported back, never silently treated as
  a success — `paymentStore.markRefunded()` is only ever called after
  Razorpay's own API confirms the refund, never speculatively.

### 5. Calendar sync degrades silently and never touches booking state

Section 10's push sync to Google Calendar (`src/engine/calendarSync.js`) is
a one-directional side effect of a booking's state, never a dependency of
it — the same relationship Section 9's WhatsApp payment-link message has
to the underlying booking write. Every `syncBookingCreated`/
`syncBookingRescheduled`/`syncBookingCancelled` call catches its own
errors internally and logs them (`ERROR`), and never rethrows — a
provider's calendar being unreachable, unconfigured, or its refresh token
revoked must never fail a booking, a cancellation, or a reschedule that
already succeeded at the database level. Call sites `await` these
functions for ordering (so a test or a log line can rely on the sync
having been attempted before the request finishes), not because their
success is required.

A connection's access token is refreshed proactively (`getValidAccessToken`,
a 2-minute safety margin before actual expiry) rather than reactively on a
401 — simpler to reason about, and avoids a real request failing outright
mid-flight. A refresh failure is inspected once: Google's `invalid_grant`
means the refresh token itself was revoked, which flips the connection to
`needs_reconnect` (surfaced in the dashboard, requires the provider to
reconnect); any other failure is treated as transient and simply logged,
tried again on the next booking event.

### 6. Dashboard events are additive — never a dependency, never broadcast

Section 11's SSE layer (`src/infra/dashboardEvents.js`, one process-wide
`EventEmitter`; `GET /api/dashboard/events` in `server.js`) exists purely
to make a browser tab's own reads happen sooner — it is never in the path
of a write. `publish()` cannot throw in a way that reaches its caller (an
`EventEmitter.emit()` with no listeners — no dashboard tab currently
open — is simply a no-op), so every booking-state-changing call site
publishes as its very last step, after the database write and any
customer-facing WhatsApp send have already succeeded or failed on their
own terms.

Every event is filtered server-side, per connection, before a single byte
reaches the browser — never broadcast-then-filter-on-the-client. A
provider session's SSE subscription only matches events whose payload
`workflowId`/`providerId` equals that session's own (or that omit
`providerId` entirely — a workflow-scoped event like a support
escalation, which isn't yet tied to one provider); an admin session
matches every event for its own `tenantId`, the same full-tenant
visibility `GET /api/dashboard/all-bookings` already grants elsewhere.
This is the same `(tenant_id, workflow_id, provider_id)` boundary
invariant 1 establishes for every stored row, applied to an in-memory
stream instead of a SQL `WHERE` clause — the isolation guarantee doesn't
change shape just because the data is now moving over an open HTTP
connection instead of sitting in a table.

### 7. The Public API is read-only until write validation is genuinely shared

Section 14's `/api/v1/*` routes (`server.js`, `requireApiKey` — a bearer
API key resolves straight to a `tenantId`, no session/role concept on
this path) intentionally implement no write endpoint. `recordBooking()`
in `src/engine/workflowEngine.js` — the only thing that ever creates a
booking (invariant 2) — is coupled to a live conversational session's
step-by-step validation state, not a standalone, callable "create one
valid booking from a flat set of fields" function. Adding
`POST /api/v1/bookings` before that coupling is untangled would force a
choice between two bad options: a second, hand-maintained copy of
`recordBooking()`'s validation (a real, ongoing risk of the two
silently drifting apart, the same class of problem invariant 2 exists to
prevent for the AI/engine split), or accepting a booking that skips a
check the WhatsApp flow enforces. `GET /api/v1/availability` avoids this
entirely by calling `getAvailableSlots()` — extracted from
`workflowEngine.js`, not reimplemented — so the one read endpoint that
exists is provably the same answer the bot itself would give, not a
close approximation of it.

## Request lifecycle (WhatsApp message)

1. `POST /webhook` (`server.js`) verifies Meta's signature, acks
   immediately (Meta requires a fast response), then processes the
   message asynchronously. Section 8: the receiving WhatsApp number's
   `phone_number_id` (always present in Meta's payload) is resolved to a
   tenant via `src/store/tenantStore.js`'s `getByPhoneNumberId()` before
   anything else — every following step operates within that one
   tenant's data, and a tenant whose status isn't `active` gets a single
   clear reply instead of being silently processed or silently dropped.
2. `src/engine/workflowEngine.js`'s `handleIncomingMessage(tenantId, ...)` loads (or
   creates) the customer's session (`src/store/sessionStore.js`, SQLite-backed,
   survives a restart), checks for STOP/START ALERTS commands, an
   awaited-feedback capture, then either continues an in-progress workflow
   step or classifies which business the message is about
   (`src/ai/classify.js`, falling back to each workflow's `keywords` list
   if Groq is unavailable).
3. Each step's input is validated deterministically. An off-script reply
   goes through `src/ai/orchestrator.js`'s planner (see invariant 2 above).
4. A completed booking is written via `src/store/bookingStore.js`, which
   is where the DB-level guarantees live: a `UNIQUE` index blocks a
   double-booked time slot, a trigger blocks an overlapping hotel date
   range — both are the *authoritative* check, catching a race the
   in-memory pre-check earlier in the conversation can miss (see
   `tests/integration/walConcurrency.test.js`).
5. The reply goes out via `src/infra/whatsapp.js`. A proactive message
   with no customer reply to naturally retry it (an arrival alert, a
   cancellation notice) goes through `sendWithRetry()` — a couple of
   immediate attempts, then the durable `outbound_queue`
   (`src/store/outboundQueueStore.js`) if those fail, drained by a
   background worker so a transient outage doesn't lose the message even
   across a restart.

## Reliability posture

- **Backups**: `src/infra/backupStore.js`, SQLite's native Online Backup
  API (safe under WAL, no manual checkpoint), scheduled + verified after
  every run, pruned past a retention count.
- **Structured logs**: every `log()` call (`src/infra/logger.js`) writes
  both a human-readable line and a JSON line (`logs/app.jsonl`), plus
  feeds a rolling error-rate counter (`src/infra/alerting.js`) that logs a
  loud, rate-limited `ALERT` line if errors cluster.
- **No silent failures**: the webhook handler, voice message handling,
  and async route handlers all guarantee a response/reply even when
  something throws internally, instead of the client hanging or the
  customer getting nothing back.
- **CSRF**: `SameSite=Lax` + `HttpOnly` session cookie combined with
  JSON-only body parsing (no `express.urlencoded()`) closes the classic
  cross-site vector for this app's shape (a JSON API, no CORS) without a
  separate token scheme — see README's Section 12 writeup for the full
  reasoning.
- **Per-user resource caps**: the one long-lived connection type this app
  holds open (SSE, Section 11) is capped per account
  (`MAX_SSE_CONNECTIONS_PER_USER`, `server.js`) — every other route is
  request/response and needs no such cap.
- **Secrets at rest**: per-tenant WhatsApp tokens (Section 8) and
  connected-calendar OAuth tokens (Section 10) are AES-256-GCM encrypted
  in the DB (`src/infra/secretsEncryption.js`); booking PII is not
  field-encrypted, a deliberate choice — see README's "PII, retention,
  and encryption at rest" section.

See `README.md` for the full, evidence-backed feature list (what's built,
how each piece was verified live) — this document stays focused on the
structure and invariants, not a running changelog.
