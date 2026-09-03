#!/usr/bin/env bash
# Compile every Ko-sign contract + probe to artifacts/. Ctor args under
# contracts/args/<name>.json are illustrative placeholders for compile checks;
# real per-treasury args are produced by packages/descriptor at deploy time.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ok=0; fail=0
compile() {
  local src="$1" name; name="$(basename "$src" .sil)"
  local args="contracts/args/$name.json"
  if bash scripts/compile.sh "$src" "$args" >/dev/null 2>/tmp/silc.$name.err; then
    echo "  ✓ $name"; ok=$((ok+1))
  else
    echo "  ✗ $name"; sed 's/^/      /' "/tmp/silc.$name.err"; fail=$((fail+1))
  fi
}

echo "contracts:"
for f in contracts/KoRoot.sil contracts/KoVault.sil contracts/KoProposal.sil; do compile "$f"; done
echo "probes:"
for f in contracts/probes/*.sil; do compile "$f"; done
echo "---- $ok compiled, $fail failed ----"
[[ $fail -eq 0 ]]
