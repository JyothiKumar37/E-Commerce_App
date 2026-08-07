#!/usr/bin/env bash
#
# Points every manifest at a registry.
#
#   bash scripts/set-images.sh local
#   bash scripts/set-images.sh 123456789012.dkr.ecr.ap-south-1.amazonaws.com/ecom v1.0.0
#
# Image name and pull policy are changed together, because they are not
# independent:
#
#   local  -> ecom/<name>:local          + IfNotPresent
#             The images only exist inside minikube's own Docker daemon. Always
#             would make the kubelet try Docker Hub and fail with ErrImagePull.
#
#   ECR    -> <registry>/<name>:<tag>    + Always
#             ECR repositories here are tag-mutable, so pushing a rebuilt image
#             under the same tag is normal. IfNotPresent would keep running the
#             copy already cached on the node and quietly ignore the new push.
#             Switch to IfNotPresent once tags are immutable and unique per build.
#
# Only the application's own images are touched. postgres, redis and
# elasticsearch stay on their public upstream tags.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ $# -lt 1 ]; then
  echo "usage: $0 local" >&2
  echo "       $0 <registry> <tag>" >&2
  exit 1
fi

if [ "$1" = "local" ]; then
  REGISTRY="ecom"
  TAG="local"
  POLICY="IfNotPresent"
else
  REGISTRY="${1%/}"
  TAG="${2:?a tag is required when pushing to a registry}"
  POLICY="Always"
fi

REGISTRY="$REGISTRY" TAG="$TAG" POLICY="$POLICY" python3 - <<'PY'
import os, pathlib, re

REGISTRY = os.environ["REGISTRY"]
TAG      = os.environ["TAG"]
POLICY   = os.environ["POLICY"]

# Only these. Anything else in an `image:` line is an upstream dependency.
OWN = {
    "api-gateway", "account", "cart", "inventory", "order-status", "payment",
    "place-order", "product-review", "recommendation", "recommendation-generation",
    "search", "shipping", "database", "web",
}

# Split the reference apart and compare the LAST PATH SEGMENT exactly. Matching
# the name anywhere in the string is not good enough: "elasticsearch" ends with
# "search", so an alternation over the names happily rewrote
#   docker.elastic.co/elasticsearch/elasticsearch:8.13.4
# into the search service's image, silently replacing Elasticsearch with a Node
# process. Anchoring on the whole segment is the only safe test.
pattern = re.compile(r"^(?P<indent>\s*)image:\s*(?P<ref>\S+)\s*$")

changed = 0
for path in sorted(pathlib.Path("k8s").rglob("*.yaml")):
    lines = path.read_text().split("\n")
    out, touched = [], False

    for line in lines:
        m = pattern.match(line)
        if not m:
            out.append(line)
            continue

        ref = m.group("ref")
        # Strip the tag, then take the final path segment. A digest (@sha256:…)
        # is left alone entirely — it pins an exact image on purpose.
        if "@" in ref:
            out.append(line)
            continue
        repo = ref.rsplit(":", 1)[0] if ":" in ref.rsplit("/", 1)[-1] else ref
        name = repo.rsplit("/", 1)[-1]

        if name not in OWN:
            out.append(line)
            continue

        out.append(f"{m.group('indent')}image: {REGISTRY}/{name}:{TAG}")
        touched = True

    if touched:
        text = "\n".join(out)
        # The pull policy sits on the line after the image in every manifest here.
        text = re.sub(
            r"(image: " + re.escape(REGISTRY) + r"/\S+\n\s*imagePullPolicy: )\w+",
            lambda mm: mm.group(1) + POLICY,
            text,
        )
        path.write_text(text)
        changed += 1

print(f"  registry      {REGISTRY}")
print(f"  tag           {TAG}")
print(f"  pull policy   {POLICY}")
print(f"  files updated {changed}")
PY

echo
grep -rh "image: " k8s/ | grep -vE "postgres:|redis:|elasticsearch:" | sort -u | sed 's/^ */  /'
