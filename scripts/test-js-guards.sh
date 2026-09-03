#!/usr/bin/env bash
# Mutation testing for the code the network does NOT check.
#
# scripts/test-security.sh does this for the covenants: strip a guard, and the
# tests that pin it must fail. That discipline exists because a test suite can be
# large, green, and pinning nothing — which is not a hypothetical here. The four
# defects the second on-chain round found were all in code that had 75 passing
# frontend tests and 28 passing indexer tests at the time.
#
# The covenants have every Kaspa node enforcing them. The browser app, the
# indexer and the transaction builder have nobody. This is the substitute: for
# each rule, remove it and require a named test to fail.
#
# Two failure modes of the harness itself are treated as harness bugs rather than
# results, because both have already produced confident nonsense once today:
#
#   A mutation that breaks SYNTAX fails every test in the file, which reads like a
#   very well-guarded rule and means nothing. `node --check` rejects those.
#
#   Counting lines that look like failures counts the summary block too. Only
#   named tests under "failing tests:" are counted.
#
# The control run matters as much as the mutations: if the unmutated file does
# not pass, every "failure" above it is noise. That is the lesson from the STATE
# guard family, whose pinning numbers were once read off signature rot.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v node >/dev/null || { echo "node not found — this check cannot run, and reporting success would be a lie" >&2; exit 1; }

RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'

