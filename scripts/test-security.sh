#!/usr/bin/env bash
# ============================================================================
# Covenant security verification — re-runnable.
#
# WHAT IT PINS — seven FAMILIES of guard, kept apart on purpose
#   Every family gets its own inventory number, and its own negative control
#   wherever one can be built, so a red run names the family that broke instead of
#   reporting one aggregate that could mean anything:
#
#   LINEAGE   Kaspa's `OpInputCovenantId` returns ZERO_HASH — not an error — for
#             an input whose UTXO carries no covenant binding (rusty-kaspa
#             opcodes/mod.rs). A bare `OpInputCovenantId(a) == OpInputCovenantId(b)`
#             therefore holds for ANY two unbound inputs, so every spend path must
#             demand a NON-ZERO id on its own input. Consensus likewise never
#             restricts WHICH outputs may carry a covenant id, so each path must
#             also pin the exact set (`OpCovOutputCount` / `OpCovOutputIdx`):
#             createProposal / bootstrapVault 2, executeConfig / executeProposal /
#             deposit / approve / reject / execute 1, closeExpired 0. Without both,
#             a permissionless path becomes a covenant-minting oracle.
#             Non-zero is still not the same as OURS. Consensus lets anyone bind a
#             genesis covenant to any scriptPubKey, so a stranger can plant a
#             lineage of his own making at the treasury's own vault address and
#             sweep the next incoming payment — which arrives unbound — into it.
#             KoVault therefore carries the treasury's covenant id in STATE and
#             both its paths demand `cid == lineage`; `deposit` additionally counts
#             the vault-address inputs that carry that id (`boundVaultIns >= 1`, so
#             the sweep continues a real treasury) and those carrying any other
#             (`alienVaultIns == 0`, so a planted dust UTXO cannot re-parent it).
#   DISTINCT  Identity in this design is the SLOT, not the key: one key sitting in
#             several live owner slots is several owners to every later check, so
#             [A,A,A,B,C] at threshold 3 is a 1-of-3 treasury presenting itself as
#             3-of-5. Pairwise distinctness below ownerCount, on both the genesis
#             set (createProposal) and the installed set (executeConfig).
#   BOUNDS    threshold / ownerCount are mutable STATE. Out of range they break
#             the arithmetic every vote depends on: `threshold <= 1` mints
#             proposals already Approved, ownerCount past the five slots aliases
#             owner 0, snapThreshold 0 makes one vote sufficient, and an inflated
#             ownerCount makes a proposal impossible to Fail.
#   TALLY     approvalCount and rejectCount are STATE too, and a planted proposal
#             carries whatever its minter wrote in them. Unbounded they break the
#             same arithmetic from the other side: approvalCount 1000 behind an
#             empty bitmap makes ONE approval enough, a negative count makes the
#             threshold unreachable, and a rejectCount below zero makes Failed
#             unreachable. Bounded, plus consistency with the status the state
#             claims — Pending must not already be Approved or Failed, and
#             Approved must carry a threshold's worth of approvals.
#   VALUE     The output pinning fixes WHICH outputs inherit the id, not what they
#             are worth. Each covenant continuation must retain its input value
#             less the committed fee cap — over the whole input SET where several
#             UTXOs can be spent at once, since every copy of the script is
#             satisfied by the same single change output.
#   STATE     Which outputs inherit the id is one half; what they must CONTAIN is
#             the other, and it is `validateOutputState` /
#             `validateOutputStateWithTemplate` that pins it — the root continuing
#             with nonce+1 and the same owners, the proposal snapshotting them, and
#             the vault minted by bootstrapVault carrying the root's own covenant id
#             as its whole state. That stamp IS the treasury: a vault built around
#             any other id belongs to whoever chose it, and the template hash is
#             what stops the spender-supplied vault bytes from being some other
#             script entirely. Inventory-only, like SCAN: the call spans several
#             lines and a partial one does not compile, so it cannot be made into a
#             negative control — but it is why five of KoRoot's LINEAGE-selected
#             fixtures go on rejecting when the LINEAGE guards are stripped
#             (FLIPMIN_LINEAGE_KoRoot is 9 of 14, not 14).
#   SCAN      KoVault and KoRoot sum their inputs with a bounded loop; the compiler
#             emits `require(end - start <= MAX)` before unrolling, which is also
#             what stops a vault or root UTXO parked past the scan window from
#             escaping the VALUE sum — and what caps every covenant spend at 16
#             inputs, a ceiling the wallet-funded fee paths must respect
#             (frontend/src/sweepPlan.js). Inventory-only: deleting the loop header
#             does not compile, so it cannot be made into a negative control (the
#             VALUE require that consumes the sum is the strippable half).
#
# THREE LAYERS, all required to exit 0:
#   1. POSITIVE    — the regression tests pass on the current contracts. When one
#                    does not, it regenerates that contract's fixtures into the
#                    mirror and says whether they were STALE (a contract edited
#                    without `npm run gen:*-tests`, which fails at checkSig and
#                    looks exactly like a broken rule) or CURRENT (a real change
#                    in what the contract accepts).
#   2. INVENTORY   — every contract still carries its full set of guard lines,
#                    counted per family. Static tripwire: it counts guards in the
#                    SOURCE, so a guard deleted from a path no fixture happens to
#                    exercise still fails here rather than passing unnoticed.
#   3. DIFFERENTIAL— each family is stripped, on its own, into a THROWAWAY copy
#                    under $TMPDIR, and the tests that pin THAT family must then
#                    FAIL. A regression test that cannot fail proves nothing; this
#                    proves the suite bites. The stripped variants are generated,
#                    never stored — the repo holds only the correct contracts.
#
# HOW THE DIFFERENTIAL PICKS ITS TESTS
#   LINEAGE selects on two markers in the test names: the SECURITY label, and the
#   "[weak control: …]" annotation the generators put on a fixture that pins a
#   lineage guard but sits behind a signature — those bite only once the fixtures
#   are rebuilt against the mutant, which is exactly what REGEN does, so leaving
#   them out would hand createProposal's and approve's covenant pinning no control
#   at all. The other families are pinned by tests that predate any label, so each
#   declares a name pattern (scripts/lib/fixture-subset.mjs). Every family then
#   declares how many of the selected tests must flip — a MINIMUM, not all of them,
#   because a rejection can be over-determined: "a snapshot with ownerCount 0" is
#   also caught by `ownerIndex < ownerCount`, and a test like that pins nothing on
#   its own. The bootstrapVault fixtures are the same story from the STATE side — a
#   vault stamped with a foreign id, a vault template that is not the vault, a root
#   altered in passing: `validateOutputStateWithTemplate` refuses all three whether
#   or not the lineage requires are present, so five of KoRoot's fourteen selected
#   fixtures cannot flip on the LINEAGE mutant and the minimum says so out loud. An
#   empty selection is an error, so renaming the pins away fails loudly.
#
#   FIXTURES FOR THE MUTANT. Deleting a line changes a contract's compiled bytes,
#   hence its P2SH address, hence every sighash — so a fixture carrying a real
#   BIP340 signature stops verifying on a mutant and its test "fails" for a reason
#   that has nothing to do with the guard. On signature-gated paths (createProposal,
#   bootstrapVault, approve, reject, execute) that makes the control vacuous: the
#   guard could be gone and the test would still pass. Families marked REGEN
#   therefore rebuild the fixtures FROM THE MUTANT (the same generators
#   `npm run gen:*-tests` runs, in a throwaway mirror of the repo — the repo's own
#   fixtures are never touched), so the signatures are valid and the only thing left
#   that can change the verdict is the missing guard. LINEAGE is one of them:
#   bootstrapVault and execute are signature-gated, and without the rebuild not one
#   of their SECURITY fixtures could ever flip.
#
# EXPECTED COUNTS are invariants, not trivia: if you change a contract's guards or
#   its fixtures, update the numbers in the same commit. `--rederive` prints the
#   block as the current tree would have it — read the diff before pasting it, a
#   number that dropped is exactly what this file exists to catch.
#
# Optional arg: a vault address → reports, per contract, whether the live
# treasury runs THIS build's KoVault and KoRoot. Both, because they no longer
# move together: a vault can reconstruct exactly while its root is an older
# script.
# Run:  bash scripts/test-security.sh [--rederive] [--only=FAMILY[,FAMILY…]] [kaspatest:…]
#       (or: npm run test:security).  --only is for iterating on one family while
#       editing it: it skips layer 1 and says PARTIAL in the summary, so it can
#       never be mistaken for a verification.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

