# Ko-sign — Development Log

A chronological record of how Ko-sign went from a design spec to a working
on-chain covenant multisig with a web UI. Newest entries at the bottom.

---

## 1 · Feasibility check (plan.md → reality)

Started from `plan.md` (a Gnosis-Safe-style on-chain proposal covenant). The plan
leaned on Kaspa features I couldn't confirm from memory, so I verified against
current sources: **Toccata** hard fork (L1 covenants), **Silverscript** (CashScript-
inspired language compiling to Kaspa script), KIP-10 introspection, KIP-20
covenant ids. All real, live on testnet. Conclusion: the architecture is sound;
the risks are tooling maturity, the timelock model, and storage mass.

## 2 · Ground-truthing the compiler

No published `silverc` binary, so I cloned `kaspanet/silverscript` and built it
(needed rustc ≥ 1.90 for the Toccata `*-toc` crates; bumped the toolchain). Read
the real example contracts + `DECL.md` to learn the actual primitives:
`OpInputCovenantId`, `OpCov*`, `readInputStateWithTemplate`,
`validateOutputState[WithTemplate]`, `this.age`, `checkSig`. plan.md mapped
remarkably well onto these.

## 3 · Contracts

Wrote `KoRoot` / `KoVault` / `KoProposal` + 4 primitive probes. Key design
choice: per-proposal data lives in the fixed-width **state** region while
owners/threshold sit in the immutable prefix — so every proposal of a treasury shares
one template hash the Vault can pin, and the template hash is independent of
`treasuryId` (breaks the circular-dependency bootstrap). All 7 compile against the
real compiler. Verified contract logic offline in the source-level debugger.

## 4 · TypeScript packages + RPC reality

`descriptor` (template hash / prefix-suffix / P2SH / state codec, unit-tested),
plus `indexer`/`signer`/`tx-builder` scaffolds. Discovered the published
`kaspa-wasm` (0.13.0) is **pre-Toccata** and hard-panics against TN10. Built a
**native Rust wRPC client** (`tools/kaspa-probe`) on the `rusty-kaspa` tn12 branch
instead — confirmed TN10 is live Toccata (`server_version 1.2.1-toc.3`).

## 5 · Genesis on-chain

Reverse-engineered covenant-id genesis: `covenant_id = hash(funding_outpoint,
outputs)` via `populate_genesis_covenants` — precomputable, un-forgeable. Built a
3-of-5 treasury live on TN10 (`treasuryId b79d0f30…`); KoRoot + KoVault UTXOs verified
to carry the matching covenant id. (Fee lesson: node requires `fee ≥ mass × 100`,
and storage mass dominates for small outputs.)

## 6 · Full lifecycle on-chain

Wrote the covenant-spend tools (createProposal / approve / execute). Reverse-
engineered sigscript encoding (`add_i64`/`add_data` + selector + redeem reveal),
the continuation-binding rule (an output inherits its authorizing input's
covenant id), and the compute-budget commitment (`limit = budget×10000 + 9999`).

**Bug found only on-chain:** `approve` failed with `AND operands must be of equal
length`. Kaspa's `OpAnd`/`OpOr` require equal-width operands, but state ints are
fixed 8-byte while computed ints are minimal — the source debugger missed it
(it encodes state minimally). **Fix:** make the approval bitmap a `byte[8]` and
use byte-array masks. State encoding is byte-identical, but the contract change
altered the template hash → fresh genesis. After the fix: genesis → createProposal
→ approve ×3 → executeProposal all confirmed on TN10, recipient received funds.
(See `docs/ONCHAIN-FLOW.md`.)

## 7 · Web UI + backend bridge

The browser can't build covenant txs (no Toccata WASM SDK) and shouldn't hold
owner keys, so the React UI talks to a thin local **backend bridge** that wraps
the proven Rust tools. Verified a full UI-path transfer end-to-end (+1 KAS to the
recipient). Backend retries on unconfirmed UTXOs.

**Correctness fix:** Treasuries with identical owners/threshold/state share a P2SH
address (treasuryId isn't baked into the script). The covenant id still separates them
at the protocol level, so the tools now **select UTXOs by covenant id** and report
covenant-filtered balances — otherwise a spend could target the wrong treasury.

## 8 · Create-treasury + UI polish + restructure

Wired **Create treasury** into the UI (set threshold + amounts → generate owners →
compile → genesis); verified by creating a 2-of-5 treasury via the API that funded its
2 KAS vault on-chain. Added the vault deposit address + balance and the owner
address list. Restructured into clear `frontend/` + `backend/` folders and gave
the UI a Kaspa-themed (teal-on-dark, glass, glow) responsive design with a landing
page.

---

## 9 · Fixed vault address + deposit/sweep

Made `KoVault` **stateless** (dropped `vaultNonce`): its redeem script — and so
its P2SH address — is now **fixed**. `executeProposal` returns change to the same
address (`tx.outputs[i].scriptPubKey == tx.inputs[activeInputIndex].scriptPubKey`,
the tutorial idiom; recomputing via `new ScriptPubKeyP2SH(blake2b(...))` did NOT
reproduce the spk — caught in the debugger).

Added a permissionless **`deposit`** entrypoint that sweeps *all* UTXOs at the
vault address — including plain payments mistakenly sent there (no covenant id) —
into one consolidated covenant vault output, requiring `output[0] >= sum(vault-
address inputs) − fee` so funds can only flow IN. This fixes the footgun that
funds sent straight to the vault address were otherwise **locked**. Verified on
TN10: a 0.15 KAS stray + 0.2 KAS fresh deposit consolidated into the vault
(0.5 → 0.85 KAS), `unswept` back to 0, address unchanged. Backend `/deposit` +
a UI Deposit/Sweep panel (shows an "unswept" warning when strays exist). Also
made `genesis` gather multiple funding UTXOs (consolidates a fragmented wallet).

Known limit: without a per-treasury salt, Treasuries with identical owners+threshold share
a vault address; covenant_id still separates them and the sweep can't steal, but a
deposit could be attributed to a sibling treasury with the same owners. A salt would
make addresses unique (deferred — baking an unused salt is compiler-fragile).

## 10 · Client-side signer — import a key, sign in the browser

First tried the **Kasware** wallet, but it can't sign covenant txs: it bundles a
pre-Toccata SDK (same root cause as the `kaspa-wasm` 0.13.0 panic) so it can't
serialize covenant outputs or make the raw BIP340 sighash signature `checkSig`
needs. Dropped it for a direct **key import + client-side Schnorr signer**.

The browser can't *build* Toccata txs and the backend mustn't hold owner keys, so
each owner-signed op (genesis / createProposal / approve) became two phases:
backend builds the exact unsigned tx and returns the **sighash** → the browser
signs it with the imported key (`@noble/curves`, BIP340) → backend rebuilds the
identical tx and injects the signature. Verified the JS signer interops with the
Rust `secp256k1` tooling (same x-only pubkey, verifying sigs). Tools gained a
`KOSIGN_SIGN_MODE` (`local`/`sighash`/`submit`); genesis persists its chosen
funding inputs so the multi-input rebuild can't drift. Owner 0 = the imported
key: it funds genesis and signs it; co-signers are added by address (pubkeys
baked, no keys held). The **"Generate test owners"** mode (backend holds 5 keys)
stays for end-to-end approve/execute testing. See `docs/CLIENT-SIGNER.md`.

## 11 · Owner-signed execute + concurrent proposals (re-validated on-chain)

Two protocol changes (both shift the KoProposal template hash, so every earlier
treasuryId is retired and a fresh genesis is required):

1. **`execute` now needs an owner signature.** `KoProposal.execute` gained
   `(int ownerIndex, sig ownerSig)` + `require(checkSig(ownerSig, ownerAt(ownerIndex)))`,
   mirroring `approve` — only an owner decides when funds actually leave. Any one
   of the N owners may trigger it (`KOSIGN_EXECUTOR`); like approve it is now a
   client-signed op (sighash → browser → submit), not permissionless.
2. **Multiple concurrent proposals.** The backend keeps the live set in
   `treasury.proposals.json` (an array); `treasury.proposal.json` is just the transient
   scratch a tool operates on. createProposal/approve/execute take a `proposalId`;
   a per-treasury `treasury.history.json` is the audit log. The UI Queue lists all open
   proposals, History shows executed/closed ones.

**Re-validated end-to-end on TN10** as a 2-of-2 treasury, fully client-signed (keys
imported in the signer, never sent to the backend — owner 0 = the funding wallet,
owner 1 = a co-signer that only approves):
- treasuryId `8b2570afc963e40b42c873c51984fd7a5d6a5221213a0d50f2ca9fa0cdcd203b`
- genesis `4ba1964a9678ffe970fe9fbd00991d890b617d0c3bd941f35a4ef60392e330e7`
  (owner 0 funds + signs), createProposal `2eac05aa42a5a3a99e535618b1f245160e7889d31bc5a48442a5475c4546b673`
  (owner 0), approve by **owner 1** → Approved, execute
  `88db9f35fedeb69b39de55078f6c3fcf6bed3c16e9bcfde5872884581ead6cbb`
  (owner 0, owner-authorized) → recipient paid, proposal closed.

## 12 · Graceful errors + Safe{Wallet}-style app

Hardened the tools' error path: the four UTXO-not-found lookups (create_proposal
KoRoot, approve proposal, execute vault + proposal) used `.expect()` and leaked
a raw Rust backtrace into the UI when a treasury was unfunded/dead. A `bail()` helper
now exits cleanly with an actionable message — keeping the substrings `runRetry`
retries on, so genuinely-unconfirmed lookups still get retried.

Restructured the per-treasury view into a Safe{Wallet}-style app
(`frontend/src/TreasuryView.jsx`): a fixed left sidebar (Assets / Transactions /
Settings) over a content area. **Assets** = vault holdings + Sweep; **Transactions**
= new transfer proposal + Queue (approve/execute) + History; **Settings** = signers
+ required confirmations. **Create treasury** moved to its own `/create` page
(`CreateTreasury.jsx`); the marketing landing page is untouched. A treasury is now
addressed in the URL by its **vault wallet address** (`/treasury/kaspatest:…`),
resolved to the internal treasuryId via `/api/treasuries` (which gained an `address`
field); legacy 64-hex treasuryIds still resolve. The old `Wallet.jsx` was retired.

## 13 · Unique treasury addresses — CREATE2 without CREATE2

Like treasury.global, each created wallet should be a fresh address even with identical
owners. treasury does this with CREATE2 + a `saltNonce` baked into the *address*
derivation (not the runtime code). Kaspa L1 has no CREATE2; an address is purely
`P2SH(redeem_script)`. Baking a salt as a contract parameter fails — silverc
strips the unused `treasuryId` param (verified: two salts → byte-identical scripts).

