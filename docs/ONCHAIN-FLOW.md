# On-chain milestone — full proposal lifecycle live on TN10

**Date:** 2026-06-18 · **Network:** testnet-10 (Toccata `1.2.1-toc.3`)

The complete Gnosis-Safe-style flow runs end-to-end on Kaspa L1 covenants:
**genesis → createProposal → approve ×3 (threshold) → executeProposal**, with the
treasury actually paying a recipient.

## The treasury (3-of-5)

```
treasuryId : c409c8406b006333ff311c14e4b6468c6c66224aa4f627bd4aecddda622f6665
```

## Transactions (in order)

| Phase | txid | result |
|-------|------|--------|
| genesis | `bf291cd5f6f8e5d316f36d8af0222869b11fe8e60a59983a452eea492e53840a` | KoRoot 2 KAS + KoVault 40 KAS |
| createProposal (owner0) | `13b00cdda892d188018cc1fba26ddde0c8e96a5b73b62c93c8641de7f3b14569` | proposalId 1, transfer 10 KAS, approvals 1/3 |
| approve (owner1) | `7147dcc33aa59170d1c9e8b7e2a6c0851b7292b53febd0ebc4d4557304e9d709` | 2/3, bitmap 3, Pending |
| approve (owner2) | `fc5a4e2e2aa86c4c5fe3d9d62563ccbb6fcf7c5ce5d68ca551a0c24a3fab12af` | 3/3, bitmap 7, **Approved** |
| executeProposal | `0d867df16d56ede327bddb0ca020d9336c6ba1873057902d8e2e5770c4cd3916` | paid 10 KAS, vault change 30.8 KAS (vaultNonce 1), proposal consumed |

**Verified:** the recipient (funding wallet) received exactly `1,000,000,000`
sompi (10 KAS). Genesis-state KoRoot/KoVault addresses show 0 UTXOs because
each spend continues the covenant to a NEW state-address (state lives in the
redeem script, so the P2SH address changes per state) — the 30.8 KAS change sits
at the vaultNonce=1 address.

## What this proves on-chain

- Covenant **spend** with owner `checkSig` inside the script (createProposal, approve).
- **State continuation** via state-carrying P2SH (KoRoot nonce, proposal bitmap/count/status, vault nonce).
- **Cross-template minting** (`validateOutputStateWithTemplate`) — KoRoot creates KoProposal.
- **Cross-contract, signature-less execution** — KoVault + KoProposal spent together; authorization is the approved covenant state, not a signature (`executeProposal` + `execute` run in one tx, mutually validating).
- On-chain **approval bitmap**: threshold gating + duplicate-approval rejection.
- Covenant-id lineage propagation across the whole flow (continuation outputs inherit `treasuryId`).

## Tooling (native Rust, rusty-kaspa tn12)

`tools/kaspa-probe` bins: `genesis`, `create-proposal`, `approve <ownerIndex>`,
`execute`, `treasury-status`, `balance`, `keygen`. Redeem scripts + state come from
`.secrets/treasury.manifest.json` (compiled by `pnpm build:treasury`); per-proposal state
is tracked in `.secrets/treasury.proposal.json`.

## Bug found & fixed on-chain (lesson)

First attempt at `approve` failed: `AND operands must be of equal length`. Kaspa's
`OpAnd`/`OpOr` require equal-width operands, but state ints are fixed 8-byte while
computed ints are minimal-width — so `approvalBitmap & mask` on `int` fails at
runtime. The source-level debugger missed it (it encodes state minimally). **Fix:**
make `approvalBitmap` a `byte[8]` and use `byte[8]` masks (`bitwise.sil` confirms
byte-array bitwise works). State encoding is byte-identical (9 bytes), so the
off-chain tooling was unchanged — but the contract change altered the template
hash, requiring a fresh genesis. Takeaway: **bitwise covenant logic must use
fixed-width byte arrays, and the debugger must test with full-width state.**

## Also tuned

- Compute budget: a covenant input must commit `budget` where the script-units
  limit is `budget*10000 + 9999`. createProposal needed ~110k units → budget ≥ 11
  (we use 20). `sign()` hardcodes 10, so we set the budget manually before signing.
