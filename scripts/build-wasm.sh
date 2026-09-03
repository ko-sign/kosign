#!/usr/bin/env bash
# Rebuild the browser's covenant transaction builder from source, and require the
# committed artefacts to match it byte for byte.
#
# frontend/src/wasm/kosign_wasm_tx_bg.wasm builds EVERY transaction an owner
# signs — it chooses the amount, the recipient and the covenant continuation. It
# is a committed binary, and reading tools/wasm-tx/src/lib.rs tells you nothing
# about it unless something ties the two together. This is that something.
#
# Reproducibility is not free here, and three separate things had to be fixed
# before "rebuild it and compare" could mean anything:
#
#   Cargo.lock was gitignored. 392 packages, none of their versions recorded.
#   A rebuild resolved crates.io afresh, so two honest people building the same
#   commit got different binaries — and nobody could say which serde_json was
#   inside the thing that decides a recipient address.
#
#   rustc was unpinned (rust-toolchain.toml now fixes it). Instruction selection
#   and section ordering are the compiler's choice; a different rustc is a
#   different binary from identical source.
#
#   rustc records the path of every file it compiles, so the shipped blob carried
#   47 occurrences of one developer's home directory and could only ever be
#   reproduced by that one account. --remap-path-prefix below is what makes
#   "anyone can check this" true rather than aspirational.
#
# One honest limit remains. secp256k1-sys compiles C with the HOST clang, and
# some of it survives into the wasm, so a different clang is a different binary
# even with everything above pinned. The toolchain that produced the committed
# artefacts is recorded in the manifest; on a mismatch this script says so
# instead of reporting tampering. Reproducing across machines needs a pinned
# container, which is a separate job.
#
# Usage:
#   bash scripts/build-wasm.sh            verify the committed artefacts
#                                         (exit 1 = drift on the SAME toolchain,
#                                          exit 2 = a different toolchain, expected)
#   bash scripts/build-wasm.sh --write    rebuild, install and record them
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$ROOT/tools/wasm-tx"
OUT="$ROOT/frontend/src/wasm"
# one argument per line: these messages tell someone what to run, and a wall of
# text with the command buried mid-sentence is a message nobody acts on.
die() { echo "" >&2; printf '%s\n' "$@" >&2; exit 1; }

MODE="verify"
if [[ "${1:-}" == "--write" ]]; then
  # Writing a HOST build over the committed artefacts is how reproducibility dies:
  # the canonical artefact is the one tools/wasm-tx/Dockerfile.repro produces,
  # because that is the one a second person can reproduce. secp256k1-sys compiles
  # C with the host clang, so a laptop build is byte-reproducible by exactly one
  # account on one machine — which is the situation this whole apparatus exists to
  # get out of. Refuse by default rather than let a convenient command quietly undo
  # it, and say what to run instead.
  if [[ "${2:-}" != "--not-reproducible" ]]; then
    die "refusing to overwrite the committed artefacts with a build from THIS machine." \
      "" \
      "The canonical build is the pinned container, because anyone can reproduce it:" \
      "  npm run build:wasm      (writes from the container)" \
      "" \
      "secp256k1-sys compiles C with the host clang, so what this script builds is" \
      "reproducible only by someone with your exact toolchain. If you genuinely want" \
      "that — a container is unavailable and you accept nobody else can verify the" \
      "result — pass --not-reproducible after --write."
  fi
  echo "WARNING: writing a host build. Nobody without your exact toolchain can reproduce it." >&2
  MODE="write"
fi

ARTEFACTS=(kosign_wasm_tx_bg.wasm kosign_wasm_tx.js kosign_wasm_tx.d.ts kosign_wasm_tx_bg.wasm.d.ts)


# Fail loudly rather than skipping. A suite that silently does nothing when a
# tool is missing reports success for a check that never ran — the exact failure
# scripts/test-contracts.sh used to have.
command -v cargo >/dev/null || die "cargo not found — this check cannot run without the Rust toolchain." \
  "install: https://rustup.rs (rust-toolchain.toml pins the version)"
command -v wasm-bindgen >/dev/null || die "wasm-bindgen not found." \
  "install: cargo install wasm-bindgen-cli --version \"\$WANT\" (see below)"

# The CLI and the crate must be the same version or the generated glue silently
# disagrees with the module it is meant to load. Read the wanted version out of
# the lockfile so this pin cannot drift from the build.
WANT="$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/[",]/,""); sub(/version = /,""); print; exit}' "$CRATE/Cargo.lock")"
HAVE="$(wasm-bindgen --version | awk '{print $2}')"
[[ "$WANT" == "$HAVE" ]] || die "wasm-bindgen CLI is $HAVE but Cargo.lock pins $WANT." \
  "install: cargo install wasm-bindgen-cli --version $WANT --force"

