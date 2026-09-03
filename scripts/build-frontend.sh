#!/usr/bin/env bash
# Build the app, and record exactly what was built.
#
# Everything else this repo verifies — the covenants, the wasm builder, the spend
# guard — protects the code in this repository. None of it helps if the page a
# person actually loads is not this code. A bundle served from a CDN is the last
# link, and until this existed there was no way for anyone, including us, to check
# that link.
#
# This does not make that link trustworthy. It makes it CHECKABLE:
#
#   * the build is deterministic, so the same commit yields the same bytes. If it
#     ever stops being (a dependency that stamps a timestamp, a plugin that emits a
#     random id), verification becomes impossible and this says so loudly.
#   * every emitted file is hashed into dist/BUILD-MANIFEST.json, plus one digest
#     over the whole tree, so a deployment can be named by a single 64-hex string.
#   * scripts/verify-deployed.mjs fetches a live site and compares it to that
#     manifest, which is the check that actually matters to a person deciding
#     whether to type their key into a page.
#
# The honest limit: a manifest published by whoever serves the bundle proves
# nothing on its own. It is worth something only when the digest is also recorded
# somewhere the server does not control — a git tag, a release, a message a person
# already trusts. This script produces the number; publishing it is a human step.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
DIST="frontend/dist"

command -v pnpm >/dev/null || { echo "pnpm not found — cannot build, and reporting success would be a lie" >&2; exit 1; }

CHECK_DETERMINISM=0
[[ "${1:-}" == "--check-determinism" ]] && CHECK_DETERMINISM=1

echo "building the frontend…"
pnpm --filter kosign-frontend build >/dev/null

if (( CHECK_DETERMINISM )); then
  # Two builds, compared. Not a formality: rollup chunk names are content-hashed,
  # so a single stray timestamp does not just change one file, it renames half of
  # them — and every future verification would report a tamper that never happened.
  snap="$(mktemp -d)"; trap 'rm -rf "$snap"' EXIT
  cp -R "$DIST" "$snap/first"
  echo "building again to check the build is deterministic…"
  pnpm --filter kosign-frontend build >/dev/null
  if ! diff -rq "$snap/first" "$DIST" >/dev/null 2>&1; then
    echo "" >&2
    echo "FRONTEND BUILD IS NOT DETERMINISTIC — two builds of the same source differ:" >&2
    diff -rq "$snap/first" "$DIST" >&2 || true
    echo "" >&2
    echo "Nobody can verify a deployment against a build that does not reproduce." >&2
    exit 1
  fi
  echo "deterministic: two builds are byte-identical"
fi

node scripts/frontend-manifest.mjs --write
