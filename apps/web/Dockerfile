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
ARG VITE_API_URL=http://localhost:8080
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

# ---------- production ----------
FROM nginx:1.27-alpine AS production
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost/ >/dev/null || exit 1
CMD ["nginx", "-g", "daemon off;"]
