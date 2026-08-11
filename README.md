# BookPilot AI — WhatsApp Booking Bot with a Dynamic Workflow Engine

This is DoctorFlow's original WhatsApp bot, refactored around the core idea
from the BookPilot AI PRD: **a config-driven Dynamic Workflow Engine**
instead of hardcoded per-industry logic. It's the lean MVP slice of that
PRD — no NestJS/Angular/Postgres/Redis/RabbitMQ yet, just the workflow
engine concept proven out on the same free-tier stack DoctorFlow used
(Node/Express + Groq + WhatsApp Cloud API).

```
Customer's WhatsApp message (the "requirement", can be anything)
        |
        v
  AI detects the business -> medical / hair / makeup / hotel / ...
        |
        v
  Workflow engine loads that business's steps from workflows/*.json
        |
        v
  Bot walks the steps on WhatsApp (tap a provider from a list/buttons,
  fill in any free-text fields...)
        |
        v
  Booking confirmed
```

Provider and option choices are sent as native WhatsApp interactive
messages — a tappable list (`select_provider`) or reply buttons
(`select_option` with ≤3 choices) — not "reply with a number." Free-text
fields (name, date, etc.) still prompt for typed input, since there's
nothing to tap.

**Two other docs, for different questions than this README answers:**
[`docs/SETUP.md`](docs/SETUP.md) is the standalone step-by-step to get
this running locally (this README's own walkthrough below points there
too). [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the source of
truth for the directory layout and the invariants a change must never
break (`(workflow_id, provider_id)` scoping, the engine-owns-every-write
boundary, the DB migration pattern) — read that before making a
structural change; this README stays the feature-level tour of what's
built and how each piece was verified.

## The core idea: adding a new industry is a config change

Everything industry-specific — providers, prompts, what fields to collect,
the confirmation message — lives in a JSON file under `workflows/`. The
engine (`src/engine/workflowEngine.js`) never mentions "doctor" or "hotel"; it just
walks whatever `steps` array the matched workflow defines.

To add a new business (e.g. a restaurant), create `workflows/restaurant.json`:

```json
{
  "id": "restaurant",
  "description": "restaurant table reservation",
  "matchLabel": "a table",
  "keywords": ["restaurant", "table", "dinner", "reservation", "book a table"],
  "providers": [
    { "id": "p1", "name": "The Garden Bistro", "attribute": "Outdoor Seating", "fee": 0 }
  ],
  "providerListItem": "{provider.name} — {provider.attribute}",
  "providerRowDescription": "{provider.attribute}",
  "steps": [
    { "type": "select_provider", "prompt": "Here are our restaurants:" },
    { "type": "text_input", "field": "partySize", "prompt": "How many people?" },
    { "type": "text_input", "field": "customerName", "prompt": "What name should I book this under?" }
  ],
  "confirmationTemplate": "✅ Table booked!\n\nID: {bookingId}\nAt: {provider.name}\nParty size: {partySize}\nFor: {customerName}"
}
```

No changes to `server.js`, `src/engine/workflowEngine.js`, or `src/ai/classify.js` are
needed — restart the server and it's live. Currently shipped: `medical`,
`hair`, `makeup`, `hotel`. Every workflow needs `id`, `label` (short name
shown in the clarification menu below), `providers[]`, and `steps[]`.

### Handling unclear or off-script replies

Two behaviors keep the bot from getting stuck or guessing wrong:

- **Unclear intent** — if neither Groq nor a workflow's `keywords` can tell what the customer wants (e.g. "hi", "hello"), the bot shows a tappable menu of every loaded business instead of silently defaulting to one. (Previously it defaulted to whichever workflow's JSON file sorted first alphabetically — a real bug where a bare "hii" would start a haircut booking.)
- **Mid-flow business switch** — if a reply doesn't match the current step's options, the bot re-classifies it before giving up. If it clearly reads like a request for a *different* business (e.g. typing "doctor" while stuck picking a hair stylist), it switches the customer into that workflow instead of looping the same error. Genuinely unmatched input (typos, gibberish) just re-shows the current step.

### Supported step types

| type              | what it does                                                                  |
| ----------------- | ------------------------------------------------------------------------------ |
| `select_provider`  | tappable list of `providers`. With `confirmCard: true`, shows a detail card (using `confirmTemplate`) with Continue / Choose Another before advancing — see `medical.json`. |
| `select_hotel`     | tappable list of `hotels` (each `{ id, name, location, rating, rooms[] }`). Stores the picked hotel as `{hotel.xxx}` for templates. See `hotel.json`. |
| `select_room`      | tappable list of the previously-picked hotel's `rooms[]`. Rooms reuse the same shape as `providers`, so they work with `provider.xxx` templates. |
| `text_input`       | prompts for free text, stores it under `field`. Optional `"validate": "required"` rejects empty input; `"validate": "number"` requires digits within `min`/`max` (default 1–120) — both take a custom `validationError` message. Mark one step `"editTarget": true` so `review_confirm`'s Edit button knows where to jump back to. |
| `select_option`    | `options` as reply buttons (≤3) or a list (>3), stores the matched one. `"skippable": true` lets the customer reply SKIP/NONE/"prefer not to say" to store "Not specified" instead of picking one — see `gender` in `medical.json`. |
| `select_date`      | tappable list of the next `days` (default 7, max 10) calendar days — the closest thing to "a calendar" WhatsApp's standard interactive messages support (a real date-picker widget only exists in WhatsApp Flows, a separate, much larger feature — see Roadmap). Days a provider has fully blocked (see Availability below) are left out of the list entirely. Stores `{field}` (the ISO date), `{field}Label` ("6 August 2026"), `{field}Iso`. |
| `select_time_slot` | tappable list of slots generated from the workflow's `businessHours`/`slotMinutes`, skipping already-past slots (if today), slots already booked by someone else for that provider/date, and slots the provider has blocked. Capped at 10 (WhatsApp's list row limit). |
| `review_confirm`   | renders `template`, then Confirm / Edit Details / Cancel buttons. Confirm finishes the booking; Edit jumps back to whichever step has `"editTarget": true`; Cancel discards the session. |

Customer-detail fields (name, age, gender, reason, etc.) are collected **one
at a time** as ordinary `text_input`/`select_option` steps, not parsed out of
one combined message — see `medical.json` for the full pattern (name → age →
gender → reason, each individually validated).

Templates (`providerListItem`, `providerRowDescription`, `confirmTemplate`, `template`, `confirmationTemplate`)
can reference `{provider.xxx}`, `{hotel.xxx}`, `{bookingId}`, `{bookingCode}`,
`{businessName}`, or any collected `{fieldName}`. `providerRowDescription` is
the subtitle shown under a provider's/room's name in the tappable list — keep
it name-free since the row title already shows the name (falls back to
`providerListItem` if omitted).

### Understanding context, not just the current step

If a customer's opening message already answers more than "what business do
you want" — e.g. *"book a haircut with Barber Co tomorrow"* names both a
provider and a date — the bot extracts that via one extra Groq call
(`src/ai/extractContext.js`) and skips straight past whatever was already said,
instead of re-asking from step one. It only skips *consecutive* steps from
the start (you can't skip a later step whose answer depends on one still
unresolved), and a `select_provider` step with `confirmCard` still shows its
confirm card rather than silently skipping the highest-stakes choice.

This is deliberately conservative, verified against real failure modes, not
just the happy path:
- **Not extracted at all: time-of-day.** Matching free text like "5pm"
  against a generated slot list is failure-prone — better to show the
  tappable list than silently guess wrong.
- **Hallucination guard.** The AI's claim alone is never trusted. A provider
  name has to both (a) match a real provider in that workflow and (b)
  actually appear in the customer's real message — verified live that
  without check (b), a 5000-character garbage string got a *real* provider
  name hallucinated onto it.
- **Input is capped** (`src/infra/textLimits.js`, 500 chars) before reaching any AI
  call — cost control, and it also happens to be what fixed the above case
  outright (the classifier stopped mis-firing on huge garbage input once it
  only ever saw the first 500 characters of it).
- Every extracted value still goes through the *exact* validation a manually
  typed answer would (a bogus date still has to match a real generated
  option; a bogus name is just... a name, no different from someone typing
  it themselves).

### No manual date/time/duration entry — anywhere

Every date, time slot, and duration in every workflow is a tappable list —
`select_date`, `select_time_slot`, and (for hotel) `nights` as a
`select_option` list of 1–10. Nothing free-text except name, age, and
reason, which genuinely can't be tapped from a fixed list. This was a real
gap fixed in this pass: `hotel.json`'s check-in date and nights count used
to be free-text (`text_input`) — switched to the same tappable mechanism
everything else already used, verified against the existing double-booking
conflict check (still correctly rejects overlapping tapped dates, still
allows back-to-back stays).

### Answering real questions instead of always showing a menu

Every message is classified first — *is this a booking request* — and only
falls through to a menu if it isn't. But "isn't a booking request" now has
two outcomes, not one: if it's a genuine question answerable from real data
(`src/ai/factualQA.js` — business hours, provider fees, hotel locations), the
bot answers it directly; only if it's truly unclear (a greeting, or a
question about something we don't actually know) does the business menu
show. The classifier prompt was sharpened to recognize "how much does X
charge?" as an information question, not a booking intent, even though it
names a real provider — verified live this was a real gap (the AI correctly
said "unclear," but the code's own keyword fallback then overrode that by
matching the provider's name in the text anyway; fixed so an explicit AI
"unclear" is trusted, not second-guessed by a cruder keyword check).

Answers are grounded in real config data only (hours, fees, location) —
the prompt explicitly forbids answering from general knowledge and requires
saying "I don't know" (falling through to the menu) rather than guessing.
This is prompt-level discipline, not a hard technical guarantee the way the
provider-name grounding check above is — worth knowing the difference.

### Support requests: soft redirect first, not an instant "I'm a bot"

Asking for a human/customer support no longer immediately triggers the
canned "I'm an automated assistant" message — the first ask gets a softer
"let me help directly" redirect, giving the AI classifier a chance to route
a real request normally. Only a second consecutive ask (tracked per
session, resets once a booking flow actually starts or on `restart`) gets
the definitive message.

### Real availability — no double-booking

Two customers can no longer be given the same doctor's slot or the same
hotel room for overlapping dates:

