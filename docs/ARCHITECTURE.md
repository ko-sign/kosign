# Ko-sign Architecture

A Gnosis-Safe-style multisig for Kaspa L1, implemented as **on-chain proposal
covenants** using Toccata / Silverscript (KIP-10 introspection + KIP-20 covenant
ids). Approvals are UTXO state, not off-chain signatures collected into one spend.

## Covenant model

One treasury = **one covenant domain** = one network-enforced `covenant_id` (== `treasuryId`).
Three contract templates live in that domain:

| Contract       | Holds            | State (mutable)                        | Role |
|----------------|------------------|----------------------------------------|------|
| `KoRoot`     | small reserve    | `proposalNonce`, `threshold`, `ownerCount`, `owner0..4` | config + proposal factory |
| `KoVault`    | the treasury     | `lineage` (the treasury's covenant id)  | releases funds for an approved proposal; refuses every other lineage |
| `KoProposal` | bond/dust        | id, op, recipientHash, amount, fee, expiry, delay, **bitmap, count, status** | one proposal's state machine |

Trust between contracts is established by **covenant lineage**, not by reading
state bytes:

1. `OpInputCovenantId(otherInput) == OpInputCovenantId(this)` → same treasury.
2. `readInputStateWithTemplate(idx, prefixLen, suffixLen, templateHash)` →
   the other input really is a `KoProposal` (checks foreign template hash +
   P2SH commitment) and decodes its state.
3. decoded `status == Approved`, `approvalCount >= threshold`.
4. recipient/amount/change outputs must match the decoded proposal.

`covenant_id` is the anti-forgery backbone (a fake "approved" UTXO can't carry
the treasury's network-enforced id). See `docs/RISKS.md` #4.

## State layout (the key design choice)

Every proposal of a treasury must share **one** template hash so the Vault can pin
it. So: **treasury-global, immutable** config (owners, threshold) is baked into the
script; **per-proposal / per-approval** data lives in the fixed-width STATE
region. Verified: the template (prefix‖suffix) is byte-identical across
different `treasuryId` and different state, and the state region is a constant 114
bytes. This also breaks the would-be circular template dependency
(`RISKS.md` #5).

`KoProposal` state field order (mirrored by structs in `KoVault`/`KoRoot`
and by `@kosign/descriptor`):

```
proposalId, operation, recipientSpkHash, amount, maxFee,
expiresAt, executionDelay, approvalBitmap, approvalCount, status
```

## Transaction flow (see packages/tx-builder/src/plans.ts)

```
genesis        funding              -> [KoRoot, change]            (mint covenant domain)
bootstrapVault KoRoot (+fee)      -> [KoRoot, KoVault]            KoRoot.bootstrapVault
createProposal KoRoot (+fee)      -> [KoRoot', KoProposal]        KoRoot.createProposal
approve        KoProposal (+fee)  -> [KoProposal']                  KoProposal.approve  (xN)
reject         KoProposal (+fee)  -> [KoProposal']                  KoProposal.reject   (xN)
execute        KoVault+Proposal   -> [recipient, KoVault']          KoVault.executeProposal
                                                                        + KoProposal.execute (mutual)
executeConfig  KoRoot+Proposal    -> [KoRoot'']                     KoRoot.executeConfig
closeExpired   KoProposal         -> [dust back]                      KoProposal.closeExpired
deposit        KoVault + strays   -> [KoVault']                      KoVault.deposit
```

- **approve** continues the proposal (output 0) with `bitmap|=mask`,
  `count+=1`, and `status=Approved` once `count>=threshold`. Duplicate
  approvals are blocked by the bitmap, not a signature count.
- **execute** spends Vault + Proposal in one tx; Vault enforces the payout,
  Proposal enforces Approved + `this.age>=executionDelay` + same covenant. The
  Proposal UTXO is consumed (no continuation) — replay-proof by construction.

## Deploy order (resolves the bootstrap)

1. Compile `KoProposal.sil` with the treasury's `owners` + `threshold` (placeholder
   state) → `deriveTemplate()` → `{prefixLen, suffixLen, templateHash, prefix, suffix}`.
2. Compile `KoVault.sil` baking `{prefixLen, suffixLen, templateHash}`, with a
   PLACEHOLDER lineage — the real covenant id does not exist yet. Only the template
   (prefix/suffix around the state slot) is invariant, and that is all anyone needs.
   → `deriveTemplate()` → `vaultTemplateHash`.
3. Compile `KoRoot.sil` baking the proposal `{prefix, suffix, templateHash}` and
   `vaultTemplateHash`.
4. Build genesis: bind output 0 = KoRoot **alone**, which fixes the covenant id
   `C = covenant_id(fundingOutpoint, [(0, rootValue, rootSpk)])` before broadcast.
   Output 1, if present, is ordinary unbound change. There is no vault output — a
   covenant id hashes the scriptPubKeys of its own genesis group, so a vault whose
   state IS that id cannot be inside it.
5. Call `KoRoot.bootstrapVault`: it spends the root, continues it UNCHANGED at output
   0 and mints `KoVault { lineage: C }` at output 1, both under `C`. The spender
   supplies the vault template bytes and the root pins them against
   `vaultTemplateHash`.

`@kosign/descriptor` provides the derivation + constructor-arg builders for
steps 1–3.

## Repo layout

```
contracts/            KoRoot.sil, KoVault.sil, KoProposal.sil
  probes/             on-chain primitive verification scripts (run these first)
  args/               sample ctor args (compile checks only)
scripts/              build-compiler.sh, compile.sh, compile-all.sh
artifacts/            compiled JSON (gitignored, reproducible)
packages/
  descriptor/         artifact -> template hash / prefix-suffix / spk / state codec  (TESTED)
  rpc/                TN10 connectivity + node capability probe                       (WORKS)
  tx-builder/         per-phase TxPlan layouts (realize() blocked on SDK)
  signer/             anti-blind-sign approval summary (signInput() blocked on SDK)
  indexer/            proposal classification reducer (trackTreasury() blocked on SDK)    (TESTED)
docs/                 ARCHITECTURE.md, RISKS.md, PLAN_VS_REALITY.md
```

## Frontend (later)

The frontend is intentionally not built yet. It will consume `@kosign/descriptor`
(addresses, state decode), `@kosign/signer` (approval summaries), and
`@kosign/indexer` (proposal lists/status). Keep that boundary: the UI never
constructs covenant scripts itself — it drives `TxPlan`s through `tx-builder`.