The fix is the raw-script equivalent of CREATE2's salt: **prepend `<32-byte random
salt> OP_DROP` to the stateless vault redeem script, after compilation.** It's a
runtime no-op (push then drop) the optimizer can't fold, so the vault P2SH — and
therefore the treasuryId (`covenant_id = hash(funding_outpoint, outputs)`) — is unique
per treasury even for identical owners/threshold. Only the vault is salted (it's
stateless and not referenced by the proposal template), keeping the change
self-contained. See `docs/UNIQUE-ADDRESSES.md`. Offline-verified (two builds →
distinct addresses); the salted-vault **spend** path still needs on-chain
validation (the TN10 node was mid-sync — `is_synced:false` — when this landed, so
no fresh genesis was confirming).

## 14 · Dynamic sweep fees — the network raised the floor 100×

Node v1.2.1-toc.3 (rusty-kaspa `ab4c51a`) raised the minimum relay fee to
**100 sompi/gram**, and the sweep's fixed 0.05 KAS fee started bouncing as soon
as a few direct deposits piled up (5 strays → compute mass 84,463 → the node
demanded 0.0845 KAS). Root-caused against the fork sources; fixed with a new
wasm export `sweep_funded_mass` returning the node-exact masses of the built tx
(validated **0% deviation** against the node's own number), fee = mass × rate
with an iterative funding pick, small change folded into the fee (dust/KIP-9
windows), and a self-correcting resubmit that parses the node's
`required amount of N` if the rate ever changes again. An adversarial review of
the fix surfaced two real edge-case bugs (iteration-cap state inconsistency on
dust-fragmented wallets; sub-0.02-KAS change tripping KIP-9) — both fixed and
simulation-tested before landing.

## 15 · Batched sweeps — thousands of deposits, ~7× cheaper

Two measured discoveries reshaped the plan (script-engine harness on the pinned
rev AND the deployed node's line, identical numbers):

- **The covenant caps a sweep tx at 16 inputs** — the compiled deposit loop's
  unroll bound, confirmed live (a 17-input probe is rejected on TN10). Batches
  are covenant + ≤14 deposits + fee input(s); the contract, not mass, binds.
- **Compute budgets were ~240× over-provisioned**: the deposit branch executes
  in ≤5,001 script units even at the cap, so vault inputs now declare
  `ComputeBudget(2)` instead of 120 — per-deposit sweep cost falls
  0.0137 → ~0.0035 KAS. The node accepted a `budgetVault: 0` probe at 16
  inputs, proving the live cost ≤9,999 units (≥3× margin at budget 2).

Large deposit sets sweep as a **chain**: each batch spends the previous batch's
still-in-mempool covenant output and reuses its fee change as the next fee
input — no confirmation waits, cancel between batches is free (each batch is
final), and re-running resumes from what's left. Pure planning logic lives in
`frontend/src/sweepPlan.js` (shared browser/Node), the engine in `wasmTx.js`,
with a pre-sweep quote, per-batch progress, stop-after-batch and a 0.05 KAS
dust floor (KIP-9 already makes dust-showering a vault expensive: creating an
output of value v costs ~10^12/v grams). Fee pricing follows the node's
normalized check `max(compute, ceil(transient × 0.5)) × 100` — the on-chain E2E
(genesis → fan-out → 14+3 chained batches → dust runs → exact final value) ran
with **zero fee retries**. See `docs/SWEEP.md`.

## 16 · Dynamic fees everywhere — the covenants already allowed it

Extended the sweep's mass-priced fees (§14–15) to every flow: genesis, create
proposal, approve, reject, execute, config-execute. The key discovery is in the
contracts themselves: **every covenant bounds fee leakage with a cap, never an
equality** (`approve/reject` keep ≥ `inVal − maxFee`; the vault's execute path
is bounded by the committed `p.maxFee`; `executeConfig` by the compiled
`maxProposalFee`; create/genesis have no value rule) — so fees can float under
the deployed 0.1 KAS caps with **no contract changes and no migration**.

One new wasm export does all the pricing: `borsh_masses(borshHex)` returns the
node-exact masses of any built tx. Each flow builds a PROBE with dummy zero
signatures at fee 0, prices it (`max(compute, ceil(transient×0.5)) × 100`),
then signs at that fee — a fee change only moves fixed-width output values, so
the probe's mass is exact (unit-tested as the fee-invariance property). The
actual fee travels in `meta.fee` into the tracked state deltas, because those
values feed later builders' sighashes; a "required amount of N" rejection
re-signs at N. Probing at fee 0 also removed the old constants as hidden
availability floors (a 0.55 KAS root can propose again; a 0.006 KAS bond can
still be approved).

Measured on-chain (full 2-of-2 matrix incl. reject and a signer change, zero
fee retries): genesis 0.0026 KAS (38× cheaper), propose 0.0097 (10×), approve/
reject 0.0051 (10×), execute 0.0183 (2.7×), config 0.0206 (2.4×) — 11 txs cost
0.114 KAS vs 0.80 fixed. The E2E doubles as a fund-recovery tool: it drains
throwaway test Treasuries back to the dev wallet via chain recovery → propose →
execute. An adversarial review surfaced 9 edge cases (negative-change wrap at
genesis retry, per-proposal maxFee caps vs the global constant, probe-at-default
dead zones, a missing relay reject mirror) — all fixed and re-tested. See
`docs/FEES.md`.

## 17 · Removing the fee ceiling — the freeze that was one repricing away

Finishing §16 exposed a sharper problem than the one it solved. A Kaspa tx has
no separate fee field: the fee is simply what the inputs don't pay out. For
approve/reject/execute/executeConfig the only inputs were covenant UTXOs, so
the fee was value leaving the treasury — and the contracts cap that leak at
0.1 KAS. If the network's minimum feerate ever passed the cap, those ops would
become **unbuildable in both directions** (pay less, the network rejects; pay
more, the covenant rejects) and every deployed treasury would be frozen, with no
migration path because the cap is compiled in. The network had just moved that
number 100× in one release, so the tail was not hypothetical.

The fix needed no contract change, because the rules are `>=` caps: let those
ops take **owner-funded P2PK inputs** (plus a change output), leave the
covenant output at its FULL value, and the inequality holds with slack for any
fee. That also makes the treasury strictly richer — approve no longer nibbles the
bond, execute no longer nibbles the vault. Wallet-funded is now the default;
the covenant-funded path stays as the fallback for an empty wallet (and is the
only path that still has a cap, ~20× headroom).

Proven on-chain rather than argued: the E2E submits an approve paying
**0.2 KAS — twice the covenant cap — and the node accepts it**. Unit tests pin
builds at 10× the cap and assert the covenant outputs stay whole. The one
thing that did break during bring-up was the E2E's own bookkeeping (it kept
deducting the fee from a bond that no longer pays it), which is exactly the
coupling `meta.ownerFunded` now carries through the tracked state.

## 18 · Renaming to Ko-sign — what a global rename actually hits

The name now leads with the action the product *and* the revenue model share:
co-signing. The rename itself was mechanical — three ordered, case-sensitive
rules over 86 tracked text files, 289 substitutions, counts matching the
pre-rename baseline exactly. Deliberately a script rather than hand edits: a
deterministic pass is exhaustively verifiable afterwards, and it cannot
paraphrase prose the way a manual sweep does.

The interesting part was the four things a naive `sed -i` would have broken.

**The on-chain magic that must outlive the brand.** `KSAFE` is the 5-byte
recovery inscription magic, written into the genesis payload of every treasury that
already exists. Changing it would make all of them unrecoverable and blind the
stats indexer. On-chain formats are append-only history, not branding — and this
one survives for free, since its five bytes never matched any rename rule.
(Superseded on 2026-08-19: with nothing yet launched, the magic *was* changed to
`KOSGN` and the pre-existing testnet treasuries were written off. See the entry
below.)

**A migration we wrote, tested, and then deleted.** The instinct was that
localStorage is load-bearing: in node-direct mode no backend holds a second copy,
so a renamed key prefix looked like it would drop every existing user's Treasuries.
A copy-not-move, idempotent shim went in, with seven tests and a subtle ordering
constraint — `signer.js` does `let _priv = load()` at module-evaluation time, so
the shim had to be the *first* `import` in `main.jsx`, because ES imports
evaluate before the importing module's own statements.

Then someone asked the obvious question: isn't it all on the chain? It is.
`TreasuryView` already falls through `findByVault` → `recoverTreasuryFromChain` →
`seedFromChain`, rebuilding the covenant scripts from the recovered
owners/threshold/salt, locating the live `KoRoot`, and walking its spend
history for config changes — automatically, with retries, ending fully operable
rather than read-only. localStorage was never the source of truth; it is a cache
keyed by treasuryId, and there is no "my Treasuries" list to lose because `findByVault`
only ever resolves the vault address already in the URL. The app cannot even
generate a signing key — `signer.js` exposes `importKey` only — so the stored key
always came from somewhere the owner still has it.

So the migration protected nothing, and it went in the bin. What it would have
bought was a nicety: no re-import, and no chain-recovery round-trip on first
load. That second one is not nothing — recovery leans on the REST indexer, which
is exactly the third-party dependency Route B exists to avoid — but it is a
one-time cost on one load, not data loss. Worth writing the shim to find that
out; not worth keeping it.

**The wordmark grep structurally cannot find.** The brand is rendered as a split
pair of spans, `<span>Ko-<span className="grad">sign</span></span>`, so the second
half can take the gradient. Before the rename the same markup held the old name
with no contiguous substring anywhere in the source — so the sweep reported zero
occurrences while the largest text on the landing page, the treasury sidebar and the
whitepaper nav were all still wrong. Caught by an adversarial audit pass, not by
the search. `Ko-sign` splits cleanly at its hyphen, so the treatment survived.

**A run-book that would have failed on the production host.** The first draft of
the DB migration drove both stacks with `export STACK=` alone. But an exported
`STACK` only sets the compose *project name* — `NETWORK`, `PORT`, `DB_PORT`,
`DATABASE_URL` and `DB_PASSWORD` still come from the env file, and
`indexer/README.md` says every command for the mainnet stack needs
`--env-file .env.mainnet`. Following it verbatim would have brought "mainnet" up
pinned to `testnet-10` against the mainnet data, with the verification `curl`
answered by the still-running testnet indexer — a false green on the exact check
meant to catch the failure.

Verification: the 25 unit tests, all workspace package tests, `cargo check` clean
on all three Rust crates, and a `vite build` still emitting
`kosign_wasm_tx_bg-CrBTtZTI.wasm` — the same digest as before the rename, proving
the binary was renamed rather than rebuilt. Then five independent audit lenses
(residue, over-rename, broken references, producer/consumer consistency, prose)
with every candidate finding put through a refutation pass: 43 candidates, 35
refuted, 8 real.

Two steps the code cannot do for itself: rename the GitHub repository, and — on
each indexer VM — rename the Postgres role and database inside the existing
volume, then copy the volumes across to the new compose project name. Bringing
the new compose file up without that does not error; it creates empty volumes,
orphans the real data, and re-scans the chain from genesis.

## 19 · Safe → treasury, and the rename that could touch the contracts

The Ko-sign rename left the *object* still called a Safe. Renaming it to
**treasury** meant touching three things the previous sweep had deliberately
refused to: the covenant contract names, the on-chain inscription magic, and the
indexer's wire schema. Nothing is launched yet, so all three went.

**The claim I had to disprove before touching `contracts/`.** My first instinct
was that renaming `SafeVault` → `KoVault` would change the compiled redeem script
and therefore the P2SH address, bricking every existing treasury. That is worth
being wrong about in the safe direction, so it got a harness rather than an
argument: compile all three contracts from the original tree and from a renamed
copy with byte-identical ctor args, and diff the emitted `script`. They matched
exactly — 1408 / 1638 / 4258 bytes, same sha256, same `state_layout`. The
contract name is a source-level identifier that never reaches the output, so the
addresses are invariant and `proposalTemplateHash` (a hash *of the script*) is
too. The gate was re-run against the fully renamed tree as the last step.

**Where a blanket `sed` would have done real damage.** "Safe" is three different
words in this tree. It is the domain object; it is *secure* (`unsafe`, `safety`,
"safe to run on every boot", "safe integer range", "strays are safe to leave");
and it is other people's proper nouns (`Transaction.serializeToSafeJSON` from
kaspa-wasm, `Number.isSafeInteger`, `safe_arch`, Gnosis Safe, Safe{Wallet},
safe.global). The sweep therefore ran from an explicit longest-first token list
with the homonyms masked out and re-checked afterwards, never a bare
`s/safe/treasury/`.

**Two silent half-renames, same root cause.** `git grep -E` does not implement
`\b` — it is POSIX ERE, where `\b` is not a word boundary. Both times the *perl*
substitution was correct and the *file selection* silently under-matched, leaving
`backend/server.mjs` and `Landing.jsx` holding both spellings at once: the
indexer emitting `treasuries` while the frontend read `stats.safes`. Select files
with a fixed string and leave `\b` to perl.

**The inscription magic, reversed.** Section 18 argued `KSAFE` had to outlive the
brand because it is written into the genesis payload of every treasury that
already exists. That reasoning still holds — it just stopped mattering, because
nothing has launched and the only treasuries in existence are testnet. So the
magic is now `KOSGN` (`4b4f53474e`), still five bytes so every downstream offset
is unmoved. It lives in the *encoder*, which is Rust compiled into the shipped
wasm, so the binary had to be rebuilt or the app would have written `KSAFE` while
looking for `KOSGN`. Verified three ways: `KOSGN` ×1 / `KSAFE` ×0 in the wasm
bytes, a wasm-encode → JS-decode round-trip on threshold/ownerCount/salt, and a
hand-built `KSAFE`-prefixed payload confirmed rejected.

**What this breaks, on purpose.** Every pre-existing treasury is now invisible to
chain recovery. The deployed indexers will create empty `treasuries` tables
beside their populated `safes` ones, so both need their databases recreated and
must be redeployed in lockstep with the frontend — `/api/stats` renamed its
field. Bookmarked `/#/safe/…` URLs 404; the route is `/#/treasury/…`.

## 20 · Three script rules, integrated — and the fixtures that had been lying (2026-08-19)

Three rules landed in parallel: owner-slot **distinctness** (KoRoot), the vault's
value bound over the whole **input SET** rather than per input (KoVault), and a
proposal **bounding its own snapshot** (KoProposal). Integrating them was mostly
about the fourth thing nobody set out to fix.

**The fixtures were the bug.** `contracts/*.test.json` bake values that only the
compiled contract can produce — a BIP340 signature over a sighash that commits to
the spent script, a continuation's redeem script, `P2SH(compiled KoVault)`. When a
contract moves, a stale fixture does not fail loudly; it fails **early**, at
`checkSig` or at the scriptPubKey compare, *before* reaching the rule the test was
written for. Every test that expects `fail` then passes for the wrong reason. The
KoVault PoC hit exactly this: re-run against the fixed contract it still "failed",
but at the spk compare — the fix looked proven and wasn't, until the fixture was
regenerated. So `KoVault.test.json` and `KoProposal.test.json` joined
`KoRoot.test.json` as generated files (`npm run gen:contract-tests`).

**What the generators exposed.** `executeProposal` had *no* test coverage at all —
which is why a per-input value bound survived in a treasury contract with a test
suite. `approve` had no positive test whatsoever, because the debugger cannot
auto-sign and every fixture was a rejection that stopped at `checkSig`; the whole
entrypoint was pinned only by what it refused. Contract coverage went 54 → 141
(KoVault 4 → 25, KoProposal 7 → 53, KoRoot 43 → 63, counting the fixtures the
later sections of this round added).

**The vacuous-control trap, one level down.** The new `executeProposal` SECURITY
fixtures passed on the current contract *and* on the guard-stripped mutant — they
looked like differential controls and were not. The cause was the change output's
`script_hex`, baked as `P2SH(current KoVault)`: on any mutant the script moves, so
the fixture rejects at the spk compare no matter what the guards do. Omitting
`script_hex` lets the debugger derive it from the contract under test, so the
fixture follows the mutant and the control bites. `KoVault` went from 2 SECURITY
tests to 6, `KoProposal` from 1 to 2 — the ones that can honestly flip live on the
two entrypoints that check no signature (`executeProposal`, `closeExpired`);
everything signature-gated is labelled `[weak: …]` and stays out of the count.

**Where the rules deliberately do not agree.** KoRoot enforces distinctness;
KoProposal does not. That is not an oversight, and the PoC proves it: a
duplicate-owner snapshot planted directly on a proposal UTXO is still votable once
per slot. It costs ~280 bytes on every vote to close, and it closes nothing that a
forged snapshot naming one key does not reopen. Conversely KoProposal bounds a
snapshot that KoRoot already bounded when it minted it — that one *is* worth
repeating, because a covenant id does not prove KoRoot minted the UTXO. The rule
of thumb that came out of it: repeat a check when the other contract's enforcement
is not *provable* from where you stand, not merely when it exists.

**Cost.** KoProposal 1567 → 1630 bytes, KoVault 2240 → 2724, KoRoot 4694 → 5060
for these three rules alone. (The round did not end here: the tally invariant and
the root-input value floors below carried KoProposal to **1720** and KoRoot to
**6219**, which is what the final `proposalTemplateHash` `9963c721…` and the
shipped `vaultConstant` are derived from — see the integration section at the end.)
`proposalTemplateHash` and `vaultConstant` both move, so every derived address
moves; existing treasuries keep running their old scripts and are not covered by
any of this. Executions also inherit the deposit path's 16-input ceiling now, so a
fee-funding wallet may contribute at most 14 inputs to one execution.

## 21 · The attack no contract can see — genesis provenance (2026-08-19)

Every rule Ko-sign has enforced so far lives in a script, and every one of them
answers the same shape of question: *is this spend allowed?* This one does not.

`KoVault.executeProposal` authenticates a proposal by two facts — the input's
script matches the KoProposal template, and its covenant id equals the vault's.
Both hold for every proposal `KoRoot.createProposal` mints. Both also hold for a
proposal that was **never minted at all**, if it was placed into the covenant at
genesis.

`populate_genesis_covenants` takes
`GenesisCovenantGroup { authorizing_input, outputs: Vec<u32> }`. The **spender**
decides how many outputs join. Our builders bind `vec![0, 1]` — KoRoot and KoVault
— and I had always read that as a fact about the treasury. It is a fact about our
*builder*. Bind `vec![0, 1, 2]` with output 2 a KoProposal-shaped P2SH carrying
`status = 1, snapThreshold = 1, ownerCount = 1, owner0 = <attacker>`, and the
treasury ships with a pre-approved proposal inside its own covenant. Every address
is correct, the KOSGN inscription decodes, the owner set is whatever you agreed,
the balances are real — and the vault is drainable at the creator's convenience.

