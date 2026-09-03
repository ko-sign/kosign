#!/usr/bin/env bash
# Materialise the publishable subset of this repo into opensource/<repo-name>/,
# where each directory name is the GitHub repository it becomes under
# https://github.com/ko-sign/.
#
# The boundary lives here as code rather than as a one-off move, so it can be
# reviewed, re-run, and diffed. opensource/ is gitignored: it is a build output.
#
#   bash scripts/make-opensource.sh        (or: npm run opensource)
#
# WHAT SHIPS — one repo, ko-sign/kosign, deliberately not split. The whole point
# is that anyone can rebuild a vault address from source and compare it to chain,
# and that story needs contracts/ + the compiler scripts + treasuryTemplates.js
# + the wasm builder together. Splitting them would break verification.
#
# WHAT DOES NOT SHIP, and why:
#   backend/            route-A bridge, superseded by in-browser tx building. It
#                       reads owner private keys from .secrets/ on the host — not
#                       something to hand a wallet auditor as "our code".
#   tools/kaspa-probe/  the same route-A path in Rust (src/bin/* read .secrets/).
#   indexer/            operational service with its own deployment story.
#   plan.md, .claude/   internal working files.
#   the two dev-only scripts/ files — the publish step and its pattern list —
#                       which describe the private side of the boundary and so
#                       cannot sit on the public side of it.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="opensource/kosign"
PATTERNS="scripts/privacy-patterns.txt"   # dev-only; see the privacy gate below
rm -rf "$OUT"; mkdir -p "$OUT"

# Copy tracked files only, so nothing untracked or secret can leak in.
git ls-files -z \
  ':(exclude)backend/*' \
  ':(exclude)indexer/*' \
  ':(exclude)tools/kaspa-probe/*' \
  ':(exclude)plan.md' \
  ':(exclude).claude/*' \
  ':(exclude)scripts/publish-opensource.sh' \
  ":(exclude)$PATTERNS" \
| while IFS= read -r -d '' f; do
    mkdir -p "$OUT/$(dirname "$f")"
    cp "$f" "$OUT/$f"
  done

# The workspace and scripts must not reference what no longer ships.
python3 - "$OUT" <<'PY'
import json, sys, pathlib
out = pathlib.Path(sys.argv[1])

ws = out / "pnpm-workspace.yaml"
ws.write_text(ws.read_text().replace('  - "backend"\n', ""))

pkg = json.loads((out / "package.json").read_text())
# `indexer/` does not ship, so its suite cannot run here — and `test` chains the
# whole list with &&, so leaving the entry behind makes the published repo fail on
# `npm test` at the second step. Rebuild the chain from whatever survives rather
# than editing the string, so a future test:* addition cannot reintroduce this.
for dead in ("dev", "dev:api", "verify:node", "wallet:balance", "test:indexer"):
    pkg["scripts"].pop(dead, None)
order = ["test:wasm", "test:unit", "test:indexer", "test:packages", "test:contracts", "test:security", "test:js-guards"]
pkg["scripts"]["test"] = " && ".join(f"npm run {t}" for t in order if t in pkg["scripts"])
pkg["scripts"]["dev"] = "pnpm --filter kosign-frontend dev"
pkg["scripts"]["opensource"] = "bash scripts/make-opensource.sh"
(out / "package.json").write_text(json.dumps(pkg, indent=2) + "\n")

for dead in ("scripts/probe-node.sh", "scripts/wallet-balance.sh"):
    (out / dead).unlink(missing_ok=True)

# Prose about what does not ship is fenced in the source, so the boundary is visible
# where the text is written rather than encoded as a line filter here that silently
# stops matching the day someone rewords a bullet.
import re
FENCE = re.compile(r"[ \t]*<!-- oss:strip -->.*?<!-- /oss:strip -->\n?", re.S)
for md in out.rglob("*.md"):
    if "node_modules" in md.parts: continue
    src = md.read_text()
    if "oss:strip" not in src: continue
    md.write_text(FENCE.sub("", src))

