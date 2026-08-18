# BookPilot AI

AI-powered WhatsApp booking bot for service businesses. Built around a **config-driven Dynamic Workflow Engine** — adding a new industry means dropping a JSON file, not changing code.

---

## What It Does

BookPilot AI acts as a fully automated booking assistant on WhatsApp. A customer sends a message, the AI classifies what they need, loads the right business workflow, and walks them through booking step-by-step — handling date selection, provider/service selection, payment, and confirmation without any human in the loop.

Key capabilities:

- **End-to-end WhatsApp booking** — receives messages via WhatsApp Business Cloud API, walks customers through a configured multi-step booking flow, and confirms the appointment
- **AI intent detection** — classifies every incoming message (book, cancel, check status, question, complaint, greeting) using Groq LLMs with a regex fallback for when the API is unavailable
- **Agentic orchestration** — if a customer says "actually make it Friday" mid-booking, the AI orchestrator plans the right recovery action (jump to that step, answer the question, retry, cancel) rather than just returning "invalid input"
- **Factual Q&A** — answers questions about pricing, hours, location, and services from a per-tenant knowledge base (uploaded documents + workflow metadata), without making anything up
- **Multi-language support** — translates messages to/from English before processing; 23 Indian languages supported via Sarvam AI
- **Voice messages** — transcribes incoming WhatsApp audio (Sarvam STT), processes it through the same booking pipeline, and optionally replies with synthesized speech (Sarvam TTS) in 11 Indian languages
- **Payments** — collects payment via Razorpay during the booking flow; supports refunds on cancellation
- **Google Calendar sync** — pushes confirmed bookings to the tenant's connected Google Calendar and removes them on cancellation
- **Appointment reminders** — sends automated WhatsApp reminders 24 hours and 2 hours before each appointment
- **Double-booking protection** — slot locking and conflict detection enforced at the database level, not in application logic
- **Rate limiting** — per-sender message throttling with configurable grace-period notifications
- **Multi-tenant** — each business has its own isolated workflows, availability, WhatsApp credentials, payment keys, staff, and knowledge base

---

## How the Workflow Engine Works

Each business type is defined as a JSON workflow. The engine has no knowledge of any specific industry — it only walks the `steps` array defined in the config. This is what makes new industries a config change, not a code change.

A workflow defines:
- **`id`** and **`label`** — identifier and display name
- **`providers`** or **`hotels`** — the inventory to book from (doctors, stylists, hotel rooms, etc.)
- **`steps`** — ordered list of conversation steps the engine will walk through (e.g. `select_provider`, `select_date`, `select_time_slot`, `review_confirm`, `collect_payment`)
- **`businessHours`**, **`fees`**, **`description`**, **`keywords`** — used by the classifier and factual Q&A

The AI classifier reads the customer's first message and picks the right workflow. From there the engine is fully deterministic — it only calls the AI again when it needs to parse an ambiguous free-text input or handle an out-of-flow message.

---

## AI Layer (`src/ai/`)

| Module | Role |
|---|---|
| `groqClient.js` | Wrapper around Groq API with retry, timeout, and model config |
| `intentDetector.js` | Classifies messages: cancel, check_status, restart, question, complaint, booking_intent, greeting |
| `classify.js` | Picks the right workflow for an incoming message (LLM + keyword fallback) |
| `extractContext.js` | Pulls structured fields (date, time, name, etc.) out of free-text |
| `orchestrator.js` | Agentic planner — decides which action to take when a message doesn't fit the current step |
| `factualQA.js` | Answers questions from the tenant knowledge base; refuses to guess |
| `translate.js` | Detects language and translates to/from English for processing |
| `workflowGenerator.js` | Generates a new workflow JSON from a plain-text business description |

---

## Project Structure