# module(s) | test file | rule | perl expression that removes the rule
#
# The first field may be a COMMA-SEPARATED list. packages/descriptor/src/genesis.js
# and indexer/genesisAudit.mjs are byte-identical by design, with a tripwire test
# asserting it; mutating one alone would trip that instead of the rule, and the
# harness would report a bite it never earned. They move together or not at all.
RULES=(
"frontend/src/txGuard.js|frontend/test/txGuard.test.mjs|lineage: an output may only continue THIS treasury's covenant|s/if \(o\.covenant\.covenantId\.toLowerCase\(\) !== lin\)/if (false)/"
"frontend/src/txGuard.js|frontend/test/txGuard.test.mjs|the vault is not spendable by approve/reject/propose/retire|s/if \(touches\) problems\.push/if (false) problems.push/"
"frontend/src/txGuard.js|frontend/test/txGuard.test.mjs|a payment must be for the amount that was declared|s/if \(guard\.amount != null && o\.value !== BigInt\(guard\.amount\)\)/if (false)/"
"frontend/src/txGuard.js|frontend/test/txGuard.test.mjs|a transfer that pays nobody is a failure, not a no-op|s/if \(MAY_PAY_OUT\.has\(kind\) && \(wantSpk \|\| payout\) && declaredPayments === 0\)/if (false)/"
"frontend/src/txGuard.js|frontend/test/txGuard.test.mjs|an undeclared destination is refused|s/problems\.push\(\`output \\\$\{i\} sends/void(\`output \${i} sends/"
"frontend/src/txGuard.js|frontend/test/txGuard.test.mjs|paying the declared address twice is refused|s/if \(declaredPayments > 1\)/if (false)/"
"frontend/src/txGuard.js|frontend/test/txGuard.test.mjs|without a lineage nothing is broadcast|s/return \[\"no treasury lineage to check this transaction against — refusing to broadcast\"\];/return [];/"
"frontend/src/txGuard.js|frontend/test/txGuard.test.mjs|a transaction that cannot be decoded is refused|s/return \[\`this transaction could not be decoded[^;]*;/return [];/s"
"frontend/src/txGuard.js|frontend/test/txGuard.test.mjs|conservation: the treasury must not lose more than it was told it would|s/if \(lost > cap\)/if (false)/"
"frontend/src/txGuard.js|frontend/test/txGuard.test.mjs|conservation: a payment must be counted as having left|s/declaredPayments\+\+; paidOut \+= o\.value;/declaredPayments++;/"
"frontend/src/txDecode.js|frontend/test/txGuard.test.mjs|trailing bytes mean this is not one well-formed transaction|s/if \(r\.remaining !== 0\)/if (false)/"
"frontend/src/txDecode.js|frontend/test/txGuard.test.mjs|a truncated transaction is an error, not a short one|s/if \(i \+ n > bytes\.length\)/if (false)/"
"packages/descriptor/src/genesis.js,indexer/genesisAudit.mjs|vitest:@kosign/descriptor|genesis: at most one change output beyond the KoRoot|s/if \(outs\.length > MAX_GENESIS_OUTPUTS\)/if (false)/"
"packages/descriptor/src/genesis.js,indexer/genesisAudit.mjs|vitest:@kosign/descriptor|genesis: exactly output 0 is bound into the covenant|s/if \(bound\.length !== 1 \|\| bound\[0\] !== ROOT_OUTPUT_INDEX\)/if (false)/"
"packages/descriptor/src/genesis.js,indexer/genesisAudit.mjs|vitest:@kosign/descriptor|genesis: the covenant is authorized by input 0|s/if \(root\.authorizingInput !== AUTHORIZING_INPUT_INDEX\)/if (false)/"
"packages/descriptor/src/genesis.js,indexer/genesisAudit.mjs|vitest:@kosign/descriptor|genesis: change must be plain unbound value|s/if \(change\.covenantId\) return stop\(\"change-covenant-bound\"/if (false) return stop(\"change-covenant-bound\"/"
"packages/descriptor/src/genesis.js,indexer/genesisAudit.mjs|vitest:@kosign/descriptor|genesis: an uninscribed genesis cannot be identified|s/if \(!ins\) \{/if (false) {/"
"packages/descriptor/src/genesis.js,indexer/genesisAudit.mjs|vitest:@kosign/descriptor|genesis: output 0 must reconstruct as THIS build's KoRoot|s/if \(rootHash !== members\.rootHash\)/if (false)/"
"packages/descriptor/src/genesis.js,indexer/genesisAudit.mjs|vitest:@kosign/descriptor|genesis: the recomputed covenant id must match the one carried|s/if \(claimed && computed !== claimed\)/if (false)/"
"packages/descriptor/src/genesis.js,indexer/genesisAudit.mjs|vitest:@kosign/descriptor|genesis: the vault being opened must be the one this genesis derives|s/if \(derived\.vaultHash !== wantHash\)/if (false)/"
"packages/descriptor/src/genesis.js,indexer/genesisAudit.mjs|vitest:@kosign/descriptor|genesis: a parked foreign UTXO must not overturn a derived vault (the 0.2 KAS defamation)|s/\} else if \(derivedVault\) \{/} else if (false) {/"
"packages/descriptor/src/genesis.js,indexer/genesisAudit.mjs|vitest:@kosign/descriptor|genesis: a genesis not tied to the address being opened is not clean|s/if \(wantHash \&\& !derivedVault\)/if (false)/"
"frontend/src/txGuard.js|frontend/test/txGuard.test.mjs|guard: the vault's money must return to the vault's own script, not to its id|s/if \(home < owed\)/if (false)/"
"frontend/src/wasmTx.js|frontend/test/txGuard.test.mjs|creation: a published vault address must be derived, not taken from the builder|s/const derivedRedeem = rebuildVault\(lineage\);/const derivedRedeem = out.vaultRedeemHex;/"
"frontend/src/txGuard.js|frontend/test/txGuard.test.mjs|precision: a treasury too large to represent exactly is refused, not mis-accounted|s/if \(!Number\.isSafeInteger\(guard\.treasuryIn\) \|\| !Number\.isSafeInteger\(guard\.treasuryFee\)\)/if (false)/"
"frontend/src/sweepPlan.js|frontend/test/sweepPlan.test.mjs|precision: an amount too large to represent is refused, not rounded|s/if \(!Number\.isSafeInteger\(n\) \|\| n < 0\)/if (false)/"
"frontend/src/wasmTx.js|frontend/test/txGuard.test.mjs|sweep: fee UTXOs read through the session-spend filter|s/let fents = freshUtxos\(/let fents = freshUtxosDROP(/"
"frontend/src/wasmTx.js|frontend/test/txGuard.test.mjs|sweep: each batch records its spent inputs|s/markSpentOutpoints\(rpcTx\);\n      return \{ txid: r\.transactionId/return { txid: r.transactionId/"
"frontend/src/wasmTx.js|frontend/test/txGuard.test.mjs|sweep: nothing to sweep and nothing to compact does nothing|s/if \(!keep\.length && !covExtra\.length\)/if (false)/"
"frontend/src/wasmTx.js|frontend/test/txGuard.test.mjs|guard coverage: the sweep re-reads its bytes before broadcast|s/ *assertSpend\(out\.borshHex, \{\n +kind: \"sweep\"[\s\S]*?\n *\}\);\n//"
"frontend/src/wasmTx.js|frontend/test/txGuard.test.mjs|guard coverage: genesis re-reads its bytes before broadcast|s/\n *assertSpend\(gout\.borshHex, \{ kind: \"genesis\"[^\n]*\);//"
"frontend/src/wasmTx.js|frontend/test/txGuard.test.mjs|guard coverage: bootstrap re-reads its bytes before broadcast|s/\n *assertSpend\(out\.borshHex, \{ kind: \"bootstrap\"[^\n]*\);//"
"frontend/src/txGuard.js|frontend/test/txGuard.test.mjs|fidelity: a non-zero script version output is refused|s/if \(o\.scriptPublicKey\.version !== 0\)/if (false)/"
"frontend/src/wasmTx.js|frontend/test/trustBoundary.test.mjs|recipient: an unverified discovered recipient is flagged, not trusted|s/else p\.recipientMismatch = true;/else p.recipientSpkHex = ri.spkHex;/"
"frontend/src/TreasuryView.jsx|frontend/test/trustBoundary.test.mjs|recipient: approval is gated on recipient verification|s/ \|\| recipientUnverified//"
"frontend/src/wasmTx.js|frontend/test/trustBoundary.test.mjs|config bounds: a config the contract would reject must not be proposable|s/if \(threshold < 1 \|\| threshold > realCount\) throw new Error\(\x22Threshold must be between 1 and the signer count.\x22\);//"
"frontend/src/TreasuryView.jsx|frontend/test/trustBoundary.test.mjs|waiting state: the calm path must stay narrow (indexer-lag code only)|s/if \(gate\?\.code !== \x22no-genesis\x22 \|\| !gateAddress\) return false;/if (!gateAddress) return false;/"
"frontend/src/proposalScan.js|frontend/test/proposalScan.test.mjs|scan: only selector 1 counts as an execution|s/sel === 1n/sel !== null/"
"frontend/src/proposalPolicy.js|frontend/test/proposalPolicy.test.mjs|policy: a transfer may not exceed what the vault can fund|s/if \(sompi > max\)/if (false)/"
"frontend/src/sweepPlan.js|frontend/test/sweepPlan.test.mjs|fee ceiling: a node-demanded fee out of proportion is refused, not paid|s/if \(a > ceiling\)/if (false)/"
"frontend/src/proposalPolicy.js|frontend/test/proposalPolicy.test.mjs|expiry: a proposal's lifetime is bounded, not open-ended|s/if \(!Number\.isFinite\(secs\) \|\| secs < MIN_EXPIRY_SECS \|\| secs > MAX_EXPIRY_SECS\)/if (false)/"
"frontend/src/proposalPolicy.js|frontend/test/proposalPolicy.test.mjs|expiry: an expired proposal reads as expired, not open|s/if \(daa >= exp\) return \{ state: \"expired\", expiresAt: exp, daaScore: daa \};//"
"frontend/src/wasmTx.js|frontend/test/trustBoundary.test.mjs|expiry: proposal builders anchor their expiry to the chain clock|s/expiryDaa\(await currentDaaScore\(\), expirySecs\)/4_000_000_000/"
"frontend/src/wasmTx.js|frontend/test/trustBoundary.test.mjs|expiry: execute consults the expiry window before signing|s/const w = executeWindow\(committedExpiry, await currentDaaScore\(\)\);/const w = { state: \"open\" };/"
"frontend/src/wasmTx.js|frontend/test/txGuard.test.mjs|fee ceiling: the demanded fee is clamped before the rebuild sees it|s/saneFeeDemand\(Number\(want\[1\]\), fee0\)/Number(want[1])/"
"frontend/test/txGuard.test.mjs|frontend/test/txGuard.test.mjs|coverage: every submitted operation must have its real shape tested|s/, \"close-expired\"\]\)/])/"
"frontend/src/wasmTx.js|frontend/test/trustBoundary.test.mjs|trust boundary: the money path must not reach the indexer client|s/^import init/import { fetchStats } from \".\\/stats.js\";\nimport init/m"
"frontend/src/Landing.jsx|frontend/test/trustBoundary.test.mjs|trust boundary: an indexer number must not gate a control|s/<div className=\"statstrip\"/<button disabled={!stats.treasuries}\/><div className=\"statstrip\"/"
"frontend/src/TreasuryView.jsx|frontend/test/trustBoundary.test.mjs|trust boundary: chain-reconstructed history is labelled as indexer-sourced|s/item\.discovered && \(item\.status === 2 \|\| item\.status === 3\)/false && (item.status === 2 || item.status === 3)/"
"frontend/src/TreasuryView.jsx|frontend/test/trustBoundary.test.mjs|claim accuracy: an unswept deposit must not be described as unprotected|s/The covenant already protects it: the only spend it permits is a sweep back into this vault, so nobody can take it — it simply isn.t part of the covenant balance until swept\./not covenant-controlled until swept in./"
"scripts/frontend-manifest.mjs|frontend/test/frontendManifest.test.mjs|deploy digest: file order must be sorted, not filesystem order|s/\[\.\.\.files\]\.sort\(\)/[...files]/"
"scripts/frontend-manifest.mjs|frontend/test/frontendManifest.test.mjs|deploy digest: the manifest must not describe itself|s/\.filter\(\(f\) => f !== MANIFEST_NAME\)//"
"indexer/server.mjs|indexer/test/policy.test.mjs|indexer: only a policy established as live may be reported current|s/current: p\.state === \"live\"/current: true/"
)

