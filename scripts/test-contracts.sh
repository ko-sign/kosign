#!/usr/bin/env bash
# Run the covenant contracts' own test suites through the Silverscript debugger.
#
# These exercise the compiled SCRIPT against synthetic transactions — including
# covenant-id bindings on inputs and outputs — which nothing else in `npm test`
# does: the JS suites test transaction BUILDING and fee math, not consensus-side
# script evaluation. A contract can therefore pass every JS test while still
# being exploitable, so these run on every `npm test` rather than on demand —
# which also keeps the fixtures honest: a test file that drifts out of sync with
# its contract's constructor fails loudly here instead of rotting unnoticed.
#
# It GLOBS rather than naming contracts. A hand-written list is a silent-omission
# machine: scripts/verify-contracts.sh (deleted, this replaced it) listed
# KoProposal and KoVault, so KoRoot's entire suite was never run by the command
# the README tells you to run. Adding a contract must not require remembering to
# add it here, so every <name>.test.json next to a <name>.sil is picked up —
# contracts/ and contracts/probes/ alike.
set -uo pipefail
cd "$(dirname "$0")/.."

DBG=".tooling/silverscript/target/debug/cli-debugger"
if [ ! -x "$DBG" ]; then
  cat >&2 <<'MSG'
the Silverscript toolchain is not built, so THESE TESTS DID NOT RUN.

This used to exit 0 and print a note. That made `npm test` able to report success
having executed no contract test at all — and the contract suite is the only thing
that would catch the one guard this project cannot see in its own source: the
compiler emits `require(end - start <= max)` before unrolling a bounded loop, which
is what stops a UTXO being parked past the scan window, and it carries a TODO to
become debug-only. The 17-input fixtures are the tripwire. A silent skip disarms it.

  run: pnpm build:compiler
MSG
  exit 1
fi

rc=0
for tf in contracts/*.test.json contracts/probes/*.test.json; do
  [ -e "$tf" ] || continue
  sil="${tf%.test.json}.sil"
  [ -e "$sil" ] || { echo "no contract for $tf"; rc=1; continue; }
  echo "── $(basename "$sil")"
  "$DBG" --test-file "$tf" --run-all "$sil" 2>&1 | grep -E '  (PASS|FAIL)|tests:|Error' || true
  "$DBG" --test-file "$tf" --run-all "$sil" >/dev/null 2>&1 || rc=1
done
exit $rc
