#!/usr/bin/env bash
#
# Points the deployment at a public hostname.
#
#   bash scripts/set-domain.sh shop.example.com          # HTTPS, TLS via cert-manager
#   bash scripts/set-domain.sh my-elb.amazonaws.com --http   # back to plain HTTP
#
# Four things have to agree, and they are in three different files:
#
#   PUBLIC_ORIGIN   the CORS allowlist every service checks
#   COOKIE_SECURE   true only over HTTPS, or the refresh cookie is never sent
#   Ingress host    which server block nginx matches the request against
#   Ingress tls     which certificate that server block presents
#
# Getting one wrong produces a site that half works: pages render, POSTs 403.
# That is what happened moving from the EC2 IP to the load balancer, so this
# moves them as a set.
#
# It does NOT rebuild the storefront. VITE_API_URL is compiled into the bundle,
# so a domain change also needs:
#   VITE_API_URL=https://<host>/api TAG=<tag> bash scripts/ecr-push.sh web
set -euo pipefail

cd "$(dirname "$0")/.."

HOST="${1:?usage: $0 <hostname> [--http]}"
SCHEME="https"
SECURE="true"
[ "${2:-}" = "--http" ] && { SCHEME="http"; SECURE="false"; }

case "$HOST" in
  *://*) echo "Pass a bare hostname, not a URL: ${HOST#*://}" >&2; exit 1 ;;
  */*)   echo "Pass a bare hostname, no path: ${HOST%%/*}" >&2; exit 1 ;;
esac

HOST="$HOST" SCHEME="$SCHEME" SECURE="$SECURE" python3 - <<'PY'
import os, pathlib, re

HOST, SCHEME, SECURE = os.environ["HOST"], os.environ["SCHEME"], os.environ["SECURE"]
ORIGIN = f"{SCHEME}://{HOST}"

# --- the shared config -----------------------------------------------------
cm = pathlib.Path("k8s/ecom-config-configmap.yaml")
s = cm.read_text()
s = re.sub(r'(  PUBLIC_ORIGIN: )".*"', lambda m: f'{m.group(1)}"{ORIGIN}"', s)
s = re.sub(r'(  COOKIE_SECURE: )".*"', lambda m: f'{m.group(1)}"{SECURE}"', s)
cm.write_text(s)

# --- the storefront's recorded build argument ------------------------------
# Informational only: the real value is compiled in. Kept truthful so that
# `kubectl describe` does not describe a bundle that no longer exists.
web = pathlib.Path("k8s/web-deployment.yaml")
s = web.read_text()
s = re.sub(r"(            - name: VITE_API_URL\n              value: )\S+",
           lambda m: f"{m.group(1)}{ORIGIN}/api", s)
s = re.sub(r"(--build-arg VITE_API_URL=)\S+", lambda m: f"{m.group(1)}{ORIGIN}/api", s)
web.write_text(s)

# --- the ingress -----------------------------------------------------------
ing = pathlib.Path("k8s/ecom-ingress.yaml")
s = ing.read_text()

# `- http:` becomes `- host: <name>` + `  http:`. Idempotent: an existing host
# line is rewritten rather than a second one inserted.
s = re.sub(r"^    - host: \S+\n      http:$", "    - http:", s, flags=re.M)
s = re.sub(r"^    - http:$", f"    - host: {HOST}\n      http:", s, flags=re.M)

# A tls block on each object, both naming the same secret so cert-manager
# issues one certificate that both server blocks present.
s = re.sub(r"\n  tls:\n    - hosts:\n        - \S+\n      secretName: \S+\n", "\n", s)
if SCHEME == "https":
    s = re.sub(r"^  ingressClassName: nginx$",
               "  ingressClassName: nginx\n  tls:\n    - hosts:\n"
               f"        - {HOST}\n      secretName: ecom-tls", s, flags=re.M)
    # Only the storefront Ingress carries the issuer annotation. Both objects
    # serve the same host, and two annotated Ingresses would race to order two
    # certificates for it.
    if "cert-manager.io/cluster-issuer" not in s:
        s = s.replace(
            "  name: ecom-web-ingress\n",
            "  name: ecom-web-ingress\n", 1)
        s = re.sub(r"(name: ecom-web-ingress\n(?:.*\n)*?  annotations:\n)",
                   r"\1    cert-manager.io/cluster-issuer: letsencrypt\n", s)
else:
    s = re.sub(r"^    cert-manager\.io/cluster-issuer: \S+\n", "", s, flags=re.M)

ing.write_text(s)

print(f"  PUBLIC_ORIGIN   {ORIGIN}")
print(f"  COOKIE_SECURE   {SECURE}")
print(f"  Ingress host    {HOST}")
print(f"  Ingress TLS     {'ecom-tls via cert-manager' if SCHEME == 'https' else 'none'}")
PY

echo
echo "Next:"
echo "  kubectl apply -f k8s/"
echo "  VITE_API_URL=${SCHEME}://${HOST}/api AWS_REGION=\$AWS_REGION TAG=v1.0.0 bash scripts/ecr-push.sh web"
echo "  kubectl -n ecom rollout restart deploy"
