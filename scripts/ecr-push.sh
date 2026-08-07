#!/usr/bin/env bash
#
# Builds all fourteen images and pushes them to ECR.
#
#   AWS_REGION=ap-south-1 TAG=v1.0.0 bash scripts/ecr-push.sh
#   AWS_REGION=ap-south-1 TAG=v1.0.1 bash scripts/ecr-push.sh search web
#
# VITE_API_URL must be set to the URL the BROWSER will use, because Vite inlines
# it into the storefront bundle at build time. On EKS that is the ingress
# hostname, which does not exist until the Ingress is created — so the usual
# order is: deploy everything, read the load balancer hostname, then rebuild and
# push `web` with the real value.
#
# Creates each repository on first run. Repositories are tag-mutable, which is
# why the manifests use imagePullPolicy: Always; see scripts/set-images.sh.
set -euo pipefail

cd "$(dirname "$0")/.."

AWS_REGION="${AWS_REGION:?set AWS_REGION, e.g. ap-south-1}"
TAG="${TAG:?set TAG, e.g. v1.0.0 — do not use 'latest', it makes rollbacks guesswork}"
ECR_NAMESPACE="${ECR_NAMESPACE:-ecom}"

for tool in aws docker; do
  command -v "$tool" >/dev/null || { echo "$tool is not installed or not on PATH." >&2; exit 1; }
done

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY_HOST="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
REGISTRY="${REGISTRY_HOST}/${ECR_NAMESPACE}"

ALL=(api-gateway account cart inventory order-status payment place-order
     product-review recommendation recommendation-generation search shipping
     database web)

requested=("$@")
[ ${#requested[@]} -eq 0 ] && requested=("${ALL[@]}")

echo "registry : ${REGISTRY}"
echo "tag      : ${TAG}"
echo "images   : ${requested[*]}"
echo

# --- repositories ----------------------------------------------------------
# One repository per image. ECR has no concept of a namespace, so the slash in
# `ecom/search` is simply part of the repository name.
echo "==> ensuring repositories exist"
for name in "${requested[@]}"; do
  repo="${ECR_NAMESPACE}/${name}"
  if aws ecr describe-repositories --region "$AWS_REGION" --repository-names "$repo" >/dev/null 2>&1; then
    echo "    ok      ${repo}"
  else
    aws ecr create-repository \
      --region "$AWS_REGION" \
      --repository-name "$repo" \
      --image-scanning-configuration scanOnPush=true \
      --encryption-configuration encryptionType=AES256 >/dev/null
    echo "    created ${repo}"
  fi
done

# --- login -----------------------------------------------------------------
# The token lasts 12 hours. A push that fails with "no basic auth credentials"
# usually just means it expired; re-run this script.
echo
echo "==> logging docker in to ${REGISTRY_HOST}"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY_HOST"

# --- build -----------------------------------------------------------------
# build-images.sh already tags as ${REGISTRY}/${name}:${TAG}, so it needs no
# changes to target ECR — only the two variables.
echo
echo "==> building"
REGISTRY="$REGISTRY" TAG="$TAG" WEB_TARGET=production \
  bash scripts/build-images.sh "${requested[@]}"

# --- push ------------------------------------------------------------------
echo
echo "==> pushing"
failed=()
for name in "${requested[@]}"; do
  docker push "${REGISTRY}/${name}:${TAG}" || failed+=("$name")
done

echo
if [ ${#failed[@]} -gt 0 ]; then
  echo "Failed to push: ${failed[*]}" >&2
  exit 1
fi

echo "Pushed ${#requested[@]} image(s) to ${REGISTRY} at tag '${TAG}'."
echo
echo "Point the manifests at them with:"
echo "  bash scripts/set-images.sh ${REGISTRY} ${TAG}"
