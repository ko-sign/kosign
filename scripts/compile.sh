#!/usr/bin/env bash
# Compile a Ko-sign .sil contract to a JSON artifact using the locally-built
# Silverscript compiler. The compiler lives in .tooling/silverscript (cloned,
# gitignored) because there is no published silverc release yet (Toccata tooling
# is experimental). See docs/RISKS.md.
#
# Usage:
#   scripts/compile.sh contracts/probes/probe_age_time.sil [ctor_args.json]
#   scripts/compile.sh contracts/KoProposal.sil contracts/args/proposal.json
#
# Output: artifacts/<name>.json
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SILC="$ROOT/.tooling/silverscript/target/debug/examples/silc"
SRC="${1:?usage: compile.sh <file.sil> [ctor_args.json]}"
CTOR="${2:-}"

if [[ ! -x "$SILC" ]]; then
  echo "compiler not built. Run: scripts/build-compiler.sh" >&2
  exit 1
fi

mkdir -p "$ROOT/artifacts"
NAME="$(basename "$SRC" .sil)"
OUT="$ROOT/artifacts/$NAME.json"

if [[ -n "$CTOR" ]]; then
  "$SILC" "$SRC" "$CTOR" > "$OUT"
else
  "$SILC" "$SRC" > "$OUT"
fi
echo "compiled $SRC -> artifacts/$NAME.json ($(wc -c < "$OUT" | tr -d ' ') bytes)"
