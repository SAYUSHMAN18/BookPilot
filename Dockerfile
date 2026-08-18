# BookPilot AI — production image.
#
# ONE image, TWO deployable services — server.js (dashboard/bot, meant for
# bookpilot.com) and marketingServer.js (the public site, meant for
# app.bookpilot.com) are both baked in; which one actually runs is chosen
# at `docker run`/deploy time by overriding CMD, not by building two
# separate images. They share the same package.json/src/, so one image
# avoids duplicating that whole dependency layer — see README's "How
# marketing, dashboard, and the bot actually run" for why they're two
# processes at all.
#
#   docker run --env-file .env -p 8081:8081 bookpilot-ai                      # dashboard/bot (default CMD)
#   docker run --env-file .env -p 8082:8082 bookpilot-ai node marketingServer.js  # marketing
#
# The database itself is Postgres, reached over the network via
# DATABASE_URL (src/store/db.js) — not a local file, so there's no data
# volume to mount or share between the two services the way the old
# SQLite version needed. Only /app/logs needs a persistent mount if you
# want logs to survive a container restart; nothing else writes to local
# disk that matters past a single request. Only server.js's process
# should be the one starting background jobs (reminders/outbound queue) —
# marketingServer.js never does, by design, specifically so nothing here
# double-runs those jobs.
#
# Two stages: build the React dashboard (frontend/) with full devDeps and
# a build toolchain, then copy ONLY its compiled output into a slim
# runtime image alongside the backend. The backend itself has zero native
# dependencies (node:sqlite is built into Node itself, not a compiled
# addon — see src/store/db.js), so the runtime stage stays tiny and
# doesn't need any build tools at all.
#
# Secrets (.env) are deliberately NOT copied into the image at any stage
# — inject them at `docker run` time via --env-file or your platform's
# secret manager. Baking secrets into an image layer means anyone with
# the image (registry, another engineer, a compromised host) has them
# forever, even after rotation.

# ---------- Stage 1: build the React dashboard ----------
FROM node:24-slim AS frontend-builder
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ .
# Outputs to ../public/app per frontend/vite.config.js's own outDir —
# i.e. /build/public/app, one level up from this WORKDIR.
RUN npm run build

# ---------- Stage 2: slim runtime ----------
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Root package.json's only real deps are dotenv + express (see
# package.json) — no native modules, so `npm ci --omit=dev` needs no
# build toolchain even on alpine's musl libc.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Backend source + static assets actually served (server.js references
# each of these — see its express.static() calls).
COPY server.js marketingServer.js ./
COPY src/ ./src/

# Found live (first real container deploy): despite this file's own
# stale comment claiming "not something the running server reads",
# ensureDemoTenant() (src/infra/demoTenant.js) DOES call
# tenantWorkflowStore.seedDefaultsForTenant() on every boot — for the
# public marketing site's live-chat demo tenant — which reads this exact
# directory via loadWorkflows.js. Without it in the image, every boot
# crashed with ENOENT before the server ever started listening. Small
# (~28KB, 5 JSON files), so just include it rather than fork the demo
# tenant onto a separate, duplicated content source.
COPY tests/fixtures/workflows/ ./tests/fixtures/workflows/
COPY public/marketing/ ./public/marketing/
COPY --from=frontend-builder /build/public/app ./public/app

# logs/ is created at startup by src/infra/logger.js (mkdirSync recursive)
# — declared as a volume so a container restart/redeploy doesn't lose log
# history. data/ no longer holds a database (that moved to Postgres —
# DATABASE_URL, no local file) but src/infra/uploads.js still uses it for
# locally-stored business photo uploads — on Cloud Run specifically, this
# directory is EPHEMERAL per instance despite being declared a volume here
# (Cloud Run ignores VOLUME/bind-mounts; only a real Cloud Storage-backed
# solution survives a redeploy/scale event there). Uploaded photos moving
# to Cloud Storage is a known follow-up, not yet done — flagged here
# rather than silently left for a deploy to discover the hard way.
# /app/backups no longer exists — the old SQLite-native backup mechanism
# was removed with the Postgres migration (see src/routes/dashboard.js's
# comment); Cloud SQL's own automated backups replace it.
#
# These directories don't otherwise exist in the image — the app only
# mkdirSync()s them at runtime — so with nothing here to inherit ownership
# from, Docker would initialize a fresh anonymous volume at each mount
# point owned by root, and every write from the non-root `node` user this
# container runs as (see below) would crash with EACCES before the server
# ever came up. Explicitly creating them here, in the SAME chown step as
# the rest of /app, gives Docker real (correctly-owned) directory content
# to seed each volume from on first mount.
RUN mkdir -p /app/data /app/logs && chown -R node:node /app
VOLUME ["/app/data", "/app/logs"]

# Runs as the pre-created non-root `node` user baked into the official
# image, not root — standard container hardening, and this app has no
# reason to need root (no privileged ports, no system-level access).
USER node

# 8081 is just this image's documented DEFAULT (matches server.js's own
# `process.env.PORT || 8081`) — EXPOSE is metadata, not a binding, so it
# doesn't actually limit which port a container built from this image can
# listen on. Whatever deploys this (docker run -p, Cloud Run, Compute
# Engine) should set PORT explicitly for BOTH services — 8081 for the
# server.js deployment, something else (e.g. 8082) for the
# marketingServer.js one — since the healthcheck below reads that same
# variable and needs to agree with whichever port the running process is
# actually listening on.
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||8081;fetch('http://localhost:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
