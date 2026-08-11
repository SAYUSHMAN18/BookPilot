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
COPY public/dashboard.html ./public/dashboard.html
COPY public/marketing/ ./public/marketing/
COPY --from=frontend-builder /build/public/app ./public/app

# src/data/ (SQLite DB) and src/logs/ are created at startup by
# src/store/db.js and src/infra/logger.js themselves (mkdirSync recursive)
# — declared as volumes so a container restart/redeploy doesn't lose the
# database or backups. Mount these to real persistent storage in
# production; without a mount they're still writable, just ephemeral.
VOLUME ["/app/src/data", "/app/src/logs", "/app/backups"]

# Runs as the pre-created non-root `node` user baked into the official
# image, not root — standard container hardening, and this app has no
# reason to need root (no privileged ports, no system-level access).
RUN chown -R node:node /app
USER node

EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8081/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