# pnpm compares the lockfile's importers against the workspace and refuses a
# --frozen-lockfile install when they disagree, so dropping `backend` from the
# workspace above without dropping it here makes CI red on the published repo's
# very first push.
lock = out / "pnpm-lock.yaml"
lock.write_text(lock.read_text().replace("  backend: {}\n\n", "").replace("  backend: {}\n", ""))
PY

# A fence that survives the copy is a fence that did not fire. Match a marker that
# is ALONE on its line, which is what a real fence looks like — the changelog and
# devlog discuss the marker in running prose, and a bare substring search calls
# that a leak. This script ships too and necessarily contains it: the one exemption.
FENCE_LINE='^[[:space:]]*<!-- /?oss:strip -->[[:space:]]*$'
if grep -rqIE "$FENCE_LINE" "$OUT" --exclude-dir=node_modules --exclude=make-opensource.sh 2>/dev/null; then
  echo "   ✗ an oss:strip fence survived into $OUT — check that it is balanced" >&2
  grep -rnIE "$FENCE_LINE" "$OUT" --exclude-dir=node_modules --exclude=make-opensource.sh >&2
  exit 1
fi
if grep -q '^  backend:' "$OUT/pnpm-lock.yaml"; then
  echo "   ✗ the backend importer is still in the published lockfile" >&2; exit 1
fi

# Tracked-only is the safety property, but it is also a way to lose a file: a new
# doc that has not been `git add`ed is skipped in silence, and the first symptom
# is a dead link in the published README. Name what was left behind.
untracked="$(git ls-files --others --exclude-standard \
  ':(exclude)backend/*' ':(exclude)indexer/*' ':(exclude)tools/kaspa-probe/*' ':(exclude).claude/*')"
if [ -n "$untracked" ]; then
  echo "── NOT copied (untracked — git add them if they should ship):"
  printf '%s\n' "$untracked" | sed 's|^|   ? |'
  echo
fi

echo "── opensource/kosign  →  github.com/ko-sign/kosign"
printf '   %s tracked files, %s\n' "$(find "$OUT" -type f | wc -l | tr -d ' ')" "$(du -sh "$OUT" | cut -f1)"
for d in contracts tools packages frontend scripts docs .github; do
  [ -e "$OUT/$d" ] && printf '   %-12s %s files\n' "$d/" "$(find "$OUT/$d" -type f | wc -l | tr -d ' ')"
done

echo
# Privacy gate: the developer's identity, and the private infrastructure this
# project is developed next to, must never reach the published tree. The
# patterns live in a dev-only file rather than inline, because spelling them out
# here would itself ship them — this script is part of the published tree.
# Unlike the advisory check below, a hit is fatal.
echo "── privacy gate: identity and private-infra strings"
if [ ! -f "$PATTERNS" ]; then
  echo "   ✓ skipped ($PATTERNS is dev-only; this tree is already public)"
elif grep -rInIE -f <(grep -vE '^\s*(#|$)' "$PATTERNS") --exclude-dir=node_modules \
       --exclude=pnpm-lock.yaml "$OUT" 2>/dev/null | sed 's|^|   ✗ |'; then
  echo
  echo "   FATAL: the strings above must not ship. Fix them in the source tree"
  echo "   (not in $OUT — it is regenerated), then re-run."
  exit 1
else
  echo "   ✓ clean"
fi

echo
echo "── leak check: anything referencing what does not ship?"
if grep -rlI -e 'backend/' -e 'kaspa-probe' -e '\.secrets' "$OUT" \
     --exclude-dir=node_modules --exclude=CHANGELOG.md --exclude=DEVLOG.md 2>/dev/null | sed 's|^|   ⚠ |'; then
  echo "   (review the files above — prose mentions are fine, live references are not)"
else
  echo "   ✓ none"
fi
