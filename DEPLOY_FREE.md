# Deploying BookPilot AI for $0, with no payment method on file anywhere

The codebase already targets Docker + Postgres (`Dockerfile`, `src/store/db.js`),
originally aimed at Google Cloud Run + Cloud SQL. Cloud Run requires a GCP
billing account with a card attached even to stay within its free tier, so
this uses two services that are free with **no card required at signup**
instead, wired together with `render.yaml` in this repo.

| Piece | Service | Why |
|---|---|---|
| Postgres database | [Neon](https://neon.tech) free tier | Serverless Postgres, no card at signup, works with any `DATABASE_URL` client (this app already only needs that). |
| `server.js` (dashboard + bot + webhook) | [Render](https://render.com) free web service | Docker-native deploy straight from this GitHub repo, no card at signup. |
| `marketingServer.js` (public site + signup) | Render free web service (second one) | Same account, same repo, different start command. |
| WhatsApp | Meta Cloud API | Already free tier — you already have a Meta App from local dev. |
| Groq | Groq API | Already free tier — you already have a key from local dev. |

**I can't do the account-creation or secret-entry steps for you** — creating
accounts and typing passwords/API keys/tokens into any web form are both
things I'm not allowed to do even with permission, so those steps below are
yours. Everything else (the Docker image, `render.yaml`, code changes) is
already done in this repo.

## 1. Neon — free Postgres

1. Go to neon.tech, sign up (GitHub login is fastest) — no card asked.
2. Create a project (any name/region).
3. Copy the **connection string** it gives you (starts `postgres://...`,
   already includes `?sslmode=require`). You'll paste this into Render twice
   (once per service) in step 3.

## 2. Push this repo to GitHub

This repo's `origin` is already `github.com/SAYUSHMAN18/BookPilot`. Once you
say go, the two local commits sitting ahead of `origin/main` get pushed —
Render deploys straight from that.

## 3. Render — the two web services

1. Go to render.com, sign up (GitHub login) — no card asked.
2. **New → Blueprint**, pick the `BookPilot` repo. Render reads `render.yaml`
   and proposes both services (`bookpilot-dashboard`, `bookpilot-marketing`)
   at once.
3. Before the first deploy, each service has a set of **empty secret fields**
   (Render shows these because `render.yaml` marks them `sync: false` —
   that's deliberate, so nothing sensitive lives in the repo). Fill them in
   directly in Render's dashboard, not anywhere else:
   - **Both services**: `DATABASE_URL` (the Neon connection string from step 1
     — same value in both services, it's one shared database).
   - **bookpilot-dashboard only**: `SESSION_SECRET`, `APP_ENCRYPTION_KEY`
     (generate both with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
     — run that locally, paste the output in, don't reuse one value for both),
     `GROQ_API_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
     `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` (same values already in
     your local `.env`), and `ADMIN_BOOTSTRAP_EMAIL`/`ADMIN_BOOTSTRAP_PASSWORD`
     (only needed for the very first login — pick a real password, you can
     unset these after).
   - **bookpilot-marketing only**: `SESSION_SECRET` — must be the *identical*
     value you set on bookpilot-dashboard (same signed cookies).
4. Deploy. Render assigns each service a URL like
   `https://bookpilot-dashboard-xxxx.onrender.com`.
5. Go back into each service's env vars and fill in `DASHBOARD_URL` /
   `MARKETING_URL` with each other's real assigned URL, then redeploy —
   these are just used for cross-links between the two sites, not secrets.

## 4. Point Meta's webhook at the new dashboard URL

In Meta App Dashboard → WhatsApp → Configuration: set the webhook URL to
`https://bookpilot-dashboard-xxxx.onrender.com/api/webhook` and the verify
token to whatever you set `WHATSAPP_VERIFY_TOKEN` to in step 3. This part
isn't a secret being typed *into* a third party — it's your own app's config
on Meta's own dashboard — so I can drive the browser for this step if you'd
rather just watch, once the service is live.

## Known limitation on this specific free setup

Render's free web services have **no persistent disk** — a provider/business
photo uploaded through the dashboard is written to local disk
(`src/infra/uploads.js`) and won't survive a redeploy or a cold-restart after
the service sleeps from inactivity. Booking data itself is safe (it's in
Neon's Postgres, not local disk) — only uploaded *photos* are at risk. The
whole booking flow works fine without a photo; if you want photo uploads to
actually persist on this free setup, say so and I'll wire in a free
object-storage option (e.g. Cloudinary's free tier) — a real code change,
not just config, so it's worth doing deliberately rather than folding into
this pass silently.

Free web services also spin down after ~15 minutes idle and take a few
seconds to wake on the next request — Meta retries a failed/slow webhook
delivery, so this is a latency risk on the first message after a quiet
period, not a guaranteed lost message, but it's worth knowing about.
