# syntax=docker/dockerfile:1.7
#
# Checkout orchestration service (:8086).
#
# Self-contained — no base image to build first, no ordering to remember:
#   docker build -f services/place-order/Dockerfile -t ecom/place-order:local .

# ---------- deps ----------
FROM node:20.19-bookworm-slim AS deps
WORKDIR /app

# Only the manifests this service resolves against, so the layer stays cached
# until one of them actually changes. npm does not need the other workspaces'
# manifests when the install is filtered to these.
COPY package.json package-lock.json   ./
COPY packages/shared/package.json     packages/shared/
COPY services/place-order/package.json services/place-order/

# Scoped to this service. A blanket install pulls every other service's
# dependencies in — and the storefront's React tree along with them.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --include-workspace-root \
      --workspace=packages/shared \
      --workspace=services/place-order

# ---------- runtime ----------
FROM node:20.19-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json                     ./
COPY --chown=node:node packages/shared                  ./packages/shared
COPY --chown=node:node services/place-order             ./services/place-order

USER node
EXPOSE 8086

# Node 18+ ships a global fetch, so the probe needs nothing installed. Under
# Kubernetes prefer an httpGet probe and drop this entirely.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8086/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Exec form, so node is PID 1 and receives SIGTERM directly — the graceful
# shutdown handler in @ecom/shared drains in-flight requests. No init shim is
# needed: the process installs its own signal handlers and spawns no children.
# Compose sets `init: true` anyway, for zombie reaping if that ever changes.
CMD ["node", "services/place-order/src/index.js"]