```
bookpilot-ai/
├── server.js                  # Main Express server (port 8081) — API + dashboard + webhook
├── marketingServer.js         # Separate marketing site server (port 8082)
├── frontend/                  # React + Vite dashboard
│   └── src/
│       ├── pages/             # Login, Overview, Bookings, Availability, Analytics, Billing, Settings, PlatformAdmin
│       └── components/        # BookingsTable, WorkflowEditorModal, CalendarSyncPanel, KnowledgeBasePanel, etc.
├── src/
│   ├── ai/                    # All LLM-facing modules (see table above)
│   ├── engine/
│   │   ├── workflowEngine.js  # Core state machine — one session per WhatsApp sender
│   │   ├── dateSlots.js       # Date parsing, slot generation, availability checking
│   │   ├── calendarSync.js    # Google Calendar push/remove on booking events
│   │   ├── analytics.js       # Booking analytics aggregations
│   │   ├── billing.js         # Plan enforcement
│   │   ├── paymentRefunds.js  # Razorpay refund logic
│   │   └── bookingStateMachine.js # Terminal state checker
│   ├── infra/
│   │   ├── whatsapp.js        # WhatsApp Cloud API — send text, buttons, lists, images, audio
│   │   ├── voice.js           # Sarvam STT/TTS for voice messages
│   │   ├── reminders.js       # 24h and 2h pre-appointment WhatsApp reminders
│   │   ├── rateLimit.js       # Per-sender rate limiting
│   │   ├── emailSender.js     # Nodemailer — OTPs, password resets, notifications
│   │   ├── auth.js            # Session-based auth middleware
│   │   ├── calendarProviders/ # Google Calendar OAuth provider
│   │   ├── paymentProviders/  # Razorpay provider
│   │   └── ...                # logger, tracing, alerting, uploads, secrets encryption, etc.
│   ├── routes/
│   │   ├── webhook.js         # Incoming WhatsApp message handler
│   │   ├── dashboard.js       # All dashboard REST API endpoints
│   │   ├── auth.js            # Signup, login, OTP, password reset
│   │   ├── billing.js         # Subscription and plan management
│   │   ├── platformAdmin.js   # Platform-level admin endpoints
│   │   ├── publicApi.js       # Public-facing API with API key auth
│   │   ├── demoChat.js        # In-dashboard demo chat simulator
│   │   └── marketing.js       # Marketing site routes
│   └── store/                 # Database access layer (one file per domain)
│       ├── db.js              # PostgreSQL pool + schema migrations
│       ├── bookingStore.js    # Bookings CRUD + slot conflict detection
│       ├── tenantStore.js     # Multi-tenant config, credentials (encrypted at rest)
│       ├── userStore.js       # Users, roles, team management
│       ├── sessionStore.js    # WhatsApp conversation sessions
│       ├── availabilityStore.js # Blocked dates and ranges
│       ├── paymentStore.js    # Payment records
│       ├── calendarStore.js   # Linked calendar config
│       ├── knowledgeStore.js  # Uploaded knowledge base documents
│       └── ...                # queues, audit log, feedback, OTPs, API keys, etc.
├── public/
│   ├── marketing/             # Static marketing site
│   └── openapi.yaml           # Public API spec
├── tests/                     # Node built-in test runner
│   ├── engine/                # Workflow engine unit tests
│   ├── ai/                    # AI module tests
│   ├── http/                  # HTTP endpoint integration tests
│   ├── store/                 # Store layer tests
│   └── fixtures/workflows/    # JSON workflow fixtures used by the test suite
├── Dockerfile
├── docker-compose.yml         # App + Postgres for local dev
└── render.yaml                # One-click Render deployment config
```

---

## Dashboard (Frontend)

The React dashboard lets each tenant manage their business:

| Page / Panel | What it does |
|---|---|
| Overview | Live booking counts, recent activity, setup checklist |
| Bookings | Full booking table — search, filter, cancel, refund |
| Availability | Block dates and date ranges |
| Analytics | Booking trends, conversion rates, revenue |
| Billing | Subscription plan and usage |
| Settings | Workflow editor, knowledge base upload, calendar sync, WhatsApp config, API keys |
| Team | Invite and manage staff |
| Platform Admin | Tenant management, onboarding requests, support queue (superadmin only) |

---

## Integrations

| Service | Purpose |
|---|---|
| [Groq](https://groq.com) | LLM inference (LLaMA models) — intent, classification, Q&A, context extraction |
| [WhatsApp Business Cloud API](https://developers.facebook.com/docs/whatsapp) | Messaging channel |
| [Sarvam AI](https://sarvam.ai) | Indian-language speech-to-text and text-to-speech |
| [Razorpay](https://razorpay.com) | Payment collection and refunds |
| [Google Calendar API](https://developers.google.com/calendar) | Calendar sync via OAuth 2.0 |
| [Nodemailer](https://nodemailer.com) | Email delivery — OTPs, password resets, alerts |
| [PostgreSQL](https://postgresql.org) | Primary database |

---

## Running Locally

**Prerequisites:** Node.js 20+, PostgreSQL 16, ngrok

```bash
# 1. Install dependencies
npm install
cd frontend && npm install && cd ..

# 2. Configure environment
cp .env.example .env
# Fill in your keys — minimum required: DATABASE_URL, GROQ_API_KEY,
# WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN

# 3. Start Postgres (or use docker-compose)
docker-compose up -d postgres

# 4. Start the backend
npm start
# → http://localhost:8081

# 5. Start the frontend (separate terminal)
cd frontend && npm run dev
# → http://localhost:5173

# 6. Expose the webhook to WhatsApp (separate terminal)
ngrok http 8081
# Set your Meta App webhook URL to: https://<ngrok-url>/webhook
```

---

## Key Environment Variables

```bash
# Server
PORT=8081
DATABASE_URL=postgres://user:pass@localhost:5432/bookpilot

# AI
GROQ_API_KEY=...

# WhatsApp
WHATSAPP_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_VERIFY_TOKEN=...
WHATSAPP_APP_SECRET=...        # optional — enables webhook signature verification

# Voice
SARVAM_API_KEY=...             # optional — enables voice message support

# Payments
RAZORPAY_KEY_ID=...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...

# Google Calendar
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:8081/api/dashboard/calendar/callback

# Email
EMAIL_USER=...
EMAIL_PASS=...

# Security
SESSION_SECRET=...             # 64-char random hex
APP_ENCRYPTION_KEY=...         # 64-char hex — used to encrypt tenant credentials at rest

# Admin bootstrap (first run only)
ADMIN_BOOTSTRAP_EMAIL=...
ADMIN_BOOTSTRAP_PASSWORD=...
```

Full reference with descriptions: [`.env.example`](.env.example)

---

## Tests

```bash
npm test
```

Uses Node.js built-in test runner. Test suite covers workflow engine logic, AI modules, HTTP endpoints (supertest), and store layer.

---

## Deployment

- **Docker Compose** — `docker-compose up` spins up the app + Postgres together
- **Render** — `render.yaml` is pre-configured; connect the repo and deploy
- **Free-tier notes** — see [`DEPLOY_FREE.md`](DEPLOY_FREE.md)
- **Production checklist** — set `NODE_ENV=production`, use a persistent Postgres instance, move file uploads to cloud storage (currently stored on local disk)
