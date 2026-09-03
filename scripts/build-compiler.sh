#!/usr/bin/env bash
# Build the Silverscript compiler locally.
#
# Toccata tooling is experimental and has no published silverc binary, so we
# clone the compiler and build small clap-free front-ends that reuse the
# silverscript-lang crate. Requires rustc >= 1.90 (the Toccata rusty-kaspa
# `*-toc.1` crates demand it). See docs/RISKS.md.
#
# TWO front-ends, because there are two compilations of the same source:
#   examples/silc      — CompileOptions::default(). The PRODUCTION script:
#                        what scripts/compile.sh emits and what real addresses
#                        are derived from.
#   examples/silc_dbg  — record_debug_infos: true, exactly what cli-debugger
#                        uses. That flag skips `lower_local_aliases`, so it
#                        emits DIFFERENT bytes — a different script hash, a
#                        different P2SH address, a different sighash. Test
#                        fixtures that carry real signatures must be built from
#                        THIS one or they sign for an address the debugger never
#                        presents (see scripts/gen-koroot-tests.mjs).
# .tooling/ is gitignored (it is a clone), so both front-ends are written here
# rather than stored in the repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLING="$ROOT/.tooling"
REPO="$TOOLING/silverscript"
mkdir -p "$TOOLING"

# PINNED, for two reasons that both bite silently.
#
# Reproducibility: the project's central claim is that anyone can recompile the
# covenants and check the derived P2SH against what is on chain. A floating
# compiler makes two honest people derive different addresses from the same
# source — and the natural reading of that is that someone tampered.
#
# Security: KoVault.executeProposal and KoRoot's two entrypoints sum the inputs
# paying the active input's script with a bounded `for`. What makes that sum
# COMPLETE — what stops a UTXO being parked past the scan window — is not in the
# contract source at all: the compiler emits `require(end - start <= max)` before
# unrolling (silverscript-lang/src/compiler/for.rs). That line carries a TODO to
# move it to debug-mode-only compilation. If that lands, the contracts still
# compile and the guard-inventory checks still pass, because they pin the loop's
# SHAPE, not the compiler's output. The 17-input rejection fixtures in
# contracts/KoVault.test.json and contracts/KoRoot.test.json are what would
# actually catch it — so `npm test` must run against a known compiler, not
# whatever `main` happens to be on the day someone rebuilds.
SILVERSCRIPT_REV="2c4623124d75bd8a9a7f87ded9413ef9f6b17acd"  # "Add compiler version to CompiledContract (#124)"

if [[ ! -d "$REPO/.git" ]]; then
  git clone https://github.com/kaspanet/silverscript.git "$REPO"
fi
git -C "$REPO" fetch --quiet origin "$SILVERSCRIPT_REV" 2>/dev/null || git -C "$REPO" fetch --quiet origin
git -C "$REPO" checkout --quiet "$SILVERSCRIPT_REV"

have="$(git -C "$REPO" rev-parse HEAD)"
if [[ "$have" != "$SILVERSCRIPT_REV" ]]; then
  echo "compiler pin mismatch: wanted $SILVERSCRIPT_REV, got $have" >&2
  exit 1
fi

# A commit hash names a tree, not a working directory. `checkout` leaves local
# modifications in place, so HEAD can sit exactly on the pin while the files cargo
# is about to compile say something else entirely — and the one line this pin exists
# to protect (the `require(end - start <= max)` the loop lowering emits) is a line
# nobody would notice missing until a treasury lost money to an input parked past
# the scan window. Check the tree, not the label. The examples/ directory does not
# exist at this rev — this script creates it below — so clear it first and the
# comparison is exact.
rm -rf "$REPO/silverscript-lang/examples"
dirty="$(git -C "$REPO" status --porcelain)"
if [[ -n "$dirty" ]]; then
  echo "compiler tree is not pristine at $SILVERSCRIPT_REV — refusing to build a compiler nobody can reproduce:" >&2
  echo "$dirty" >&2
  echo "run: git -C $REPO reset --hard $SILVERSCRIPT_REV && git -C $REPO clean -fdx" >&2
  exit 1