# A checkout need not carry every module this harness knows about: the published
# repo (scripts/make-opensource.sh) ships without indexer/, and its rules would
# fail the CONTROL stage below before a single mutation ran — the harness dying
# on absence rather than on a finding.
#
# Absence narrows a rule; it must not silently delete one. A multi-file rule
# exists because those files are byte-identical copies and the tripwire test
# asserting it would fire instead of the rule — but that tripwire lives in the
# indexer's suite, so where the indexer is absent the reason is absent too and
# the surviving copy can and must still be mutated on its own. Dropping the whole
# rule there would leave the genesis auditor, the strongest client-side check in
# the repo, pinned by nothing in the one repo strangers can send patches to.
#
# So: filter out the files this checkout lacks, and skip the rule only when
# nothing is left to mutate or its test is gone. Print every skip either way.
present=(); nskip=0; skipmsg=""
for row in "${RULES[@]}"; do
  IFS='|' read -r mods tf rule rest <<<"$row"
  IFS=',' read -r -a fl <<<"$mods"
  have=(); gone=""
  for f in "${fl[@]}"; do
    if [[ -f "$f" ]]; then have+=("$f"); else gone="${gone:+$gone, }$f"; fi
  done
  miss=""
  (( ${#have[@]} )) || miss="$mods"
  if [[ -z "$miss" ]]; then case "$tf" in vitest:*) ;; *) [[ -f "$tf" ]] || miss="$tf";; esac; fi
  if [[ -n "$miss" ]]; then
    nskip=$((nskip + 1))
    skipmsg+="  ${DIM}⊘ ${rule} — ${miss} is not in this checkout${OFF}"$'\n'
    continue
  fi
  if [[ -n "$gone" ]]; then
    echo "  ${DIM}· ${rule} — mutating $(IFS=,; echo "${have[*]}") only; $gone is not in this checkout${OFF}"
  fi
  present+=("$(IFS=,; echo "${have[*]}")|$tf|$rule|$rest")
done
RULES=("${present[@]+"${present[@]}"}")
if (( nskip )); then
  echo "── $nskip rule(s) skipped — the module they pin is not part of this checkout"
  printf '%s' "$skipmsg"
  echo ""
fi

failed=0; checked=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# `pipefail` is on, and grep returns 1 when it matches nothing — which is exactly
# the case this harness exists to report. Left unguarded, `set -e` killed the run
# silently at the first rule with no test behind it, so the harness died precisely
# when it found something. Swallow the pipeline status; emptiness is the finding.
names_of() { { sed -n '/^✖ failing tests:/,$p' | grep '^✖ ' | grep -v 'failing tests:' | sed 's/^✖ //; s/ (.*//'; } || true; }
# vitest names a failure as "FAIL  file > suite > test"; take the leaf.
vnames_of() { { grep -E '^ *FAIL ' | sed 's/.* > //'; } || true; }

# The repo runs two test runners, and a rule is pinned if EITHER catches it. The
# genesis auditor is the case that matters: its adversarial fixtures live in
# packages/descriptor's vitest suite, and pointing this harness only at the
# indexer's node:test file made three well-guarded rules — including the fix for
# the 0.2 KAS defamation vector — report as having no test at all. A harness that
# asks the wrong suite produces false alarms, which cost more than silence.
run_target() {
  case "$1" in
    vitest:*) pnpm --filter "${1#vitest:}" test 2>&1 | vnames_of ;;
    *)        node --test "$1" 2>&1 | names_of ;;
  esac
}