DBG=".tooling/silverscript/target/debug/cli-debugger"
SILC=".tooling/silverscript/target/debug/examples/silc"
SILC_DBG=".tooling/silverscript/target/debug/examples/silc_dbg"
if [[ ! -x "$DBG" || ! -x "$SILC" ]]; then
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

REDERIVE=0
ONLY=""
ADDR=""
for a in "$@"; do
  case "$a" in
    --rederive) REDERIVE=1 ;;
    --only=*) ONLY="${a#--only=}" ;;   # iterate on one family: --only=VALUE (a PARTIAL run)
    *) ADDR="$a" ;;
  esac
done

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
pass=0; fail=0
ok()  { echo "  ${GRN}✓${RST} $1"; pass=$((pass+1)); }
bad() { echo "  ${RED}✗ $1${RST}"; fail=$((fail+1)); }
note() { echo "    ${DIM}$1${RST}"; }
suite() { "$DBG" --test-file "$2" --run-all "$1" >/dev/null 2>&1; }  # exit 0 iff every test passes
DERIVED=""   # collected by --rederive

# ---------------------------------------------------------------- families --
# Each family: the lines that enforce it (counted in place in layer 2, deleted to
# build the negative control in layer 3), a name pattern selecting the tests that
# pin it, how many of those must flip ("all", or a number), and whether the
# mutant needs its fixtures rebuilt (see the header).
FAMILIES="LINEAGE DISTINCT BOUNDS TALLY VALUE STATE SCAN GENERATION ALIAS"

