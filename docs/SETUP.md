# Setup

Everything needed to get BookPilot AI running locally, from a clean clone
to a real WhatsApp message getting a real reply.

## What you need (both free)

1. **A WhatsApp Cloud API test app** — from Meta, gives you a free test
   WhatsApp number to send/receive real messages. No cost for testing.
2. **A Groq API key** — free tier, no credit card, from
   https://console.groq.com. Used for classifying which business the
   customer means. If you don't set this, the bot automatically falls
   back to each workflow's `keywords` list, so it still works without it.

## 1. Install

```bash
npm install
```

No native modules to compile — SQLite comes from Node's built-in
`node:sqlite`, password hashing from Node's built-in `crypto`. If
`npm install` needs a compiler toolchain, something's wrong.

## 2. Configure

```bash
cp .env.example .env
```

Open `.env` and fill in the values (steps 3–4 below say where to get
them). `WHATSAPP_VERIFY_TOKEN` can be any string you make up — just
remember it, you'll type the same value into Meta's dashboard.

Env vars, what they're for, and what happens if you skip them:

| Variable | Required for | If unset |
|---|---|---|
| `SESSION_SECRET` | Signing dashboard login sessions | Dashboard logins fail (logged as an error at startup) |
| `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` | Creating the first dashboard admin account | No way to log into the dashboard on a fresh install without hand-inserting a row |
| `GROQ_API_KEY` | AI classification/orchestration | Falls back to keyword-only matching (logged as a warning) |
| `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` | Sending real WhatsApp messages | Runs in simulated mode — replies are logged, not sent, so you can exercise the bot without a real WhatsApp number |
| `WHATSAPP_VERIFY_TOKEN` | Meta's webhook verification handshake | Verification fails (logged as a warning) |
| `WHATSAPP_APP_SECRET` | Webhook signature verification | Signature verification is disabled — anyone who finds your webhook URL could send fake messages (fine for local dev, not for production) |
| `SARVAM_API_KEY` | Voice notes (multilingual transcription + spoken replies) | Voice messages aren't transcribed |
| `DATA_DIR` | Overriding where SQLite/session/backup files live | Defaults to `data/` and `logs/` under the project root |
| `BACKUP_DIR` / `BACKUP_INTERVAL_HOURS` / `BACKUP_RETENTION_COUNT` | Tuning automated backups | Defaults to `backups/`, every 6h, keep the last 14 |
| `TRUST_PROXY` | Correct client IP behind a reverse proxy | Unset by default — only set this once there's a real reverse proxy in front, or the login rate limiter can be bypassed by a spoofed `X-Forwarded-For` |
| `PLATFORM_ADMIN_BOOTSTRAP_EMAIL` / `PLATFORM_ADMIN_BOOTSTRAP_PASSWORD` | Creating the first platform-wide admin account (Section 8 — manages every tenant, distinct from any tenant's own admin) | No way to reach `/api/platform/*` (multi-tenant management) without hand-inserting a `role='platform_admin'` row |
| `APP_ENCRYPTION_KEY` | Encrypting tenant secrets at rest — each tenant's own WhatsApp token, an optional bring-your-own Groq key (Section 8) | Storing a tenant's WhatsApp credentials fails loudly with a clear error rather than silently saving them as plaintext |

## 3. Get a free Groq API key (AI classification)

1. Go to https://console.groq.com and sign up (no credit card needed).
2. Go to **API Keys** → **Create API Key**.
3. Copy the key into `.env` as `GROQ_API_KEY`.

## 4. Set up a free WhatsApp test number (Meta Cloud API)

1. Go to https://developers.facebook.com/apps and create an app → choose **Business** type.
2. Add the **WhatsApp** product to the app.
3. In **WhatsApp → API Setup** you'll see:
   - A **temporary access token** → copy into `.env` as `WHATSAPP_TOKEN` (expires in 24 hours — fine for testing; see README's "Get a permanent WhatsApp token" section for a token that doesn't expire, once you're past local testing).
   - A **Phone number ID** → copy into `.env` as `WHATSAPP_PHONE_NUMBER_ID`.
   - A field to add a **test recipient number** — add your own WhatsApp number and verify it with the code Meta sends you.

## 5. Expose your local server to the internet

Meta can't reach `localhost` directly. Use a tunnel — easiest is
[ngrok](https://ngrok.com) (free):

```bash
npm install -g ngrok
ngrok http 8081
```

This prints a URL like `https://abcd1234.ngrok-free.app` — copy it.

## 6. Point Meta's webhook at your server

In **WhatsApp → Configuration** in the Meta dashboard:

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

Send a WhatsApp message to your test number — e.g. `I have a bad
headache`, `need a hotel room`, `looking for a haircut` — and the bot
replies on WhatsApp itself. Type `restart` anytime to start over.

The dashboard is at `http://localhost:8081/dashboard` — log in with
whatever you set as `ADMIN_BOOTSTRAP_EMAIL`/`ADMIN_BOOTSTRAP_PASSWORD`.

### Optional: the new React dashboard (Section 13)

A React/Vite rewrite of the same dashboard lives at `frontend/` and is
served at `http://localhost:8081/app` once built — same login, same data,
alongside (not instead of) `/dashboard` above. It needs a one-time build
step `node server.js` doesn't do for you:

```bash
cd frontend
npm install
npm run build
cd ..
```

This writes static files into `public/app/`, which `server.js` already
serves — no restart needed after a rebuild, just refresh the browser. For
active frontend development, `cd frontend && npm run dev` runs Vite's own
dev server on a different port with hot reload, proxying `/api` calls to
your already-running `node server.js` on 8081.

## Running the tests

```bash
npm test
```

Runs Node's built-in test runner (`node --test`) across every
`tests/**/*.test.js` file — no external test framework dependency. Each
test file that touches the database sets `DATA_DIR` to a fresh temp
directory before requiring `src/store/db.js`, so tests never touch (or
share state with) your real `data/bookpilot.db`. A couple of tests
specifically exercise real Groq API calls and are skipped automatically
if `GROQ_API_KEY` isn't set in your shell environment (as opposed to only
being in `.env` — `dotenv` only loads `.env` inside the app's own
process, not into the shell running `npm test`); export it manually first
if you want those to run:

```bash
export GROQ_API_KEY=your-key-here   # PowerShell: $env:GROQ_API_KEY = "your-key-here"
npm test
```

## Where things live

See `docs/ARCHITECTURE.md` for the directory layout and the invariants
that hold the system together — read that before making a structural
change (moving code between layers, changing the schema, touching the
booking engine's write path).
