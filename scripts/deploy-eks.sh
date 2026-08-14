#!/usr/bin/env bash
# ============================================================================
# deploy-eks.sh — Post-Terraform EKS deployment & ArgoCD GitOps automation
# ============================================================================
#
# Automates everything AFTER `terraform apply` has provisioned the EKS cluster:
#
#   1. Configures kubectl from Terraform outputs
#   2. Applies the EBS CSI StorageClass
#   3. Installs ingress-nginx with NLB + TLS termination
#   4. Creates a Route 53 alias record for the domain
#   5. Installs ArgoCD and retrieves admin credentials
#   6. Bootstraps namespace, secrets, and ConfigMap
#   7. Deploys infrastructure (Postgres, Redis, Elasticsearch)
#   8. Runs database migration and seed jobs
#   9. Creates an ArgoCD Application CR for GitOps
#  10. Verifies the full deployment
#
# Usage:
#   bash scripts/deploy-eks.sh
#   bash scripts/deploy-eks.sh --skip-dns          # skip Route 53 step
#   bash scripts/deploy-eks.sh --skip-images       # skip set-images step
#   bash scripts/deploy-eks.sh --branch develop     # ArgoCD tracks 'develop'
#   TAG=v1.0.0 bash scripts/deploy-eks.sh          # specify image tag
#
# Prerequisites:
#   - Terraform has been applied (terraform/ directory has state)
#   - aws CLI configured with appropriate credentials
#   - kubectl, helm, jq installed
#   - k8s/ecom-secrets.yaml exists with real secret values
#   - Images already pushed to ECR (see scripts/ecr-push.sh)
#
# Every step is idempotent — re-running is safe.
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"

# ── Configuration ──────────────────────────────────────────────────────────
ARGOCD_REPO="${ARGOCD_REPO:-https://github.com/JyothiKumar37/E-Commerce_App.git}"
ARGOCD_BRANCH="${ARGOCD_BRANCH:-main}"
ARGOCD_PATH="${ARGOCD_PATH:-k8s}"
ARGOCD_APP_NAME="${ARGOCD_APP_NAME:-ecom}"
ARGOCD_NAMESPACE="argocd"
ECOM_NAMESPACE="ecom"
TAG="${TAG:-v1.0.0}"

SKIP_DNS=false
SKIP_IMAGES=false

# ── Parse arguments ────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-dns)     SKIP_DNS=true; shift ;;
    --skip-images)  SKIP_IMAGES=true; shift ;;
    --branch)       ARGOCD_BRANCH="$2"; shift 2 ;;
    --tag)          TAG="$2"; shift 2 ;;
    --repo)         ARGOCD_REPO="$2"; shift 2 ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--skip-dns] [--skip-images] [--branch <branch>] [--tag <tag>] [--repo <url>]" >&2
      exit 1
      ;;
  esac
done

# ── Colours & helpers ──────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

step_num=0
step() {
  step_num=$((step_num + 1))
  echo ""
  echo -e "${BOLD}${BLUE}══════════════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}${BLUE}  Step ${step_num}: $1${NC}"
  echo -e "${BOLD}${BLUE}══════════════════════════════════════════════════════════════${NC}"
  echo ""
}

info()    { echo -e "  ${CYAN}ℹ${NC}  $1"; }
success() { echo -e "  ${GREEN}✔${NC}  $1"; }
warn()    { echo -e "  ${YELLOW}⚠${NC}  $1"; }
fail()    { echo -e "  ${RED}✘${NC}  $1" >&2; exit 1; }

wait_for() {
  local desc="$1" cmd="$2" timeout="${3:-300}" interval="${4:-5}"
  local elapsed=0
  info "Waiting for ${desc} (timeout: ${timeout}s)..."
  while ! eval "$cmd" >/dev/null 2>&1; do
    sleep "$interval"
    elapsed=$((elapsed + interval))
    if [ "$elapsed" -ge "$timeout" ]; then
      fail "Timed out waiting for ${desc} after ${timeout}s"
    fi
  done
  success "${desc} — ready"
}