fi

# `cat >` into a directory that is not in the pinned tree fails on a fresh clone.
mkdir -p "$REPO/silverscript-lang/examples"

# clap-free front-end so we don't need the full silverc bin dependency tree.
cat > "$REPO/silverscript-lang/examples/silc.rs" <<'RS'
use silverscript_lang::ast::Expr;
use silverscript_lang::compiler::{compile_contract, CompileOptions};
use std::{fs, process::exit};
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 { eprintln!("usage: silc <input.sil> [ctor_args.json]"); exit(2); }
    let source = fs::read_to_string(&args[1]).unwrap_or_else(|e| { eprintln!("read {}: {e}", args[1]); exit(1); });
    let ctor: Vec<Expr> = if args.len() >= 3 {
        let raw = fs::read_to_string(&args[2]).unwrap_or_else(|e| { eprintln!("read {}: {e}", args[2]); exit(1); });
        serde_json::from_str(&raw).unwrap_or_else(|e| { eprintln!("ctor parse: {e}"); exit(1); })
    } else { Vec::new() };
    match compile_contract(&source, &ctor, CompileOptions::default()) {
        Ok(c) => println!("{}", serde_json::to_string_pretty(&c).unwrap()),
        Err(e) => { eprintln!("compile error: {e}"); exit(1); }
    }
}
RS

# Same front-end, but compiled the way cli-debugger compiles. Emits only the two
# fields fixture generation needs, so its output is stable to unrelated changes
# in CompiledContract.
cat > "$REPO/silverscript-lang/examples/silc_dbg.rs" <<'RS'
// Same as examples/silc.rs but compiles with `record_debug_infos: true`, which is
// what the cli-debugger uses. That flag skips `lower_local_aliases`, so it emits a
// DIFFERENT script — the one the debugger's synthetic transactions actually run.
// Written by scripts/build-compiler.sh; see scripts/gen-koroot-tests.mjs.
use silverscript_lang::ast::Expr;
use silverscript_lang::compiler::{compile_contract, CompileOptions};
use std::{fs, process::exit};
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 { eprintln!("usage: silc_dbg <input.sil> [ctor_args.json]"); exit(2); }
    let source = fs::read_to_string(&args[1]).unwrap_or_else(|e| { eprintln!("read {}: {e}", args[1]); exit(1); });
    let ctor: Vec<Expr> = if args.len() >= 3 {
        let raw = fs::read_to_string(&args[2]).unwrap_or_else(|e| { eprintln!("read {}: {e}", args[2]); exit(1); });
        serde_json::from_str(&raw).unwrap_or_else(|e| { eprintln!("ctor parse: {e}"); exit(1); })
    } else { Vec::new() };
    let opts = CompileOptions { record_debug_infos: true, ..Default::default() };
    match compile_contract(&source, &ctor, opts) {
        Ok(c) => println!("{}", serde_json::to_string(&serde_json::json!({
            "script": c.script, "state_layout": c.state_layout
        })).unwrap()),
        Err(e) => { eprintln!("compile error: {e}"); exit(1); }
    }
}
RS

echo "building compiler (first run pulls rusty-kaspa tn12 tree, several minutes)..."
# cli-debugger is what actually RUNS contracts/*.test.json — without it both
# scripts/test-contracts.sh and scripts/test-security.sh have nothing to execute.
( cd "$REPO" && cargo build -q -p silverscript-lang --example silc --example silc_dbg )
( cd "$REPO" && cargo build -q --bin cli-debugger )
echo "compiler ready: $REPO/target/debug/examples/silc"
echo "fixture compiler ready: $REPO/target/debug/examples/silc_dbg"
echo "debugger ready: $REPO/target/debug/cli-debugger"
