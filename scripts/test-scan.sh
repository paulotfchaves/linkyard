#!/usr/bin/env bash
# Proves scan.sh actually fails. A gate that never fails is not a gate.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

# 1. Clean tree must pass.
if ! bash scripts/scan.sh >/dev/null 2>&1; then
  echo "FAIL: scan.sh rejected a clean tree"
  fail=1
else
  echo "ok: clean tree passes"
fi

# 2. Each forbidden term must be caught in a working-tree file.
for term in nextech marcolang grupoxflow; do
  printf 'contact: %s\n' "$term" > .tmp-scan-probe.txt
  if bash scripts/scan.sh >/dev/null 2>&1; then
    echo "FAIL: scan.sh missed the term '$term' in the working tree"
    fail=1
  else
    echo "ok: '$term' caught"
  fi
  rm -f .tmp-scan-probe.txt
done

# 3. A token-shaped secret must be caught.
printf 'CF_TOKEN=cfut_%s\n' "$(printf 'a%.0s' {1..40})" > .tmp-scan-probe.txt
if bash scripts/scan.sh >/dev/null 2>&1; then
  echo "FAIL: scan.sh missed a token-shaped secret"
  fail=1
else
  echo "ok: token-shaped secret caught"
fi
rm -f .tmp-scan-probe.txt

# 4. A Brazilian CPF must be caught.
printf 'cpf: 123.456.789-01\n' > .tmp-scan-probe.txt
if bash scripts/scan.sh >/dev/null 2>&1; then
  echo "FAIL: scan.sh missed a CPF"
  fail=1
else
  echo "ok: CPF caught"
fi
rm -f .tmp-scan-probe.txt

# 5. A term that exists ONLY in history must still be caught. Without this case
# a broken history pathspec would silently pass every run: the working-tree
# checks above would keep working while the history sweep looked at nothing.
if [ -d .git ] && git rev-parse HEAD >/dev/null 2>&1; then
  probe_branch="scan-probe-$$"
  start_ref=$(git rev-parse --abbrev-ref HEAD)
  git checkout -q -b "$probe_branch"
  printf 'contact: nextech\n' > .tmp-scan-probe.txt
  git add -f .tmp-scan-probe.txt >/dev/null 2>&1
  git -c user.name=probe -c user.email=probe@example.com commit -q -m "probe commit" >/dev/null 2>&1
  git rm -q --cached .tmp-scan-probe.txt >/dev/null 2>&1
  rm -f .tmp-scan-probe.txt
  git -c user.name=probe -c user.email=probe@example.com commit -q -m "remove probe" >/dev/null 2>&1

  # The file is gone from the tree but lives on in history.
  if bash scripts/scan.sh >/dev/null 2>&1; then
    echo "FAIL: scan.sh missed a term that exists only in git history"
    fail=1
  else
    echo "ok: history-only term caught"
  fi

  git checkout -q "$start_ref"
  git branch -q -D "$probe_branch" >/dev/null 2>&1
  rm -f .tmp-scan-probe.txt
fi

exit $fail