GUARD_LINEAGE='require\((cid[0-9]* != 0x0+|cid[0-9]* == lineage|OpCovOutputCount\(|OpCovOutputIdx\(|OpAuthOutputCount\(|boundVaultIns >= 1|alienVaultIns == 0|pairedInputIndex != this\.activeInputIndex|OpInputCovenantId\([a-zA-Z]+\) == cid)'
WHAT_LINEAGE='covenant lineage (non-zero id, the id of THIS treasury, exact id-bearing output set)'
SEL_LINEAGE='^SECURITY|\[weak control'
FLIP_LINEAGE=min
REGEN_LINEAGE=yes
STMT_LINEAGE=no
EXPECT_LINEAGE_KoVault=11
FLIPMIN_LINEAGE_KoVault=12
EXPECT_LINEAGE_KoProposal=12
FLIPMIN_LINEAGE_KoProposal=8
EXPECT_LINEAGE_KoRoot=12
# 9 -> 8 with the bond-return commitment (RISKS #17): "createProposal REJECTS an
# UNBOUND root input" used to be pinned by `cid != 0` alone, but createProposal
# now derives the minted proposal's vaultSpkHash FROM that cid — a zero-cid spend
# mints a state the template validation refuses, so the test no longer flips on
# the LINEAGE mutant. Over-determined by a second, independent guard — a thicker
# defence, not a lost pin (verified by diffing the mutant flip lists by name).
FLIPMIN_LINEAGE_KoRoot=8

GUARD_DISTINCT='require\([a-zA-Z]*[Oo]wner[0-4] != [a-zA-Z]*[Oo]wner[0-4]\);'
WHAT_DISTINCT='owner-slot distinctness below ownerCount'
SEL_DISTINCT='duplicate|same key'
FLIP_DISTINCT=min
REGEN_DISTINCT=yes
STMT_DISTINCT=no
EXPECT_DISTINCT_KoRoot=20
FLIPMIN_DISTINCT_KoRoot=5

GUARD_BOUNDS='require\((newOwnerCount|ownerCount|newThreshold|threshold|snapThreshold) (>=|<=) (1|5|ownerCount|newOwnerCount)\);'
WHAT_BOUNDS='threshold / ownerCount range bounds'
SEL_BOUNDS='^(?!.*(duplicate|same key)).*(genesis treasury|newOwnerCount|newThreshold|snapshot (claiming|with|whose))'
FLIP_BOUNDS=min
REGEN_BOUNDS=yes
STMT_BOUNDS=no
EXPECT_BOUNDS_KoRoot=8
FLIPMIN_BOUNDS_KoRoot=6
EXPECT_BOUNDS_KoProposal=4
FLIPMIN_BOUNDS_KoProposal=5

