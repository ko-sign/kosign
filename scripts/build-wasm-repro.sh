#!/usr/bin/env bash
# Rebuild the covenant transaction builder inside a fully pinned container, so a
# second person can check the artefact.
#
# scripts/build-wasm.sh already catches the routine failure — edit lib.rs, forget
# to rebuild — and it is the one wired into `npm test`. What it could not do is let
# anyone else verify the result: secp256k1-sys compiles C with the host clang and
# some of it survives into the binary, so byte identity held per-toolchain and
# "reproducible" quietly meant "on the machine that built it".
#
# tools/wasm-tx/Dockerfile.repro pins the base image by digest, the apt archive by
# snapshot date, wasm-bindgen by the lockfile, the dependency graph by the tracked
# Cargo.lock, and the source paths by --remap-path-prefix. With all of that fixed,
# any machine with Docker should produce the same bytes.
#
#   bash scripts/build-wasm-repro.sh          compare against the committed artefacts
#   bash scripts/build-wasm-repro.sh --write  adopt the container's output
#
# Not part of `npm test`: it needs Docker and pulls half a gigabyte. It belongs to
# a release, and to anyone who wants to check a release without trusting us.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$ROOT/tools/wasm-tx"
OUT="$ROOT/frontend/src/wasm"
TAG="kosign-wasm-repro"
MODE="verify"
[[ "${1:-}" == "--write" ]] && MODE="write"

ARTEFACTS=(kosign_wasm_tx_bg.wasm kosign_wasm_tx.js kosign_wasm_tx.d.ts kosign_wasm_tx_bg.wasm.d.ts)

die() { echo "" >&2; echo "$@" >&2; exit 1; }

command -v docker >/dev/null || die "docker not found — this check cannot run, and reporting success would be a lie." \
  "install Docker, or use the host-toolchain check instead:  npm run verify:wasm"
docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable — start it and run this again."

echo "building in a pinned container (first run pulls the base image)…"
docker build --platform linux/amd64 -f "$CRATE/Dockerfile.repro" -t "$TAG" "$CRATE"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
# `docker create` + `cp` rather than a bind mount: a mount would let the host
# filesystem's ownership and timestamps reach into the build, which is the sort of
# thing that makes a "reproducible" artefact reproducible only here.
cid="$(docker create "$TAG")"
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true; rm -rf "$STAGE"' EXIT
for f in "${ARTEFACTS[@]}" TOOLCHAIN; do docker cp "$cid:/out/$f" "$STAGE/$f" >/dev/null; done

echo ""
echo "container toolchain:"
sed 's/^/  /' "$STAGE/TOOLCHAIN"
echo ""

if [[ "$MODE" == "write" ]]; then
  for f in "${ARTEFACTS[@]}"; do cp "$STAGE/$f" "$OUT/$f"; done
  TOOLCHAIN_JSON="$(node -e '
    const l = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n");
    console.log(JSON.stringify({ rustc: l[0], wasmBindgen: l[1], clang: l[2], container: l[3] }));
  ' "$STAGE/TOOLCHAIN")"
  node "$ROOT/scripts/wasm-manifest.mjs" --write --toolchain "$TOOLCHAIN_JSON"
  echo "installed from the container into frontend/src/wasm/"
  exit 0
fi

differ=()
for f in "${ARTEFACTS[@]}"; do cmp -s "$STAGE/$f" "$OUT/$f" || differ+=("$f"); done

if (( ${#differ[@]} )); then
  echo "REPRODUCIBLE BUILD MISMATCH — the container produced different bytes:" >&2
  for f in "${differ[@]}"; do
    printf '  %-32s committed %s\n                                   container %s\n' "$f" \
      "$(shasum -a 256 "$OUT/$f" | cut -c1-16)…" "$(shasum -a 256 "$STAGE/$f" | cut -c1-16)…" >&2
  done
  echo "" >&2
  echo "Everything the build reads is pinned, so this is not expected to drift on its" >&2
  echo "own. Either the committed artefacts were built outside the container (run" >&2
  echo "  bash scripts/build-wasm-repro.sh --write" >&2
  echo "to adopt it), or the source and the artefact genuinely disagree." >&2
  exit 1
fi

echo "REPRODUCIBLE — all ${#ARTEFACTS[@]} artefacts match a build from a fully pinned container."
echo "Anyone with Docker can run this and get the same bytes, which is the point:"
echo "it no longer requires trusting the machine that built them."
