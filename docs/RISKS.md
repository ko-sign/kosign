# Ko-sign — Risks & Open Questions

Status legend: 🔴 blocker · 🟠 must-verify-on-chain · 🟡 design note · 🟢 resolved

This is the "potential problems" doc. Every item here was discovered while
building against the **real** Toccata/Silverscript toolchain (cloned + built
locally, contracts compiled). Items marked 🟠 compile fine but have **not** been
executed on a node yet — the four `contracts/probes/*.sil` exist to settle them.

---

## 1. 🟠 No *JS* covenant SDK — but the native Rust client works

The published `kaspa-wasm` (0.13.0) is **pre-Toccata** and hard-panics
(`memory access out of bounds`) against TN10, on every encoding — it cannot be
used. **However**, a NATIVE wRPC client built from `rusty-kaspa` `tn12`
(`tools/kaspa-probe`, rev `42b734f`) **connects fine** (see #2). So RPC is *not*
blocked — only the JS path is.

**Still to build:** covenant-bound transaction *construction* (covenant-id
binding, authorizing input, state-carrying P2SH outputs) + sighash/signing.
`@kosign/tx-builder.realize()`, `signer.signInput()`, `indexer.trackTreasury()`
remain stubbed; the transaction *shapes* are fully specified in
`packages/tx-builder/src/plans.ts`.

**Unblock path (proven):** tx construction/signing/submission in Rust on the
`tn12` crates works for the **entire lifecycle** — genesis → createProposal →
approve ×3 → executeProposal all confirmed on TN10, recipient received funds
(`docs/ONCHAIN-FLOW.md`). `kaspa-wasm` is not needed. Remaining is packaging
(a thin API/CLI) and the frontend, not protocol unknowns.

### Language gotcha found on-chain (now fixed)
Bitwise `&`/`|` on `int` fails at runtime (`AND operands must be of equal
length`) because state ints are fixed 8-byte and computed ints are minimal-width.
Use `byte[8]` for bitwise covenant logic (the approval bitmap). The source
debugger does NOT catch this (it encodes state minimally) — test bitwise paths on
a real node. Also: a covenant input's committed compute budget must cover the
script (limit = `budget*10000 + 9999`); `sign()` hardcodes 10, set it manually.

## 2. 🟢 TN10 is Toccata — confirmed live

Verified with `pnpm verify:node` (native client): the TN10 node reports
`server_version 1.2.1-toc.3` (the `-toc` suffix = Toccata), `network_id
testnet-10`, `is_synced true`, `has_utxo_index true`, advancing DAA score.

**Remaining caveat:** the Silverscript README says compiled scripts are "valid
only on Testnet 12"; the node here is `toc.3` on TN10. The node IS Toccata, but
confirm covenant *script execution* by submitting `contracts/probes/*.sil`
on-chain once tx construction (#1) exists. Different `toc.N` revisions could
still differ at the opcode level.

## 3. 🟡 Expiry cannot be enforced on execute (timelock asymmetry; age leg now verified)

`tx.time` is a **lower bound** only (like CLTV): `require(tx.time >= X)` proves
"not before X", but `require(tx.time <= X)` does **not** prove "before X" — the
spender chooses locktime. So an **Approved** proposal's expiry is *not* a hard
on-chain gate at execution time. We therefore:
- enforce expiry only on `KoProposal.closeExpired` (`tx.time >= expiresAt`), and
- treat post-expiry execution as possible until someone closes the proposal.

The indexer's `classify()` surfaces this honestly. `this.age` (relative
timelock) is used for `executionDelay` and is now **VERIFIED ON-CHAIN**
(2026-09-02, `tools/kaspa-probe/src/bin/probe_age.rs` against a live TN10
node): `this.age >= minAge` compiles to OpCheckSequenceVerify, which pins the
spending input's SEQUENCE to at least minAge, and consensus
(`check_sequence_lock`, BIP-68 shaped) enforces the declared wait in **DAA
score blocks** (~10/s — not seconds; the old probe comment was wrong). All
three gates bit on the node: an early spend declaring the delay was refused by
consensus (`sequence locks conditions was not met`), a spend lying with
sequence 0 was refused in SCRIPT (`600 > 0`), and the BIP-68 DISABLED-bit
escape hatch was refused by the opcode itself — on a young and an already-aged
UTXO alike. The mature spend (age 1051 > 600, sequence 600) was accepted:
txid `c9a00f28cb23b96f6a3603d38f77d7702e392cce6c315cbd6f0b07680891db18`.
One builder note rides on this: a NONZERO executionDelay requires the execute
transaction to set the proposal input's sequence to at least the delay — the
shipped builders set sequence 0, which is exactly right while the UI commits
executionDelay 0, and must change together with any feature that sets it.

## 4. 🟢 covenant-id genesis derivation — RESOLVED on-chain

The genesis covenant id is derived by the network as
`covenant_id = hash(funding_outpoint, [(index, value, spk)…])` via
`Transaction::populate_genesis_covenants`. It is **precomputable before signing**
and cannot be forged (it anchors on the spent outpoint). Verified end-to-end on
TN10: the on-chain `covenant_id` on both KoRoot and KoVault UTXOs equals the
locally-computed `treasuryId` `b79d0f30…`. See `docs/ONCHAIN-GENESIS.md`.

Still to confirm on-chain: that `OpInputCovenantId` returns this id at *spend*
time inside a covenant script (settled by the createProposal / approve phases).

## 5. 🟢 Circular template-hash dependency — resolved

KoVault/KoRoot bake KoProposal's template hash; if that hash depended on
`treasuryId` (derived at genesis) we'd have a cycle. **Verified it does not:**
compiling KoProposal with different `treasuryId` *and* different per-proposal
state yields a byte-identical template (prefix‖suffix) and a constant 114-byte
state region (see `scripts/`/the manual check in git history and
`packages/descriptor/test`). Deploy order: compile KoProposal (owners +
threshold only) → `deriveTemplate` → bake into KoVault/KoRoot.

## 6. 🟠 Storage mass (KIP-9) penalizes small covenant UTXOs

Storage mass ∝ Σ(1/outputValue). Tiny KoRoot/KoProposal UTXOs (the "dust /
bond" in plan.md) are expensive. **Set a non-trivial minimum value** for every
covenant UTXO (Root reserve, Proposal bond) and include storage mass in the fee
caps. Each approve rewrites the (small) proposal UTXO, so this recurs per
approval. `genesisPlan`/`createProposalPlan` notes flag it.

## 7. 🟡 Output-index trust

Entrypoints currently take output indices as call args and use fixed indices
(continuation at output 0, etc.) plus value checks. Call args are **not
committed by tx structure** (DECL.md security note). MVP mitigates with fixed
layout + shape checks; **production should bind indices via the covenant
declaration macros** (`#[covenant(...)]` → `OpCovOutputIdx`/`OpAuthOutputIdx`)
so the index cannot be steered. `recipientSpk` is already bound by
`blake2b == p.recipientSpkHash`; `threshold` is baked in, not passed.

**Round 7 closed one concrete instance of this class** (`KoVault.executeProposal`):
binding `recipientSpk` was not enough on its own, because a proposal may commit the
vault's OWN scriptPubKey as recipient (a net-zero self-send) and then alias
`recipientOutputIndex == vaultChangeOutputIndex` so one output satisfies the recipient
check and the change floor at once, leaking up to `amount + maxFee`. Now guarded by
`require(recipientOutputIndex != vaultChangeOutputIndex)` (family ALIAS in
`test-security.sh`).

## 8. 🟡 Proposal→Vault check is covenant-id only (one-directional template)

`KoProposal.execute` checks the Vault input's `covenant_id` but **not** its
template hash (that would re-introduce the cycle of #5). treasury because
`KoVault.executeProposal` independently enforces the money movement and both
scripts run in the same tx. Documented deviation from plan.md's symmetric
template check.

## 9. 🟠 Hashing / encoding assumptions to confirm on-chain

- `OpBlake2b` assumed to be plain **blake2b-256, no key** (`packages/descriptor/src/hash.ts`).
- P2SH scriptPubKey assumed `00 00 aa 20 <hash> 87` incl. 2-byte version prefix
  (`template.ts`, from compiler codegen). Confirm the version bytes the node's
  introspection returns.
- Proposal state ints assumed **fixed 8-byte little-endian** (`state.ts`);
  consistent with observed `state_layout.len == 114`, but confirm decode against
  a real on-chain UTXO.

## 10. 🟡 MVP simplifications (intentional, per plan.md)

Exactly 5 owner slots (if-chain selection, no dynamic array index), single
KoVault UTXO, one transfer per proposal, approvals stop at threshold (path A),
owner rotation = migrate to a new treasury. No batching, tokens, daily limits, or
modules. Re-open these only after on-chain validation of the core.

## 11. 🟢 Fee-cap freeze — RESOLVED (owner-funded ops)

approve/reject/execute/executeConfig could only pay their network fee out of
covenant value, and the contracts cap that leak at 0.1 KAS
(`maxProposalFee`/`maxExecutionFee`, plus each proposal's committed `maxFee`).
A network minimum-feerate rise past the cap would have made those ops
**unbuildable** — pay under it and the network rejects, pay over it and the
covenant rejects — permanently freezing every deployed treasury (the caps are
compiled in; no migration path).

**Resolved** by letting those ops pay the fee from the owner's own wallet
(extra P2PK inputs + change), leaving the covenant output at FULL value: the
`>=` rules then hold with slack for any fee. Validated on-chain by submitting
an approve paying **0.2 KAS — 2× the cap**. The covenant-funded path remains as
a fallback (still capped, ~20× headroom). See `docs/FEES.md`.

## 12. 🟡 Deposit-loop input cap (16) is a compile-time property, discovered empirically

The vault's `deposit` loop unrolls over at most 16 tx inputs; a 17-input sweep
fails script verification outright. Found by script-engine measurement + an
on-chain probe, not from any spec — the same technique has NOT been applied
systematically to the root/proposal paths, so comparable undocumented limits
may exist there.

## 13. 🟡 Outpoint-churn griefing (unmitigated)

`KoVault.deposit` is permissionless, so anyone can spend the vault UTXO into
an identical-value continuation, changing its outpoint and invalidating any
already-signed `execute` that referenced the old one. Cost to the attacker is
one sweep fee (~0.0008 KAS after the fee work); the UI mitigates by re-reading
the vault UTXO before building, but a determined attacker can keep a treasury's
executes racing. Funds are never at risk — deposit can only move value INTO the
vault. A contract-level fix would need to restrict non-value-adding
compactions.

## 14. 🟡 Approval race

Two approvals spending the same proposal UTXO conflict; only one confirms. UI
must re-fetch the proposal UTXO before building the next approval
(`approvePlan` note).

---

## 15. 🟡 `KoProposal.execute` does not self-enforce its operation's effect (owner-griefing)

`KoProposal.execute` (round 7, F6) checks `status == 1`, age, the covenant id, the
approval tally and one owner signature — but it does **not** check `p.operation`, nor
which entrypoint the paired covenant input runs. `KoVault.deposit` is a same-lineage
entrypoint that, given one real vault UTXO, satisfies `OpCovOutputCount(lineage) == 1`
and leaves `OpAuthOutputCount(proposal) == 0`, so an owner can spend an Approved
TRANSFER proposal via `execute` while the vault runs `deposit` instead of
`executeProposal`: the proposal is **consumed** but no recipient is paid and every
sompi returns to the vault.

**Accepted, not fixed.** It is INFO-severity: `execute` requires a valid owner
signature (not keyless), no funds move anywhere unauthorised (the vault is preserved by
`deposit`'s own floor), and the Safe is not bricked — the owners simply recreate the
proposal. Self-enforcing the effect would mean `execute` re-scanning outputs for the
`operation == 1` payout (duplicating `KoVault.executeProposal`) or the `operation == 2`
root continuation, adding bytes to every execute's revealed signature script for a
single-owner, fully-recoverable griefing vector. The cost outweighs the benefit at this
severity; revisit if the byte budget or a higher-impact variant changes the calculus.

## 16. 🟢 Hostile fee demand ("required amount of N") — RESOLVED (demand ceiling)

The submit-retry loops re-sign at the fee a rejecting node names, and the
owner-funded paths deliberately carry no covenant cap (that is their point:
the treasury keeps full value). The spend guard could not stand in — it
conserves TREASURY value and is never told the wallet input total, so a
wallet-funded fee is invisible to it by construction. A hostile endpoint
answering `required amount of 5000000000` would therefore have re-signed
50 KAS of the owner's wallet into a miner's fee automatically, bounded only
by the wallet balance, with no second confirmation. The vault itself was
never exposed; the paying wallet was, on all four retry sites (covenant ops,
sweep batches, genesis, bootstrap — the last two already partially bounded
by their change floors).

**Resolved** by treating N as untrusted input: every retry site clamps it
with `saneFeeDemand` (sweepPlan.js) — at most 20× the honestly mass-priced
fee, anchored to the fee computed BEFORE any retry so a two-step lie cannot
walk the anchor, with a 0.01 KAS absolute floor so near-free shapes tolerate
honest rounding. Beyond the ceiling the demand is refused with the node named
as the reason. Pinned by two mutation rules (`test-js-guards.sh`): dropping
the ceiling check fails the sweepPlan tests, and unclamping any single retry
site fails the coverage test that counts clamp sites against parse sites.

## 17. 🟢 Eternal proposals & the closeExpired bond bounty — MITIGATED (real expiries)

Both proposal builders hard-coded `expiresAt: 4_000_000_000` — eleven years out.
That default had three teeth: an Approved-but-unexecuted proposal was a
decade-lived standing authorization (rotation cannot revoke it — see
`docs/OWNER-MANAGEMENT.md` on snapshot semantics); a Rejected proposal's 0.5 KAS
bond was stranded as long (`closeExpired` is the only path that frees a bond,
and it requires expiry); and it hid a race that real expiries make live:
`closeExpired` is PERMISSIONLESS and pays the bond to whoever runs it, so near
expiry a stranger can profitably snipe the close, destroying an Approved
transfer and forcing a re-bond and re-vote.

**Mitigated client-side** — the covenant cannot do better, because `tx.time` is
a lower bound and "now < expiresAt" is unprovable on-chain (#3): proposals now
commit a bounded, chosen lifetime (`expiryDaa`, 1 hour–1 year, default 30 days,
anchored to the node's DAA score, refusing to guess without one); the execute
path consults `executeWindow` and refuses an EXPIRED proposal outright (retire
or re-propose — the client declines to race bond snipers with a transfer as the
stake) and warns inside the final hour; the retire flow frees bonds on a
schedule measured in days, not decades. Pinned by four mutation rules. The
residual is inherent: between the final-hour warning and expiry, an owner who
insists can still lose the race.

**The contract-level fix has now LANDED** (2026-09-03): `KoProposal.closeExpired`
requires output 0 to pay `new ScriptPubKeyP2SH(vaultSpkHash)` — the treasury's
own vault address, committed into every proposal's state at mint — at least the
full bond over the input SET, with nothing inheriting the lineage (the bond
arrives as an unbound stray the next sweep folds in). `vaultSpkHash` is written
by `KoRoot.createProposal`, which recomputes it from the hash-pinned vault
template reveal and the live covenant id — never taken from the proposer, whose
bond can be root-reserve-funded and whose chosen return address would therefore
drain the reserve 0.5 KAS a proposal. Closing stays permissionless but pays
NOTHING: the closer funds the network fee from their own signed wallet inputs,
so sniping an Approved proposal at expiry now costs money and yields none — the
bounty is dead, and the race with it. Pinned by new contract fixtures (the
destination, the full-value floor, and the createProposal template pin /
commitment guards), the VALUE and SCAN guard-family counts, and reworked
txGuard rules; the closer-payout shape was additionally REFUSED by a live TN10
node in script during the E2E round that validated the honest close.

## 18. 🟡 Reorg / finality: the client mirror is written at mempool acceptance

At consensus level a GHOSTDAG reorg is safe by construction: conflicting
covenant spends are ordinary double-spends, exactly one settles, and every
entrypoint pins its continuation (`OpCovOutputCount`/`OpCovOutputIdx`), so a
lineage can never fork into two live continuations. The exposure is the client
MIRROR: `submitAndTrack` writes localStorage state when the node ACCEPTS the
transaction, not when it confirms, and the rescan merge prefers the local
record when it carries more votes — so an approve reorged away leaves the
mirror ahead of the chain until a later build bounces off the stale outpoint
and self-heals. Truth is the chain (whitepaper §10); the mirror is a cache with
a documented healing path, not a ledger. No funds exposure; worst case is a
stale vote count displayed until the next rescan or failed build.

## 19. 🟡 Served-wasm integrity is proven at build/test time, not at load time

`scripts/wasm-manifest.mjs` ties the committed blob to its Rust sources on every
`npm test`/CI run, and the deploy digest + determinism check pin what a release
IS — but the browser loads the blob with no SRI and no runtime hash check. A
compromised host/CDN could therefore serve a different blob than the one the
manifest vouches for. A same-origin attacker also controls the JS that would do
any runtime checking, so an in-page check would be theater; the honest
statement is that load-time integrity is the DEPLOYMENT's job:
`npm run verify:deployed` compares what a URL serves against the recorded
digest, and a user who cares can run it. Accepted at this severity while the
app is testnet-only; SRI on the wasm asset is worth adding when the host moves
beyond a first-party CDN.

## What IS verified (so the above is in proportion)

- All 3 contracts + 4 probes **compile** against the real compiler.
- Template/prefix/suffix/hash derivation matches the compiler's codegen and is
  **unit-tested** against the real artifacts.
- Proposal state encode/decode round-trips and matches the artifact's 114-byte
  state region.
- The TN10 endpoint is **reachable**.
- The covenant primitives the design needs (`OpInputCovenantId`, `OpCov*`,
  `readInputStateWithTemplate`, `validateOutputState[WithTemplate]`, `this.age`,
  `tx.time`, `checkSig`) all exist in the compiler and compile in our contracts.