The first instinct was to fix it in KoVault. It cannot be fixed there. The complete
covenant instruction set is `OpInputCovenantId`, `OpOutputCovenantId`,
`OpCovOutputCount`, `OpCovOutputIdx`, `OpOutputAuthorizingInput`; not one of them
distinguishes a binding created at genesis from one minted by a rule-following
spend. A script sees an id, never its provenance. Which reframes the whole
security model in a useful way: the `OpCovOutputCount`/`OpCovOutputIdx` guards
`test-security.sh` pins govern **every** binding after genesis — genesis is the
single moment in a treasury's life when covenant membership is chosen by a party
instead of by a script. That is where the check has to live, and it has to run
before anyone deposits.

**What I expected to find, and what was actually there.** Earlier work had
established that `utxoEntry` does not report `covenant_id`, so I went in assuming
the check would be reduced to "is there a suspicious third P2SH output" — real,
but weak. Probing a live 2.0.1 node said otherwise: `getBlock(s)` returns
`output.covenant = { covenantId, authorizingInput }` per output, `utxoEntry`
*does* carry `covenantId`, and the REST indexer exposes both `covenant_id` and
`covenant_authorizing_input`. The genesis covenant group is directly readable from
both sources the app already uses.

**And then the part that made it a proof rather than a report.** `covenant_id` is
not opaque:

```
blake2b-256(key = "CovenantID")( outpoint.txid ‖ le32(index) ‖ le64(n)
    ‖ for each: le32(idx) ‖ le64(value) ‖ le16(spkVersion) ‖ le64(len) ‖ spk )
```

It commits to `n`. A three-output group cannot hash to a two-output id. So instead
of *reading* the bindings the indexer reports, recompute the id over
`{output 0, output 1}` and compare it with the id the vault actually carries. I
reproduced the live TN10 treasury exactly — funding outpoint `be6288e9…:1`, outputs
0/1 → `8ff0e529…48e0`, the id its UTXOs carry — on the first attempt. That turns a
third-party report into a cryptographic argument: take the genesis *content* from
REST but the *answer* from your own node's UTXO set, and an indexer that omits the
extra output entirely still fails to match. The test suite includes exactly that
hostile case.

**Refuse, don't annotate.** A warning banner would have been the comfortable
choice and it would have been useless: the whole point is that everything else
looks right, so a banner competes with a correct-looking balance and a copyable
deposit address. A refused treasury now renders one screen explaining what was
found, and nothing else — no balance, no proposals, no deposit address, no
override (a covenant id cannot be re-minted; there is nothing to wait for), and
nothing written to `localStorage`, since resolution and node-direct seeding are
held back until the gate clears. The verdict distinguishes `refused` from
`unverified`: "we could not check" is not "it is fine", so an unreachable chain
also keeps the treasury closed — but it retries, and offers a clearly-labelled
session-only escape, because otherwise a REST outage bricks every treasury in the
app. Only immutable verdicts are cached.

**One file, two runtimes.** The rules live in
`packages/descriptor/src/genesis.js` — plain ESM with JSDoc types (typechecked via
`allowJs`/`checkJs`). The indexer ships as a standalone Docker image with its own
build context, so it vendors a byte-identical copy rather than importing across the
workspace, and a drift test compares the two by hash: a vendored security check
that quietly falls behind the original is worse than none.

## 22 · The bypass in the genesis audit — shape is not identity (2026-08-19)

§21 shipped a check that binds the *number* of covenant members. It never bound
their *identity*, and that gap is the whole attack again in a cheaper form.

The auditor classified genesis output 0 by shape: `scriptKind(spk) === "p2sh"`, and
on that basis called it "the KoRoot". Output 1 it compared to the vault address the
caller handed it. So bind exactly **two** outputs — output 0 the forged
KoProposal, output 1 the real KoVault — and every layer agrees: two outputs, both
P2SH, bound set `[0, 1]`, one id, one authorizing input, and the covenant-id
recomputation **matches**, because the group genuinely is those two outputs. The
proof I was proudest of in §21 is a proof about the group's *size*, and this attack
does not change the size. Verdict: clean, `cryptographic: true`, even with the live
id supplied from an independent node.

The on-chain half was already true and I had written it down without joining it up:
`KoVault.executeProposal` needs a bound vault input plus a same-id, template-shaped
proposal input, and **no KoRoot need appear in the transaction at all**.
`treasuryId` is a constructor argument no contract body references. The vault
address commits to the salt, not the covenant id. There is nothing on chain that
distinguishes the two-output forgery — which makes the audit the only defence, and
means the audit has to answer a question it was not asking: *are these two outputs
this treasury's contracts?*

**The fix was already in the repo, applied to one member.**
`scripts/treasury-version.mjs` rebuilds a treasury's KoRoot from its inscription
and compares the derived address to genesis output 0. A P2SH address *is*
`blake2b-256(redeemScript)`, so that comparison is identity, not resemblance — and
it is sound even though the creator writes the inscription, because he cannot make
a forged KoProposal hash to the KoRoot his own inscription derives. Lying in the
inscription only moves the address the audit demands. The audit now does exactly
that for **both** members, by script hash rather than by address (no bech32, no
network prefix, works on a bare block transaction with no `verboseData`).

That has a cost worth stating plainly: identity is relative to a *build*. The
auditor now imports `treasuryTemplates.js`, so a treasury minted by different
contract bytes reports `not-this-build` and is **refused**. Not an accusation — but
this build cannot derive that treasury's own vault address either, so it could
never have operated it; "I cannot tell" rendering as "verified" is the failure mode
worth avoiding. `treasury-version.mjs` reaches the same verdict independently, and
the refusal points at it.

**And the second bug, which was about honesty rather than about bytes.** When no
`treasuryId` was supplied, the auditor set `treasuryId = root.covenantId` — the
value the possibly-hostile source had just reported — then recomputed, matched it
against itself, and set `cryptographic = true`. Meanwhile the browser's
`liveTreasuryId` returned `null` three silent ways (no endpoint, any thrown error,
a node whose UTXOs carry no `covenantId`), none of which changed the verdict, and
`TreasuryView` never read `gate.cryptographic` at all. So "I confirmed this against
your own node" and "the indexer agreed with itself" were the same pixel.
`cryptographic` is now set **only** for an independently supplied id; each failure
mode returns a reason that travels with the verdict; a clean-but-unconfirmed
verdict renders an amber panel and is deliberately not cached, so the proof
completes by itself once a node is reachable.

The injection point that caused the indexer to run structural-only is gone
entirely — the module imports `@noble/hashes` and its templates instead of taking
them as options, because an audit whose strength depends on what a call site
remembered to pass is a hole with a schedule. The indexer picked up a 4 kB
dependency and full member identity on both paths, and its follower now re-runs the
audit with the covenant id from its own UTXO set, which is a genuinely independent
second view. What each registration proved is recorded as
`genesisAudit: { version, assurance }` and served on `/api/treasuries`.

**Evidence.** The live TN10 treasury `kaspatest:pq05ne9c…se77fv` audits CLEAN with
`cryptographic: true` under the templates of the build that minted it (470be03),
with the covenant id read from a public node — its real on-chain KoRoot and KoVault
script hashes are reproduced exactly from its inscription. The same genesis under
this working tree's in-flight contract templates reports `not-this-build`, which is
what `scripts/treasury-version.mjs` says too. The two-member forgery is refused
`root-not-koroot` even when an independent node confirms its id.

## 23 · The ceiling nobody told the client about, and a suite that proved less than it said (2026-08-19)

Two loose ends from the security review, neither of them in a contract.

**A hard limit enforced on one side only.** `KoVault` grew a bounded input scan,
and the compiler emits `require(end - start <= maxDepositInputs)` before it
unrolls — so `executeProposal` now rejects a 17-input transaction outright, which
is exactly what makes the vault-input SUM complete (nothing can be parked past the
scan window). The CHANGELOG said so. Nothing in the client did: `pickFrom` added
wallet UTXOs until the fee was covered, `feeSizedOp` called it uncapped, and
`attach_funding` attached all of them. `MAX_TX_INPUTS = 16` already existed in
`sweepPlan.js` — the sweep path had been shrinking its batches around it since the
batched-sweep work — but the covenant ops never looked at it. A dust-fragmented
owner wallet therefore built a transaction the covenant rejects, and the owner saw
a script failure rather than the "your wallet needs…" message every other funding
path produces.

The fix is where the operation is planned, not where it is signed: `sizeOpFee` in
`sweepPlan.js` (pure, no wasm, no network) caps the pick at the ceiling minus what
the covenant itself brings — 1 input for approve/reject, 2 for execute and
config-execute — and distinguishes two ways to fall short. `short` means the wallet
cannot pay; `capped` means it *has* the money but not in few enough pieces, which
is a different sentence: *consolidate your wallet, or fund the fee from a single
UTXO*. On the first sizing the treasury pays instead (the fallback that already
existed), so fragmentation alone never blocks an operation; on the submit-retry
path, where the node has demanded a higher fee and there is no fallback left, it
throws. `createProposal` was left alone here on purpose — it spends KoRoot, which
had no bounded scan, and capping a transaction the chain would accept is its own
bug. That reasoning was true when it was written and false by the time the round
closed: the root-input value floors gave KoRoot the same loop, hence the same
`require(tx.inputs.length <= 16)`. Section 24 closes it.

`frontend/test/opFunding.test.mjs` builds the real transactions through the wasm
and counts their inputs — including the demonstration that the builder attaches 15
funding UTXOs to a 2-input covenant spend when nobody stops it. Four of its nine
tests fail if the cap is removed (13 tests and 6 failures once section 24 adds the
createProposal side).

**A suite that proved less than its closing line said.** `test-security.sh` ended
with "the guards hold and the tests prove it", and for covenant lineage that was
true. For everything added this round it was not: the GUARD regex matched only the
lineage guards, so the 20 owner-distinctness requires, the value floors,
`requireSaneSnapshot` and the vault's input-set sum could each be deleted while the
inventory still reported 8/10/8 and every SECURITY-labelled test still passed.

Splitting the guards into families (LINEAGE, DISTINCT, BOUNDS, VALUE, and
inventory-only SCAN for the loop header, which cannot be deleted without breaking
compilation) was the easy half. The hard half was that a differential control on a
signature-gated path is a lie: deleting a line moves the compiled script, hence the
P2SH address, hence every sighash, so the fixture's real BIP340 signature stops
verifying and the test keeps "passing" for a reason that has nothing to do with the
guard. That is what the `[weak: …]` labels in the fixtures have always been about,
and it is why `requireSaneSnapshot` — reached only from approve, reject and
execute, all signature-gated — could not be pinned at all by stripping.

So the harness now rebuilds the fixtures **against the mutant**: it mirrors the
repo into `$TMPDIR` (real copies of `contracts/` and `scripts/`, symlinked
toolchain and `node_modules` — the generators locate the repo from their own path,
so a symlinked `scripts/` would resolve back to the original and write into it),
strips one family, and runs `gen-*-tests.mjs` there. The signatures are then valid
for the mutant and the only thing that can change a verdict is the missing guard.
Stripping the snapshot bounds flips exactly the eight tests that pin them, and not
one test more.

Selection is by test name (or by the SECURITY label for lineage), which doubles as
a check that the pins still exist — renaming them away is a failure, not a silent
pass — and lets each control run a handful of tests instead of all 56, so the suite
got faster while checking four times as much. The rule is a MINIMUM number of
flips, not "all of them", because rejections are over-determined: "a snapshot with
ownerCount 0" is also caught by `ownerIndex < ownerCount`, and a test like that
pins nothing on its own. That number, and every guard count, is re-derivable with
`--rederive` — necessary in a tree where three agents were editing the contracts
while this was written.

All four original tripwires were re-verified by deliberately breaking each one in a
throwaway mirror (perl made to fail, a guard reformatted across two lines, a guard
line made load-bearing so the mutant cannot compile, a SECURITY-labelled test that
cannot flip), plus three new ones: pinning tests renamed away, a generator that
cannot rebuild the mutant's fixtures, and a policy guard deleted outright.

One more thing fell out of having the mirror. Layer 1 used to say only "a test
FAILED on the current contract", and the overwhelmingly common cause is a contract
edited without regenerating its fixtures — the signature no longer verifies, which
looks exactly like a broken rule and is not one. When a contract goes red the
harness now regenerates its fixtures into the mirror and compares: **STALE** ("run
`npm run gen:koroot-tests`") or **CURRENT** ("this is a real change in what the
contract accepts, read the failing test"). It cost nothing on a green tree, and it
diagnosed itself on the first run: KoRoot was red the whole time this was being
written, purely because a concurrent edit to `KoRoot.sil` had not been followed by
a regeneration — its 56 tests all pass against fixtures rebuilt from the same
source.

## 24 · Integrating four concurrent security rounds (2026-08-19)

Four agents worked the same tree at once — genesis provenance, the proposal's
tally invariant, KoRoot's root-input value floors, and the client-side input
ceiling plus the security harness. Each was correct in isolation. Integration was
about the seams, and the seams are where this log earns its keep.

**Contracts read together, not one at a time.** Three findings came out of reading
the three sources as one artefact:

* `KoRoot.executeConfig` said its floor "mirrors `approve()`". It had, until the
  same round rewrote `createProposal`'s floor as a walk over the root-input set
  and left `approve` per-input. A comment that names the wrong sibling is worse
  than none — it tells the next reader the two are the same rule. It now names
  `createProposal`.
* `KoProposal.approve/reject` still cap value against **`this` input's value**,
  and that stays. Not an oversight and not the same bug: the continuation pins all
  19 state fields to this input's own state, so a second proposal input can only
  co-validate if its state is identical — and state lives *inside* the redeem
  script, so identical state means the identical address, i.e. a byte-for-byte
  duplicate UTXO. KoRoot mints one proposal per spend at a freshly bumped nonce,
  and a plain payment to a proposal address is unbound, so its own copy of the
  script stops at the non-zero-id require and it cannot ride along. What is left is
  a genesis planter binding two identical proposals and later spending both,
  leaking the smaller — his own money, on a proposal only he can vote. The walk
  that would close it measures **+966 bytes** (1720 → 2686, both entrypoints), a
  56% growth of a script revealed in the signature script of every approve, reject
  and execute. Written into the contract with the measurement, so the next reader
  inherits the reasoning rather than the conclusion.
* The frontend's `proposerFunding` said, in a comment, that KoRoot "has no bounded
  input scan, so no covenant rule limits how many inputs the transaction may
  carry". That had been true for hours. Capping it (15 wallet UTXOs beside the one
  root input) is section 23's fix applied to the fifth op; the fragmented wallet now
  falls back to the root-funded path with a message instead of failing at submit.