# secp256k1-sys needs a clang that can target wasm32; Apple's system clang cannot.
LLVM_BIN=""
if [[ -n "${LLVM_PREFIX:-}" ]]; then LLVM_BIN="$LLVM_PREFIX/bin"
elif command -v brew >/dev/null && brew --prefix llvm >/dev/null 2>&1; then LLVM_BIN="$(brew --prefix llvm)/bin"
fi
CC_WASM="${LLVM_BIN:+$LLVM_BIN/clang}"; AR_WASM="${LLVM_BIN:+$LLVM_BIN/llvm-ar}"
[[ -z "$CC_WASM" ]] && { CC_WASM="$(command -v clang || true)"; AR_WASM="$(command -v llvm-ar || true)"; }
[[ -x "$CC_WASM" ]] || die "no clang able to target wasm32 (secp256k1-sys compiles C)." \
  "macOS: brew install llvm    linux: apt-get install clang lld" \
  "or point LLVM_PREFIX at an LLVM install"

CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
# The object cache is persistent and gitignored (tools/wasm-tx/.gitignore covers
# /target) so verifying is incremental rather than a cold build every time. Only
# the wasm-bindgen output is staged in a temp dir, so a failed verify can never
# leave a half-written artefact in frontend/src/wasm/. It lives under target/
# rather than target/ itself because the RUSTFLAGS here differ from an ad-hoc
# `cargo build`, and sharing one directory makes the two evict each other.
CACHE="$CRATE/target/verify"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# RUSTFLAGS as an env var REPLACES the crate's .cargo/config.toml rustflags, so
# the getrandom backend cfg has to be repeated here — dropping it does not warn,
# it just fails to link.
echo "building $CRATE (release, wasm32-unknown-unknown)…"
(
  cd "$CRATE"
  CARGO_TARGET_DIR="$CACHE" \
  RUSTFLAGS="--cfg getrandom_backend=\"wasm_js\" --remap-path-prefix=$CARGO_HOME_DIR=/cargo --remap-path-prefix=$ROOT=/src" \
  CC_wasm32_unknown_unknown="$CC_WASM" AR_wasm32_unknown_unknown="$AR_WASM" \
    cargo build --release --target wasm32-unknown-unknown
)
wasm-bindgen --target web --out-dir "$STAGE" \
  "$CACHE/wasm32-unknown-unknown/release/kosign_wasm_tx.wasm"

# The remap exists so no machine's paths reach the shipped binary. Check it
# actually worked rather than trusting the flag: a typo in the prefix is silent.
if strings -a "$STAGE/kosign_wasm_tx_bg.wasm" 2>/dev/null | grep -qE "$(printf '%s' "$HOME" | sed 's/[.[\*^$]/\\&/g')"; then
  die "the rebuilt wasm still embeds this machine's home directory — the path remap did not apply," \
      "so the artefact would be reproducible only on this account."
fi

TOOLCHAIN_JSON="$(printf '{"rustc":"%s","wasmBindgen":"%s","clang":"%s"}' \
  "$(rustc --version)" "$HAVE" "$("$CC_WASM" --version | head -1)")"

if [[ "$MODE" == "write" ]]; then
  for f in "${ARTEFACTS[@]}"; do cp "$STAGE/$f" "$OUT/$f"; done
  node "$ROOT/scripts/wasm-manifest.mjs" --write --toolchain "$TOOLCHAIN_JSON"
  echo "installed into frontend/src/wasm/"
  exit 0
fi

differ=()
for f in "${ARTEFACTS[@]}"; do
  cmp -s "$STAGE/$f" "$OUT/$f" || differ+=("$f")
done

if (( ${#differ[@]} )); then
  echo "" >&2
  echo "WASM VERIFY FAILED — the committed artefacts are not what this source builds:" >&2
  for f in "${differ[@]}"; do
    printf '  %-32s committed %s\n                                   rebuilt   %s\n' "$f" \
      "$(shasum -a 256 "$OUT/$f" | cut -c1-16)…" "$(shasum -a 256 "$STAGE/$f" | cut -c1-16)…" >&2
  done
  recorded="$(node -e 'const m=require("'"$OUT"'/MANIFEST.json");console.log(JSON.stringify(m.toolchain??{}))' 2>/dev/null || echo '{}')"
  echo "" >&2
  echo "  recorded toolchain: $recorded" >&2
  echo "  this machine:       $TOOLCHAIN_JSON" >&2
  echo "" >&2
  # The two cases mean opposite things, so they exit differently: a caller that
  # cannot read prose (CI) must not report a toolchain difference as tampering.
  if [ "$recorded" = "$TOOLCHAIN_JSON" ]; then
    echo "The toolchains MATCH, so this is the serious case: the committed blob was not" >&2
    echo "built from this source." >&2
    echo "" >&2
    echo "To adopt the rebuild: npm run build:wasm" >&2
    exit 1
  fi
  echo "The toolchains DIFFER, so differing bytes are expected and this is not tampering —" >&2
  echo "secp256k1-sys compiles C with the host clang. Settle it against the recorded" >&2
  echo "toolchain with 'npm run verify:wasm' (Docker), which pins one." >&2
  echo "" >&2
  echo "To adopt the rebuild: npm run build:wasm" >&2
  exit 2
fi

echo "WASM OK — all ${#ARTEFACTS[@]} artefacts are byte-identical to a rebuild from source"
echo "  $TOOLCHAIN_JSON"