GUARD_TALLY='require\((approvalCount|rejectCount|\(ownerCount - rejectCount\))( \+ rejectCount)? (>=|<=|<) (0|ownerCount|snapThreshold)\);'
WHAT_TALLY='tally invariant (the counts, and their consistency with the status)'
SEL_TALLY='tall(y|ies)'
FLIP_TALLY=min
REGEN_TALLY=yes
STMT_TALLY=no
EXPECT_TALLY_KoProposal=6
FLIPMIN_TALLY_KoProposal=8

GUARD_VALUE='require\(tx\.outputs\[[a-zA-Z0-9_]+\]\.value( \+ tx\.outputs\[[a-zA-Z0-9_]+\]\.value)? >= '
WHAT_VALUE='value floors (continuation keeps in-value less the fee cap)'
SEL_VALUE='^(?!SECURITY)(?!.*address other than).*(dust|drain|sompi more than|sompi below|sompi short|one-of-two|only ONE of two|not returned|beyond its maxFee)'
FLIP_VALUE=min
REGEN_VALUE=yes
STMT_VALUE=no
EXPECT_VALUE_KoRoot=3
FLIPMIN_VALUE_KoRoot=8
# 3 = approve + reject fee caps, plus closeExpired's bond-return floor (RISKS #17:
# output 0 must carry the full input-SET bond back to the vault)
EXPECT_VALUE_KoProposal=3
FLIPMIN_VALUE_KoProposal=2
EXPECT_VALUE_KoVault=2
FLIPMIN_VALUE_KoVault=5

# STATE is the rule that says WHAT each id-bearing output must contain, field by
# field. Every other family constrains which outputs inherit the lineage and what
# they are worth; this one is the only thing standing between an approve and an
# output that carries the treasury's id with a state its spender chose. It was
# inventory-only for a mechanical reason, not a principled one: validateOutputState
# spans many lines, so deleting the line that matches leaves an orphaned argument
# block, the mutant fails to PARSE, and a control that cannot compile certifies
# itself green. STMT_STATE removes the whole balanced statement instead, which
# yields a contract that compiles and simply pins nothing — the control this family
# always needed.
GUARD_STATE='validateOutputState(WithTemplate)?\('
WHAT_STATE='continuation state binding (what each id-bearing output must contain)'
SEL_STATE='.'
FLIP_STATE=min
REGEN_STATE=yes
STMT_STATE=yes
EXPECT_STATE_KoProposal=2
FLIPMIN_STATE_KoProposal=15
EXPECT_STATE_KoRoot=5
FLIPMIN_STATE_KoRoot=12

# Inventory-only (see SCAN in the header): no selector, no negative control.
GUARD_SCAN='for \(i, 0, tx\.inputs\.length, max(DepositInputs|TxInputs)\)'
WHAT_SCAN='bounded input scan (compiler emits the ≤ max…Inputs guard)'
SEL_SCAN=''
FLIP_SCAN=none
REGEN_SCAN=no
STMT_SCAN=no
EXPECT_SCAN_KoVault=2
EXPECT_SCAN_KoRoot=3
EXPECT_SCAN_KoProposal=1

# GENERATION (round 7, F4): a CONFIG proposal snapshots the owner set in force when
# it was created; executeConfig must admit only a proposal whose snapshot still equals
# the config installed NOW, so an executed rotation invalidates every prior
# approved-but-unexecuted config (else a removed owner replays a stale one to reinstate
# themselves). Seven equality guards, one per snapshot field.
GUARD_GENERATION='require\(p\.(snapThreshold|ownerCount|owner[0-4]) == (threshold|ownerCount|owner[0-4])\);'
WHAT_GENERATION='config generation gate (an approved CONFIG must still match the CURRENT owner set)'
SEL_GENERATION='STALE config'
FLIP_GENERATION=min
REGEN_GENERATION=yes
STMT_GENERATION=no
EXPECT_GENERATION_KoRoot=7
FLIPMIN_GENERATION_KoRoot=2