**Two guard families were inventoried nowhere.** `test-security.sh` was rewritten
around five families in the same round the tally rules and the root walks landed,
so its regexes matched neither: six new `require` lines in KoProposal and two new
bounded loops in KoRoot could all have been deleted with the harness still green.
Added a TALLY family (`EXPECT_TALLY_KoProposal=6`, all 8 pinning fixtures flip when
the six lines are stripped) and broadened SCAN to `max(DepositInputs|TxInputs)`
with `EXPECT_SCAN_KoRoot=2`. The lesson generalises: a harness organised by family
only covers what someone remembered to declare, so adding a rule and adding its
family have to be the same commit.

**Fixtures for the rules that had none.** The tally rules shipped with no fixture
at all, and KoRoot's set-walk had only scratchpad probes. 12 KoProposal fixtures (8
rejections, 4 boundary acceptances — the zero tally, the last vote of a fully-voted
2-of-3, the last rejection a 3-of-5 can take, an Approved proposal whose tallies
reach `ownerCount` exactly) and 7 KoRoot fixtures (two roots covered, one-of-two
refused from either root's point of view, 17 inputs refused at the loop's own
bound, 16 accepted, and the same pair on `executeConfig`). Every rejection was
verified by flipping its `expect` and reading the debugger's `--> line:col`, then
checking that line is the rule the test is named for rather than an earlier guard:
all six tally rules in KoProposal are covered (`approvalCount >= 0`,
`rejectCount >= 0`, `approvalCount + rejectCount <= ownerCount`,
`approvalCount < snapThreshold`, `(ownerCount - rejectCount) >= snapThreshold`,
`approvalCount >= snapThreshold`), and in KoRoot both floors plus the loop's own
`tx.inputs.length` bound — the 17-input fixture dies at the `for` header, not at
the floor, which is the point of having it. `build()` in
`gen-koroot-tests.mjs` gained an `active` option for that, since the sighash
commits to the active input.

**What the numbers actually are.** Every claim in the CHANGELOG and in section 20
was re-measured with `silc` and the production constructor arguments, because two
of them had gone stale mid-round: KoProposal **1567 → 1720** (+153), KoVault
**2240 → 2724** (+484), KoRoot **4694 → 6219** (+1525, of which 979 is its two
walks). Per-rule tally costs verified by compiling each rule out on its own: 15,
12, 27, 30, 6 — summing to the 90 the contract comment claims. The proposal
template hash finished at `9963c721…`, not the `d3367119…` the CHANGELOG had
recorded from an intermediate compile: the committed templates were themselves
behind the tree, which is exactly what `gen-templates.ts` (now writing all three
mirrors) and the CI `git diff --exit-code` step exist to catch.

**Still open, deliberately.** `KoProposal`'s per-input value floor, above. And
`OpCovInputCount` would close KoRoot's sibling-root case more tightly than the spk
sum for ~4 opcodes instead of 979 bytes — but it is a lineage guard the harness's
LINEAGE regex does not match, so it would survive into the LINEAGE mutant and make
two SECURITY controls vacuous. Landing it means changing `test-security.sh` in the
same commit, which is a decision about the harness, not about the contract.

## 25 · The stateful vault — an address that is a function of its genesis (2026-08-20)

A treasury's deposit address was a random salt spliced into the vault redeem
script. The vault itself was stateless, and a stateless script does not care whose
covenant it is spending under. So anyone could compute that address, plant a
covenant **lineage of his own** at it, wait for an incoming payment — payments
arrive UNBOUND, which is the whole point of a deposit address — sweep it into his
lineage with `deposit`, and spend it with a proposal he had pre-approved for
himself. No owner key. No forged genesis. Just an address that committed to
nothing except itself.

The fix is one sentence: **the vault holds the treasury's covenant id in state and
refuses every other lineage.** `executeProposal` requires `cid == lineage`,
`deposit` requires `cid0 == lineage`. A foreign covenant that reaches a vault input
dies at the first `require`.

**Except the id cannot be a constant baked at genesis.** `covenant_id` hashes the
scriptPubKeys of its own genesis group, so a vault whose state IS that id would
have to contain a hash of itself. The way out is to invert the order:

```
tx1  GENESIS         output 0: KoRoot   ← the covenant group, alone
                     output 1: change   ← ordinary, unbound, optional
                     ⇒ C = covenant_id(fundingOutpoint, [(0, rootValue, rootSpk)])

tx2  bootstrapVault  spends the root, mints the vault as a CONTINUATION of C,
                     stamping C into its state; the root continues UNCHANGED
```

`C` depends on nothing but the funding outpoint and the root, so the genesis can
compute it before broadcast and inscribe it in its own payload. `KoRoot` gained a
`vaultTemplateHash` constructor argument and a `bootstrapVault` entrypoint that
pins the spender-supplied vault template against it — 3.9 kB of vault script
supplied at spend time and hash-checked, rather than carried inside the root's
redeem and revealed on every proposal any owner ever creates.

What falls out is the property the change exists for: **the vault address is a pure
function of the genesis.** One lineage, one address, and no second lineage can ever
transact there.

**The audit stops observing and starts deriving.** `genesis.js` used to look for the
vault among the genesis outputs and compare it to the address the caller was
opening. There is no vault output any more, so instead it recomputes `C` from
`{output 0}` and *derives* `p2sh(vaultPrefix ‖ push32(C) ‖ vaultSuffix)`. A forged
genesis no longer fails by being detectably forged — it fails by deriving a
different address, i.e. by not being this vault's genesis at all. That also retires
the awkwardness §22 shipped with: `cryptographic` needed an independently-supplied
covenant id, because matching a source's id against its own outputs restates what
it already said. It no longer does. **The address the user typed is the second
opinion.** A node's UTXO id still strengthens the verdict — `assurance` now reads
`independent` / `lineage` / `structural` instead of two levels — but the derivation
alone is enough to open a treasury. Audit version 3; refusal codes
`vault-not-p2sh`, `vault-index-mismatch`, `root-not-koroot` and `vault-not-kovault`
are gone, replaced by `vault-not-from-this-genesis` and `vault-underivable`.

**Then the seams.** Five agents ported the app layer in parallel and each was
correct in its own files. Everything that broke, broke between them:

* **Chain recovery died at hop 0.** `KoRoot` gained an entrypoint in the middle of
  its declaration order, so silc renumbered the selectors: `executeConfig` moved
  from 1 to 2 and `bootstrapVault` took 1. `frontend/src/proposalScan.js::walkRoot`
  still read selector 1 as `executeConfig`, and the walk starts at the genesis
  root output — which is exactly what `bootstrapVault` spends. So it parsed a
  bootstrap witness as a config change, read `threshold = 1.34e154`,
  `ownerCount = 107`, and threw `rootState needs 5 owner slots` on the next hop.
  Every treasury, every time: opening one in a fresh browser or a co-signer's tab
  was dead. It failed loudly rather than installing garbage, which is the only
  charitable thing to say about it. The mapping had no test at all — a selector is a
  coupling between a contract's declaration order and a client's parser, with no
  compiler and no type in between, and a wrong number does not fail to parse, it
  parses the WRONG witness. `frontend/test/proposalScan.test.mjs` now pins all three
  against real witness shapes (3 of its 4 tests fail if the old mapping is restored).
* **The genesis was searched for in a history it can never appear in.**
  `fetchGenesisTx` paged the *vault* address looking for the KOSGN payload. The
  genesis does not pay the vault and cannot; the `bootstrapVault` transaction that
  does carries an empty payload. So the gate answered `no-genesis` forever and
  chain-only recovery answered `no-inscription` forever — the provenance control
  degrading, permanently and for 100% of treasuries, to a "continue anyway" button.
  The unit test could not catch it because its `fetch` stub ignored the URL and
  served the genesis for every address; the fixture described a chain that cannot
  exist. It is now a two-hop walk (oldest covenant-bound payment to the vault →
  the outpoint its input 0 spent → that txid in the KoRoot's history), matched by
  **txid** rather than by "the first KOSGN payload there" — anyone may pay the root
  address with any payload, and a payload-picked candidate hands a stranger a
  permanently-cached refusal.
* **A degraded REST index became a permanent verdict.** The indexer's second-line
  walk treated a blank first page from the KoRoot's history as a completed walk,
  which fell through to `no-genesis` — definitive, so it dropped the durable queue
  entry and cached the failure. The file documents that this very index answers
  `[]` for old, busy addresses while `/balance` answers fine, and the vault walk 30
  lines above already refuses that inference. The root address is known non-empty,
  because the mint paid it.
* **A guard family with no differential coverage.** `test-security.sh` selected
  only `^SECURITY` fixtures for the LINEAGE control, which excluded the eight
  `[weak control: …]` ones — so `createProposal`'s lineage pinning (`cid != 0`,
  `OpCovOutputCount(cid) == 2`, both `OpCovOutputIdx` bounds) could be stripped with
  the harness still green. The same round that made those fixtures able to flip
  (regenerating them against the mutant) is what exposed it. Selector widened,
  flip minimums raised 4→8 and 5→9.
* **A JSDoc property, and therefore CI.** `auditGenesis` returns `vaultScriptHash`;
  the `AuditVerdict` typedef never declared it, so `tsc --noEmit` failed with two
  TS2353s and the build gate was red on a file with zero runtime problems.

**Naming.** The 32-byte inscription slot is unchanged on the wire but no longer
means a random salt, so `decodeInscription` returns `lineage`. That matters beyond
tidiness: a salt was a number only its creator knew, and a lineage is a claim an
auditor **recomputes from the chain and compares**.

**Not ported, on purpose: the paths that cannot be validated from here.**
`scripts/build-treasury.ts`, `tools/kaspa-probe/src/bin/genesis.rs` and the
`backend/` route-A bridge over them still describe a one-transaction genesis with a
salted vault output, which this protocol cannot express. They are fail-closed rather
than wrong — `build-treasury.ts` throws inside `koVaultArgs`/`koRootArgs` on the
renamed and added constructor arguments, so no manifest can be produced and nothing
downstream has anything to consume. Same for the two
`frontend/test/*.manual.mjs` lifecycle scripts, which spend real TN10 funds and are
excluded from CI for that reason: they still build a genesis with a vault output and
now assert out at "vault covenant UTXO didn't appear". Porting any of them means a
second native binary for `bootstrapVault` and a node to run it against; the browser
path is the shipped one and is on-chain validated, so these are left broken-and-loud
rather than half-ported and quiet. `execute_config.rs`'s selector constant WAS
corrected (1 → 2), because a stale one there dispatches `bootstrapVault` — a wrong
number that still runs is a different kind of thing from a tool that refuses to
start. `scripts/treasury-version.mjs` was ported for the same reason: it is what the
audit's own `not-this-build` refusal tells a user to run, and it was looking for the
genesis in the vault's history.

## 26 · The blob nobody could check

The security story so far had been about the covenants: four adversarial review
rounds, three on-chain rounds, a mutation harness proving each guard family
bites. All of it about `.sil` files that every Kaspa node enforces.

Then the question was asked the other way round — what runs that *isn't*
enforced by anyone? Three things: the browser app, the indexer, and the
transaction builder. And the transaction builder ships as a committed binary.

`frontend/src/wasm/kosign_wasm_tx_bg.wasm` decides the amount, the recipient and
the covenant continuation of every transaction an owner signs. Reading
`tools/wasm-tx/src/lib.rs` said nothing about it, because nothing connected the
two. The interesting part is that the dangerous case is not an attacker: edit
`lib.rs`, forget to rebuild, and all 176 contract tests plus 75 frontend tests
stay green — because every one of them exercises the old blob. The fix is in the
diff and not in the product, and no suite in the repo can tell.

The fix sounds like one line — rebuild it and compare — and the first attempt
proved it. A rebuild reproduced the committed artefacts byte for byte, on the
first try, which was suspicious rather than reassuring. It was: `cargo` had
answered from cache in 0.43s. A clean-room rebuild into a fresh `CARGO_TARGET_DIR`
also matched, which was genuinely good news, but `strings` on the artefact
explained why the good news was local: **47 occurrences of the developer's `/Users/<username>` home directory**.
rustc records the path of every file it compiles. The blob was reproducible by
exactly one account on one machine, and it had been shipping a developer's
username to every visitor.

Pulling that thread found two more, both silent:

- `Cargo.lock` was **gitignored**. 392 packages, not one version recorded. Two
  honest people building the same commit would resolve crates.io differently and
  get different binaries — and nobody could say which `serde_json` was inside the
  code that decides a recipient address.
- rustc was unpinned. Instruction selection and section ordering are the
  compiler's choice; a different rustc is a different binary from identical
  source, and the natural reading of that difference is tampering.

So the real work was making a rebuild mean something: track the lockfile, add
`rust-toolchain.toml`, and pass `--remap-path-prefix` for both `CARGO_HOME` and
the repo root. The script asserts the remap worked rather than trusting the flag,
because a typo in a prefix fails silently — which is the whole theme.

Two tiers, because they answer different questions. `scripts/wasm-manifest.mjs`
hashes the four artefacts *and* the five build inputs into a committed manifest;
source hashes moving while artefact hashes stand still is precisely the "forgot
to rebuild" case, and it needs no toolchain, so it runs in `npm test` on any
machine. `scripts/build-wasm.sh` rebuilds and compares bytes — the only tier that
proves the blob came from the source, since a manifest can be updated by whoever
swapped the blob.

Then the part that makes it worth anything: nine mutations, each of which had to
be reported for the *right* reason. Edited `lib.rs`; appended a byte to the
`.wasm`; edited `Cargo.lock`; moved both sides at once; deleted the rustc pin;
changed `ROOT_PROPOSAL_VAL` from 50 to 60 KAS and rebuilt; removed `cargo` from
`PATH`. Plus the control — the clean tree must pass, or the other eight are
noise. That last one is the lesson from the STATE guard family, where a set of
"failures" turned out to be signature rot rather than the guard being missed.

One limit stayed. `secp256k1-sys` compiles C with the host clang and some of it
survives into the wasm, so byte identity holds per-toolchain, not universally.
The manifest records the toolchain and the script reports a mismatch as a
mismatch rather than as tampering; the CI rebuild job is informational and the
manifest job is the gating one. Reproducing across machines needs a pinned
container — separate work, listed below.

## 27 · The signature is valid; that was never the question

The wasm provenance work answered "is this binary the published Rust?". Asking the
next question out loud made the gap obvious: **so what if it is?**

An owner reads "send 2 KAS to kaspatest:qr…" and signs a sighash. That sighash is a
hash of a transaction the builder assembled. If the builder assembled something
else — an ordinary bug, not necessarily malice — the signature over it is perfectly
valid, the covenant is satisfied, and the money lands somewhere the owner never
saw. Every `require` in `contracts/*.sil` is upstream of that moment. The contract's
question is "are there enough signatures?" and the honest answer is yes.

