#!/usr/bin/env bash
#
# Builds every image.
#
# Each Dockerfile is self-contained, so there is no ordering to enforce and no
# prerequisite to build first. This script exists for convenience: consistent
# tagging across fourteen targets, and a summary at the end.
#
#   bash scripts/build-images.sh                 # everything
#   bash scripts/build-images.sh payment search  # just these
#   TAG=v1.4.0 bash scripts/build-images.sh      # tag explicitly
#   WEB_TARGET=production bash scripts/build-images.sh web
#
set -euo pipefail

cd "$(dirname "$0")/.."

TAG="${TAG:-local}"
REGISTRY="${REGISTRY:-ecom}"
WEB_TARGET="${WEB_TARGET:-production}"

# name -> path containing its Dockerfile
declare -A TARGETS=(
  [api-gateway]=apps/api-gateway
  [account]=services/account
  [cart]=services/cart
  [inventory]=services/inventory
  [order-status]=services/order-status
  [payment]=services/payment
  [place-order]=services/place-order
  [product-review]=services/product-review
  [recommendation]=services/recommendation
  [recommendation-generation]=services/recommendation-generation
  [search]=services/search
  [shipping]=services/shipping
  [database]=packages/database
  [web]=apps/web
)

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed or not on PATH." >&2
  exit 1
fi

requested=("$@")
if [ ${#requested[@]} -eq 0 ]; then
  requested=("${!TARGETS[@]}")
fi

for name in "${requested[@]}"; do
  if [ -z "${TARGETS[$name]+x}" ]; then
    echo "Unknown target '$name'. Known: ${!TARGETS[*]}" >&2
    exit 1
  fi
done

failed=()
for name in "${requested[@]}"; do
  path="${TARGETS[$name]}"
  echo "==> ${name}  ${REGISTRY}/${name}:${TAG}"

  args=(-f "${path}/Dockerfile" -t "${REGISTRY}/${name}:${TAG}")
  if [ "$name" = "web" ]; then
    args+=(--target "${WEB_TARGET}")
    [ -n "${VITE_API_URL:-}" ] && args+=(--build-arg "VITE_API_URL=${VITE_API_URL}")
  fi

  if ! docker build "${args[@]}" .; then
    failed+=("$name")
  fi
done

echo
if [ ${#failed[@]} -gt 0 ]; then
  echo "Failed: ${failed[*]}" >&2
  exit 1
fi

echo "Built ${#requested[@]} image(s), tag '${TAG}'."
docker images --filter "reference=${REGISTRY}/*" \
  --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' | sort
