# syntax=docker/dockerfile:1.7
#
# API gateway service (:8080).
#
# Self-contained — no base image to build first, no ordering to remember:
#   docker build -f apps/api-gateway/Dockerfile -t ecom/api-gateway:local .

# ---------- deps ----------
FROM node:20.19-bookworm-slim AS deps
WORKDIR /app

# Only the manifests this service resolves against, so the layer stays cached
# until one of them actually changes. npm does not need the other workspaces'
# manifests when the install is filtered to these.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api-gateway/package.json apps/api-gateway/

# Scoped to this service. A blanket install pulls every other service's
# dependencies in — and the storefront's React tree along with them.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --include-workspace-root \
      --workspace=packages/shared \
      --workspace=apps/api-gateway

# ---------- runtime ----------
FROM node:20.19-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json                 ./
COPY --chown=node:node packages/shared              ./packages/shared
COPY --chown=node:node apps/api-gateway             ./apps/api-gateway

USER node
EXPOSE 8080

# Node 18+ ships a global fetch, so the probe needs nothing installed. Under
# Kubernetes prefer an httpGet probe and drop this entirely.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Exec form, so node is PID 1 and receives SIGTERM directly — the graceful
# shutdown handler in @ecom/shared drains in-flight requests. No init shim is
# needed: the process installs its own signal handlers and spawns no children.
# Compose sets `init: true` anyway, for zombie reaping if that ever changes.
CMD ["node", "apps/api-gateway/src/index.js"]