# ALIAS (round 7, F5): executeProposal's recipient and vault-change output indices must
# be DISTINCT, or a net-zero self-send (recipient == the vault's own spk) collapses both
# onto one output and leaks up to amount+maxFee.
GUARD_ALIAS='require\(recipientOutputIndex != vaultChangeOutputIndex\);'
WHAT_ALIAS='recipient / vault-change output distinctness (no self-send index collapse)'
SEL_ALIAS='aliasing'
FLIP_ALIAS=min
REGEN_ALIAS=yes
STMT_ALIAS=no
EXPECT_ALIAS_KoVault=1
FLIPMIN_ALIAS_KoVault=1

# want <family> <contract>  → the declared count, or "" when the family does not
# apply to that contract.
want() { eval "printf '%s' \"\${EXPECT_$1_$2-}\""; }
flipmin() { eval "printf '%s' \"\${FLIPMIN_$1_$2-0}\""; }
famvar() { eval "printf '%s' \"\${$1_$2}\""; }

MUT=$(mktemp -d) || { bad "cannot create temp dir"; MUT=""; }
trap '[ -n "${MUT:-}" ] && rm -rf "$MUT"' EXIT

# regen <contract> <mutant.sil> <out.test.json> — rebuild a contract's fixtures
# FROM THE MUTANT, using the repo's own generator, inside a throwaway mirror of
# the repo so nothing under contracts/ is written. The generators locate the repo
# from their own path, so the mirror needs real copies of scripts/ and contracts/
# (not symlinks, which node resolves back to the original) and can borrow the
# toolchain and node_modules.
regen() {
  local name="$1" mut="$2" out="$3"
  local gen lower m
  lower=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
  gen="scripts/gen-$lower-tests.mjs"
  [ -f "$gen" ] || { echo "no generator $gen"; return 1; }
  [ -x "$SILC_DBG" ] || { echo "missing $SILC_DBG (pnpm build:compiler)"; return 1; }
  m="$MUT/mirror-$name"
  rm -rf "$m"; mkdir -p "$m" || return 1
  cp -R contracts "$m/contracts" && cp -R scripts "$m/scripts" || return 1
  ln -s "$PWD/.tooling" "$m/.tooling" && ln -s "$PWD/node_modules" "$m/node_modules" || return 1
  cp "$mut" "$m/contracts/$name.sil" || return 1
  node "$m/$gen" >/dev/null 2>"$m/gen.err" || { sed -n '$p' "$m/gen.err"; return 1; }
  cp "$m/contracts/$name.test.json" "$out"
}

if [ -n "$ONLY" ]; then
  FAMILIES=$(printf '%s' "$ONLY" | tr ',' ' ')
  echo "${YEL}PARTIAL RUN — only the $FAMILIES family/families, and layer 1 is skipped.${RST}"
  echo "${DIM}Drop --only for a verification that means anything.${RST}"
  echo