echo "── CONTROL: the unmutated files must pass, or everything below is noise"
for tf in $(printf '%s\n' "${RULES[@]}" | cut -d'|' -f2 | sort -u); do
  case "$tf" in
    vitest:*) ok=$(pnpm --filter "${tf#vitest:}" test >/dev/null 2>&1 && echo y || echo n) ;;
    *)        ok=$(node --test "$tf" >/dev/null 2>&1 && echo y || echo n) ;;
  esac
  if [[ "$ok" == y ]]; then echo "  ${GREEN}✓${OFF} $tf"; else
    echo "  ${RED}✗${OFF} $tf fails before any mutation — fix that first" >&2; exit 1; fi
done

echo ""
echo "── DIFFERENTIAL: remove one rule → a named test must fail"
for row in "${RULES[@]}"; do
  IFS='|' read -r mods tf rule expr <<<"$row"
  checked=$((checked + 1))
  IFS=',' read -r -a files <<<"$mods"
  for k in "${!files[@]}"; do cp "${files[$k]}" "$tmp/orig.$k"; done
  restore() { for k in "${!files[@]}"; do cp "$tmp/orig.$k" "${files[$k]}"; done; }
  changed=0
  for k in "${!files[@]}"; do
    perl -0pi -e "$expr" "${files[$k]}"
    cmp -s "$tmp/orig.$k" "${files[$k]}" || changed=1
  done
  mod="${files[0]}"
  if (( ! changed )); then
    restore
    echo "  ${RED}✗${OFF} ${mod##*/}: $rule ${DIM}— the mutation matched nothing; this rule is NOT being tested${OFF}" >&2
    failed=$((failed + 1)); continue
  fi
  bad_syntax=0
  for f in "${files[@]}"; do case "$f" in *.js|*.mjs) node --check "$f" >/dev/null 2>&1 || bad_syntax=1;; esac; done
  if (( bad_syntax )); then
    restore
    echo "  ${RED}✗${OFF} ${mod##*/}: $rule ${DIM}— the mutation broke syntax, so its 'failures' would be noise (harness bug)${OFF}" >&2
    failed=$((failed + 1)); continue
  fi
  names="$(run_target "$tf" || true)"
  restore
  n="$( { grep -c . <<<"$names"; } || true )"
  if [[ -z "$names" ]]; then
    echo "  ${RED}✗${OFF} ${mod##*/}: $rule ${DIM}— removed, and every test still passed${OFF}" >&2
    failed=$((failed + 1))
  else
    echo "  ${GREEN}✓${OFF} ${mod##*/}: $rule ${DIM}→ $n test(s): $(paste -sd '; ' - <<<"$names")${OFF}"
  fi
done

echo ""
if (( failed )); then
  echo "${RED}JS GUARDS FAILED${OFF} — $failed of $checked rules are not pinned by any test." >&2
  echo "A rule with no test behind it is a rule that can be deleted in a refactor without anything noticing." >&2
  exit 1
fi
echo "${GREEN}JS GUARDS OK${OFF} — $checked rules, each pinned by a test that fails without it."