So the app now reads the transaction back. `frontend/src/txDecode.js` decodes borsh
by hand against the rusty-kaspa layout — `Transaction`, `TransactionInput`, the
`TxInputMass` enum, `ScriptPublicKey`'s hand-written impl, `Option<CovenantBinding>`
— and rebuilds addresses with its own cashaddr encoder. It never calls the wasm.
That is the whole value: asking the builder to describe its own output is not a
check, and two independent readings that must agree is the only thing that is.

Proving the decoder was right, rather than merely different, meant checking it
against the builder's OWN reading (`borsh_to_rpc_json`) across execute, approve and
propose — every outpoint, value, script, covenant binding, lock time and payload.
The address encoder was checked the same way: `pubkey_address` → `recipient_info` →
back through this file's encoder, character for character.

`txGuard.js` then compares that reading to what was asked. The rule that carries
the weight is about destinations, because that is what a defect costs: every output
is a continuation of THIS treasury's lineage, a payment to a declared address, or
change to the funding wallet. There is no fourth category. Three more rules say
what no covenant states out loud — approve/reject/propose/retire must not spend the
vault, a transfer that pays nobody is a failure rather than a no-op, and the
declared address is paid exactly once.

The placement took a second look. `submitAndTrack` retries on fee: when a node
demands more, `rebuild()` re-signs DIFFERENT bytes. A guard at the top of the
function would have inspected the first attempt and waved through every one after
it, which is the kind of correct-looking wiring that is worth nothing. It goes
inside the loop. Gating at submit rather than at signing is deliberate: a signature
that is never broadcast cannot move money, and gating at signature time would need
an independent reimplementation of Kaspa's sighash for a strictly smaller gain.

Then `scripts/test-js-guards.sh` — `test-security.sh`'s discipline pointed at the
code no node checks. Ten rules, each removed in turn, each required to fail a NAMED
test. Writing it produced two false results in a row, and both are now things the
harness refuses to report as findings. A mutation that breaks syntax fails every
test in the file, which reads like a superbly guarded rule and means nothing —
`node --check` rejects those. And counting lines that look like failures counts the
summary block too, which is how six different rules all appeared to be pinned by
"3 tests" before anyone looked at the names. Same shape as the STATE family's
pinning numbers being read off signature rot; apparently it needs re-learning per
layer.

It earned its place on the first honest run: the **pay-the-declared-address-twice**
rule had no test behind it at all. Reaching it meant splitting `inspectDecoded` out
of `inspectSpend`, because the real builder will not produce that shape — and a
rule only reachable through the builder is a rule the builder decides whether to
test.

One last thing is pinned in the test file rather than the harness: that every
`submitAndTrack` call site passes a guard, and that the call sits inside the retry
loop. A new entrypoint that forgot one would submit unchecked and nothing else
would notice.

What this still cannot do is help if the page itself is hostile — a malicious
bundle simply does not call it. That is what a reproducible frontend build is for,
and it has not been done.

## 28 · Pointing the mutation harness at everything else

With the spend guard's ten rules pinned, the obvious next move was to aim the same
harness at the rest of the code no node checks: the genesis auditor, the proposal
scanner, the transfer ceiling, the indexer's current-policy reporting. Twenty-two
rules in total, each chosen because it corresponds to a defect that has actually
happened or provably could.

Extending it found two bugs, both in the harness rather than the code, and both of
the same family as everything else this week: **a checking tool whose own failure
mode looks like a result.**

The first was `pipefail`. `grep` returns non-zero when it matches nothing — and
matching nothing is exactly the finding worth having. With `set -e`, the run died
silently at the first rule with no test behind it, printed a tidy partial list, and
exited 1. The harness died precisely when it found something.

The second was worse, because it produced confident false alarms rather than
silence. Fixing the first revealed three rules reporting "removed, and every test
still passed" — including the fix for the 0.2 KAS defamation vector, which was
alarming enough to check by hand before writing it down. It was wrong. The genesis
auditor's adversarial fixtures live in `packages/descriptor`'s vitest suite, and
the harness was only asking the indexer's `node --test` file. All three rules were
well guarded; the harness had asked the wrong suite. It now runs whichever runner a
row names, and a rule counts as pinned if either catches it.

That near-miss is worth recording on its own. A false alarm from a security tool
costs more than silence, because it gets believed and then acted on. The only
reason it did not end up in a report is that "the defamation fix is unguarded"
sounded implausible enough to verify — which is not a control, it is luck.

One structural detail: `packages/descriptor/src/genesis.js` and
`indexer/genesisAudit.mjs` are byte-identical by design and a tripwire test asserts
it. Mutating one alone trips the tripwire rather than the rule, so the harness
takes a comma-separated list of files and moves mirrored pairs together — otherwise
it reports a bite it never earned.

Final state: 22 rules, every one pinned by a named test, across `txGuard.js`,
`txDecode.js`, `genesis.js` (both mirrors), `proposalScan.js`, `proposalPolicy.js`
and the indexer's `server.mjs`.

## 29 · The arithmetic nobody was checking

The plan called this "dual-implementation reconciliation": have `tools/kaspa-probe`
build the same transaction as `tools/wasm-tx` and compare bytes. Reading
`kobridge.rs` killed that framing — it only implements `closeExpired`, as a test
harness for a borsh-only node. There is no second builder to reconcile against.

Which forced a better question: what does the guard actually still take on trust?
Destinations were covered. Amounts paid out were covered. **Fees and change were
not.** A builder that quietly overstates the fee sends money nowhere suspicious —
it just leaves less behind, and miners take the remainder whatever it is called.
No destination rule can see that, and nothing else in the repo was looking.

The fix does not need a second builder, because every caller already knows what it
spent: it is what it told the builder to spend. So the guard now checks that what
left the treasury, minus what came back, minus what was paid out, equals the fee
the app displayed. Validated against real built transactions before wiring: a 5 KAS
vault plus a 0.45 KAS bond, 1 KAS out, 4.44 KAS back, 0.01 KAS fee — balances; a
fee misstated by 0.009 KAS is reported with that number in it.

Two things nearly made this refuse honest work, which would have been worse than
the gap it closes.

**Who pays.** In owner-funded mode the wallet covers the fee and the treasury is
fully conserved. Passing the real fee as the treasury's share would have refused
every honest owner-funded operation. `treasuryFee` is zero there, and a test pins
the mistake so it cannot come back.

**Fee retries.** `rebuild()` re-signs with different numbers, so a static guard
would check new bytes against the old fee and refuse on the second attempt. The
rebuild hands back a refreshed guard. This is the same bug as putting the guard
outside the retry loop, in a different costume, and it is worth noting that the
first version had it — the loop placement was fixed deliberately, and then the
identical mistake was made one layer up without noticing.

Where the numbers are unavailable the check is skipped rather than guessed.
Inventing a number to have something to compare against is how a safety check
becomes a liability.

## 30 · The indexer was already untrusted; now it has to stay that way

The plan said "hard rule that the browser never trusts an indexer verdict it did
not re-derive", which assumed the browser currently does trust one. Checking first
was worth more than building: it does not. `stats.js` is reached from exactly one
place, the landing page's stat strip, and all it renders is three numbers and a
"cached, re-syncing" label. Nothing in the signing path can see it. The genesis
gate reads the chain through the public Kaspa REST indexer and re-derives every
conclusion cryptographically, so a lying source there can only cause a refusal, not
a false clean — and twenty tests already pin that.

So the honest deliverable was not a fix. Inventing one would have been worse than
saying so.

What was actually missing is that the property held by habit rather than by
construction. A future change that started consulting the indexer from the signing
path would be invisible in review — no test would fail, because no test was
looking. `frontend/test/trustBoundary.test.mjs` now walks the local import graph
from every module that can move money (`wasmTx`, `txGuard`, `txDecode`,
`genesisAudit`, `proposalScan`, `proposalPolicy`, `treasuryRebuild`, `signer`) and
asserts none of them can reach the indexer client, **transitively**. "Does wasmTx
import stats" is easy to keep true while a helper two levels down does the fetching.

A third test keeps the blast radius small: the landing page may render the
indexer's numbers, and may not let one gate a control or choose a destination. Both
are pinned by mutation — inject an import into `wasmTx.js`, or a `disabled=` bound
to a stat, and named tests fail.

This is the cheapest item in the whole backlog and one of the more useful, because
what it protects is not today's code. It is the version of this code written by
someone who does not know that for 0.2 KAS an attacker once made this indexer call
an honest treasury a forgery.

## 31 · The last link, and the only one with no cryptography in it

Everything verified so far protects the code in this repository. The covenants are
enforced by every Kaspa node; the wasm builder is tied to its Rust; the spend guard
re-reads a transaction before it goes out. None of it helps if the page a person
loaded is not this code. A CDN is the last link in the chain and the only one with
nothing cryptographic holding it in place.

First the experiment, because it decides what is even possible: build twice,
compare. Byte-identical. That was not guaranteed — rollup names chunks by content
hash, so one stray timestamp does not change a file, it renames half of them, and
every future verification would report a tamper that never happened.

So the deliverable is `scripts/frontend-manifest.mjs`: hash every emitted file,
then hash the sorted `<path> <sha256>` lines into one tree digest. A deployment
becomes a single 64-hex string, short enough for a release note and specific enough
that one changed byte anywhere produces a different one.

Then the part that is actually worth something to a person:
`scripts/verify-deployed.mjs <url>` fetches every file a live site serves and
compares it to a local build. Tested end to end against a local static server —
honest deployment matches; append one line to the bundled JS and it is caught, with
the observation that makes it damning: *its filename is a content hash, so these
bytes were never built from this source.* That is not a stale cache. That is
something else being served under a name that commits to different content.

The interesting failure was in the digest's own test. The rule "file order is
sorted, not filesystem order" would not die under mutation: remove the sort and
every test still passed, because macOS readdir happens to return sorted names. That
is precisely how a missing sort survives on a laptop and then computes a different
digest in CI — after which every deployment check cries wolf, and a tool that cries
wolf gets switched off. Testing `distFiles` against a directory could never catch
it, so the ordering was extracted into `canonicalOrder` and tested against a
deliberately unsorted list, where the filesystem cannot hide it.

The honest limit is worth stating plainly, and the script says it out loud: a
manifest served by the same host as the bundle proves nothing. It is worth
something only when the digest is also recorded somewhere that host does not
control. This produces the number; publishing it is a human step.

## 32 · "Reproducible" was quietly doing a lot of work

`npm run verify:wasm` proved the committed blob was what the Rust builds. What
went unsaid is *on this machine*. `secp256k1-sys` compiles C with the host clang
and some survives into the wasm, so the check was byte-reproducible by exactly one
account on one laptop. That is a coincidence with good paperwork, and it is useless
to anyone auditing an open-source wallet — which is the entire reason the check
exists.

`Dockerfile.repro` pins the lot: base image by digest rather than tag (a tag is a
moving pointer), apt by `snapshot.debian.org` at a fixed date (Debian's rolling
archive would hand out a different clang in a month, and a different clang is a
different binary from identical source), rustc by the image, wasm-bindgen read out
of the lockfile so the version is not written twice, and paths remapped to the same
`/cargo` and `/src` the host script uses — otherwise the two would disagree about
the strings inside the binary for no reason at all.

The first run died at exit 127 inside a cc-rs build script. Debian's `clang`
package does not ship `llvm-ar`; that is in `llvm`. The symptom looks like anything
except a missing package, so the image now asserts `test -x /usr/bin/llvm-ar` in
the layer that installs it.

Then the result that mattered: the container produced **different bytes**, three of
four files. Expected — Homebrew clang 22.1.8 versus Debian clang 14.0.6 — but now
with numbers attached rather than a caveat in a document.

Which forced a decision. The container build became canonical, because it is the
one a second person can reproduce; the committed artefacts were regenerated from it
and the full suite re-run to confirm the behaviour is identical. Adopting rather
than reconciling was the honest move: the alternative is keeping an artefact only
its author can verify and describing it as reproducible.

That immediately created a footgun worth more attention than the feature.
`npm run build:wasm` used to write a HOST build. One person running it on a laptop
would silently replace the canonical artefact with one nobody else can reproduce —
the exact failure this work exists to prevent, reachable by a convenient command.
`build:wasm` now runs the container, and the host script refuses `--write` unless
told `--not-reproducible` in as many words.

Two smaller things, both about messages nobody would act on: `die()` was defined
below its first use, and it joined multi-line guidance into one paragraph with the
command to run buried mid-sentence. A message nobody acts on is not a message.

## 33 · The guard refused honest work, twice, in front of the user

The conservation rule shipped as an equality: what leaves the treasury, minus what
comes back, minus what is paid out, must EQUAL the stated fee. Within hours it
refused a real signer-change proposal, and then a real transfer proposal, with
"0.5 KAS less than accounted for".

The cause is one line of the log everybody had read and nobody had followed
through: *you're funding this proposal from your wallet (KoRoot untouched)*.
"Untouched" means its VALUE is returned whole — the root is still an input. And the
0.5 KAS bond is minted out of the proposer's WALLET, into a covenant-bound output.
So the treasury ends an owner-funded proposal **0.5 KAS ahead**, and a rule that
counted every covenant output as "came back" without counting what came in from
outside read that gain as a shortfall.

The equality was over-specified. It asserted two things: that the treasury did not
lose more than stated — which is the safety property — and that it did not GAIN,
which is not a safety property at all and is what broke. As a ceiling it catches
theft identically, since theft is precisely losing more than stated.

The part worth sitting with is that this was tested. `docs/SPEND-GUARD.md` and the
commit that introduced it both say, in as many words, that refusing honest work is
worse than the gap it closes — and a test was written specifically for the
owner-funded case. It used `approve`, where the treasury's value passes straight
through and cannot grow. **The dangerous shape was tested on the one path where it
cannot occur.** `propose` is where a treasury gains, and it had no test until a
user hit it.

The regression test now covers an owner-funded transfer proposal, and asserts
separately that the covenant outputs really do exceed what the treasury put in —
otherwise it could pass for the wrong reason, which is the failure mode this whole
week has been about.

## 34 · Round 5 — the verdict said clean, the prose said nothing ties it to the money (2026-08-20)

Five reviewers, told to overturn the previous rounds rather than confirm them, and
every finding sent to an adversarial verifier that defaults to REFUTED. The
covenants came back clean, and so did the borsh decoder — the first round in which
`contracts/*.sil` produced nothing at all. Everything found this round was in the
browser, above the contracts, where no node checks anything.

### A clean verdict for a genesis nothing tied to the address

`auditGenesis` builds its case in layers. Layer 6 recomputes the covenant id from
the funding outpoint and output 0; layer 7 derives the vault address from that id
and requires it to be the address being opened. Layer 7 is the only one that ties
the transaction to the money — the other layers establish that a genesis is
well-formed and honestly shaped, which any *other* treasury's genesis also is.