else
echo "── 1. POSITIVE: the guards hold on the current contracts"
for tf in contracts/*.test.json; do
  [ -e "$tf" ] || continue
  sil="${tf%.test.json}.sil"; name=$(basename "$sil" .sil)
  if suite "$sil" "$tf"; then ok "$name.sil: all tests pass"; continue; fi
  bad "$name.sil: a test FAILED on the current contract"
  note "run: $DBG --test-file $tf --run-all $sil"
  # Diagnose the commonest cause instead of leaving it to be guessed: a fixture
  # carries a real signature over the COMPILED script, so a contract edited
  # without regenerating its fixtures fails at checkSig — which looks exactly
  # like a broken rule and is not one. Regenerate into the throwaway mirror and
  # compare; only runs on a red contract, so it costs nothing on a green tree.
  lower=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
  if [ -n "$MUT" ] && regen "$name" "$sil" "$MUT/fresh-$name.test.json" >/dev/null 2>&1; then
    if cmp -s "$MUT/fresh-$name.test.json" "$tf"; then
      note "the fixtures are CURRENT (regenerating them from $sil reproduces $tf byte for byte)"
      note "→ so this is a real change in what the contract accepts, not fixture rot. Read the failing test."
    else
      note "the fixtures are STALE: regenerating them from $sil produces a different file"
      note "→ run: npm run gen:$lower-tests   (then re-run this suite; a stale fixture proves nothing)"
    fi
  fi
done
fi

echo
echo "── 2. INVENTORY: every contract still carries every family of guard"
# A family whose expectations were all deleted would be skipped everywhere below
# and report nothing at all, so say so out loud rather than passing vacuously.
for fam in $FAMILIES; do
  tot=0
  for sil in contracts/*.sil; do
    w=$(want "$fam" "$(basename "$sil" .sil)"); [ -n "$w" ] && tot=$((tot + w))
  done
  [ "$tot" -gt 0 ] || bad "$fam: declared as a family but expected in no contract — its EXPECT_$fam""_* lines were deleted, so nothing checks it"
done
for sil in contracts/*.sil; do
  name=$(basename "$sil" .sil)
  line=""
  for fam in $FAMILIES; do
    w=$(want "$fam" "$name")
    got=$(grep -cE "$(famvar GUARD "$fam")" "$sil")
    if [ -z "$w" ]; then
      # A family that spread to a contract nobody declared it for would be
      # inventoried nowhere and stripped nowhere — under-coverage that looks
      # exactly like coverage. Say so.
      [ "$got" -eq 0 ] || { bad "$name.sil: carries $got $fam guards that nothing expects — add EXPECT_${fam}_${name}=$got (and a FLIPMIN, unless the family is inventory-only)"
                            DERIVED="$DERIVED
EXPECT_${fam}_${name}=$got"; }
      continue
    fi
    DERIVED="$DERIVED
EXPECT_${fam}_${name}=$got"
    if [ "$got" -eq "$w" ]; then line="$line $fam $got/$w;"
    else bad "$name.sil: $got $fam guards, expected $w — a guard was added or REMOVED ($(famvar WHAT "$fam"))"; line="$line ${RED}$fam $got/$w${RST};"; fi
  done
  case "$line" in *"$RED"*) : ;; *) [ -n "$line" ] && ok "$name.sil:$line" ;; esac
done

echo
echo "── 3. DIFFERENTIAL: strip ONE family → the tests that pin it must fail"
# A negative control is only worth anything if it fails for the RIGHT reason.
# Four things are checked, because each has been observed to silently pass:
#   * the strip removed exactly the expected number of lines (a guard reformatted
#     across two lines would otherwise slip through this line-oriented filter),
#   * the stripped contract still COMPILES (an empty or unparsable mutant "fails"
#     the suite for free and would certify itself green),
#   * the tests that pin the family are still THERE (an empty selection is an
#     error, so deleting or renaming them cannot quietly empty the control),
#   * enough of them flip to FAIL — the declared minimum for that family and
#     contract, so a pin that stops biting shows up as a number that dropped rather
#     than as silence. A fixture that cannot isolate its guard even on rebuilt
#     signatures is over-determined by a guard from another family, and the gap
#     between the minimum and the selection size is where that shows.
if [ -n "$MUT" ]; then
 for fam in $FAMILIES; do
  sel=$(famvar SEL "$fam"); [ -n "$sel" ] || continue
  for tf in contracts/*.test.json; do
    [ -e "$tf" ] || continue
    sil="${tf%.test.json}.sil"; name=$(basename "$sil" .sil)
    w=$(want "$fam" "$name"); [ -n "$w" ] && [ "$w" -gt 0 ] || continue
    guard=$(famvar GUARD "$fam"); tag="$fam/$name"
    d="$MUT/$fam-$name"; mkdir -p "$d"

    if [ "$(famvar STMT "$fam")" = "yes" ]; then
      # Remove the whole balanced statement, not the line that opens it: a
      # multi-line guard stripped by line leaves an unparsable mutant, and a mutant
      # that cannot compile is a control that always "passes". Count what was
      # removed in STATEMENTS for the same reason — comments naming the guard would
      # otherwise be mistaken for guards.
      if ! perl -ne "if (!\$in && /$guard/) { \$in=1; \$d=0 } if (\$in) { \$d += tr/(//; \$d -= tr/)//; \$in=0 if \$d<=0; next } print" "$sil" > "$d/$name.sil"; then
        bad "$tag: could not build the negative control (perl failed)"; continue
      fi
      stripped=$(( $(grep -cE "$guard" "$sil") - $(grep -cE "$guard" "$d/$name.sil") ))
    else
      if ! perl -ne "print unless /$guard/" "$sil" > "$d/$name.sil"; then
        bad "$tag: could not build the negative control (perl failed)"; continue
      fi
      stripped=$(( $(wc -l < "$sil") - $(wc -l < "$d/$name.sil") ))
    fi
    if [ "$stripped" -ne "$w" ]; then
      bad "$tag: stripped $stripped guard lines, expected $w — a guard was removed, or reformatted across two lines"; continue
    fi
    if [ "$stripped" -eq 0 ]; then
      bad "$tag: no guard lines matched — the negative control is vacuous"; continue
    fi
    if ! "$SILC" "$d/$name.sil" "contracts/args/$name.json" >/dev/null 2>&1; then
      bad "$tag: the stripped contract does not COMPILE — the control would pass on a syntax error"; continue
    fi

    # fixtures the mutant is judged against
    from=""
    if [ "$(famvar REGEN "$fam")" = "yes" ]; then
      if ! err=$(regen "$name" "$d/$name.sil" "$d/mutant.test.json"); then
        bad "$tag: could not rebuild the fixtures against the mutant — ${err:-generator failed}"; continue
      fi
      from="--from $d/mutant.test.json"
    fi
    # shellcheck disable=SC2086
    if ! total=$(node scripts/lib/fixture-subset.mjs --tests "$tf" --match "$sel" $from --out "$d/subset.test.json" 2>"$d/sel.err"); then
      bad "$tag: $(sed -n 1p "$d/sel.err")"; continue
    fi

    out=$("$DBG" --test-file "$d/subset.test.json" --run-all "$d/$name.sil" 2>&1)
    caught=$(printf '%s' "$out" | grep -c '^  FAIL ')
    if [ "$(famvar FLIP "$fam")" = "all" ]; then need="$total"; else
      need=$(flipmin "$fam" "$name")
      DERIVED="$DERIVED
FLIPMIN_${fam}_${name}=$caught"
    fi
    if [ "$caught" -ge "$need" ] && [ "$caught" -gt 0 ]; then
      extra=""; [ "$caught" -lt "$total" ] && extra=" ${DIM}(the other $((total - caught)) are over-determined by guards outside this family)${RST}"
      ok "$tag: $stripped guards removed, mutant compiles → $caught of $total pinning test(s) fail, need ≥ $need$extra"
    else
      bad "$tag: only $caught of $total pinning test(s) fail when the $fam guards are removed (need ≥ $need) — the pins that used to bite no longer do"
      printf '%s\n' "$out" | grep '^  PASS ' | cut -c1-140 | sed 's/^  PASS /      still passing: /'
    fi
  done
 done
fi

echo
echo "── 4. ADDRESS DIAGNOSTIC ${DIM}(does a live treasury run this build's KoVault AND KoRoot?)${RST}"
if [ -n "$ADDR" ]; then
  node scripts/treasury-version.mjs "$ADDR" || bad "diagnostic for $ADDR: a contract is not this build, or its root could not be located"
else
  echo "  ${DIM}pass a vault address to check one, e.g.:${RST}"
  echo "  ${DIM}  bash scripts/test-security.sh kaspatest:pq05ne9c…${RST}"
fi

if [ "$REDERIVE" -eq 1 ]; then
  echo
  echo "${YEL}── EXPECTED COUNTS as the current tree has them${RST} ${DIM}(read the diff before pasting)${RST}"
  printf '%s\n' "$DERIVED" | sed '/^$/d'
fi

echo
PARTIAL=""; [ -n "$ONLY" ] && PARTIAL=" ${YEL}(PARTIAL: --only=$ONLY — not a full verification)${RST}"
if [ "$fail" -eq 0 ]; then
  echo "${GRN}SECURITY OK${RST} — $pass checks passed; every guard family is inventoried, and stripping any one of them breaks the tests that pin it.$PARTIAL"
  exit 0
fi
echo "${RED}SECURITY FAILED${RST} — $fail problem(s), $pass ok.$PARTIAL"
exit 1
