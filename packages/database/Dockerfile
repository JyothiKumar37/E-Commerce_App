# syntax=docker/dockerfile:1.7
#
# Migration and seed runner. Not a long-running service — this image is invoked
# as a one-shot job before a deploy:
#
#   docker run --rm -e DATABASE_URL=... ecom/database:local \
#     node packages/database/migrate.js up
#
# Self-contained: build it from the repository root with no prerequisites.
#   docker build -f packages/database/Dockerfile -t ecom/database:local .

# ---------- deps ----------
FROM node:20.19-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json  ./
COPY packages/database/package.json  packages/database/

RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --include-workspace-root \
      --workspace=packages/database

# ---------- runtime ----------
FROM node:20.19-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json       ./
COPY --chown=node:node packages/database  ./packages/database

USER node

# No healthcheck: this exits rather than serving.
# No destructive default either — the caller picks migrate or seed, so a stray
# `docker run` reports status instead of mutating a database.
CMD ["node", "packages/database/migrate.js", "status"]