Both layers need one field: `previous_outpoint_hash` on the genesis's input 0,
supplied by the same REST source the audit is auditing. Absent, both skip — and
the verdict was still `clean`, with a reason string that said, in as many words,
*"nothing yet ties this transaction to the money."* The prose was honest. The
machine-readable verdict, the one `TreasuryView` keys the deposit address off, was
not.

So: serve a victim opening vault V a genesis that is entirely real — an attacker's
own 1-of-1 treasury, correct inscription, correct KoRoot, covenant fields present
— with input 0 stripped. Reported in full that genesis is REFUSED,
`vault-not-from-this-genesis`. Withheld, it is clean, and V's deposit address is
displayed. One withheld field, refusal to pass.

The same field disables the independent second opinion the module advertises:
`liveTreasuryId` filters the node's UTXO ids by the lineage the genesis derives,
which is now null, so the node corroborates nothing. The module header promises "a
hostile or buggy REST indexer cannot supply both the evidence and the answer" —
and one field it controls turned off all three checks that could have contradicted
it.

It costs nothing to demand, which is what makes the fix safe rather than a trade:
**finding the genesis at all already required that field**, on the mint
transaction, from the same endpoint and the same response shape. A source that
supplies it once supplies it twice. Supplying it for the mint and withholding it
for the genesis is an asymmetry no honest indexer produces. The verdict is now
`unverified` / `vault-binding-unestablished`, which the app already renders as a
dead end with an explicit override — and the override reaches a treasury whose
deposit address stays withheld. The loading screen had been promising exactly that
all along: *"Until both are established the treasury stays closed and no deposit
address is shown."* Only the first half was enforced.

The deposit address now turns on the binding rather than on the verdict, which is
belt-and-braces on purpose. The two agree today; the money control names the
property it needs instead of trusting a summary word to keep meaning it.

### A lineage tag is not an address

`inspectDecoded` accepted any covenant output whose id matched the treasury's
lineage. A covenant id is a TAG the builder writes into the output beside the
script — not a property of the script. Repoint the vault continuation's 32-byte
P2SH hash at an attacker and leave the binding alone, and the guard saw a
continuation of this lineage; worse, its value counted as "came back" in the
conservation sum, so the arithmetic balanced too. 4.44 KAS to a stranger, no
complaint.

Consensus rejects that transaction — `KoVault.executeProposal` requires the change
output's scriptPubKey to be the vault's own — and the verifier refuted the finding
as a money bug for exactly that reason. It is fixed anyway. This module's entire
premise is that being right because the node catches it is not the same as being
right; asking the builder to describe its own output is the one thing it exists
not to do, and authenticating by tag is asking.

Only the vault is checked, and only in `execute`. Its script is known exactly and
never moves — it is the address the owner has been reading all along. The root's
and the proposal's DO move on every operation (nonce, bitmap and status live in
the redeem script, so the P2SH follows), and pre-computing those means
re-implementing the covenants' state transitions in JavaScript: a second
implementation to keep in step, which is a larger liability than the gap. The
vault is also where the money is — the root holds a small reserve, the proposal a
0.5 KAS bond.

### The address every deposit goes to, taken on the builder's word

The completeness critic asked which transaction families the guard never sees, and
following that into the creation path turned up the same class a third time.

Both callers publish the treasury's deposit address as `p2sh(bs.vaultRedeemHex)` —
and that hex is the **builder's account of what it just minted**, not a reading of
the transaction. The covenant does pin what reaches the chain:
`KoRoot.bootstrapVault` mints the vault under a template pinned by hash, carrying
the root's own id as its state, so a wrong vault cannot be minted. It cannot pin a
return value. A builder that puts the correct vault on chain and hands back a
different redeem script tells a lie no node is in a position to see, and the result
is a perfectly correct treasury with somebody else's address printed under it —
before any provenance gate exists to run.

The fix is the property the whole design already rests on: a vault address is a
pure function of its lineage. `rebuildVault(lineage)` is the same derivation
`seedFromChain` uses to recognise a vault UTXO, so `submitBootstrap` now derives
the redeem script and refuses to publish if the builder's differs — before
submitting, so a mismatch costs nothing.

Three findings, one shape: the covenant id tag, the genesis verdict word, and now
the builder's returned redeem script. Each was a value the app could have derived
and instead accepted.

### What was refuted, and what that is worth

Three paths reach a node without the guard: `submitSweepBatch`, `submitBootstrap`
and the genesis submit. The finding argued a builder regression could siphon
stray deposits to the sweeper's wallet. It could not: `KoVault.deposit` sums
`vaultInSum` over every input whose scriptPubKey is the vault's — matched by
script, not by covenant id, so strays are included — and requires
`outputs[0].value >= vaultInSum`. The node rejects it. Bootstrap and genesis
create a treasury; there is no treasury value yet for a guard to protect.

Recorded because a refutation is a result. The reviewer's premise was checkable and
wrong, and the verifier checked it rather than deferring to the severity label.

### A refusal that outlives its evidence

The third confirmed finding, kept rather than fixed. A `refused` verdict is cached
permanently and returned before any network call — a genesis is immutable, so a
refusal is a permanent fact. It is, of the transaction that was *read*. A source
that served a corrupted one gets that refusal frozen too, and the treasury is shut
in that browser until site storage is cleared.

Worth being precise about what triggers it, because the reviewer's first framing
was broader than the truth: a fetch that throws, a 500, and an empty history all
yield `unverified`, which is never cached. Ordinary flakiness fails safe. It takes
a structurally valid response with wrong content.

The obvious fix — a "re-check" button — reintroduces exactly what the permanence
was built to stop: a refusal re-rolled until it passes. Failing closed is right
here. What was actually wrong is that the screen gave an owner no way to tell a
permanent finding from a bad afternoon, so it now says when a verdict was answered
from storage and how to make it run again.

### Same test-vacuity pattern, third time

The tests that covered the withheld-outpoint case asserted `verdict === "clean"`
— on the HONEST genesis of that very vault, where a clean verdict is harmless. The
danger was asserted only on the path where it cannot arise. That is now three
rounds running: the owner-funded bond tested through `approve`, `close-expired`
tested with another operation's transaction relabelled, and this. The rewritten
tests substitute an *unrelated* genesis, which is the same input to the same
function and the case that actually matters.

## 35 · Round 6 — the amounts nobody was holding in enough bits (2026-08-21)

Round 6 aimed at the surfaces round 5's own completeness critic named as never
examined: the creation transactions, the sweep math, integer precision, the
proposal scanner's trust in REST, the KasWare path, and the guard's deliberately
degraded modes. KasWare and the degraded-guard modes came back clean; the proposal
scanner's dangerous half (is a proposal still live and re-signable) is anchored to
the node's own UTXO set, not to REST, so a hostile indexer can mislabel history
but cannot resurrect a spent proposal. The real finding was arithmetic.

(The review workflow hit the session's usage limit partway — two finder agents,
creation-bootstrap and proposal-scan, never ran, and several verifiers were cut
off. What follows is what actually got verified, by the workflow or by hand; the
unreached surfaces are logged as open below rather than claimed clear.)

### A JS Number does not hold a large sompi value

Every amount off the node is read into a JS Number, exact only to 2^53 - 1 sompi
(~90,071,992 KAS). Above that a value rounds. Two places then act on the rounded
figure:

The spend guard computes `treasuryIn = ctx.vault.value + p.proposalValue` as a
Number SUM, wraps it in `BigInt()`, and compares against outputs decoded from the
bytes as exact BigInt. Reproduced against the real `inspectDecoded`: an honest,
exactly-conserving execute over a ~90M KAS vault produces two refusals — the
conservation rule and the round-5 vault-home rule each off by the rounding — so
`assertSpend` throws "the builder and screen disagree, report a bug" and the payout
is frozen. The other direction is worse in kind if not in size: above 2^53 a real
1-sompi over-loss rounds away and the conservation check passes with zero problems.
The guard was authenticating against a number the app had already corrupted.

The wasm builder is fed the same rounded Number as `vaultAmount`, and its JSON
interface takes amounts as numbers, not strings, so it cannot even receive an exact
value above 2^53. A treasury that consolidated more than ~90M KAS into one vault
UTXO — the normal end state of sweeping — could not sign a correct spend at all.

