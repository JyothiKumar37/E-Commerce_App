# syntax=docker/dockerfile:1.7
#
# Storefront. Two targets:
#   development — Vite dev server with hot reload (what compose uses by default)
#   production  — static bundle served by nginx
#
# Unlike the backend services the shipped artefact here is static files behind
# nginx, so the runtime stage shares nothing with the Node service images.
#
# Build from the repository root:
#   docker build -f apps/web/Dockerfile --target production -t ecom/web:local .

# ---------- deps ----------
FROM node:20.19-bookworm-slim AS deps
WORKDIR /app

# Only the storefront's manifests. The backend workspaces are irrelevant here.
COPY package.json package-lock.json ./
COPY apps/web/package.json          apps/web/

RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --include-workspace-root --workspace=apps/web

# ---------- development ----------
FROM deps AS development
COPY apps/web ./apps/web
WORKDIR /app/apps/web
EXPOSE 5173
CMD ["npm", "run", "dev"]

# ---------- build ----------
FROM deps AS build
COPY apps/web ./apps/web
WORKDIR /app/apps/web
# Vite inlines VITE_* variables at build time, so the API URL must be known here
# rather than injected at container start.
#
# No default, deliberately. This used to fall back to http://localhost:8080, and
# a build that forgot the argument produced a bundle that looked perfectly
# healthy — the image starts, nginx serves it, every probe passes — while every
# browser called localhost:8080 on the visitor's own machine. Nothing
# server-side can detect that: the value is compiled into the JavaScript, so no
# health check, log line or `kubectl describe` will ever show it.
#
# Failing here costs one clear error message. Not failing here costs a deploy
# that appears to work and does not.
ARG VITE_API_URL
RUN test -n "${VITE_API_URL}" || { \
      echo "" >&2; \
      echo "VITE_API_URL is required for a production build." >&2; \
      echo "It is compiled into the bundle and cannot be set at runtime." >&2; \
      echo "" >&2; \
      echo "  docker build -f apps/web/Dockerfile --target production \\" >&2; \
      echo "    --build-arg VITE_API_URL=https://shop.example.com/api -t ecom/web:tag ." >&2; \
      echo "" >&2; \
      exit 1; \
    }
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

# ---------- production ----------
FROM nginx:1.27-alpine AS production
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
# 127.0.0.1, not localhost: nginx here binds IPv4 only (`listen 80`), while
# `localhost` in this image can resolve to ::1 first — nothing is listening
# there, so the probe fails against a perfectly healthy server. The service
# images already use 127.0.0.1 for the same reason.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
