#!/usr/bin/env bash
# Creates .env from the template with freshly generated secrets.
#
#   bash scripts/generate-secrets.sh
#
# Refuses to overwrite an existing .env; pass --force to replace it.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env && "${1:-}" != "--force" ]]; then
  echo ".env already exists. Re-run with --force to overwrite it." >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate secrets." >&2
  exit 1
fi

jwt_secret="$(openssl rand -base64 48 | tr -d '\n')"
internal_secret="$(openssl rand -base64 48 | tr -d '\n')"
pg_password="$(openssl rand -base64 24 | tr -d '\n/+=')"

cp .env.example .env

# The two signing keys must differ: one is client-facing, the other is not.
python3 - "$jwt_secret" "$internal_secret" "$pg_password" <<'PY'
import re, sys
jwt, internal, pg = sys.argv[1:4]
text = open(".env").read()
text = re.sub(r"^JWT_SECRET=.*$",          f"JWT_SECRET={jwt}",               text, flags=re.M)
text = re.sub(r"^INTERNAL_JWT_SECRET=.*$", f"INTERNAL_JWT_SECRET={internal}", text, flags=re.M)
text = re.sub(r"^POSTGRES_PASSWORD=.*$",   f"POSTGRES_PASSWORD={pg}",         text, flags=re.M)
open(".env", "w").write(text)
PY

chmod 600 .env
echo "Wrote .env with generated secrets (mode 600)."
echo "It is git-ignored — never commit it."