# ── Step 0: Prerequisite checks ───────────────────────────────────────────
step "Checking prerequisites"

for tool in aws kubectl helm jq python3; do
  if command -v "$tool" >/dev/null 2>&1; then
    success "${tool} found: $(command -v "$tool")"
  else
    fail "${tool} is required but not installed. Please install it and re-run."
  fi
done

if [ ! -d "${ROOT_DIR}/terraform" ]; then
  fail "terraform/ directory not found. Run this from the project root."
fi

if [ ! -f "${ROOT_DIR}/k8s/ecom-secrets.yaml" ]; then
  fail "k8s/ecom-secrets.yaml not found. Copy from ecom-secrets.example.yaml and fill in real values."
fi

# Verify AWS credentials
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  fail "AWS credentials not configured. Run 'aws configure' or set AWS_PROFILE."
fi
success "AWS credentials valid ($(aws sts get-caller-identity --query 'Account' --output text))"

# ── Step 1: Read Terraform outputs & configure kubectl ─────────────────────
step "Reading Terraform outputs and configuring kubectl"

cd "${ROOT_DIR}/terraform"

if [ ! -f "terraform.tfstate" ] && [ ! -d ".terraform" ]; then
  fail "No Terraform state found. Run 'terraform apply' first."
fi

# Extract outputs
TF_OUTPUT="$(terraform output -json 2>/dev/null)" || fail "Failed to read Terraform outputs. Is the cluster provisioned?"

CLUSTER_NAME="$(echo "$TF_OUTPUT" | jq -r '.cluster_name.value')"
REGION="$(echo "$TF_OUTPUT" | jq -r '.configure_kubectl.value' | grep -oP '(?<=--region )\S+')"
ECR_REGISTRY="$(echo "$TF_OUTPUT" | jq -r '.ecr_registry.value')"

if [ -z "$CLUSTER_NAME" ] || [ "$CLUSTER_NAME" = "null" ]; then
  fail "Could not extract cluster_name from Terraform outputs."
fi

info "Cluster:  ${CLUSTER_NAME}"
info "Region:   ${REGION}"
info "Registry: ${ECR_REGISTRY}"

# Configure kubectl
info "Configuring kubectl..."
aws eks update-kubeconfig --region "$REGION" --name "$CLUSTER_NAME" --alias "$CLUSTER_NAME" 2>&1 | sed 's/^/    /'
success "kubectl configured for cluster '${CLUSTER_NAME}'"

# Verify connectivity
info "Verifying cluster connectivity..."
if ! kubectl get nodes --no-headers 2>/dev/null | head -5; then
  fail "Cannot reach the cluster. Check your VPN / network."
fi
success "Cluster is reachable"

cd "$ROOT_DIR"

# ── Step 2: Apply StorageClass ─────────────────────────────────────────────
step "Applying EBS CSI StorageClass"

kubectl apply -f k8s/eks/storageclass.yaml 2>&1 | sed 's/^/    /'
success "StorageClass 'standard' applied (gp3, WaitForFirstConsumer)"

# ── Step 3: Install ingress-nginx ──────────────────────────────────────────
step "Installing ingress-nginx controller"

helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx 2>/dev/null || true
helm repo update ingress-nginx 2>&1 | sed 's/^/    /'

info "Installing/upgrading ingress-nginx..."
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  -f k8s/eks/ingress-nginx-values.yaml \
  --wait --timeout 300s 2>&1 | sed 's/^/    /'
success "ingress-nginx installed"

info "Waiting for controller rollout..."
kubectl -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=300s 2>&1 | sed 's/^/    /'
success "ingress-nginx controller is ready"

