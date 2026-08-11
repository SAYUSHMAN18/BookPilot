# BookPilot AI — production image.
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
COPY server.js ./
COPY src/ ./src/
COPY workflows/ ./workflows/
COPY public/marketing/ ./public/marketing/
COPY --from=frontend-builder /build/public/app ./public/app

# data/ (SQLite DB) and logs/ are created at startup by src/store/db.js
# and src/infra/logger.js themselves (mkdirSync recursive) — declared as
# volumes so a container restart/redeploy doesn't lose the database or
# backups. Mount these to real persistent storage in production; without
# a mount they're still writable, just ephemeral.
#
# Found live (this Dockerfile's own first verification pass): both paths
# here originally said /app/src/data and /app/src/logs — stale, matching
# a path this codebase moved away from (see db.js's DATA_DIR and
# logger.js's LOG_FILE, both resolve to <root>/data and <root>/logs, not
# <root>/src/data or <root>/src/logs; the same stale-path confusion this
# project's own git-hygiene pass separately found and cleaned up for the
# real dev database). A container using the old paths would silently
# persist an empty, unused directory while the real database and logs
# sat in the container's own ephemeral writable layer — gone on every
# redeploy, with no error to notice it by.
#
# Found live (this Dockerfile's second bug, same verification pass): these
# three directories don't otherwise exist in the image — src/store/db.js
# and src/infra/logger.js only mkdirSync() them at runtime — so with
# nothing here to inherit ownership from, Docker initializes a fresh
# anonymous volume at each of these mount points owned by root. The
# container then runs as the non-root `node` user (see below) and every
# write crashed with EACCES before the server ever came up. Explicitly
# creating them here, in the SAME chown step as the rest of /app, gives
# Docker real (correctly-owned) directory content to seed each volume
# from on first mount — the documented way this actually works.
RUN mkdir -p /app/data /app/logs /app/backups && chown -R node:node /app
VOLUME ["/app/data", "/app/logs", "/app/backups"]

# Runs as the pre-created non-root `node` user baked into the official
# image, not root — standard container hardening, and this app has no
# reason to need root (no privileged ports, no system-level access).
USER node

EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8081/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