- **Time-slot workflows** (`medical`, `hair`, `makeup`) — `select_time_slot` excludes any slot already booked for that exact provider + date, both when the list is shown *and* again right before the booking is finalized (a race-condition guard, in case two people were mid-flow on the same last-open slot at once). The **authoritative** check is a SQLite `UNIQUE` index on `(workflow_id, provider_id, visit_date, visit_time)` — see "Data layer" below — so this holds even if the JS-level pre-check is somehow bypassed or two requests land back-to-back with no `await` between them.
- **Date-range workflows** (`hotel`) — set `"dateRangeAvailability": { "startField": "...", "nightsField": "..." }` on the workflow. Before finalizing, the engine parses the check-in date (accepts "today"/"tomorrow", "12 Aug", or "2026-08-12"), computes the stay's date range, and rejects it if it overlaps any other confirmed booking for that same room — back-to-back stays (one checkout, same-day check-in) are allowed. Unlike the time-slot case, this check is JS-level only — SQLite's `UNIQUE` index can't express a date-range overlap, so a true multi-process race for the same room/dates isn't fully closed (see Data layer).

**Every match above is scoped by `(workflow_id, provider_id)` together, never `provider_id` alone.** Provider ids like `"p1"` are only unique *within* one workflow's JSON file — `medical.json`'s `p1` is a doctor, `hair.json`'s `p1` is a completely unrelated salon. This was a real, verified-live bug during development: indexing/matching on `provider_id` alone meant booking one doctor's 10am slot silently also blocked an unrelated hair stylist's 10am slot, purely because they happened to share the id `"p1"`. Fixed at both layers — the SQLite index and every JS-side matching function.

### Availability — providers can block their own calendar