# Wait for NLB to get a hostname
info "Waiting for NLB hostname..."
NLB_HOSTNAME=""
elapsed=0
while [ -z "$NLB_HOSTNAME" ] || [ "$NLB_HOSTNAME" = "null" ]; do
  NLB_HOSTNAME="$(kubectl -n ingress-nginx get svc ingress-nginx-controller \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)"
  if [ -z "$NLB_HOSTNAME" ] || [ "$NLB_HOSTNAME" = "null" ]; then
    sleep 10
    elapsed=$((elapsed + 10))
    if [ "$elapsed" -ge 300 ]; then
      fail "Timed out waiting for NLB hostname after 300s"
    fi
  fi
done
success "NLB hostname: ${NLB_HOSTNAME}"

# ── Step 4: Update Route 53 A Record ──────────────────────────────────────
if [ "$SKIP_DNS" = true ]; then
  warn "Skipping DNS setup (--skip-dns)"
else
  step "Updating Route 53 A record"

  # Extract domain from ConfigMap
  DOMAIN="$(grep -v '^\s*#' k8s/ecom-config-configmap.yaml | grep 'PUBLIC_ORIGIN:' | head -1 | sed 's/.*: *"//;s|https\?://||;s/"//g;s/ //g')"
  if [ -z "$DOMAIN" ]; then
    fail "Could not extract domain from k8s/ecom-config-configmap.yaml"
  fi
  info "Domain: ${DOMAIN}"

  # Look up the existing hosted zone for this domain
  # Extracts the top-level zone (e.g. "jeds.shop." from "jeds.shop" or "www.jeds.shop")
  TOP_LEVEL_DOMAIN="$(echo "$DOMAIN" | rev | cut -d. -f1-2 | rev)"
  HOSTED_ZONE_ID="$(aws route53 list-hosted-zones-by-name \
    --dns-name "${TOP_LEVEL_DOMAIN}." --max-items 1 \
    --query "HostedZones[?Name=='${TOP_LEVEL_DOMAIN}.'].Id" \
    --output text 2>/dev/null | sed 's|/hostedzone/||' || true)"

  if [ -z "$HOSTED_ZONE_ID" ] || [ "$HOSTED_ZONE_ID" = "None" ]; then
    fail "Route 53 hosted zone for '${TOP_LEVEL_DOMAIN}' not found. Please verify it exists in your AWS account."
  fi
  success "Found hosted zone: ${HOSTED_ZONE_ID} (${TOP_LEVEL_DOMAIN})"

  # Get the NLB's canonical hosted zone ID (required for alias records)
  info "Looking up NLB details..."
  NLB_ZONE_ID=""
  for attempt in 1 2 3; do
    NLB_ZONE_ID="$(aws elbv2 describe-load-balancers --region "$REGION" \
      --query "LoadBalancers[?DNSName=='${NLB_HOSTNAME}'].CanonicalHostedZoneId | [0]" \
      --output text 2>/dev/null || true)"

    if [ -n "$NLB_ZONE_ID" ] && [ "$NLB_ZONE_ID" != "None" ] && [ "$NLB_ZONE_ID" != "null" ]; then
      break
    fi
    # NLB may take a moment to register in the ELBv2 API after creation
    info "  Attempt ${attempt}/3 — NLB not yet discoverable, waiting 20s..."
    sleep 20
  done

  if [ -z "$NLB_ZONE_ID" ] || [ "$NLB_ZONE_ID" = "None" ]; then
    fail "Could not look up NLB hosted zone ID. The NLB may still be provisioning — try re-running the script."
  fi
  info "NLB hosted zone: ${NLB_ZONE_ID}"

  # UPSERT the alias A record (creates if missing, updates if exists)
  info "Upserting A record: ${DOMAIN} -> ${NLB_HOSTNAME}..."
  CHANGE_BATCH="$(cat <<EOF
{
  "Changes": [{
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "${DOMAIN}",
      "Type": "A",
      "AliasTarget": {
        "HostedZoneId": "${NLB_ZONE_ID}",
        "DNSName": "${NLB_HOSTNAME}",
        "EvaluateTargetHealth": true
      }
    }
  }]
}
EOF
)"

  CHANGE_ID="$(aws route53 change-resource-record-sets \
    --hosted-zone-id "$HOSTED_ZONE_ID" \
    --change-batch "$CHANGE_BATCH" \
    --query 'ChangeInfo.Id' --output text 2>&1)"
  success "A record upserted: ${DOMAIN} -> NLB"
  info "Change ID: ${CHANGE_ID}"

  # Wait for propagation
  info "Waiting for DNS propagation (typically 30-60s)..."
  aws route53 wait resource-record-sets-changed --id "$CHANGE_ID" 2>/dev/null || \
    warn "DNS propagation wait timed out — record is likely still propagating"
  success "DNS propagated"
