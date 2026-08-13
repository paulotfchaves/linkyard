#!/usr/bin/env bash
# Publication gate.
#
# This repository is public. This script is what stands between a careless
# copy-paste and a client name on the internet. It sweeps the working tree AND
# the full git history for client brands, personal data, and secrets.
#
# Portable between GNU and BSD userland (Ubuntu CI, macOS development): uses
# only POSIX grep features plus -E/-I/-r, and no GNU-only flags.
#
# This file and its test necessarily contain the forbidden terms themselves, so
# both are excluded from every sweep.
set -uo pipefail
cd "$(dirname "$0")/.."

# Client and brand terms that must never appear in a public artifact.
BRANDS='nextech|marcolang|leandroferrari|scalementoring|grupoxflow|bflancamentos|xflow|equipe-invisivel|paulostark|cofounder|siriustrack'

# Secret shapes: Cloudflare tokens, JWTs, Postgres URLs carrying a password, and
# generic key/secret/password/token assignments with a long value.
SECRETS='cfut_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|postgres(ql)?://[^:/@ ]+:[^@ ]+@|(api[_-]?key|secret|password|token)[^A-Za-z0-9]{1,4}[A-Za-z0-9_-]{24,}'

# Brazilian personal data shapes: CPF, CNPJ, phone with country code.
PII='[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}|[0-9]{2}\.[0-9]{3}\.[0-9]{3}/[0-9]{4}-[0-9]{2}|\+55[0-9]{10,11}'

EXCLUDES=(
  --exclude-dir=node_modules
  --exclude-dir=.git
  --exclude-dir=coverage
  --exclude=scan.sh
  --exclude=test-scan.sh
  --exclude=package-lock.json
)

# Pathspecs mirroring the greps above, for the history sweep.
HISTORY_PATHS=(
  '.'
  ':(exclude)scripts/scan.sh'
  ':(exclude)scripts/test-scan.sh'
  ':(exclude)package-lock.json'
)

status=0

report() {
  echo ""
  echo "GATE FAILED: $1"
  echo "$2"
  status=1
}

# ── working tree ────────────────────────────────────────────────────────────

hits=$(grep -rIEi "${EXCLUDES[@]}" "$BRANDS" . 2>/dev/null || true)
[ -n "$hits" ] && report "client brand in the working tree" "$hits"

hits=$(grep -rIE "${EXCLUDES[@]}" "$SECRETS" . 2>/dev/null || true)
[ -n "$hits" ] && report "secret-shaped string in the working tree" "$hits"

hits=$(grep -rIE "${EXCLUDES[@]}" "$PII" . 2>/dev/null || true)
[ -n "$hits" ] && report "personal data in the working tree" "$hits"

# ── git history ─────────────────────────────────────────────────────────────
# A brand removed in a later commit is still public if it ever landed. CI must
# clone with fetch-depth: 0 or this sweep sees nothing.

if [ -d .git ] && git rev-parse HEAD >/dev/null 2>&1; then
  hits=$(git log --all -p -- "${HISTORY_PATHS[@]}" 2>/dev/null | grep -Ei "$BRANDS" || true)
  [ -n "$hits" ] && report "client brand in git history" "$(echo "$hits" | head -20)"

  hits=$(git log --all --format='%H %s%n%b' 2>/dev/null | grep -Ei "$BRANDS" || true)
  [ -n "$hits" ] && report "client brand in a commit message" "$hits"

  hits=$(git log --all -p -- "${HISTORY_PATHS[@]}" 2>/dev/null | grep -E "$SECRETS" || true)
  [ -n "$hits" ] && report "secret-shaped string in git history" "$(echo "$hits" | head -20)"

  hits=$(git log --all -p -- "${HISTORY_PATHS[@]}" 2>/dev/null | grep -E "$PII" || true)
  [ -n "$hits" ] && report "personal data in git history" "$(echo "$hits" | head -20)"
fi

if [ $status -eq 0 ]; then
  echo "GATE PASSED: no brand, personal data, or secret found in tree or history."
fi

exit $status
