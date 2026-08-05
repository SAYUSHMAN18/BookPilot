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

## The core idea: adding a new industry is a config change

Everything industry-specific — providers, prompts, what fields to collect,
the confirmation message — lives in a JSON file under `workflows/`. The
engine (`src/workflowEngine.js`) never mentions "doctor" or "hotel"; it just
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

No changes to `server.js`, `src/workflowEngine.js`, or `src/classify.js` are
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
(`src/extractContext.js`) and skips straight past whatever was already said,
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
- **Input is capped** (`src/textLimits.js`, 500 chars) before reaching any AI
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
(`src/factualQA.js` — business hours, provider fees, hotel locations), the
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

A provider can mark a specific slot or an entire day unavailable
(`src/availabilityStore.js`, the `blocked_slots` table) — a lunch break, a
day off, maintenance. Blocked slots/days are excluded from what
`select_date`/`select_time_slot` offer, checked at both display time and
the final pre-booking race-check, same as booked slots. Set through the
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
JSON file. `src/db.js` owns the schema; `src/bookingStore.js` exposes a
small `get`/`has`/`set`/`values` interface so the rest of the engine doesn't
know or care that it's a real database underneath.

Sessions (in-progress, unconfirmed conversations) are still a JSON file
(`src/sessionStore.js`, `logs/sessions.json`) — lower stakes than bookings,
and deliberately out of scope for this migration.

Known limits, worth knowing before treating this as fully production-grade:

- One booking per customer (`wa_id` is the primary key) — a new booking overwrites the previous one on file. Carried over unchanged from the old JSON store; supporting multiple concurrent bookings per customer would need a real schema change (an auto-incrementing `id` instead of `wa_id` as the key).
- The date-range (hotel) conflict check isn't DB-enforced the way time-slot booking is — see above.
- Single SQLite file = fine for one server process (even several, since SQLite handles multi-process file access), but a real multi-tenant admin dashboard with concurrent writers at real scale would eventually want Postgres.

### Timestamps and logs

Everything logged (`src/logger.js`) is timestamped in IST (`Asia/Kolkata`),
regardless of what timezone the server itself runs in — a booking business
reading its own logs shouldn't have to mentally convert UTC.

### Post-booking commands

Once a booking is confirmed, its record survives in the database even after
the conversation session ends, so these work anytime afterward, from any
stage:

- **STATUS** — for a time-slot booking (medical/hair/makeup): date/time and, for a same-day appointment, an approximate queue position (a real count of other same-provider, same-day bookings made earlier — not a live queue, since there's no staff-side check-in system behind it). For a hotel booking: check-in/check-out dates.
- **HERE** — marks the booking as arrived.
- **MENU** / **restart** — abandons whatever's in progress and starts fresh.

These are workflow-agnostic — any workflow that records a booking gets them
for free.

### Provider dashboard

`GET /dashboard` (`public/dashboard.html`) — one static page, one set of
API endpoints, but **not one generic table** — the bookings view is
profile-based per business type, since a doctor's booking and a hotel
room's booking aren't the same shape and showing them in an identical
table means either field is missing or the other's fields are clutter:

- **Doctor** — Patient, Age, Gender, Reason, Doctor, Date, Time
- **Salon/Makeup** — Customer, Stylist/Artist, Date, Time
- **Hotel** — Guest, Hotel, Room, Check-in, Check-out (computed from check-in + nights), Nights

Each profile also tints the header (icon + accent color) so it's visually
obvious which business you're looking at. A workflow not in the profile
list (a new `workflows/*.json` someone adds) falls back to a generic
column set automatically — no dashboard code change required, same
config-driven principle as the bot itself. See `PROFILES` in
`public/dashboard.html` to add a tailored view for a new business type.

There's no login/signup system yet (explicitly deferred, not an
oversight) — "logging in" is just picking yourself from a dropdown, built
live from the same `workflows/*.json` the bot reads.