So the honest bound of this whole stack is 2^53 sompi, and the fix is to say so at
the door rather than round past it. `safeSompi` (in sweepPlan.js, the one module
with no imports) refuses any amount that is not a safe integer, and it is wired
into every source conversion on the money path: the vault balance, each deposit,
the chained-batch sum. The guard refuses outright when `treasuryIn`/`treasuryFee`
is not a safe integer. The detection survives the rounding it guards against: any
true value at or above 2^53 lands on a Number that is itself not a safe integer, so
a value cannot slip through by having already been rounded on the way in. A
treasury above the limit is now refused clearly ("split it into UTXOs under ~90M
KAS") instead of silently mis-signed or mis-checked. The verifier downgraded the
finding from HIGH to MEDIUM — no fund loss, an extreme balance gate — which is
right; the reason to fix it anyway is that a silent conservation bypass and a
"report a bug" freeze on an honest payout are both exactly what this guard exists
to prevent.

### The sweep re-picked a UTXO it had just spent

Every wallet-funded flow reads its UTXOs through `freshUtxos` and calls
`markSpentOutpoints` after submit, so a second op in the same session does not
re-pick an input the first already spent (the node's utxoindex still lists it until
the op confirms). The sweep was the sole exception — a raw filter, no marking — so
a proposal or approve immediately followed by a sweep deterministically re-picked
the just-spent wallet UTXO and the node rejected the sweep as a double-spend, with
five futile retries and no recovery. Confirmed against the code by hand. The fix
routes the sweep's fee read through `freshUtxos` and marks each batch's inputs
spent, exactly like every sibling flow.

Also fixed alongside it: a sweep with nothing to consolidate (no strays, a single
vault UTXO) built and submitted a transaction that re-minted the vault to itself
for a wallet fee — a charge for no effect, behind a button that read "Sweep 0
KAS". It now returns before touching the wallet. Compaction still runs when there
is a second vault UTXO to merge.

### The genesis check that fired after the point of no return

A LOW, and honest: the genesis submit had no money bug on the honest path (every
downstream value is independently derived and output 0 is cryptographically pinned
by the covenant-id check). But its one check — that the built genesis mints the
lineage the inscription names — ran AFTER the irreversible submit and BEFORE
`savePending`, so if it ever fired it would strand the on-chain root with no
recovery record. Moved before the submit, and inside the retry loop so every
re-signed rebuild is checked too. A divergent build is now refused instead of
broadcast.

### What round 6 did not reach

creation-bootstrap (resumeBootstrap against a drifted/spent root, and the
never-measured BOOTSTRAP_ROOT_BUDGET) and proposal-scan's history LABELS were not
fully reviewed — the finder agents for both were cut off by the usage limit. A
byte-level output guard for the genesis transaction (the defense-in-depth analog
of the ops-path assertSpend) was scoped but not built: getting the expected output
shape wrong would refuse honest creation, the one failure this project fears most,
so it is left for a pass that can validate it on-chain. All three remain open below.

## 36 · Round 6 follow-up — the two surfaces the usage limit had cut off (2026-08-21)

Round 6's workflow hit the session usage limit before two finders ran. This round
ran exactly those two, each finding adversarially verified.

**creation-bootstrap:** one INFO, no defect. `bootstrapVault`'s value floor permits
a dust root continuation with the reserve shifted into the vault — but the vault IS
the treasury, so that moves the treasury's own money from the root to the vault, not
out of it, and it needs an owner signature. No fund path, no fix.

**proposal-scan history labels:** four findings, all confirmed and all in the same
place — a CLOSED proposal's displayed outcome (paid-out vs retired), amount and
recipient are reconstructed from the REST indexer's bytes and never cross-checked
against the node. Whether a proposal is still open and re-signable is node-anchored
and safe (that was out of scope by design); these are the HISTORY labels only. A
hostile indexer could show a real payout as a retirement (an owner might re-pay a
vendor), or show a wrong recipient/amount that an owner reconciles their books
against. The verifiers put these at LOW/INFO: display-only, no signing over bad data,
and it needs full control of the REST source — the documented "indexer is untrusted"
property, now reaching the history view.

The app cannot make that display trustworthy without consulting the node, but it can
stop presenting it as if it were. Chain-reconstructed (`discovered`) proposals in a
terminal state now carry a note: the outcome, amount and recipient are read from the
chain indexer and not confirmed by your node — open the closing/executed tx to verify
what moved. Locally-tracked proposals (this app's own submissions) are trustworthy
and carry no note. Same move as round 5's "answered from storage" label: surface the
provenance instead of pretending. Pinned by a trust-boundary test and a mutation rule
(38 JS rules now).

The other two proposal-scan findings fold into the same note: a 24-hop walk cap that a
hostile indexer could use to hide a proposal from a fresh seed (LOW), and a malformed
signature_script that throws inside the scan but is already caught by both call sites
(INFO). Both are the same "indexer is untrusted" property; the note tells the owner not
to treat the reconstructed list as authoritative.

## 37 · "Not covenant-controlled until swept" — the scary half-truth (2026-08-21)

A user pointed at a deposit sitting unswept at their vault address and asked the
plainest possible question: can someone take the 12 KAS before I sweep it? The
Assets panel had been telling them "Sent straight to the vault address — **not
covenant-controlled until swept in**." That sentence is wrong in the direction
that costs people money: it reads as *unprotected until you act*, which is exactly
the feeling that makes someone rush a transaction they didn't need to make.

The truth is the opposite. A payment to the vault address lands at a P2SH whose
redeem script IS `KoVault`, so it can only be spent by running that script, and a
plain deposit's covenant id is ZERO. `executeProposal` refuses a ZERO-id active
input (`require(cid != 0)`), so the only entrypoint an unbound stray can satisfy
is `deposit`, which forces `output0.scriptPubKey == vaultSpk` and
`output0.value >= sum(vault-address inputs)`. The sole spend the covenant permits
for a stray is a sweep back into this same vault. "Unbound" means *not yet part of
the covenant balance* — not *unprotected*.

Rather than argue that in prose, we proved it on-chain from the attacker's own
position. `tools/kaspa-probe/src/bin/steal_stray.rs` takes only the public vault
address, reads the lineage off the chain, rebuilds the public redeem script from
`treasuryTemplates.js`, **asserts it hashes back to the real vault address** (so
this is genuinely the script an attacker would reveal), and spends via the
signature-free `deposit` path in three shapes, each isolated to a single covenant
rule:

- **A** — output 0 keeps the real lineage binding but pays the attacker → must fail
  `outputs[0].scriptPubKey == vaultSpk`.
- **B** — output 0 returns to the vault but short by the stray, output 1 pays the
  attacker the stray → must fail `outputs[0].value >= vaultInSum`.
- **C** — spend the lone unbound stray straight to the attacker, no covenant input →
  must fail `boundVaultIns >= 1`.

Run against TN10 (vault `kaspatest:ppuvun4dy…jw9f49v`, lineage `f1e315bf…438c`,
141.8 KAS bound + 12 KAS unbound), **all three were rejected** with `script ran,
but verification failed` — the covenant executed and its `require`s refused, not a
technicality bounce. Not a sompi moved. It is a manual E2E (needs a live funded
vault), not wired into `npm test`.

The copy on the Assets panel now says what the covenant actually permits, and the
two source comments that carried the same "not covenant-controlled until swept"
phrasing were corrected. A `trustBoundary` test (`an unswept deposit is described
as protected, not as unprotected`) pins the note against regression, and a
mutation rule reintroduces the old scary phrasing and requires that test to fail
(39 JS rules now). Understating protection is treated as a defect the same way
overstating it is.

## 38 · Round 7 — the guard was right, but three flows never called it (2026-08-21)

Six rounds hardened the spend guard's RULES. Round 7 asked a question none of them
had: which flows actually RUN it? The answer was a hole. `assertSpend` — the
independent second reading that re-decodes the built bytes and refuses to broadcast
anything that doesn't do what the app said — was wired into exactly one place,
`submitAndTrack`, which every covenant op routes through. Three wallet-signing flows
do not route through it: the **sweep**, the **genesis** mint, and the **bootstrap**
mint. All three sign the operator's own wallet inputs with SIGHASH_ALL (a signature
over every output) and broadcast with no re-read.

The covenant floor keeps the treasury itself safe — a sweep's output 0 must return to
the vault, genesis/bootstrap continuations are consensus-pinned — but none of that
protects the operator's own **change** output, which is ordinary P2PK funds under no
covenant rule. A wrong or hostile wasm builder (the shipped `kosign_wasm_tx` blob —
threat-model item 2) could keep output 0 valid and route the change to an attacker;
the owner's SIGHASH_ALL signature authorises it and nothing reads it back. Because
coin selection is largest-first, a tiny sweep fee pulls in a single large wallet UTXO,
so the diverted change can be nearly the whole wallet — the app repeatedly tells users
to consolidate into one UTXO, which makes this worse, not better. An identical
tampering on `execute`/`approve` is caught by the guard's destination rule; the sweep,
genesis and bootstrap were simply never asked.

The fix routes all three through `assertSpend` before every broadcast, re-run on each
fee-retry rebuild (each retry re-signs different bytes). No new guard logic was needed:
`kind:"sweep"|"genesis"|"bootstrap"` are neither `MAY_PAY_OUT` nor
`MUST_NOT_TOUCH_VAULT`, so the existing destination rule already demands every
non-covenant output be change home to the operator's own wallet and every covenant
output continue this lineage. The sweep also passes `vaultSpk`+`treasuryIn` so the
vault-home and conservation rules apply. Tests build a REAL sweep/genesis/bootstrap
tx with the wasm builder, confirm the honest build passes (no false positive — the
thing that broke honest owner-funded proposals in round 5), and confirm a diverted
change or reparented vault output is refused. A source-wiring test plus three mutation
rules pin that each flow actually calls the guard.

A second round-7 finding, from re-attacking `txDecode.js` (the decoder the guard reads
with): the address layer ignored the output's `scriptPublicKey.version`. Every standard
Kaspa output is script version 0; a version > 0 output does not run its script at spend
time (it is anyone-can-spend) and so pays nobody — yet `addressFromSpk` reads only the
script SHAPE and rendered such an output as an ordinary address, which the destination
rule then accepted as the declared recipient. A builder could show the owner "pays
Alice 100 KAS" while the real output is anyone-can-spend, and the recipient never gets
paid. The guard now refuses any non-zero script version outright. The cashaddr encoder
and borsh decoder themselves were re-verified against rusty-kaspa (two official address
test vectors reproduce exactly; borsh field order/widths and the strict Option/enum
tags leave no malleability window) — the version blindness was the one real gap.

Frontend 136 tests, 43 JS mutation rules. The exploitable class round 7 set out to find
(a bad builder moving money the owner never saw) is the guard-coverage family; it is now
closed on the client. Contract-level findings from the same round are tracked separately
below.

## 39 · Round 7 — the recipient on screen was not the one being signed (2026-08-21)

R6.1 labelled a CLOSED proposal's reconstructed history as not-node-confirmed and
called the live/signable state safe because it is anchored to the node's UTXO set.
Round 7 found the hole in that reassurance: for an OPEN, still-approvable transfer,
almost everything IS node-anchored — amount, operation, approvals and the committed
`recipientSpkHash` all live in the proposal redeem, and the scanner only accepts a
state whose reconstructed address holds the live UTXO. The one field that is NOT in
the redeem is the human-readable recipient. `recipientSpkHash` is a one-way hash, so
the address cannot be recovered from it for display; the address shown comes instead
from the create-tx payload — a free-form inscription the untrusted REST indexer serves
and a malicious proposer chooses.

`enrichDiscovered` already recomputed `recipient_info(address).spkHash` and compared it
to the commitment — but on a mismatch it merely withheld the verified `recipientSpkHex`
and left the misleading address on screen with no flag. So a malicious owner could
commit `H(attacker)` while the payload said `V`; honest co-owners would open the
treasury, see their own node confirm a real pending proposal "to V", approve it, and
the attacker would then execute to the committed `H(attacker)` — which their approval
had authorised all along. A single insider (or a hostile indexer swapping the payload)
defeats the exact thing multisig relies on: honest review of the destination.

The fix binds what the approver sees to what they cryptographically authorise.
`enrichDiscovered` now sets `recipientMismatch` when the shown address does not hash to
the commitment (or cannot be parsed), leaving `recipientSpkHex` unset. `TreasuryView`
derives `recipientUnverified` from that and, for an open transfer, shows a
do-not-approve warning and disables every approve control until the recipient verifies
against the on-chain commitment. Locally-created proposals are unaffected: they set
`recipientSpkHex` from the same address they committed, so they verify by construction.

Pinned in `trustBoundary.test.mjs` (the untrusted-boundary suite) with a source test on
both the flag-on-mismatch logic and the two-path approve gate, plus two mutation rules.

**And the test that was supposed to catch this class was itself misleading.** The same
file asserted "nothing that decides whether money is safe to move may read from the
indexer" and checked it against `stats.js` — the landing stat strip. But the REST
indexer client is `kaspaRest.js`, and `genesisAudit` and `wasmTx` both import it; the
money path demonstrably reads the indexer. The invariant was false and the test passed
anyway, giving false regression assurance. Corrected to say what is actually true: the
stat client must stay off the money path (a real avoidance invariant, still checked),
while the REST indexer IS on it and is kept safe by RE-ANCHORING — every value from it
is either recomputed cryptographically (the covenant id) or pinned to a node UTXO
(open proposals) before it decides anything, and the two spots that are not
(closed-history labels, the open-transfer recipient) are the ones labelled/gated above.
A new test documents that `kaspaRest.js` is expected on the money path so the false
avoidance claim cannot creep back by conflating the two clients.

Frontend 139 tests, 45 JS mutation rules. Contract-layer round-7 findings are next.

## 40 · Round 7 — the covenants, after two rounds that found nothing in them (2026-08-21)

Rounds 5 and 6 found nothing in the `.sil` contracts, so round 7 re-attacked them
specifically, told to overturn that. It found three, two worth fixing on-chain.

**F4 (MEDIUM) — owner rotation did not invalidate stale approved configs.**
`KoRoot.executeConfig` installed the owner set carried by ANY approved (status 1)
operation-2 proposal of this lineage. It checked the lineage, the status, the operation,
the committed config hash, and the bounds/distinctness of the NEW set — but nothing tied
the proposal to the CURRENT root state, and the nonce is preserved (so it is not a
version). `KoProposal.execute` authenticates the trigger against the proposal's own
SNAPSHOT owners and needs only one signature. So a CONFIG approved during the {A,B,C}
era, then abandoned, could be executed at any later time — after a rotation to {D,E,F}
done precisely to recover from a key compromise — by a single holder of a snapshot-era
key, to overwrite the current set and reinstate {A,B,C}. Rotation, the one
compromise-recovery action a multisig has, did not actually revoke anyone.

The fix is a generation gate. `createProposal` already snapshots the owner set in force
at creation (`snapThreshold`/`ownerCount`/`owner0..4`); `executeConfig` now requires that
snapshot to equal the config installed NOW, so every executed rotation makes every prior
approved-but-unexecuted config unusable. Seven equality guards, one per snapshot field —
a new GENERATION family in `test-security.sh`, pinned by two negative fixtures (a
snapshot whose threshold differs, and one whose owner differs — the removed-owner
reinstatement) that both flip when the gate is stripped. (The TRANSFER variant of the
same snapshot-persistence — a pre-rotation approved transfer fired post-rotation — is
noted for a future pass: the vault cannot read the root, so it needs a different
mechanism. The rotation-replay that reinstalls a whole owner set is the sharp edge and
is closed.)

**F5 (LOW) — a self-send could alias the recipient onto the change output.**
`KoVault.executeProposal` took `recipientOutputIndex` and `vaultChangeOutputIndex` as
call args and never required them distinct. Binding `recipientSpk` by hash was not enough:
a proposal may commit the vault's OWN scriptPubKey as recipient (a net-zero self-send),
and then one output at an aliased index satisfies both the recipient check and the change
floor at once, so up to `amount + maxFee` leaks while co-signers believed they approved a
net-zero move. One line — `require(recipientOutputIndex != vaultChangeOutputIndex)` — a
new ALIAS family, pinned by a self-send fixture whose recipient is the compiled vault's
own P2SH (computed by the generator, so it tracks a mutant and the isolation holds).

**F6 (INFO) — `execute` does not self-enforce its operation's effect.** An owner can
consume an approved TRANSFER proposal by pairing it with `KoVault.deposit` instead of
`executeProposal`: the proposal is burned, nobody is paid, every sompi returns to the
vault. Not keyless, nothing misdirected, recoverable by recreating the proposal — so it
is documented as an accepted owner-griefing limitation (RISKS §15) rather than paying
bytes on every execute to self-enforce the payout.

Changing two `.sil` files changed their compiled bytecode, so `treasuryTemplates.js` was
regenerated across all three copies (frontend / descriptor / indexer), the contract test
fixtures were regenerated from the mutated contracts, and the whole suite re-run: KoRoot
76, KoVault 33, KoProposal 68 — all pass, honest paths included. The wasm builder needed
no change (it splices state into the redeem scripts it is handed, so a new template flows
through). Pre-launch, so the address change every treasury sees is a non-issue.

## 41 · Round 7 completeness critic — the gaps between the modules (2026-08-21)

The round-7 critic looked past the modules to the seams, and found three worth acting on
(none exploitable — the critic agreed):

- **G1 (defence-in-depth):** the conservation ceiling's `treasuryFee` reaches the guard
  from the builder's own output (`treasurySpend` sources it from `r.fee`) — the "builder
  vouching for itself" seam. It is backstopped by the destination rule, which reads the
  bytes and owes the builder nothing, but that backstop was never tested against an
  *inflated* fee. Added a test: an execute paying the wrong address with `treasuryFee`
  set absurdly high is still refused by the destination rule. No code change — naming the
  load-bearing assumption so it cannot rot.

- **G5 (robustness):** `configProposeClientSide` did not validate `1 ≤ threshold ≤
  signers ≤ 5` or owner distinctness, though `createTreasuryClientSide` does and
  `KoRoot.executeConfig` enforces them on-chain. So an invalid config built and could be
  approved, only to be refused at execute time — stranding the 0.5 KAS bond until expiry.
  Now the two entry points agree; pinned by a source test + mutation rule (46 JS rules).

- **G4 (open):** backend mode (`getCtx → /wasmctx`, `submitAndTrack → /relay`) is the
  fallback when no node endpoint is set. In it the guard's own reference values (lineage,
  vaultSpk, treasuryIn) come from the backend, so a hostile `/wasmctx` makes the guard
  self-consistent with its own lie — consensus still backstops outright theft, but the
  seam is real. The creation flows `ensureRpcUrl` (and throw without one) and the default
  resolves an official node, so node-direct is the shipped path; whether a build can still
  *reach* backend mode, and whether to delete `/wasmctx` + `/relay` outright or document
  the hostile-ctx tradeoff, is left as its own pass (below).

## 42 · A treasury you just made should not greet you with a warning (2026-08-24)

Create a treasury, watch both transactions land, watch the terminal say the vault is
minted — and then get a yellow panel headed "Could not verify the genesis". That is what
the app did, and it is worth being precise about why it was wrong, because the fix is not
"show less".

The genesis audit reads the genesis transaction from the chain INDEXER, which trails the
node by minutes. A treasury created seconds ago is genuinely absent from it, so the audit
returns `no-genesis` / unverified, and the gate rendered its one unverified state: the
warning. But "the check has not run yet" and "the check could not run" are different
facts, and only the second deserves an alarm. Showing the first as an alarm is not merely
noisy — it is the thing that trains people to click past the alarm that matters, which is
the same panel, on a treasury someone else built.

The app already had everything needed to tell them apart and was making the user do it
instead: the override button's own copy said "do it only for a treasury you created
yourself". `saveBootstrapped` now records `mintedAt`, and the gate distinguishes a
treasury this browser minted inside a 15-minute window from everything else, showing a
calm "waiting for the chain indexer" state — same geometry, the app's teal instead of the
warning amber.

**What was deliberately not done: the audit is not skipped.** Trusting a treasury because
this browser says it built it is precisely the pattern rounds 5 and 7 kept punishing
(KS-10, KS-12: authenticate by identity, not by what the builder claims about itself). The
audit still runs, still retries, and the deposit address stays hidden until it passes
cryptographically — only the wording of the wait changed. A test pins that narrowness on
four axes (the calm path takes only the indexer-lag code, needs a local mint record inside
a bounded window, and touches neither `gateOk` nor the deposit-address gate), plus a
mutation rule that widens the condition and requires that test to fail (47 JS rules).

## 43 · The published repo, actually run for the first time (2026-08-24)

`scripts/make-opensource.sh` has existed for days and the staging area it writes
was 25 commits stale — missing `txGuard.js`, `txDecode.js` and every test from
rounds 5 through 7, i.e. missing most of what makes this repo worth reading. That
part is just a stale build output. The part worth writing down is what happened
when the regenerated copy was, for the first time, installed and tested as a
stranger would install and test it.

It failed three times before reaching a single test:

