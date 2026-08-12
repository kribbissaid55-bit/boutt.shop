# syntax=docker/dockerfile:1.6
# ============================================================================
# Bot Said 22 — production Docker image (multi-stage).
#
# Build from the PROJECT ROOT so the client + server folders are in scope:
#   docker build -f deploy/Dockerfile -t bot-said-22:latest .
#
# Run with docker compose (recommended) — see deploy/docker-compose.yml.
# ============================================================================

# ----------------------------------------------------------------------------
# Stage 1: builder — installs ALL deps, compiles TS, builds the SPA.
# ----------------------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# System deps for prisma binary + native modules.
RUN apk add --no-cache openssl python3 make g++

# Copy workspaces skeleton first for better layer caching.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/

RUN npm ci

# Copy source AFTER install so a source-only change doesn't invalidate deps.
COPY server ./server
COPY client ./client

# Prisma generate + build server + build client.
RUN cd server && npx prisma generate --schema=./prisma/schema.prisma \
 && npm run build \
 && cd ../client && npm run build

# ----------------------------------------------------------------------------
# Stage 2: runtime — slim image, production deps only, non-root user.
# ----------------------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache openssl tini \
 && addgroup -g 1001 -S nodejs \
 && adduser -u 1001 -S nodejs -G nodejs

# Copy manifest + production-only install for a small image.
COPY --chown=nodejs:nodejs package.json package-lock.json ./
COPY --chown=nodejs:nodejs server/package.json ./server/

# Only install SERVER runtime deps in the final image (client is static files).
RUN cd server && npm ci --omit=dev \
 && cd .. && npm cache clean --force

# Copy the built artifacts + prisma schema/seed from the builder.
COPY --chown=nodejs:nodejs --from=builder /app/server/dist ./server/dist
COPY --chown=nodejs:nodejs --from=builder /app/server/prisma ./server/prisma
COPY --chown=nodejs:nodejs --from=builder /app/server/node_modules/.prisma ./server/node_modules/.prisma
COPY --chown=nodejs:nodejs --from=builder /app/server/node_modules/@prisma ./server/node_modules/@prisma
COPY --chown=nodejs:nodejs --from=builder /app/client/dist ./client/dist

# nginx or another reverse proxy serves /app/client/dist as static; the API
# runs here on 4000. See deploy/nginx/bot-said-22.conf.sample for a reference.

USER nodejs
WORKDIR /app/server
EXPOSE 4000
ENV NODE_ENV=production

# tini reaps zombies + forwards SIGTERM so the Baileys shutdown handler runs.
ENTRYPOINT ["/sbin/tini", "--"]

# Push schema on boot (idempotent) then start.
CMD ["sh", "-c", "npx prisma db push --schema=./prisma/schema.prisma --accept-data-loss=false && node dist/index.js"]