fi

# ── Step 5: Install ArgoCD ────────────────────────────────────────────────
step "Installing ArgoCD"

helm repo add argo https://argoproj.github.io/argo-helm 2>/dev/null || true
helm repo update argo 2>&1 | sed 's/^/    /'

info "Installing/upgrading ArgoCD..."
helm upgrade --install argocd argo/argo-cd \
  --namespace "$ARGOCD_NAMESPACE" --create-namespace \
  --set 'server.service.type=ClusterIP' \
  --set 'server.extraArgs={--insecure}' \
  --set 'configs.params."server\.insecure"=true' \
  --wait --timeout 300s 2>&1 | sed 's/^/    /'
success "ArgoCD installed in '${ARGOCD_NAMESPACE}' namespace"

info "Waiting for ArgoCD server to be ready..."
kubectl -n "$ARGOCD_NAMESPACE" rollout status deploy/argocd-server --timeout=300s 2>&1 | sed 's/^/    /'
success "ArgoCD server is ready"

# Retrieve admin password
ARGOCD_PASSWORD="$(kubectl -n "$ARGOCD_NAMESPACE" get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || echo '<already changed>')"
info "ArgoCD admin password: ${ARGOCD_PASSWORD}"

# ── Step 6: Bootstrap namespace, secrets, and configmap ────────────────────
step "Bootstrapping namespace, secrets, and ConfigMap"

kubectl apply -f k8s/00-namespace.yaml 2>&1 | sed 's/^/    /'
kubectl apply -f k8s/ecom-secrets.yaml 2>&1 | sed 's/^/    /'
kubectl apply -f k8s/ecom-config-configmap.yaml 2>&1 | sed 's/^/    /'
success "Namespace '${ECOM_NAMESPACE}', secrets, and configmap applied"

# ── Step 7: Deploy infrastructure ─────────────────────────────────────────
step "Deploying infrastructure (Postgres, Redis, Elasticsearch)"

# Update image tags in manifests if not skipped
if [ "$SKIP_IMAGES" = false ]; then
  info "Updating manifest image tags to ${ECR_REGISTRY}:${TAG}..."
  bash scripts/set-images.sh "$ECR_REGISTRY" "$TAG" 2>&1 | sed 's/^/    /'
  success "Image tags updated"
fi

# PVCs first
info "Applying PersistentVolumeClaims..."
kubectl apply \
  -f k8s/postgres-data-persistentvolumeclaim.yaml \
  -f k8s/redis-data-persistentvolumeclaim.yaml \
  -f k8s/elastic-data-persistentvolumeclaim.yaml \
  2>&1 | sed 's/^/    /'
success "PVCs applied"

# Infrastructure deployments + services
info "Deploying Postgres..."
kubectl apply -f k8s/postgres-deployment.yaml -f k8s/postgres-service.yaml 2>&1 | sed 's/^/    /'

info "Deploying Redis..."
kubectl apply -f k8s/redis-deployment.yaml -f k8s/redis-service.yaml 2>&1 | sed 's/^/    /'