1. **`pnpm install --frozen-lockfile`.** The generator strips `backend` from
   `pnpm-workspace.yaml` and left `backend: {}` in `pnpm-lock.yaml`. pnpm compares
   importers against the workspace and refuses the install outright. First push,
   red build, before any code runs.
2. **CI.** Three steps name `indexer/`, which deliberately does not ship:
   `npm ci --prefix indexer`, the indexer suite, and a `git diff --exit-code` over
   a template mirror path.
3. **`npm test`.** `scripts/test-js-guards.sh` opens with a CONTROL stage that runs
   every rule's test file unmutated and exits on the first failure — deliberately,
   because a mutation harness whose control is red reports noise. One rule points at
   `indexer/test/policy.test.mjs`. In the published repo that file does not exist, so
   the harness exits 1 having tested nothing.

Each of these is the same shape: a check that treats *absent* as *broken*. That is
the correct default — this repo has spent seven rounds establishing that a silent
skip is worse than a failure — but "absent because this repo was built without it"
is a different fact from "absent because someone deleted it", and nothing
distinguished them.

**The interesting one.** The obvious fix for (3) is to drop rules whose files are
missing. Ten of the eleven affected rules have a two-file module list —
`packages/descriptor/src/genesis.js,indexer/genesisAudit.mjs` — because the two are
byte-identical by design and mutating one alone trips the tripwire test asserting
that, so the harness would report a bite it never earned. Dropping them would have
been defensible and would have been wrong: those ten rules pin the *genesis
auditor*, the strongest client-side check in the codebase, and the published repo is
the one repo where strangers send patches. It would have shipped unpinned exactly
where pinning matters most.

The reason for the pairing dissolves in the published repo: the byte-identity
tripwire lives in `indexer/test/genesisAudit.test.mjs`, which does not ship either.
No tripwire, no reason not to mutate the surviving copy alone. So the harness now
*narrows* a rule to the files the checkout has and skips only when nothing is left —
46 of 47 rules run in the published repo, the 10 narrowed ones say so on stdout, and
the 1 genuinely indexer-only rule is named rather than dropped in silence.

**Two smaller things the run surfaced.** The generator copies tracked files only —
a real safety property, and also a way to lose a file: a root `CONTRIBUTING.md`
written minutes earlier was never `git add`ed, so it was skipped without a word and
the first symptom was a dead link in the published README. It now lists what it left
behind. And the README's own boundary handling was a line filter dropping lines that
start with `backend/`, which would have stopped matching the first time anyone
reworded that bullet; it is now an explicit `<!-- oss:strip -->` fence, asserted gone
after the copy.

**What the scan found besides.** Two manual TN10 scripts defaulted their checkpoint
file to a hard-coded local scratchpad path containing a username and a session UUID.
And the 2026-08-04 changelog entry claimed the built app "makes zero external
requests"; self-hosting Inter removed the last third-party *asset*, but
`frontend/src/price.js` still calls `api.coingecko.com` on every open Assets page —
the one party in the app's request list with no role in the protocol. Corrected in
place rather than quietly left standing.

## 44 · Round 8 — three lanes, and the invoice nobody checks (2026-09-02)

The pre-publish sweep ended with one more adversarial round, run as three
parallel lanes so each could go deep instead of wide: the covenant scripts, the
browser signing path, and the protocol lifecycle above both.

Two lanes came back clean in the way that counts. The covenant lane could not
construct a keyless drain — the entrypoint-contradiction pairing
(closeExpired's zero-continuation vs execute's one), the input-SET value sums,
the round-7 alias collapse and the generation gate all held under direct
attack, and the one latent item it flagged was already on file: the compiled
loop-bound `require` lives in the compiler, not the contracts, and carries a
TODO to become debug-only (`build-compiler.sh` documents the watch). The
lifecycle lane confirmed the front-running matrix: a stranger can churn the
vault's outpoint (RISKS #13) and, after expiry, take a proposal's bond — but
never move vault value.

The signing lane found the round's one real drain, and it was not in anything
the previous seven rounds had hardened — it was in the retry that made round
6's fee work ergonomic. A node that rejects a submit reports the exact fee it
wants (`required amount of N`), and the retry re-signs at N. Owner-funded ops
deliberately have no covenant cap — that is their entire point, the treasury
keeps full value — and the spend guard conserves *treasury* value, so a
wallet-paid fee is a number it is structurally never shown. Put together: a
hostile endpoint answering `required amount of 5000000000` re-signs 50 KAS of
the owner's wallet into a miner's fee, automatically, twice if asked. The
vault was never exposed; the wallet paying for it was. Two careful decisions —
"no cap, so the treasury can never freeze" and "the guard watches the
treasury" — each right alone, left the seam between them to whoever noticed.

The fix treats N as what it is, untrusted input: `saneFeeDemand` clamps every
retry site to 20× the fee this client priced from wasm-exact mass, anchored to
the price computed *before* any retry (a two-step lie would otherwise walk the
anchor up), with a 0.01 KAS floor so near-free shapes tolerate honest
rounding. Two mutation rules pin it — one strips the ceiling check itself, one
unclamps a single retry site and is caught by a coverage test that counts
clamp sites against parse sites, the same shape-pinning trick the guard
inventory uses. Alongside it, a lane-2 one-liner: the execute path's
vault-UTXO picker no longer falls back to an alien-lineage UTXO when the
node's view lags — an attacker-planted unspendable now reads "not visible
yet" instead of an opaque script failure.

## 45 · Eleven years is not an expiry (2026-09-02)

Round 8's lifecycle lane kept circling one number: `expiresAt: 4_000_000_000`.
It was never a decision — it was a placeholder that shipped, eleven years of
DAA score standing in for "no expiry yet". And "no expiry" turned out to be
load-bearing in three unpleasant ways. An Approved proposal never stopped
being executable, which combined with snapshot semantics (rotation checks the
proposal's OWN owner set, not the current one) into a standing authorization
no key rotation could revoke. A Rejected proposal's bond had exactly one
release path, `closeExpired`, which requires expiry — so rejection stranded
0.5 KAS for a decade. And the bounty race the permissionless close creates
(the bond pays whoever runs it) was invisible only because no proposal ever
reached the line.

The covenant cannot fix any of this: `tx.time` is a lower bound, "now <
expiresAt" is unprovable on-chain, so post-expiry execution stays legal until
someone closes — RISKS #3, now with consequences attached. So the fix is
policy, in the layer that can hold it. `expiryDaa` commits a bounded lifetime
(1 hour to 1 year, default 30 days) anchored to the node's DAA clock and
refuses to guess without one — the failure mode of a missing node is a loud
error, not a silently eternal proposal. `executeWindow` gives the execute path
a verdict: expired means retire or re-propose (the client declines to race
bond snipers with a treasury transfer as the stake), the final hour means a
warning. The New-transfer dialog grew a 7/30/90-day choice with one honest
sentence about what a longer life means; Manage-signers now states the
rotation corollary out loud when proposals are open. Four mutation rules pin
it — the bounds, the expired verdict, and a source-shape test that fails the
moment `4_000_000_000` walks back into a builder.

Two smaller things rode along: the recipient hash an execute verifies against
is now read out of the chain-anchored redeem script (`stateBytes32`) instead
of the local record's copy — consensus would have caught the mismatch anyway,
but at the node, after signing, with an opaque error; and RISKS gained the
reorg-mirror note (#18) and the served-wasm integrity position (#19), both of
which the audit found undocumented rather than wrong.

## 46 · Five spends against the clock (2026-09-02)

The oldest unproven line in RISKS was #3's homework: "confirm `this.age`
actually gates spends on the node." Every treasury ever executed had passed
`executionDelay: 0`, so the only thing on record was that zero is tolerated.
Reading the engine first made the probe sharper than the plan: `this.age`
lowers to OpCheckSequenceVerify, and that opcode never looks at the UTXO's age
at all — it only compares the demanded delay against the spending input's
SEQUENCE field, which the spender writes. The actual wait lives one layer up,
in consensus (`check_sequence_lock`, BIP-68 with DAA score as the clock). So
the guard is a coupling, and a probe that only tried "spend too early" would
have proven half of it.

Five spends of one 1-KAS ProbeAgeTime(600) UTXO proved all of it on TN10:
declaring the delay honestly but early — refused by consensus; lying with
sequence 0 — refused in script (600 > 0); setting BIP-68's DISABLED bit to
skip the consensus wait — refused by the opcode itself, on a young UTXO and
again on an aged one; and the mature spend, sequence 600 at age 1051 —
accepted, txid c9a00f28…. Two corrections came home with the receipts: the
probe's comment said `this.age` counts seconds (it counts DAA blocks, ten a
second), and the first mature attempt bounced on fees because ComputeBudget
120 prices at 12,568 grams — the budget itself is mass, and 4 is plenty for
two timelock checks. Recorded in RISKS #3 alongside the builder note that a
future nonzero delay must ride in the execute's input sequence.

## 47 · The bounty had to die in the covenant (2026-09-03)

Round 8 left one fix deliberately on the table: `closeExpired` paid the bond
to whoever ran it, and no client-side policy can unmake a bounty that lives in
consensus — the client can refuse to enter the race (§45), but the sniper was
never running our client. The fix had to be a template change, and the first
design for it died on a whiteboard: bake the vault's template hash into
KoProposal so the close can derive the vault address — except KoVault already
bakes the PROPOSAL template hash (executeProposal reads proposal state through
it), and two contracts each hashing the other's finished bytes is a cycle no
amount of cleverness closes.

The design that shipped breaks the cycle with state instead: every proposal
carries a 20th field, `vaultSpkHash`, and `KoRoot.createProposal` writes it —
recomputed on-chain from a hash-pinned reveal of the vault template (the exact
mechanism bootstrapVault already uses) and the live covenant id. Not taken
from the proposer, and that is a rule with teeth: the bond can be
root-reserve-funded, so a proposer-chosen return address is a 0.5-KAS-per-
proposal drain of treasury money by a single owner. `closeExpired` then
requires output 0 to pay `new ScriptPubKeyP2SH(vaultSpkHash)` the full bond
over the input SET — unbound, since the zero-continuation pin already forbids
the lineage surviving — and the closer brings their own fee inputs. Closing
stays permissionless; it just stopped being paid work.

The ripple was the real cost: proposal state 315 → 348 bytes and every mirror
of that fact — the KoProposalState structs in KoRoot and KoVault, the
descriptor's field list, the scan's state encoder (which now derives the
commitment from the lineage rather than trusting anything it read), three
regenerated templates, four e2e harnesses, the fixture generators (where the
new tests are honest single-reason controls: the destination test is expiry-
honest and value-whole, the short-bond test pays the right address), the VALUE
and SCAN family counts, and both wasm close exports growing a signing phase.
The one non-obvious catch: output-script introspection compares the
VERSION-PREFIXED spk, so a hand-concatenated `aa20‖hash‖87` comparison can
never match — `new ScriptPubKeyP2SH()` exists precisely because someone else
hit this first.

On TN10, against the new covenants end to end (73 assertions, treasury
`34cf73fa…5f05`): the full round-1 lifecycle passed unchanged — createProposal
carrying its ~4KB template reveal cleared script verification at compute
budget 80 for a 0.0258 KAS fee (`f776aa53…`) — then a proposal minted to
expire in a minute met two closes. One routed the bond to a wrong P2SH and was
refused by the node in script; the honest one (`fca17c1d…`) landed the whole
0.5 KAS at the vault address as an unbound stray, the closer's change came
home minus a 0.0074 KAS fee, and the vault's covenant UTXO never moved.

## Open items / next

- **Backend-mode hostile-ctx seam (round-7 G4):** determine whether a shipped build can
  reach backend mode (no ⚙ endpoint) at all. If it is dead code, delete `/wasmctx` and
  `/relay` so the seam cannot silently return; if reachable, either re-anchor the guard's
  reference values to the node or document it as a known hostile-backend limitation.
- Validate the two-transaction creation flow on-chain: the `bootstrapVault` mint
  chained onto an unconfirmed genesis, and `BOOTSTRAP_ROOT_BUDGET = 40` (reasoned
  generous, never measured — if short, the symptom is an opaque script-verification
  failure at submit).
- ~~Round 6 left three surfaces unreviewed when the review hit the usage limit~~ —
  two are now reviewed (§36): the proposal scanner's history LABELS (LOW/INFO,
  display-only; a "not node-confirmed" note now marks chain-reconstructed history)
  and `resumeBootstrap`/`bootstrapVault`'s value floor (INFO, no fund path). Still
  open: `resumeBootstrap` against a root whose on-chain STATE has drifted from the
  saved genesis record was reasoned but not driven on-chain; and the byte-level
  genesis output guard (ops-path assertSpend analog) remains scoped-but-unbuilt,
  because a wrong expected-shape would refuse honest creation, so it needs on-chain
  validation.
- ~~Port or retire the legacy route-A native path~~ — retired.
  `scripts/build-treasury.ts` and `tools/kaspa-probe/src/bin/genesis.rs` are
  deleted, and with them `backend/`'s creation and recovery endpoints
  (`createTreasury`, `createTreasuryPrepare`, `createTreasuryFinalize`,
  `recoverTreasury`, `POST /api/create-treasury/*`, `POST /api/recover`) plus the
  browser's "Re-import to this backend" banner. `backend/` itself stays: it is
  still the fallback that serves `wasmctx`, `relay` and status to a browser with
  no node endpoint. Rewrite from the two-transaction flow if a native minting
  path is ever wanted again.
- ~~Reproduce the wasm build across machines~~ — done.
  `tools/wasm-tx/Dockerfile.repro` pins base image, apt snapshot, rustc,
  wasm-bindgen and paths; the committed artefacts come from it, and
  `npm run verify:wasm` is the container check. What is still open is only the CI
  **cadence**: the container build takes minutes, so running it on every push buys
  little over the manifest check that already gates. Per-release, or on a tag, is
  probably the right frequency — an unmade decision, not a missing capability.
- Re-run `npm run build:wasm` (the pinned-container build) when Docker Hub is
  reachable again — the committed wasm for the bond-to-vault covenants was
  host-built (`--not-reproducible`; the manifest records the host toolchain, so
  the container check will report a toolchain difference, not tampering).
- Timelock/expiry hard-enforcement nuances (see `docs/RISKS.md`).
- A Toccata-capable JS SDK would let the browser build txs without the bridge.
- Recover ~28 KAS of TN10 test funds locked in the throwaway E2E Treasuries
  (1-of-1, dev-key-owned — propose → execute back to the dev wallet).
- rusty-kaspa 2.0 renamed `TransactionInput.mass` → `compute_commit` and
  capped `ScriptBuilder` elements at 520 bytes (engine still allows 1MB
  post-Toccata) — the pinned `tools/wasm-tx` rev predates this; bump carefully.