- **Bookings** — table of everything booked for the selected provider, filterable by status and date, reading straight from the same SQLite the bot writes to (refresh the page / click Refresh to see new WhatsApp bookings — there's no push/live-update).
- **Availability** — block a specific slot or a whole day; removing a block un-blocks it. Changes apply to the WhatsApp bot's offered slots immediately, since it's the same database, not a sync step (verified live: a block created in the dashboard was excluded from the bot's slot list on the very next message). Not shown for hotel rooms — see Availability above.

Patient details (age/gender/reason) are now persisted to the bookings
table, not just shown in the WhatsApp confirmation message and then
discarded — a real gap found and fixed while building this (with a safe
migration for anyone with an existing `data/bookpilot.db` from before this
fix — verified live against a simulated old-schema database, no data loss).

Optionally set `DASHBOARD_ACCESS_KEY` in `.env` to gate it — without one, `/dashboard` and every `/api/dashboard/*` route are open to anyone who finds the URL (can see all bookings, including customer names, and edit availability). With one set, pass it as `?key=...` on the dashboard URL or an `X-Dashboard-Key` header on the API. The server logs a startup warning if this is unset, same pattern as the other security-relevant env vars.

---

## What you need (both free)

1. **A WhatsApp Cloud API test app** — from Meta, gives you a free test WhatsApp number to send/receive real messages. No cost for testing.
2. **A Groq API key** — free tier, no credit card, from https://console.groq.com. Used for classifying which business the customer means. If you don't set this, the bot automatically falls back to each workflow's `keywords` list so it still works.

## 1. Install

```bash
npm install
```

## 2. Configure

```bash
cp .env.example .env
```

Open `.env` and fill in the values (see steps 3 and 4 below for where to get them). `WHATSAPP_VERIFY_TOKEN` can be any string you make up — just remember it, you'll type the same value into Meta's dashboard.

## 3. Get a free Groq API key (AI classification)

1. Go to https://console.groq.com and sign up (no credit card needed).
2. Go to **API Keys** -> **Create API Key**.
3. Copy the key into `.env` as `GROQ_API_KEY`.

## 4. Set up a free WhatsApp test number (Meta Cloud API)

1. Go to https://developers.facebook.com/apps and create an app -> choose **Business** type.
2. Add the **WhatsApp** product to the app.
3. In **WhatsApp -> API Setup** you'll see:
   - A **temporary access token** -> copy into `.env` as `WHATSAPP_TOKEN` (expires in 24 hours — fine for testing).
   - A **Phone number ID** -> copy into `.env` as `WHATSAPP_PHONE_NUMBER_ID`.
   - A field to add a **test recipient number** — add your own WhatsApp number and verify it with the code Meta sends you.

## 5. Expose your local server to the internet

Meta can't reach `localhost` directly. Use a tunnel — easiest is [ngrok](https://ngrok.com) (free):

```bash
npm install -g ngrok
ngrok http 8081
```

This prints a URL like `https://abcd1234.ngrok-free.app` — copy it.

## 6. Point Meta's webhook at your server

In **WhatsApp -> Configuration** in the Meta dashboard:

- **Callback URL**: `https://abcd1234.ngrok-free.app/webhook`
- **Verify token**: the same string you put in `.env` as `WHATSAPP_VERIFY_TOKEN`
- Click **Verify and save**, subscribe to the **messages** webhook field

## 7. Run it

```bash
node server.js
```

You should see:

```
BookPilot AI listening on port 8081
```

Send a WhatsApp message to your test number — e.g. `I have a bad headache`, `need a hotel room`, `looking for a haircut` — and the bot replies on WhatsApp itself. Type `restart` anytime to start over.

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

---

## Production readiness

What's already in place:

- **Interactive UI** — providers/options are native tappable WhatsApp lists/buttons, not "reply with a number."
- **Webhook signature verification** — set `WHATSAPP_APP_SECRET` and every webhook POST is HMAC-verified against Meta's `X-Hub-Signature-256` header; invalid requests are rejected with 403. Without it, the server logs a startup warning and accepts unsigned requests (fine for local dev only).
- **Duplicate delivery protection** — Meta retries webhook deliveries; `src/dedupe.js` ignores messages it's already processed.
- **Rate limiting** — `src/rateLimit.js` drops (silently, no reply) any single WhatsApp id sending more than 20 messages/minute, so one abusive sender can't burn through the Groq quota or hammer the DB.
- **Dev endpoints don't leak into production** — `POST /api/simulate-whatsapp` auto-disables once `WHATSAPP_APP_SECRET` is set (it's unauthenticated by design, which is an impersonation risk — anyone could POST a real customer's WhatsApp id and read their booking back). The dashboard has its own optional `DASHBOARD_ACCESS_KEY` gate instead, since unlike the simulate endpoint it's meant to be used in production.
- **Explicit request size cap** on the JSON body parser (100kb) — stated intentionally rather than left as an implicit Express default.
- **Session persistence** — conversations survive a restart via a JSON file store (`src/sessionStore.js`, `logs/sessions.json`, gitignored). Single-instance only — running multiple server instances behind a load balancer needs a real DB instead.
- **Health check** — `GET /health` for uptime monitoring / load balancer probes.
- **Fail-loud config** — missing `WHATSAPP_APP_SECRET`/`WHATSAPP_VERIFY_TOKEN`/`GROQ_API_KEY`/`DASHBOARD_ACCESS_KEY` log clear warnings at startup instead of failing silently later.
- **Crash handling** — uncaught exceptions are logged and the process exits (run it under a process manager so it restarts); unhandled rejections are logged without killing the process.

Before real production traffic:

- **Get a permanent WhatsApp token.** The Meta test token expires every 24 hours — set up a System User token in Meta Business Settings instead.
- **Set `WHATSAPP_APP_SECRET`.** Without it, anyone who finds your webhook URL can send the bot fake messages.
- **Set `DASHBOARD_ACCESS_KEY`** before the dashboard is reachable from outside your own machine — it shows customer names and lets anyone edit provider availability otherwise.
- **Run behind a real reverse proxy / TLS**, not ngrok (ngrok is fine for development).
- **Run under a process manager** (PM2, systemd, or a container restart policy) so a crash auto-restarts the server.
- **Rotate any keys that were ever shared outside this repo** (e.g. pasted into a chat, a screenshot, or a support ticket) — treat that as exposure and regenerate from the Meta/Groq dashboards.
- **Move sessions off the JSON file too** if you need multiple server instances behind a load balancer with sticky sessions unavailable — bookings already moved to SQLite (see Data layer above), sessions haven't yet.

---

## Roadmap (from the BookPilot AI PRD)

This repo covers Phase 1's core mechanism, real availability/conflict
tracking backed by SQLite (see Data layer above — a real embedded database,
though still file-based, fine for one machine, not a distributed
multi-region deployment), and a basic provider dashboard (bookings +
availability, no auth). Not yet built:

- **Real login/auth for the dashboard** — currently just a provider picker + optional shared access key, explicitly deferred rather than built as real multi-tenant auth.
- **A real calendar-picker UI on WhatsApp** — `select_date` is a tappable list of upcoming days, the most WhatsApp's standard interactive messages support. An actual date-picker widget needs WhatsApp Flows (Meta app review, a hosted encrypted data-exchange endpoint) — a separate, materially larger feature.
- **Hotel availability blocking** — bookings/conflict-checking work for hotels, but the provider-side "block this off" control doesn't (single-day block model vs. date-range stays — see Availability above).
- Real-time push from bookings to the dashboard (currently: refresh the page), payment integrations, multi-language support, voice, analytics, or real photos/guest reviews for hotels (the current `rating` field is a plausible placeholder number, not sourced from real guests — see `hotel.json`).

See the original PRD for the full platform vision.