info "Deploying Elasticsearch..."
kubectl apply -f k8s/elasticsearch-deployment.yaml -f k8s/elasticsearch-service.yaml 2>&1 | sed 's/^/    /'

# Wait for infrastructure to be healthy
info "Waiting for Postgres to be ready..."
kubectl -n "$ECOM_NAMESPACE" wait --for=condition=available deploy/postgres --timeout=420s 2>&1 | sed 's/^/    /'
success "Postgres is ready"

info "Waiting for Redis to be ready..."
kubectl -n "$ECOM_NAMESPACE" wait --for=condition=available deploy/redis --timeout=420s 2>&1 | sed 's/^/    /'
success "Redis is ready"

info "Waiting for Elasticsearch to be ready..."
kubectl -n "$ECOM_NAMESPACE" wait --for=condition=available deploy/elasticsearch --timeout=420s 2>&1 | sed 's/^/    /'
success "Elasticsearch is ready"

# ── Step 8: Database migration and seed ────────────────────────────────────
step "Running database migration and seed"

# Delete previous jobs if they exist (completed Jobs are immutable)
kubectl -n "$ECOM_NAMESPACE" delete job ecom-migrate --ignore-not-found 2>&1 | sed 's/^/    /'
kubectl -n "$ECOM_NAMESPACE" delete job ecom-seed --ignore-not-found 2>&1 | sed 's/^/    /'

# Run migration
info "Running migration..."
kubectl apply -f k8s/migrate-job.yaml 2>&1 | sed 's/^/    /'
kubectl -n "$ECOM_NAMESPACE" wait --for=condition=complete job/ecom-migrate --timeout=300s 2>&1 | sed 's/^/    /'
success "Migration complete"

# Run seed
info "Running seed..."
kubectl apply -f k8s/seed-job.yaml 2>&1 | sed 's/^/    /'
kubectl -n "$ECOM_NAMESPACE" wait --for=condition=complete job/ecom-seed --timeout=300s 2>&1 | sed 's/^/    /'
success "Seed data loaded"

# ── Step 9: Create ArgoCD Application ─────────────────────────────────────
step "Creating ArgoCD Application for GitOps"

cat <<EOF | kubectl apply -f - 2>&1 | sed 's/^/    /'
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${ARGOCD_APP_NAME}
  namespace: ${ARGOCD_NAMESPACE}
  labels:
    app.kubernetes.io/name: ${ARGOCD_APP_NAME}
    app.kubernetes.io/part-of: ecom
    app.kubernetes.io/managed-by: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: ${ARGOCD_REPO}
    targetRevision: ${ARGOCD_BRANCH}
    path: ${ARGOCD_PATH}
    directory:
      recurse: false
      # Exclude secrets — they are applied manually and must not be in Git.
      exclude: '{ecom-secrets.yaml,ecom-secrets.example.yaml,eks/*}'
  destination:
    server: https://kubernetes.default.svc
    namespace: ${ECOM_NAMESPACE}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
      allowEmpty: false
    syncOptions:
      - CreateNamespace=false
      - PrunePropagationPolicy=foreground
      - PruneLast=true
      - ApplyOutOfSyncOnly=true
      - ServerSideApply=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
  # Ignore differences in fields that are managed outside ArgoCD
  ignoreDifferences:
    - group: ""
      kind: Secret
      name: ecom-secrets
      jsonPointers:
        - /data
        - /stringData
EOF

success "ArgoCD Application '${ARGOCD_APP_NAME}' created"
info "  Repository: ${ARGOCD_REPO}"
info "  Branch:     ${ARGOCD_BRANCH}"
info "  Path:       ${ARGOCD_PATH}"
info "  Sync:       Automated (prune + self-heal)"

# ── Step 10: Verify deployment ─────────────────────────────────────────────
step "Verifying deployment"

info "Waiting for all application deployments to be ready..."