A provider can mark a time range, a single slot, or an entire day
unavailable (`src/store/availabilityStore.js`, the `blocked_slots` table) — a
lunch break, a day off, maintenance. Blocking 2:30–3:40 excludes every
generated slot in between (2:30, 2:45, 3:00, 3:15, 3:30 for a 15-minute
grid), not just a slot exactly matching that timestamp — the range check
runs inside `dateSlots.js`'s own slot generator (`timeSlotsFor()`), so
every caller (WhatsApp offering, the pre-booking race-check) gets it for
free rather than needing to remember to apply it. Everything compares in
minute-of-day integers, which is also what fixed a real bug found while
building this: the old single-slot blocking compared 24-hour-formatted
stored times ("09:30", straight from the dashboard's `<input
type="time">`) against 12-hour slot labels ("9:30 am") as exact strings —
they could never match, so blocking one slot never actually excluded it
from what the bot offered. Creating a block also checks for existing
confirmed bookings inside that range and surfaces them as an advisory
warning (not an automatic cancellation — the provider decides) — verified
live against a real booking. Set through the
[dashboard](#provider-dashboard) below, and — like bookings — scoped by
`(workflow_id, provider_id)`.

Not covered: hotel rooms. The block model here is single-day/single-slot;
a hotel stay spans a date *range*, which is a genuinely different problem
(does a 3-night block-out reject a booking that only overlaps 1 of those
nights?) — rather than ship a half-working control for it, the dashboard's
availability editor simply isn't shown for hotel rooms.

### Data layer

Bookings live in SQLite (`data/bookpilot.db`, gitignored — via Node's
built-in `node:sqlite`, no native module to compile) instead of a hand-rolled
JSON file. `src/store/db.js` owns the schema; `src/store/bookingStore.js` exposes a
small `get`/`has`/`set`/`values` interface so the rest of the engine doesn't
know or care that it's a real database underneath.

Sessions (in-progress, unconfirmed conversations) also live in SQLite now
(`src/store/sessionStore.js`, a `sessions` table keyed by `wa_id`) — originally a
JSON file (`logs/sessions.json`), migrated over so a restart mid-conversation
can't lose or corrupt one customer's in-progress state while writing another's.
A one-time, idempotent migration (`migrateLegacyJsonFile()`) imports the old
file on first startup if the table is still empty; safe to skip entirely on a
fresh install.

**Backups.** `src/infra/backupStore.js` uses `node:sqlite`'s native Online Backup
API (`backup(db, destPath)`) — safe under WAL without a manual checkpoint,
unlike a raw file copy. Runs on startup and every `BACKUP_INTERVAL_HOURS`
(default 6h) via `scheduleBackups()`, each one **verified** immediately after
(opened with a fresh read-only connection, booking count compared against the
live DB) rather than trusted blind, with old backups pruned past
`BACKUP_RETENTION_COUNT` (default 14). Admin-only `GET`/`POST
/api/dashboard/backups` to list and manually trigger one.

**Durable outbound message queue.** Proactive WhatsApp sends the bot makes
without a customer message to naturally retry them on (arrival alerts,
post-appointment feedback requests) go through `sendWithRetry()`
(`src/infra/whatsapp.js`): a couple of immediate retries, then — if those still
fail — an `outbound_queue` row (`src/store/outboundQueueStore.js`) instead of just
logging and giving up. A background worker (`startOutboundQueueWorker()`,
polling every 60s, same pattern as `scheduleBackups()`) drains due items,
retrying each with exponential backoff (1m, 2m, 4m... capped at 30m) up to 5
attempts before giving up and marking it `failed` rather than retrying
forever. Survives a server restart, unlike the in-memory-only retry loop it
replaced. Admin-only `GET /api/dashboard/outbound-queue` for visibility.
Covered by `tests/outboundQueue.test.js` (enqueue-on-exhaustion, the worker
actually delivering a queued item, and an item that never succeeds correctly
landing on `failed` rather than looping forever) — writing that last test
caught a real off-by-one: the row that finally exhausts its attempts wasn't
having its `attempts` counter bumped for that final try, so the dashboard
would've shown one fewer attempt than actually happened.

**Concurrency.** `PRAGMA journal_mode = WAL` (`src/store/db.js`) lets reads and
writes overlap instead of blocking each other file-wide. Verified this
actually holds under realistic simultaneous webhook traffic
(`tests/walConcurrency.test.js`, Section 5.5), not just assumed from the
pragma being set: a 50-way concurrent burst of distinct bookings loses or
duplicates nothing; two customers racing for the *exact same* slot always
produce exactly one winner — the DB's `UNIQUE` index
(`bookingStore.js`'s `SlotTakenError`) is what actually closes that race,
since a JS-level "is this slot free?" check running first can never fully
close it on its own; and a backup (Section 5.1) running concurrently with
a write burst neither blocks nor loses any of them.

**`workflows/service.json` (Automobile) is now a real, complete flow**
(Section 6) — it used to have only `select_provider` + `select_date`, with
no time slot, no name collection, and no `review_confirm`, so a real
customer completing it got a booking with no name captured, no service
described, and no chance to review before it was confirmed. There were
already real bookings against this exact workflow, so the fix was to
finish it (copy the step shape from `hair.json`: provider → date → time
slot → name → a `reason` field for what service is needed → review/confirm),
not delete it. Verified live end to end — full conversation through to a
real confirmed booking with every field populated.

**Reschedule actually reschedules now** (Section 6) — the provider
dashboard's "Reschedule" action used to only write `rescheduled_date`/
`rescheduled_time` (audit-only fields nothing else read) while leaving
`visit_date`/`visit_time` — what STATUS, the live queue, the dashboard's
own booking list, and the UNIQUE slot index all actually use — frozen at
the *original* appointment forever. A rescheduled customer's STATUS reply
kept showing the old time, and the old slot stayed permanently blocked for
other customers since status never left a value nothing else recognized.
Fixed to move `visit_date`/`visit_time` to the new slot (freeing the old
one, reserving the new one through the same UNIQUE index — a reschedule
onto a slot someone else already holds now correctly 409s instead of
silently double-booking), and restricted to time-slot bookings only (a
hotel stay is a date *range*, a different shape this single-date modal
can't represent — attempting it now 400s with a clear message instead of
writing a nonsense partial update). Verified live end to end, including
both rejection paths. Covered by `tests/reschedule.test.js`.

**Hotel date-range conflicts are now DB-enforced too** (Section 6) — a
`BEFORE INSERT` trigger (`trg_no_hotel_range_overlap`, `src/store/db.js`), the
range-overlap equivalent of the time-slot UNIQUE index above (SQLite has
no exclusion-constraint feature to express "no two ranges overlap" as a
plain index, hence a trigger instead of an index here). This closes a real
race: the JS-level pre-check (`hasDateRangeConflict()`) runs right after
the customer answers "how many nights," but the actual booking isn't
created until they've also given their name and confirmed — a real gap of
several conversation turns during which a second customer's overlapping
request could pass the same stale check. `bookingStore.js` translates the
trigger's abort into a `DateRangeConflictError`, handled the same way
`SlotTakenError` already was (bounce back to the date step, ask for a
different date). Covered by `tests/hotelRangeConflict.test.js` — exact
overlap, partial overlap, adjacent-but-not-overlapping stays (correctly
allowed), a cancelled booking correctly freeing its old range, and
different rooms/hotels never conflicting with each other — and verified
live against the real database.

Known limits, worth knowing before treating this as fully production-grade:
- Single SQLite file = fine for one server process (even several, since SQLite handles multi-process file access), but a real multi-tenant admin dashboard with concurrent writers at real scale would eventually want Postgres.
- Backups are local to the same machine as the live database — real durability needs them shipped somewhere else (off-box storage, e.g. S3), not just a second directory on the same disk.

**Request validation audit** (Section 6) — went through every
`/api/dashboard/*` route in `server.js` checking for missing or
inconsistent input validation. Every route already does real, specific
validation: numeric id params are `parseInt` + `Number.isInteger`-checked
before use (never a bare `req.params.id` reaching a query), every
`req.body` field a handler reads is `typeof`-checked before use, string
fields that get written are length-capped, ids that need to be safe as
filenames are regex-validated (`WORKFLOW_ID_RE`) at creation and only ever
looked up (never trusted directly as a path afterward) at delete time, and
role-based ownership checks are applied uniformly. No route was found
trusting unvalidated input. This is intentionally *manual*, per-route
validation, not a schema-validation library (Zod/Joi/etc.) applied
uniformly — introducing one now would mean touching every route in this
file for a purely structural change with no functional gap behind it,
which is a worse trade than it sounds: broad, low-value, high-risk churn
this late in the plan. Worth reconsidering once the route count grows
enough that hand-written validation genuinely becomes the bottleneck, not
before.

**Payments — schema groundwork only** (Section 6). A `payment_status`
column now exists on `bookings` (default `'not_required'` for every new
booking), so Phase 2's actual payments feature (Section 9 — a real gateway
integration) has a real column to build on instead of starting from a
fresh migration. Nothing reads, enforces, or collects a payment yet — no
workflow declares `requiresPayment`/`depositAmount`, no booking step asks
for money, and there's no gateway wired up. Deliberately not more than
this: building the actual payment flow now would be doing Section 9's work
early, out of order, with no way to test it against a real gateway anyway.

### Real multi-tenancy (Section 8 — Phase 2)

BookPilot moved from "one business, self-hosted" to a platform multiple
independent businesses can run on, each with their own WhatsApp number,
data, team, and (optional) branding/Groq key — fully isolated from every
other tenant. This is the largest structural change in the project;
`docs/ARCHITECTURE.md`'s "Core invariants" section has the authoritative,
detailed version — this is the feature-level summary.

- **Every tenant-scoped table now carries `tenant_id`** (`bookings`, `blocked_slots`, `users`, `sessions`, `support_requests`, `feedback`, `audit_log`, `knowledge_documents`, `outbound_queue`), added via the existing `ensureColumn` migration pattern, backfilled to a `Default` tenant (id 1) so an existing single-tenant install upgrades with zero data loss and zero reconfiguration — verified against a real copy of `data/bookpilot.db`, not just a fresh test database. `sessions` needed a real structural migration (single `wa_id` key → composite `(tenant_id, wa_id)`, via the same rename-recreate-copy pattern as the original multi-booking fix) — a customer can message two different tenants' WhatsApp numbers and get two genuinely independent conversations, not one that silently clobbers the other.
- **Isolation is enforced at the query layer, not just checked afterward** — `getById`-style lookups filter `WHERE id = ? AND tenant_id = ?` together, so a provider from one tenant can never read, edit, or delete another tenant's row by guessing a numeric id. Verified directly: `tests/integration/multiTenant.test.js` creates two tenants, has the exact same phone number book with both, and proves neither can reach the other's booking/users/knowledge-base entries even with the correct row id in hand.
- **Each tenant gets their own WhatsApp number and credentials**, stored encrypted at rest (`src/infra/secretsEncryption.js`, AES-256-GCM, key from `APP_ENCRYPTION_KEY`) — never plaintext in the database file. The webhook resolves which tenant an incoming message belongs to from Meta's own `phone_number_id` field in the payload, before anything else runs. Verified live: sent a real webhook payload tagged with a second tenant's phone_number_id and confirmed (a) the message was attributed to that tenant, not the default one, and (b) the outbound send attempt used *that tenant's own* (fake, for the test) token — got a real 401 from Meta's API for an invalid token, not a silent fallback to the platform's real credentials.
- **A `platform_admin` role**, distinct from any tenant's own `admin`, manages tenants themselves through `/api/platform/tenants` (list with per-tenant summary stats, create, activate/suspend/cancel, configure branding/feature-flags/Groq override/WhatsApp credentials) — bootstrapped the same way the first tenant admin is, via `PLATFORM_ADMIN_BOOTSTRAP_EMAIL`/`PASSWORD`. A platform_admin has no `tenantId` of their own and cannot use any `/api/dashboard/*` route (those are all tenant-scoped by design); a tenant's own `admin`/`provider` cannot reach `/api/platform/*`.
- **Tenant lifecycle** (`pending` → `active` → `suspended`/`cancelled`) is enforced on every request, not just checked at login — `requireAuth()` re-verifies the caller's tenant status the same way it already re-verifies the account's own `active` flag, so a suspended tenant's dashboard users are locked out on their very next request. The webhook applies the same check before processing any message, replying with one clear, non-alarming line ("This business isn't currently accepting bookings") rather than silently 500ing, silently succeeding, or going dark — consistent with this project's existing "no silent failures" principle.
- **Closed (Item 5)**: `workflows/*.json` used to be a single global catalog shared by every tenant — any tenant's admin could view, edit, or delete any OTHER tenant's business config just by knowing a workflow id like `"hair"`, the one piece Section 8's "fully isolated" guarantee didn't yet reach. `src/store/tenantWorkflowStore.js`'s `tenant_workflows` table closes it: every workflow row is owned by exactly one tenant, seeded from the `workflows/*.json` starter catalog at signup and fully independent from every other tenant's copy from that point on. See `docs/ARCHITECTURE.md` for the detail and `tests/http/workflows.test.js` for the regression coverage.
- **Also explicitly out of scope for this pass**: per-tenant Groq key overrides exist in the schema (`tenantStore.getGroqKeyOverride()`) but aren't yet consulted by any AI call site — every tenant currently shares the platform's own `GROQ_API_KEY`. Branding (`tenants.branding_json`) is stored and settable via the platform API but not yet threaded into bot copy or dashboard chrome. Both are real, bounded follow-ups, not forgotten — just not done here.

### Payments — real Razorpay integration (Section 9 — Phase 2)

A workflow (or an individual provider, overriding the workflow) can now declare `requiresPayment: true` with a `depositAmount`/`depositType` ("fixed" rupees or a "percentage" of the provider's `fee`) and a `refundPolicy`. When set, confirming a booking no longer marks it `booked` directly — it goes to `payment_pending`, a real Razorpay Payment Link is created, and the customer gets the confirmation plus the payment URL over WhatsApp with a "your slot is held" reassurance. Only Razorpay's own webhook (never a client-side redirect, which can be spoofed or simply never fire) flips the booking to `booked` and the payment to `paid`.

- **`src/infra/paymentProviders/`** defines a small `PaymentProvider` interface (`createOrder`, `verifyWebhookSignature`, `parseWebhookEvent`, `createRefund`) with Razorpay as the concrete implementation — a second gateway could be added without touching any call site. Uses the **Payment Links API**, not Orders — a WhatsApp bot has nowhere to embed `checkout.js`, but it can send a plain URL.
- **Fails open on infrastructure problems, fails closed on trust decisions** — the same split this project has used since Section 0. If Razorpay isn't configured or the payment-link API call throws, the booking proceeds as a normal `booked` appointment (logged as `ERROR` so an admin sees it) rather than blocking the customer. But the webhook signature (HMAC-SHA256 over the raw body, same discipline as Meta's own webhook in `src/infra/verifySignature.js`) is verified with `crypto.timingSafeEqual` before anything in the payload is trusted, and a refund failure is caught and reported, never silently marked as succeeded.
- **Refunds are policy-driven and shared logic** (`src/engine/paymentRefunds.js`) — a provider-initiated cancellation refunds in full unless `refundPolicy.providerCancellation: "none"`; a customer-initiated cancellation checks `refundPolicy.customerCancellation` tiers (`[{hoursBefore, refundPercent}]`, first satisfied notice wins) with a full refund by default if no policy is configured. The exact same function backs the customer's own "CANCEL" reply, the dashboard's Cancel button, and the No-Show action (`refundPolicy.noShow: "refund"|"retain"`, defaulting to retaining the deposit) — one policy engine, not three copies that could drift.
- **Dashboard**: bookings show a Payment column (pending/paid/failed/refunded/partially refunded) next to Status, the Analytics card shows tenant-wide revenue collected, and `GET /api/dashboard/payments` + `POST /api/dashboard/payments/:id/refund` give a manual "issue a refund" escape hatch (full or partial) for whatever the automatic flow doesn't cover.
- **Live-verified against Razorpay's real test-mode API**, not just unit tests with mocked HTTP: drove a real booking through the medical workflow's now-live `requiresPayment` config end to end via `/api/simulate-whatsapp` — a real Payment Link was created (`https://rzp.io/rzp/...`), the booking correctly went to `payment_pending` with a ₹100 (20% of ₹500) payment row. A `payment.captured` webhook, signed with a real HMAC-SHA256 signature, was then POSTed to `/api/payments/webhook` and correctly flipped the booking to `booked` and the payment to `paid`; a tampered signature was correctly rejected with `403`. The manual refund route was exercised against Razorpay's real API too (denied, as expected, since the test used a synthetic payment id — proving the route's plumbing and error handling, not a real payment reversal). All test artifacts were deleted afterward; no real booking was touched.
- **Known, deliberate gap**: `parseWebhookEvent`'s preference for `payload.payment_link.entity.id` over `payload.payment.entity.order_id` is implemented per Razorpay's documentation and proven against a *simulated* signed webhook, but not against a webhook Razorpay's own servers actually sent — that requires a public URL registered in a real Razorpay dashboard, which only the account owner can set up. `RAZORPAY_WEBHOOK_SECRET` in `.env` is a locally-chosen placeholder for this reason; replace it with the real secret Razorpay issues once a live webhook endpoint is configured. Revenue reporting is tenant-wide only, not yet broken down per provider (`payments` doesn't join back to a provider).

### Calendar sync — Google Calendar OAuth (Section 10 — Phase 2)

Each individual provider (a doctor, a stylist) can connect their own Google Calendar from the dashboard's Calendar Sync panel; BookPilot then pushes every confirmed booking onto it automatically — created on confirmation, moved on reschedule, removed on cancellation — so a provider who actually lives in their calendar app sees appointments there without re-entering them.

- **Push-only, one-way sync** — a real, deliberate scope decision, not a shortcut. Pulling the other direction (an event a provider adds directly in Google Calendar blocking a BookPilot slot) is a materially different feature — a polling or push-notification listener plus reconciling external events back into `blocked_slots` — and isn't implemented here. Also scoped to time-slot bookings only (a doctor/stylist appointment); a hotel stay's date *range* has no single obviously-correct event shape yet (all-day multi-day vs. separate check-in/check-out events are both defensible, and picking one is a product decision, not a default to guess).
- **`src/infra/calendarProviders/`** mirrors the payments integration's own shape (`CalendarProvider.js` documents the contract, `googleCalendarProvider.js` is the concrete Google implementation) — a second provider (Outlook/Microsoft Graph — `calendar_connections.calendar_type` already allows for it) could be added without touching `src/engine/calendarSync.js` or the dashboard routes.
- **OAuth 2.0 authorization-code flow with a signed, short-lived `state` parameter** (`src/infra/oauthState.js`, HMAC-signed the same way dashboard session tokens are) carrying which (tenant, workflow, provider) a connection request was for across the redirect to Google and back — both CSRF protection and the only way that context survives an external hop the session cookie alone wouldn't reliably preserve. A stored refresh token is encrypted at rest with the same `APP_ENCRYPTION_KEY`/AES-256-GCM scheme Section 8 established for WhatsApp credentials — never plaintext in the database file.
- **Fails open on infrastructure, fails closed on trust** — same posture as Section 9's payments: if Google Calendar isn't configured, or a sync call fails, the booking itself is completely unaffected (logged as `ERROR`, never blocking or retried into the customer-facing flow). A refresh token that Google has revoked is detected specifically (`invalid_grant`) and flips the connection to `needs_reconnect` rather than retrying forever or silently going quiet.
- **Live-verified the entire OAuth *plumbing*** against Google's real servers using a temporary, clearly-fake OAuth client: the "Connect" redirect built a correct, complete Google consent-screen URL; a forged/tampered `state` was rejected before any network call; a real authorization attempt against Google's real token endpoint came back with a real `401 invalid_client` (proving the exchange call itself is correctly formed and reaches Google) and was surfaced back to the dashboard as a clear error. **Not verified**: an actual successful token exchange and a real event landing in a real calendar — that requires a genuine Google Cloud OAuth client (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI`), which only the project owner can create in their own Google Cloud Console.

### Real-time dashboard (Section 11 — Phase 2)

A dashboard tab open on a booking list used to only ever learn about a new booking, a cancellation, or a support escalation by clicking Refresh. `GET /api/dashboard/events` (Server-Sent Events, not WebSockets — one-directional server→browser is all this ever needed, and `EventSource` reconnects on its own with zero client-side retry code) now pushes `booking.created`, `booking.updated`, `support_request.created`, and `feedback.created` the instant they happen, and the dashboard re-fetches just the relevant panel in response. A small dot next to the Refresh button (green when connected, grey otherwise) reflects the stream's actual state rather than being decorative.

- **`src/infra/dashboardEvents.js`** is the whole pub/sub layer — one process-wide `EventEmitter`, no external broker (no Redis, no new dependency), matching this codebase's consistent "no heavy deps unless the plan calls for it" stance. Every booking-state-changing call site (both in `server.js`'s dashboard routes and `src/engine/workflowEngine.js`'s customer-facing flow — creation, cancellation, reschedule, serve/complete, no-show, payment capture/failure, manual refund) publishes through one shared helper (`publishBookingEvent`) so every event's payload shape is consistent.
- **Tenant- and provider-scoped, not broadcast** — the SSE route filters every event server-side before it's ever written to a browser: a provider session only ever receives events for its own `(workflowId, providerId)` (or a workflow-scoped event like a support escalation, which isn't tied to one specific provider), never another provider's bookings even within the same tenant. An admin session sees every event for its own tenant, matching the same full-tenant visibility `GET /api/dashboard/all-bookings` already grants.
- **A sync failure never blocks the customer-facing flow** — `publish()` never throws (an `EventEmitter.emit()` with zero listeners, e.g. no dashboard tab currently open, is simply a no-op), so this is purely additive: nothing about how a booking is created, confirmed, or cancelled depends on whether anyone is watching the dashboard live.
- **Live-verified end to end**, not just unit-tested: opened a real authenticated SSE connection with `curl -N`, drove a real booking through `/api/simulate-whatsapp`, and watched the exact `booking.created` event (correct `workflowId`/`providerId`/full booking payload) arrive over the open connection in real time; same for a `booking.updated` event on cancellation. Separately verified the tenant/provider scoping live: a second SSE connection authenticated as a different provider (`medical`/`p2`) received *nothing* when a `hair`/`p1` booking was created — proving the server-side filter, not just trusting it exists. All test bookings and the temporary test account used for the isolation check were removed afterward.

### Security hardening pass (Section 12 — Phase 2)

An audit of the app's actual security posture — what's already solid, what genuinely needed a fix — rather than a checklist of controls bolted on regardless of whether this app's shape needs them.

- **`npm audit`: zero known vulnerabilities**, across all 70 dependencies (2 direct: `express`, `dotenv`; everything else transitive). A direct result of this project's consistent "no dependency unless the plan actually needs it" discipline — hand-rolled auth, rate limiting, backups, and now payments/calendar/SSE, rather than pulling in a package for each.
- **CSRF: verified the existing posture is already sufficient, not retrofitted with a token scheme.** The session cookie is `HttpOnly; SameSite=Lax` (`Secure` too once `NODE_ENV=production`) and the server only ever parses `application/json` bodies (`express.json()` — no `express.urlencoded()`), never CORS-enabled for any other origin. Together these close the classic CSRF vector for a JSON API: `SameSite=Lax` withholds the cookie from cross-site `fetch`/`XHR`, and a cross-site HTML form (which browsers *will* send without needing JS) can't produce a same-origin-passing `application/json` request body — so it simply lands as empty/ignored here. A dedicated CSRF-token middleware would add real complexity for protection this combination already provides; documented as a deliberate decision, not an oversight.
- **New standard header**: `Strict-Transport-Security` (1 year, `includeSubDomains`), gated behind the same `NODE_ENV==='production'` signal `setSessionCookie()` already uses for the cookie's own `Secure` flag — sending it over plain HTTP would be a no-op at best. Joins the existing `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and CSP set from Section 6.
- **A real, previously-unguarded resource-exhaustion gap, found and closed**: Section 11's SSE route had no limit on how many concurrent `/api/dashboard/events` connections one account could open — each holds a live socket plus a heartbeat timer for as long as it stays open. A small per-user cap (5 concurrent connections, `server.js`) now rejects a 6th with `429`. Live-verified: opened 5 real SSE connections as one account, confirmed a 6th was rejected, then confirmed a new connection was accepted again once the earlier ones closed (the counter actually releases, not just caps).
- **Audited every route added in Sections 9-11 specifically** (the newest code, least likely to have had a dedicated security pass yet) for the exact bug class Section 8 hit once for real (a client-suppliable `tenantId`/scope bypassing the query-layer isolation boundary — see `docs/ARCHITECTURE.md`'s invariant 1): confirmed none of them accept or trust a client-supplied `tenantId`, every one resolves it from `req.user.tenantId` (set only by `requireAuth()` from the verified session), the same pattern as every pre-existing dashboard route.
- **Input validation stays manual, per-route** (as Section 6 already decided and documented for the same reason) — no Zod/Joi introduced. Nothing in this pass's audit of the newer payment/calendar/SSE routes found a real gap a schema-validation library would have caught that manual checks didn't: numeric ids are validated with `Number.isInteger`, enums are checked against a fixed set, amounts are range-checked against the original payment, and every value that reaches SQL goes through a parameterized/prepared statement (never string-concatenated), the same discipline every store module in this project already follows. Revisit only if the route count grows enough that hand-written validation becomes the actual bottleneck — not before, per Section 6's original reasoning.
- **Encryption at rest — see the updated "PII, retention, and encryption at rest" section below** (the revisit that section's own text called for once Section 8's multi-tenant model shipped).

### Frontend rewrite — React via Vite (Section 13 — Phase 2)

A real React + Vite rewrite of the dashboard, built at `frontend/` and served at **`/app`**. It started deliberately alongside the existing hand-rolled `public/dashboard.html` at `/dashboard`, not as a replacement for it — both talked to the exact same `/api/dashboard/*` and `/api/auth/*` routes, no backend changes needed. Once it reached full feature parity (Item 4), `public/dashboard.html` was deleted; `GET /dashboard` now just redirects to `/app`, and `/app` is the only dashboard.

- **Why additive first, not an immediate cutover**: this dashboard runs a business with real bookings on it. Rewriting the entire UI surface in one pass and simultaneously flipping the default route it's reachable at would mean the very first time this new code sees production use is also the moment there's no working fallback if something's subtly wrong. `/app` got a real shakeout first, live-verified against real data (below), before the old one was removed.
- **Fully ported and live-verified against real data**: login/logout/forgot-password, the provider view (bookings list with filters, Serve/Complete/Cancel/Reschedule/No-show/Refund actions, Availability blocking, Calendar Sync connect/disconnect, Analytics with revenue), the admin view (All Bookings with search/filters, Manage Businesses with full add/edit/delete — including the AI-drafting modal and the templates marketplace's publish/install flow, live-verified end to end in a real browser session — Manage Team with add/deactivate, Support Requests, Feedback, Knowledge Base, Audit Log), and Section 11's live SSE updates (a `useLiveEvents` hook wrapping the same `EventSource` stream — the live-status dot and auto-refreshing panels work identically to the classic dashboard). `BookingsTable` renders one generic column set across every workflow (a "Details" column summarizing whichever of reason/age/gender/nights a booking actually has) rather than the classic dashboard's per-workflow column configuration — same information, differently organized, a deliberate simplification rather than a per-industry reimplementation.
- **`npm audit`: one known moderate vulnerability, in `esbuild` (via Vite's dev server only — GHSA-67mh-4wv8-2f99)**, accepted rather than silently ignored or forced into an untested major-version jump this late in the pass. It only affects `vite dev` (a malicious website could probe the dev server if a developer has it running and reachable); the actual production deployment serves Vite's static *build output* through Express (`express.static`), which this vulnerability doesn't touch at all. Revisit when upgrading to Vite 6+.
- **Live-verified end to end**, not just built successfully: logged in and out through the real `/api/auth/*` flow; browsed both the provider and admin views against the real, live database (correct filtering per selected provider, correct role-based scoping matching the backend's own rules); drove a real booking through `/api/simulate-whatsapp` and watched it appear in the UI **without a manual refresh** via the live SSE connection; found and fixed a real bug during this verification (feedback/support-request rows were mislabeling their business when an admin account browsed the provider view, since those two endpoints scope by account role rather than the UI's selected provider — fixed by building the label lookup from the full provider list rather than the single selected one, the same fix both views now share). All test bookings created during verification were deleted afterward.

### Public API & platform maturity (Section 14 — Phase 2)

A tenant's own website or backend system can now call BookPilot directly — `GET /api/v1/availability` and `GET /api/v1/bookings/:bookingId` — authenticated with a real API key (`Authorization: Bearer bpk_...`) rather than a dashboard session, issued and revoked from the dashboard's new "API Keys" panel (React app only, at `/app`).

- **`src/store/apiKeyStore.js`**: keys are `bpk_`-prefixed (the same recognizable-prefix convention Stripe/GitHub use, so a leaked key is identifiable in a log or a secret scanner), SHA-256 hashed at rest (a fast hash is the right call here, unlike password hashing — the key is already a cryptographically random 32-byte value, not a low-entropy human secret a fast hash would make brute-forceable). The real key is returned exactly once, at creation — the dashboard shows a one-time "copy this now" reveal and never displays it again, only its short prefix, matching how every real API-key product handles this.
- **Rate-limited per key** (60 requests/minute, `src/infra/rateLimit.js`'s `isApiRateLimited`), not per IP — a tenant's real backend may share an egress IP with other traffic, so the key itself is what actually identifies the caller. Live-verified: 60 requests succeeded, the 61st through 65th all got `429`.
- **Deliberately read-only — no write endpoints yet, and that gap is intentional, not silent.** `POST /api/v1/bookings` (create) and a cancel endpoint are not implemented in this pass: every booking write in this app goes through `src/engine/workflowEngine.js`'s `recordBooking()`, which is coupled to a conversational session (step-by-step validation, provider/date/time selection state) in a way that isn't yet factored into a reusable, session-independent function. Building a write path safely means either extracting that validation into something both the WhatsApp flow and the Public API can call (real, separate refactoring work) or accepting a second, easily-drifting copy of the same rules — neither is something to rush through alongside everything else in this pass. `GET /api/v1/availability` reuses the *exact* slot-computation function (`getAvailableSlots`, extracted from `workflowEngine.js` for this purpose) the conversational `select_time_slot` step itself uses, so at least the read side has zero risk of drifting from what the bot actually offers.
- **`GET /api/v1/bookings/:bookingId`** looks up by the tenant-issued booking id (e.g. `APT-20260101-XY12` — the same identifier a customer's own WhatsApp confirmation already shows them), not this app's internal numeric row id, and strips the customer's WhatsApp number (`waId`) from the response even for the tenant's own authenticated integration — the phone number stays internal-only.
- **Live-verified against real data**: created a real key via the dashboard, called both endpoints successfully (including a slot-availability check that correctly excluded a real existing booking's time), confirmed a missing, wrong, or revoked key all correctly get `401`, confirmed the rate limit trips exactly at request 61, then revoked every test key afterward — the dashboard's own "API Keys" list reflects the real, current state of each.

### Engineering maturity (Section 15 — Phase 2, final section)

The last section of the plan — not a feature, a set of decisions about how the codebase stays trustworthy as it keeps growing.

- **Types, without a TypeScript migration.** `src/types.js` holds JSDoc `@typedef`s for the core data shapes (`Booking`, `Payment`, `Tenant`, `User`, `ApiKeyRecord`); `jsconfig.json` at the repo root plus `npm run typecheck` (`tsc --noEmit`, TypeScript as a dev-only dependency — never a runtime one) turns those into real, CI-enforced type-checking. Deliberately **opt-in per file** (`// @ts-check` at the top), not project-wide — this codebase is almost entirely plain, un-annotated JS with no `@types/*` packages installed for its dependencies, and checking it wholesale would drown real findings in noise from missing third-party type declarations. `src/store/bookingStore.js` is the worked example; extending the same treatment to the rest of `src/store/`/`src/engine/` is real, independent, one-file-at-a-time follow-up work — nothing about this pattern requires doing it all at once, unlike a big-bang TypeScript conversion. Checking the worked example live caught two genuine (if minor) type issues — `lastInsertRowid` being `number | bigint`, and a `module.exports = X; module.exports.Y = Z` pattern TypeScript's CommonJS typing can't represent cleanly — both fixed, not suppressed.
- **CI** (`.github/workflows/ci.yml`): every push/PR against `main` runs the real backend test suite, the new typecheck, `npm audit --audit-level=high` (clean — see Section 12), and a frontend build (`frontend/`, Section 13) — two jobs, backend and frontend, running in parallel. No lint/format gate: none is configured in this repo, and adding one as a CI requirement without first agreeing on the actual rules would just be a wall nobody asked for.
- **Process-level crash safety** (`server.js`, registered before anything else runs): `unhandledRejection` is logged loudly and the process keeps running (every route handler already goes through `asyncHandler`, specifically so a rejected promise inside a *request* becomes a normal caught error rather than reaching here — a rejection that does reach this handler happened outside any request, e.g. a fire-and-forget call). `uncaughtException` is logged with full detail and the process then **exits** — Node's own guidance is that a synchronous throw escaping every `try`/`catch` leaves the process in an undefined state, and continuing to serve requests from it risks silent corruption; exiting lets a process manager (systemd, pm2, a container's restart policy) bring up a clean instance instead. Live-verified both paths with a real isolated script: an unhandled rejection logged and the process stayed alive; an uncaught exception logged and the process exited with code 1.
- **Request tracing** (`src/infra/tracing.js`, Node's built-in `AsyncLocalStorage` — no dependency): every incoming request gets a `requestId` (also returned as `X-Request-Id`) that automatically tags every `log()` call for that request's entire lifecycle, across every async hop — a Groq call, a DB write, a WhatsApp send — without threading a parameter through every function signature in the codebase. Live-verified against a real request: sent one `/api/simulate-whatsapp` call, and every resulting log line (intent detection, two separate Groq calls, the WhatsApp send attempt, the final "reply cycle took Nms" line) carried the exact same `requestId` — both in the human-readable log and the structured JSONL file, where the full UUID is preserved for grepping/joining.

### Go-live checklist (Item 7)

Self-serve signup (`POST /api/signup`, `public/marketing/signup.html`) creates a tenant + admin and logs them straight into `/app` — that part already existed. The gap it left: a brand new tenant landed in a full dashboard pre-populated with 5 unrelated demo businesses (haircut, hotel, makeup, medical, automobile) and zero indication of what to actually do next, or whether the demo data was theirs to keep or replace.

- **`GET /api/dashboard/setup-checklist`** (`SetupChecklistPanel.jsx`, pinned to the top of the admin dashboard) computes four go-live milestones from real, live tenant state — never a separately-tracked "wizard progress" that could drift from what's actually true:
  - *Customize your first business* — `tenantWorkflowStore.hasCustomizations()` (`src/store/tenantWorkflowStore.js`): true once any workflow row has been edited since the demo catalog was seeded, or the count of businesses has changed from the default 5.
  - *Connect your WhatsApp number* — true once the tenant has a real `whatsappPhoneNumberId` on file (Section 8.3).
  - *Invite your team* — true once more than just the founding admin exists (`users.list(tenantId).length > 1`).
  - *Get your first booking* — true once any booking exists for the tenant, real or simulated.
- **Dismissible, and the dismissal persists** — stored in the tenant's own `feature_flags_json` (Section 8's existing per-tenant config store, no schema change needed), scoped per tenant like everything else.
- **Deliberately not a 10-step modal wizard with its own autosave.** A stateful multi-step wizard needs its own progress-tracking storage that can drift from what's actually configured; a checklist computed fresh from real state every load can't drift, because it isn't storing an opinion about progress — it's reading the actual facts. Simpler, and arguably more honest about what "done" means.
- **Deliberately no "Sign up with Google"** in this pass. The plumbing this would reuse (`src/infra/oauthState.js`'s signed state tokens, `src/infra/calendarProviders/googleCalendarProvider.js`'s token exchange) already exists for Calendar Sync, but that flow requests Calendar API scopes for an already-logged-in admin connecting one provider's calendar — using Google OAuth to authenticate account *creation* itself is a different scope (identity/userinfo) and a different decision (match-by-email into an existing tenant vs. create a new one), not a one-line extension of the calendar flow. Real, separate work — flagged here rather than left unmentioned.
- **Live-verified**: signed up a fresh tenant, confirmed all 4 items start false; edited a business and watched "customize your first business" flip to done on the next load; dismissed the panel and confirmed it stayed dismissed after a real page reload. `tests/http/setupChecklist.test.js` covers the same ground at the HTTP layer, including that a second tenant's checklist and dismissal state are both untouched by the first tenant's actions.

### Live demo surface (Item 8)

`/api/simulate-whatsapp` (above) is a dev/test tool — it trusts a client-supplied `tenantId`, which is exactly right for local testing but would be a real cross-tenant injection risk if it were ever reachable by the public (anyone could pass another tenant's real id and inject fake messages into their live conversation). Rather than relax that endpoint for public use, the marketing site's live chat widget (`#demo` on `/`, `public/marketing/script.js`) talks to a separate, purpose-built route instead:

- **`POST /api/demo/chat`** (`server.js`) always targets one dedicated, permanent demo tenant (`DEMO_TENANT_ID`, bootstrapped idempotently at startup via a well-known slug — never the upgrade-continuity fallback tenant id 1, which could be a real single-tenant install's actual business) — the tenant is never read from the request, so there's no way to point this route at real data even in principle. Rate-limited per IP (`src/infra/rateLimit.js`'s `isDemoChatRateLimited`, 30 messages / 5 minutes) since it's unauthenticated by design. A visitor's conversation is keyed by a random per-tab `sessionId` (generated client-side, stored in `sessionStorage`, gone when the tab closes) hashed into a synthetic id — never treated as, or shaped like, a real WhatsApp number.
- **The widget itself** reuses the existing scripted-replay phone mockup's visual language (same bubble/typing-dot CSS) but is a genuinely live conversation: typing a message calls the real `workflowEngine.js` pipeline (AI classification, real availability, the actual demo catalog's providers) and renders whatever the bot actually says — including its real limitations (e.g. without a configured `GROQ_API_KEY`, free-text provider names fall back to keyword matching the same way they would for a real tenant in the same situation). Honest, not staged.
- **Live-verified**: drove a real multi-turn conversation through the widget in a real browser session (classified "haircut" correctly, listed real providers, correctly persisted session state turn to turn), confirmed both requests hit `/api/demo/chat` and returned 200, confirmed no horizontal overflow at mobile width. `tests/http/demoChat.test.js` covers the rate limit, input validation, and — the actual point of this route's design — that a client-supplied `tenantId` has no effect on which tenant gets touched.
- **Deliberately not built in this pass: a read-only demo dashboard with a guided tour.** This is a separate, large UI feature (a temporary login-free viewing session, tour/tooltip UI anchored to every existing dashboard panel, and a real decision about how to make dozens of existing mutating routes safely no-op for a demo viewer without either a cross-cutting middleware change or relying on client-side-only enforcement) — not a small extension of the chat widget above. Flagged here rather than silently left out.

### Core AI hardening (Item 9)

- **Loop detection.** An explicit complaint or "talk to a human" ask already escalated to a real `support_requests` row after a second attempt (Section 3's soft-redirect-then-escalate design). A customer who was simply *stuck* — sending unmatched or off-script replies without ever saying so in those words — didn't: they got the exact same "I couldn't understand that" + re-prompt every time, forever, with no escalation path. `session.confusionCount` (`src/engine/workflowEngine.js`) now tracks *consecutive* unclear replies across both places a customer can get stuck (the top-level "what business do you want" classification, and a mid-flow step's invalid-input fallback), resets the moment they actually get somewhere (a successful classification, a factual answer, a valid step reply), and reuses the exact same `support_requests` escalation mechanism the complaint path already had at 3 consecutive misses — one shared escalation system, not two parallel ones. `tests/http/loopDetection.test.js` proves the threshold, the non-escalation below it, and that a successful reply mid-streak resets the count rather than just delaying escalation.
- **Business-hours awareness.** `workflow.businessHours` already gated which time slots existed and answered "what are your hours?" — but "Today" always appeared as a tappable date option regardless of whether any slots were actually left in it. A customer messaging after closing (or between the last slot and closing) could tap "Today" only to be told "No more slots available for that day" one step later. `filteredDateOptions()` now excludes "Today" up front whenever `getAvailableSlots`-equivalent logic (`timeSlotsFor`) would return none — but only for a date field a `select_time_slot` step actually consumes (matched by `dateField`, the same link `select_time_slot` itself uses); a hotel's check-in date has no time-of-day component at all, so the check correctly never applies to it. `tests/http/businessHoursAwareness.test.js` proves both halves: "Today" disappears once fully blocked for a time-slot workflow, and stays exactly where it was for a hotel's check-in date.
- **Deliberately not built in this pass: prompt versioning + golden transcripts + a CI eval suite, and exposed "confidence signals."** Real, valuable, and genuinely separate infrastructure — a way to version `src/ai/*`'s prompt templates, a library of reference conversations checked against expected outputs on every change, and CI wiring for it, plus surfacing the AI's own confidence (e.g. distinguishing a keyword-fallback classification from a confident AI one further than the `source` field already logged) somewhere a dashboard user could act on it. Neither is a small extension of loop detection or business-hours awareness; both are flagged here rather than silently left out.
- Full backend suite (187 tests) and typecheck pass; both fixes live-verified through the real conversational pipeline (loop detection via the public demo widget with properly sequenced requests; business-hours awareness via a real conversation after blocking out a provider's entire day).

### Timestamps and logs

Everything logged (`src/infra/logger.js`) is timestamped in IST (`Asia/Kolkata`),
regardless of what timezone the server itself runs in — a booking business
reading its own logs shouldn't have to mentally convert UTC. Every `log()`
call writes two lines: the existing human-readable one to `logs/app.log`
(and the console), and a structured JSON one to `logs/app.jsonl` — the
latter is what anything shipping logs to a real backend later (Datadog,
CloudWatch, etc.) would tail instead of regex-parsing free text. There's no
actual shipping integration here — no credentials to configure one against
— so this is scoped honestly as "structured and queryable locally," not
"already wired to a SaaS."

**Basic alerting** (`src/infra/alerting.js`): every `ERROR`-level log is counted
in a 5-minute rolling window; 10+ within that window logs a single loud
`ALERT` line (cooldown of 15 minutes so a sustained outage logs one alert,
not one per error). Admin-only `GET /api/dashboard/alerts` surfaces that
error rate alongside the outbound-queue failure rate (see Data layer
above) in one place. This is intentionally a local, in-process signal for
an operator watching logs or the dashboard — not a paging/on-call
integration.

### Post-booking commands

Once a booking is confirmed, its record survives in the database even after
the conversation session ends, so these work anytime afterward, from any
stage:

- **STATUS** — for a time-slot booking (medical/hair/makeup): date/time and, for a same-day appointment, a **live** queue position (`src/store/queueStore.js`) — recomputed on every check, not a count fixed at booking time. A provider marking a booking "Serve" then "Complete" on the dashboard immediately and correctly shifts everyone behind them down a position; verified live with a real 3-person queue (serve+complete the first booking, confirm the second's position drops to 0 and the third's drops from 2 to 1). Whoever newly reaches position 0 gets a proactive "you're next" WhatsApp alert, sent once per booking (`STOP ALERTS`/`START ALERTS` to opt out), via `sendWithRetry()` — a couple of immediate retries, then the durable outbound queue (see Data layer above) if those still fail, so a transient send failure doesn't just silently vanish even across a restart. For a hotel booking: check-in/check-out dates.
- **HERE** — marks the booking as arrived.
- **MENU** / **restart** — abandons whatever's in progress and starts fresh.
- **Post-appointment feedback** (`src/store/feedbackStore.js`) — marking a booking "Complete" on the dashboard (optionally with a note for the customer — follow-up care, next-visit advice) sends a WhatsApp message with that note plus a feedback ask. The customer's very next free-text reply is captured as feedback linked to that specific booking — checked *before* intent detection/business classification even run (same principle as the conversation-history mechanism above, reused rather than building a second context system), so it can never get misrouted as a new booking attempt. One-shot by design: the "awaiting feedback" flag clears on capture, so there's no repeated nudging. Visible on the dashboard per booking, with an average rating rolled into Analytics. Verified live end to end: complete with a note → real WhatsApp message sent → customer replies "5 stars, loved it!" → captured with `rating: 5` against the correct booking.

These are workflow-agnostic — any workflow that records a booking gets them
for free.

### Provider dashboard

`GET /app` (`frontend/`, a React + Vite SPA built into `public/app/` and
served statically by `server.js`) — one app, one set of API endpoints.
The bookings table (`BookingsTable.jsx`) uses one generic column set
across every workflow type, with a "Details" column summarizing whichever
of reason/age/gender/nights a booking actually has — a doctor's booking
and a hotel room's booking don't share a shape, so rather than a
per-workflow column config (`PROFILES`, in the now-deleted
`public/dashboard.html`), the extra fields are just folded into one
column. Same information, no dashboard code change required to support a
new `workflows/*.json` business type.

**Real login, real roles.** Every dashboard user is a row in the `users`
table (`src/store/db.js`) with a role — `admin` or `provider` — and a signed
HttpOnly session cookie (`src/infra/auth.js`, HMAC over a JSON payload, no JWT
library needed). There's no shared access key anymore: `SESSION_SECRET`
signs sessions, `ADMIN_BOOTSTRAP_EMAIL`/`ADMIN_BOOTSTRAP_PASSWORD` create
the first admin account on first boot (see `.env.example`), and that admin
creates provider accounts from there.

- **Provider** accounts are pinned to exactly one `workflowId` + `providerId` at creation time. Every dashboard API route enforces this server-side — a provider's `GET /api/dashboard/bookings` request ignores any `workflowId`/`providerId` it's sent and uses the session's own instead, so there is no way to read another provider's bookings by editing the URL. `/api/dashboard/providers` returns only their own entry, not the roster. The Admin toggle is hidden from their UI entirely (defense in depth on top of the server-side check, not a substitute for it).
- **Admin** accounts see everything: all bookings across every business (`GET /api/dashboard/all-bookings`), can manage workflows (`GET/POST /api/dashboard/workflows`, `DELETE /api/dashboard/workflows/:id` — add/edit/remove a business without touching JSON files by hand, though the modal still edits raw JSON under the hood), and can read the audit log (`GET /api/dashboard/audit-log`).
- **Audit log** — every login/logout and every availability block/unblock and workflow create/update/delete is recorded in `audit_log` (actor email, role, action, JSON detail, timestamp) and visible to admins in the dashboard's Audit Log card.
- **AI Workflow Generator** — describe a business in plain language ("a car wash with two bays, appointments by the hour") and Groq drafts a complete workflow JSON matching the existing schema (`src/ai/workflowGenerator.js`). It only *drafts*: the result lands in the same Add Business modal used for hand-written JSON, the admin reviews/edits it, and saving still runs the same `validateWorkflowShape()` check. A saved workflow is live for the WhatsApp bot immediately, no restart.
- **Marketplace** — publish any working business as a reusable template (shared across every tenant — `src/store/templateStore.js`), then install it as a brand-new business owned by whichever tenant installs it (`src/store/tenantWorkflowStore.js`). Installing *copies* the config rather than referencing it, so editing the installed business never mutates the template (and a template edit never silently changes a live business mid-booking-season). Admin only, since installing goes live for that tenant's bot immediately.
- **Analytics** — bookings-over-time trend, most-booked time slots, busiest weekdays, status breakdown, per-provider performance, and a no-show estimate (`src/engine/analytics.js`), rendered as inline CSS bars with no chart library (a CDN script would be blocked by this page's CSP anyway). Same role scoping as everything else: a provider sees only their own numbers. Computed on read rather than kept as running counters — at this data size the scan is microseconds, and a counter that can drift from the rows it summarizes is a worse problem than the scan it saves. The no-show figure is explicitly labelled a floor, not an exact number: the bot only learns attendance when a customer texts HERE, so "never marked arrived" overcounts.
- **Multilingual Voice AI** — set `SARVAM_API_KEY` and a customer can send a WhatsApp voice note in any of ~23 Indian languages (`src/infra/voice.js`). It's transcribed by Sarvam, run through the **exact same** text pipeline a typed message uses (so spoken bookings get identical validation, slot locking, and double-booking protection — nothing about booking correctness depends on the audio path), and the reply is spoken back in the language they used. Verified live end-to-end in Hindi: speech → transcript → correct workflow classification → spoken reply. Every failure mode degrades to text rather than dropping the message: no key, an unsupported TTS language (Sarvam synthesizes 11 of the 23 it transcribes), or a synthesis error all still send the full text reply. Implemented via a reply-capture hook in `whatsapp.js` rather than threading a "speak this" flag through every engine call site — the booking engine is entirely unaware voice exists.
- **Agentic Orchestration** — when a customer says something mid-booking that doesn't fit the step they're on, an AI planner picks the right recovery action instead of replying "invalid input" in a loop (`src/ai/orchestrator.js`). **Deliberately not free-form tool calling against the database**: this system's guarantees (no double-booking, validated fields, confirmation before any write) come from the deterministic engine owning every write, and an LLM that could call `create_booking` directly would put those behind a model's judgment on every turn. So the planner chooses only from a closed set of *navigation* intents — `retry_step`, `answer_question`, `go_to_step`, `cancel`, `restart`, `human` — and the existing engine still executes them. A model-supplied step index is treated as untrusted: it's range-checked and can never jump *forward* past unanswered steps (which would skip required fields). Anything outside the allowed set is rejected and falls back to the old retry behavior — verified live when the model invented a `change_doctor` action and the guardrail caught it. Real fix, tested: "actually, how much does Dr Sharma charge?" asked halfway through booking now gets answered (₹500) and re-prompts the date, where it previously looped.
- **Knowledge Base (RAG-lite)** — FAQs, policies, and pricing an admin or provider adds per business, which the bot answers customers from (`src/store/knowledgeStore.js`, folded into `factualQA.js`'s grounded prompt). Providers can edit their *own* business's entries — unlike workflow config, answering "do you take insurance?" is the provider's own domain knowledge. The same "only answer from this data, else say NO_ANSWER" discipline applies, so an unanswerable question still falls back to the business menu rather than an invented answer. Deliberately context-stuffed rather than vector-retrieved: at a handful of businesses with modest FAQ lists the whole base fits in one prompt, and per-document (1500 char) + total (6000 char) caps keep it bounded. Vector search becomes worth its dependency and retrieval-miss failure mode only well past that size. (Section 6: the save endpoint used to allow up to 5000 chars per document, silently truncating anything `factualQA.js` would actually use down to 1500 at query time — an admin could save a long policy and never learn most of it was invisible to every customer question. Both caps now share one constant, enforced with a clear 400 at save time instead of a silent truncation. Verified live.)
- **Bookings** — table of everything booked for the selected provider (or, in Admin mode, every business), filterable by status and date, reading straight from the same SQLite the bot writes to (refresh the page / click Refresh to see new WhatsApp bookings — there's no push/live-update).
- **Availability** — block a specific slot or a whole day; removing a block un-blocks it. Changes apply to the WhatsApp bot's offered slots immediately, since it's the same database, not a sync step (verified live: a block created in the dashboard was excluded from the bot's slot list on the very next message). Not shown for hotel rooms — see Availability above. A provider can only remove their own blocks — deleting someone else's block id returns 403.

Patient details (age/gender/reason) are now persisted to the bookings
table, not just shown in the WhatsApp confirmation message and then
discarded — a real gap found and fixed while building this (with a safe
migration for anyone with an existing `data/bookpilot.db` from before this
fix — verified live against a simulated old-schema database, no data loss).

**Migrating from the old `DASHBOARD_ACCESS_KEY` scheme?** That env var is gone. Set `SESSION_SECRET` (generate one — see `.env.example`) and either `ADMIN_BOOTSTRAP_EMAIL`/`ADMIN_BOOTSTRAP_PASSWORD` (fresh install) or insert an admin row directly via `src/store/userStore.js`'s `users.create()` (existing install, users table not empty). `DASHBOARD_ACCESS_KEY` is no longer read anywhere and can be removed from `.env`.

---

## Getting it running

Full step-by-step (what you need, installing, getting a free Groq key and
WhatsApp test number, exposing your local server with ngrok, pointing
Meta's webhook at it, running it, and running the test suite) now lives
in [`docs/SETUP.md`](docs/SETUP.md) rather than duplicated here — one
canonical setup doc instead of two that can drift out of sync with each
other. The short version: `npm install`, `cp .env.example .env` and fill
it in, `node server.js`.

---

## Testing without a real WhatsApp number yet

```bash
curl -X POST http://localhost:8081/api/simulate-whatsapp \
  -H "Content-Type: application/json" \
  -d '{"from":"911234567890","text":"I need a hotel room for 2 nights"}'
```

The reply is printed to the console and saved to `logs/app.log`. Since curl
can't tap a button, each simulated list/button prompt logs its options with
`[reply with: <id>]` — POST that id (or, for `select_provider`, the plain
number) as the next `text` to keep the conversation going. On real WhatsApp
you just tap.

## Automated tests

```bash
npm test
```

Uses Node's built-in test runner (`node --test`, Node 18+) — no test framework dependency, matching this project's "no native/heavy deps" approach elsewhere (`node:sqlite` instead of `better-sqlite3`, hand-rolled auth instead of `jsonwebtoken`/`bcrypt`). Tests live in `tests/`, isolated from real data via `DATA_DIR` overrides (never touches `data/bookpilot.db`). Covers: Groq call timeouts (including a forced-hang integration test proving the full pipeline never blocks indefinitely), keyword-vs-LLM intent priority, symptom-to-specialty matching, and the support-escalation flow.

---

## Production readiness

What's already in place:

- **Interactive UI** — providers/options are native tappable WhatsApp lists/buttons, not "reply with a number."
- **Webhook signature verification** — set `WHATSAPP_APP_SECRET` and every webhook POST is HMAC-verified against Meta's `X-Hub-Signature-256` header; invalid requests are rejected with 403. Without it, the server logs a startup warning and accepts unsigned requests (fine for local dev only).
- **Duplicate delivery protection** — Meta retries webhook deliveries; `src/infra/dedupe.js` ignores messages it's already processed.
- **Rate limiting** — `src/infra/rateLimit.js` drops (silently, no reply) any single WhatsApp id sending more than 20 messages/minute, so one abusive sender can't burn through the Groq quota or hammer the DB.
- **Dev endpoints don't leak into production** — `POST /api/simulate-whatsapp` auto-disables once `WHATSAPP_APP_SECRET` is set (it's unauthenticated by design, which is an impersonation risk — anyone could POST a real customer's WhatsApp id and read their booking back). The dashboard has real per-role authentication instead (see [Provider dashboard](#provider-dashboard)), since unlike the simulate endpoint it's meant to be used in production.
- **Explicit request size cap** on the JSON body parser (100kb) — stated intentionally rather than left as an implicit Express default.
- **Session persistence** — conversations survive a restart via SQLite (`src/store/sessionStore.js`, a `sessions` table — see Data layer above; migrated off the original JSON file store in Section 5.2, which one-time-imports any pre-existing `logs/sessions.json` on first startup).
- **On-demand session revocation for admins** — `PATCH /api/dashboard/users/:id` with `{ active: false }` deactivates an account, and `requireAuth()` re-checks that flag against the DB on *every* request rather than trusting the signed cookie's payload — so a compromised or unwanted session dies on its very next request, not whenever its (up to 12h) token would have expired naturally. Deliberately not a separate token-blocklist/session-versioning mechanism alongside this: the active flag already gives an admin real, immediate revocation power, and building a second parallel system to do the same job would just be two places that have to agree instead of one.
- **Self-serve password reset** (Section 6) — before this, a lost password meant an admin had to re-create the account via `users.create()`, which doesn't even work for the one admin on a single-admin install. `POST /api/auth/forgot-password` issues a single-use, 1-hour token (only its SHA-256 hash is ever stored, `src/store/passwordResetStore.js` — same discipline as password hashing itself) and "emails" a reset link; `POST /api/auth/reset-password` consumes it. Returns the identical response whether or not the email has an account, and is rate-limited the same way login attempts are (keyed separately) — both close the same kind of probing/abuse a real reset endpoint has to guard against that a "does this account exist" 404 would open up. **The email delivery itself is simulated** (`src/infra/emailSender.js`, logs the link instead of sending — this project has no email provider credentials or dependency, mirroring exactly how `sendWhatsAppText()` degrades when `WHATSAPP_TOKEN` isn't set); everything else — token generation, hashing, expiry, single-use enforcement, the actual password change — is real and tested (`tests/passwordReset.test.js`), and verified live end to end through the dashboard UI (request → simulated email → reset link → new password → old password rejected, new one works).
- **Every Groq call has a hard timeout** (`src/ai/groqClient.js`, ~5s default, overridable via `GROQ_TIMEOUT_MS`) — a single shared wrapper used by `classify.js`, `intentDetector.js`, `factualQA.js`, and `orchestrator.js` so this is one place to get right, not four copies of `fetch()` boilerplate that can drift. Before this existed, a hung Groq response could block a customer's entire message indefinitely with no reply at all; now every call aborts on timeout and falls through to its own keyword/deterministic fallback. Verified live (real Groq calls, `GROQ_API_KEY` set): p50 ~1.1s, p95 ~1.8s end-to-end reply time. A forced-timeout integration test (`tests/latencyIntegration.test.js`) proves the full pipeline still replies within a bounded window even when Groq is completely unreachable, not hung forever.
- **Response-time telemetry** — every message's end-to-end handling time is logged and kept as an in-memory p50/p95/max (`src/infra/perf.js`, resets on restart — it's operational signal, not business data worth a schema). Visible on the dashboard's Analytics card so a latency regression is seen, not just felt.
- **WhatsApp typing indicator** — sent immediately on message receipt, before any AI call starts, so the customer gets feedback during the 1-2s processing window instead of silence.
- **Health check** — `GET /health` for uptime monitoring / load balancer probes.
- **Fail-loud config** — missing `WHATSAPP_APP_SECRET`/`WHATSAPP_VERIFY_TOKEN`/`GROQ_API_KEY`/`SESSION_SECRET` log clear warnings at startup instead of failing silently later; missing `SESSION_SECRET` specifically is logged as an error, since no one can log into the dashboard without it.
- **Crash handling** — uncaught exceptions are logged and the process exits (run it under a process manager so it restarts); unhandled rejections are logged without killing the process.
- **Stored-XSS hardened** — customer-typed fields (name, reason) go straight from WhatsApp into the database with no sanitization by design (so WhatsApp confirmations/STATUS show exactly what the customer typed), which means anything that renders them into the dashboard's HTML has to escape them at render time or a message like `<img src=x onerror=...>` as a "name" executes in the admin's browser. Originally found live and fixed via a hand-rolled `escapeHtml()` in the old `innerHTML`-based dashboard; the React dashboard (`frontend/`) gets this for free structurally — JSX escapes every interpolated value by default and nothing in the app uses `dangerouslySetInnerHTML`, so there's no render path left where this bug class could recur. Free-text fields are also capped at 200 characters at write time (`src/engine/workflowEngine.js`).
- **Security headers** — `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, and a `Content-Security-Policy` are set on every response (`server.js`). CSP's `script-src` is `'self'` with no `'unsafe-inline'` — the React app and marketing site both load JS from external files only, so an injected inline `<script>` is actually blocked, not just discouraged (that concession was only needed for the old hand-rolled dashboard's one inline `<script>` block, deleted in Item 4). `style-src` still needs `'unsafe-inline'` for React's `style={{...}}` attributes, which CSS can't turn into executable script. CSP also blocks any externally-loaded script/frame/object and clickjacking via `frame-ancestors 'none'`.
- **No stack traces leak to clients** — a catch-all error handler logs the real error server-side and always returns a generic JSON 500, regardless of `NODE_ENV`; unmatched routes return a JSON 404 instead of Express's default HTML page.
- **Async route handlers can't silently hang the client** — this project uses Express 4, which has no built-in awareness of async/await: a rejected promise inside an `async (req, res) => {...}` handler does NOT reach the error-handling middleware the way a synchronous throw does, it becomes an unhandled rejection instead, and the client is left waiting on a response that will never arrive. Found live: a typo (`ReferenceError`) inside the bookings PATCH route hung a real request for its full timeout with nothing ever sent back. `asyncHandler()` (`server.js`) wraps the vulnerable route so a thrown error there now reaches the error middleware and gets a real response like everywhere else. This class of bug is exactly what Section 15.3's future centralized error-boundary middleware generalizes — this is the scoped, immediate fix for the one route it was live-caught in, not a claim every async route is audited yet.
- **No silent failures** — the webhook handler, `/api/simulate-whatsapp`, and voice message handling all guarantee the customer gets a reply even when something throws internally ("Sorry, something went wrong — could you try that again?") before the error is logged. Found live: a thrown error used to only be logged, meaning several consecutive customer messages — including a real symptom report — got zero reply at all.
- **Keyword signal wins over the LLM for cancel/status specifically** (`src/ai/intentDetector.js`) — if `CANCEL_RE`/`STATUS_RE` unambiguously match and the LLM disagreed, the keyword result is used. A false negative on "cancel my booking" is worse than a false positive on a softer intent. Verified live: "JITNE V BOOKING AHIA MERE NAAM PE SAB CANCEL KRDO" (Hinglish for "cancel all bookings under my name") now correctly cancels the booking end to end.
- **Hindi/Hinglish coverage** for cancel, status, and symptom phrasing — this platform targets the Indian market (see the multilingual voice feature), and Hinglish is the normal case, not an edge case.
- **Real human escalation** (`src/store/supportRequestStore.js`) — a customer asking for a person twice used to get the same canned refusal forever, with nothing anywhere for a provider to see. Now it writes a row to a `support_requests` table, visible and resolvable on the dashboard (both admin and per-provider), and surfaces a workflow's `supportContact` field if one is configured.
- **Symptom-to-specialty hint** — a symptom report ("MUJHE BUKHAR HUA HAI") suggests the most relevant doctor by matching symptom keywords against each provider's `attribute` field, shown as a hint alongside — never instead of — the full provider list. Deliberately not auto-selected: the existing grounding check that prevents provider-name hallucination structurally can't (and shouldn't) pass for a message that never names a doctor.
- **Tone-aware replies** — a genuine complaint ("this is terrible") gets an apology; a neutral "can I speak to support" doesn't get told "sorry to hear that" when nothing was said to be sorry about. A price objection at the confirm/review steps gets acknowledged before repeating the button prompt, instead of a flat "please tap Continue or Choose Another."
- **"Are you a bot?" gets one honest, consistent answer** — hardcoded, not left to whatever an LLM guesses that turn.
- **Contextual follow-ups** — a direct follow-up to the bot's own last reply ("is it for today or another day?" right after STATUS) gets answered specifically instead of the exact same static block repeated verbatim. Session-level conversation history (last 5 turns, `src/engine/workflowEngine.js`) feeds `tryAnswerAboutBooking()` (`src/ai/factualQA.js`). Found and fixed two real bugs chasing this live: the follow-up gets classified `CHECK_STATUS` again by the LLM (reasonably — it does mention a date), which used to always re-run the static STATUS command; and the first fix for that answered confidently **wrong** ("it is for today") for a booking three weeks out, because the model was never told what today's actual date is. Verified live in both directions (a future booking correctly says "another day," a same-day booking correctly says "today") and covered by tests that run against the real Groq API when `GROQ_API_KEY` is set.
- **`TRUST_PROXY`** — unset by default, since blindly trusting `X-Forwarded-For` with no reverse proxy in front would let a client spoof its own IP straight through the login rate limiter. Set `TRUST_PROXY=1` in `.env` once there's a real reverse proxy in front (see below).

Before real production traffic:

- **Get a permanent WhatsApp token.** The Meta test token expires every 24 hours — set up a System User token in Meta Business Settings instead. (If `logs/app.log` shows `401 OAuthException` on outbound sends, this is why — and as of Section 6, the server also checks the configured token against the Graph API once at startup and logs a loud `ERROR` immediately if it's already expired, rather than waiting for a customer's message to silently fail to send.) To get one that doesn't expire:
  1. [business.facebook.com/settings](https://business.facebook.com/settings) → **Users → System Users** → **Add** → create one (Admin access).
  2. **Add Assets** → assign it your WhatsApp Business App with Full Control.
  3. **Generate New Token** on that System User → select the app → check the `whatsapp_business_messaging` and `whatsapp_business_management` permissions → Generate.
  4. Copy the token into `WHATSAPP_TOKEN` in `.env` and restart the server. This token doesn't expire on its own (it's revoked only if the System User, app, or permission is removed) — no more 24-hour cycle.
- **Set `WHATSAPP_APP_SECRET`.** Without it, anyone who finds your webhook URL can send the bot fake messages.
- **Set `SESSION_SECRET`** before the dashboard is reachable from outside your own machine — without it nobody can log in, but the moment it's set anyone who guesses/brute-forces a password is only slowed down by the login rate limiter, not stopped. Use real passwords.
- **Run behind a real reverse proxy / TLS**, not ngrok (ngrok is fine for development) — session cookies only get the `Secure` flag when `NODE_ENV=production`, and that flag is meaningless without HTTPS in front of it. Set `TRUST_PROXY=1` at the same time so the login rate limiter keys on the real client IP instead of the proxy's.
- **Run under a process manager** (PM2, systemd, or a container restart policy) so a crash auto-restarts the server.
- **Rotate any keys that were ever shared outside this repo** (e.g. pasted into a chat, a screenshot, or a support ticket) — treat that as exposure and regenerate from the Meta/Groq dashboards.
- **Ship backups off-box.** Automated, verified backups now exist (see Data layer above), but they land on the same disk as the live database — copy `BACKUP_DIR` somewhere else (S3, another machine) for real durability against a lost/corrupted disk, not just accidental data loss.

### PII, retention, and encryption at rest (Section 6)

Documenting the actual current state and the decision behind it, not
implementing new controls — this platform handles real personal (and for
the medical workflow, health-adjacent) data, so what's stored and for how
long should be written down rather than left implicit.

**What's stored, and where:** WhatsApp phone number (`wa_id`), customer
name, age, gender, and a free-text `reason` field (which for the medical
workflow is effectively a self-reported symptom) — all in `bookings`
(`data/bookpilot.db`). Free-text feedback ratings/comments (`feedback`
table). None of it is encrypted at the *field* level; it's exactly as
readable as the SQLite file itself.

**Retention:** indefinite, by default — nothing currently deletes old
bookings, feedback, or sessions on any schedule. A cancelled or long-past
booking stays in the database forever, same as an active one. This is a
real decision to make explicit rather than leave as an accident: for a
regulated context (health data especially), "keep everything forever" is
often not compliant, but *how long* is a business/legal decision this repo
can't make on a business's behalf — there's no universal right answer, and
guessing one and silently deleting real records on a schedule nobody
asked for would be its own kind of harm. If a retention window is needed,
the natural place to add it is a scheduled job alongside `scheduleBackups()`
(`src/infra/backupStore.js`) that hard-deletes (or anonymizes — clears
`customer_name`/`age`/`gender`/`reason` while keeping the booking row for
analytics) bookings past a configurable age.

**Encryption at rest — revisited for Section 12, now that Section 8's
multi-tenant hosted model is real.** The verdict from Section 6 still
holds for the *file itself*: `data/bookpilot.db` is a plain SQLite file —
anyone with filesystem access to the host (or a copy of the file,
including a backup) can read every row, no key required. `node:sqlite`
(zero native-module dependencies — see Data layer above) has no built-in
encryption; swapping to SQLCipher would reintroduce exactly the
compile-step native dependency it was chosen to avoid, for protection
against a threat (a stolen disk/device) host-level disk encryption
already covers on every mainstream cloud provider by default. That
tradeoff is unchanged, so whole-file encryption remains a deliberate
non-goal.

What **has** changed since Section 6: this is no longer "every secret
lives in `.env`, only the host's disk protects the DB file." Section 8
introduced real per-tenant secrets stored *in* the database (each
tenant's own WhatsApp access token), and Section 10 added a second kind
(a connected provider's Google Calendar refresh/access tokens) — both are
now encrypted at the *column* level with AES-256-GCM
(`src/infra/secretsEncryption.js`, one app-level key from
`APP_ENCRYPTION_KEY`) before ever reaching the database file, so a raw
copy of `bookpilot.db` alone is not enough to reuse a tenant's WhatsApp
number or a provider's calendar access — the encryption key (kept only in
`.env`, never in the DB) is also required. This is intentionally
selective, not a blanket "encrypt everything" pass: it covers the fields
whose exposure lets someone impersonate a business or access a *third
party's* system (Meta, Google) on the tenant's behalf. Booking PII (names,
phone numbers, the medical workflow's health-adjacent free-text `reason`
field) is deliberately **not** column-encrypted — it's this app's own
data, read on every dashboard page load and every WhatsApp STATUS reply,
and field-level encryption there would mean decrypting on nearly every
read for protection host-level disk encryption already provides against
the same threat (a stolen disk), while adding real complexity (key
rotation, encrypted-field search/filtering, backup/restore handling) for
a threat model — an attacker with a live shell on the app server itself —
that column encryption of stored secrets doesn't stop either, since the
decryption key has to live somewhere the running process can reach it.

---

## Roadmap (from the BookPilot AI PRD)

Phase 1 covered the core mechanism — real availability/conflict tracking
backed by SQLite, a config-driven workflow engine, a provider dashboard.
Phase 2 (Sections 8-15) turned that into a real multi-tenant platform:
multi-tenancy and a platform-admin role, real payments (Razorpay), Google
Calendar sync, a live SSE-powered dashboard, a security hardening pass, a
React/Vite frontend rewrite, a Public API with its own API-key auth, and
the engineering-maturity layer (typed core modules, CI, process crash
safety, request tracing) this section itself describes. Every one of
those is covered above with what's live-verified and what's explicitly
scoped out — this section is what's still genuinely **not built**, across
both phases:

- **Email verification / MFA for the dashboard** — login is real (per-user password + signed session + RBAC + audit log), and self-serve password reset exists (see below). MFA specifically remains out of scope: it's a genuinely separate, security-sensitive feature (TOTP secret generation/verification, recovery codes, an enroll/disable flow) that deserves its own dedicated design and testing pass, not something bolted on alongside everything else. Email verification (confirming a new account's email address is real) is a smaller, related gap also not yet built.
- **A real calendar-picker UI on WhatsApp** — `select_date` is a tappable list of upcoming days, the most WhatsApp's standard interactive messages support. An actual date-picker widget needs WhatsApp Flows (Meta app review, a hosted encrypted data-exchange endpoint) — a separate, materially larger feature.
- **Hotel availability blocking** — bookings/conflict-checking work for hotels, but the provider-side "block this off" control doesn't (single-day block model vs. date-range stays — see Availability above). Section 10's calendar sync and Section 14's Public API both carry the same hotel exclusion for the same underlying reason.
- **Public API write endpoints** (Section 14) — creating or cancelling a booking via `/api/v1/*` isn't implemented; see that section's writeup for exactly why (the conversational engine's validation isn't yet factored into something reusable outside a WhatsApp session).
- **The full workflow builder and templates marketplace in the new React dashboard** (Section 13) — still classic-dashboard-only (`/dashboard`); `/app` links out to it for that one task.
- **Two-way calendar sync** (Section 10) — an event added directly in a provider's Google Calendar doesn't yet block a WhatsApp slot; sync is push-only, BookPilot → Google.
- **Per-provider revenue breakdown** (Section 9) — the dashboard's revenue figure is tenant-wide only; `payments` doesn't yet join back to a specific provider.
- Real photos/guest reviews for hotels — the current `rating` field is a plausible placeholder number, not sourced from real guests (see `hotel.json`).

See the original PRD for the full platform vision.