# Get all deployments in the ecom namespace and wait for each
DEPLOYMENTS="$(kubectl -n "$ECOM_NAMESPACE" get deploy -o name 2>/dev/null || true)"
DEPLOY_FAILED=()

for deploy in $DEPLOYMENTS; do
  deploy_name="$(echo "$deploy" | cut -d'/' -f2)"
  if kubectl -n "$ECOM_NAMESPACE" wait --for=condition=available "$deploy" --timeout=300s >/dev/null 2>&1; then
    success "  ${deploy_name} ✔"
  else
    DEPLOY_FAILED+=("$deploy_name")
    warn "  ${deploy_name} — not ready (may still be starting)"
  fi
done

if [ ${#DEPLOY_FAILED[@]} -gt 0 ]; then
  warn "Some deployments are not yet ready: ${DEPLOY_FAILED[*]}"
  warn "They may still be pulling images. Check with: kubectl -n ecom get pods"
fi

# Check ArgoCD sync status
info "Checking ArgoCD sync status..."
SYNC_STATUS="$(kubectl -n "$ARGOCD_NAMESPACE" get application "$ARGOCD_APP_NAME" \
  -o jsonpath='{.status.sync.status}' 2>/dev/null || echo 'Unknown')"
HEALTH_STATUS="$(kubectl -n "$ARGOCD_NAMESPACE" get application "$ARGOCD_APP_NAME" \
  -o jsonpath='{.status.health.status}' 2>/dev/null || echo 'Unknown')"
info "  ArgoCD Sync:   ${SYNC_STATUS}"
info "  ArgoCD Health: ${HEALTH_STATUS}"

# Extract domain for curl check
DOMAIN="$(grep -v '^\s*#' k8s/ecom-config-configmap.yaml | grep 'PUBLIC_ORIGIN:' | head -1 | sed 's/.*: *"//;s/"//g;s/ //g')"

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}${GREEN}  Deployment Complete!${NC}"
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Storefront:${NC}      ${DOMAIN}"
echo -e "  ${BOLD}API Gateway:${NC}     ${DOMAIN}/api"
echo -e "  ${BOLD}Cluster:${NC}         ${CLUSTER_NAME} (${REGION})"
echo -e "  ${BOLD}ECR Registry:${NC}    ${ECR_REGISTRY}"
echo -e "  ${BOLD}Image Tag:${NC}       ${TAG}"
echo ""
echo -e "  ${BOLD}ArgoCD:${NC}"
echo -e "    Namespace:     ${ARGOCD_NAMESPACE}"
echo -e "    App Name:      ${ARGOCD_APP_NAME}"
echo -e "    Sync Status:   ${SYNC_STATUS}"
echo -e "    Health:        ${HEALTH_STATUS}"
echo -e "    Admin User:    admin"
echo -e "    Admin Pass:    ${ARGOCD_PASSWORD}"
echo ""
echo -e "  ${BOLD}Access ArgoCD UI:${NC}"
echo -e "    kubectl port-forward svc/argocd-server -n ${ARGOCD_NAMESPACE} 8443:443"
echo -e "    Open: ${CYAN}https://localhost:8443${NC}"
echo ""
echo -e "  ${BOLD}Demo Credentials:${NC}"
echo -e "    Customer:  demo@example.com / Password123!"
echo -e "    Admin:     admin@example.com / Admin123!Pass"
echo ""
echo -e "  ${BOLD}Useful commands:${NC}"
echo -e "    kubectl -n ecom get pods              # pod status"
echo -e "    kubectl -n ecom logs -f deploy/<name>  # service logs"
echo -e "    kubectl -n ecom get ingress            # ingress rules"
echo ""
echo -e "  ${BOLD}GitOps workflow:${NC}"
echo -e "    Push changes to '${ARGOCD_BRANCH}' branch -> ArgoCD auto-syncs"
echo -e "    ArgoCD watches: ${ARGOCD_REPO}"
echo -e "    Path: ${ARGOCD_PATH}/"
echo ""
