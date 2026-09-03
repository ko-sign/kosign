# On-chain milestone — treasury genesis live on TN10

**Date:** 2026-06-18 · **Network:** testnet-10 (Toccata, `server_version 1.2.1-toc.3`)

The first Ko-sign covenant domain was created, signed, submitted, and **verified
on-chain**. This is the proof that the design works on a real Toccata node, not
just in compilation/debugger.

## What landed

```
genesis txid : df9166663a7cf06f182e98745f546e2aa2142b09161ac4f8d12a7613bab3d2a8
treasuryId       : b79d0f303f8b7cd6d1216ec4599feccac2c5cec963fa6a1158d3cb088c6371b2
              (= covenant_id, derived by the network from the funding outpoint + outputs)
threshold    : 3-of-5
```

| Contract  | Address (P2SH)                                              | Value   | covenant_id (on-chain) |
|-----------|------------------------------------------------------------|---------|------------------------|
| KoRoot  | `kaspatest:pp3s6z2crh3cl50y3hpmpzw7h4jnzdazyvw652d60cz3vrgf0dcpw7cmr0fll` | 2 KAS   | `b79d0f30…` ✓ |
| KoVault | `kaspatest:ppkj4mhezqtthlkdphvw6df8ljev0d89wug83py04s97x7ejupqrz70z643xy` | 50 KAS  | `b79d0f30…` ✓ |

The funding wallet dropped 100 → 47.99 KAS (52 KAS into the covenant + 0.01 KAS
fee + change), confirming the tx was accepted into the UTXO set. Both covenant
UTXOs report the **same** `covenant_id`, equal to the locally-precomputed
`treasuryId` — lineage established and network-enforced.

Live verification:

```
$ pnpm exec -- tools/kaspa-probe/target/debug/treasury-status
KoRoot  : kaspatest:pp3s6z2c…
KoVault : kaspatest:ppkj4mhe…
KoRoot:  1 utxo(s)
  200000000 sompi  @ daa 493946261  covenant_id = b79d0f30…  ✓
KoVault: 1 utxo(s)
  5000000000 sompi @ daa 493946261  covenant_id = b79d0f30…  ✓
```

State persisted to `.secrets/treasury.genesis.json` (gitignored).

## How it was produced

1. Funding wallet: `tools/kaspa-probe` bin `keygen` → `.secrets/wallet.testnet.json`.
2. 5 owner keypairs → `.secrets/owners.json`.
3. `pnpm build:treasury` (`scripts/build-treasury.ts`): compiled KoProposal →
   `deriveTemplate` → baked the template into KoVault + KoRoot → wrote
   `.secrets/treasury.manifest.json` (redeem scripts + values).
4. `tools/kaspa-probe` bin `genesis`: spent the funding UTXO; created KoRoot +
   KoVault outputs; `Transaction::populate_genesis_covenants([{auth_input:0,
   outputs:[0,1]}])` derived `covenant_id`; signed (Schnorr, `SIG_HASH_ALL`,
   `TX_VERSION_TOCCATA = 1`); submitted via wRPC.
5. `treasury-status` bin verified the covenant UTXOs.

Reproduce (after funding the wallet):

```bash
pnpm build:treasury
tools/kaspa-probe/target/debug/genesis        # build+sign+submit (reads .env + .secrets)
tools/kaspa-probe/target/debug/treasury-status     # verify on-chain
```

## What this proves (risks closed)

- **covenant_id genesis derivation (was RISKS #4)** — RESOLVED. The network
  derives `covenant_id = hash(funding_outpoint, [(index,value,spk)…])` via
  `populate_genesis_covenants`; it is precomputable before signing and cannot be
  forged. Confirmed: on-chain `covenant_id` == locally computed `treasuryId`.
- **Toccata tx on TN10 (was RISKS #2)** — confirmed. Version-1 covenant
  transactions build, sign, and confirm on the live node.
- **No-JS-SDK blocker (was RISKS #1)** — the native Rust `tn12` client builds,
  signs, and submits covenant transactions end-to-end. The transaction layer is
  on the Rust path; `kaspa-wasm` is not needed.
- **Address derivation** — the descriptor's redeem-script → P2SH mapping matches
  `kaspa-txscript`; the derived addresses hold the expected funds on-chain.

## Fee note

The node requires `fee ≥ mass × 100 sompi/gram`, and **storage mass dominates**
for small covenant UTXOs (the 2-KAS KoRoot output): genesis needed ~0.0053 KAS
minimum; we used 0.01 KAS. This is the practical face of RISKS #6 (KIP-9) — keep
covenant UTXO values non-trivial.

## Not yet on-chain (next)

`createProposal → approve ×3 → executeProposal` (spend KoVault to a recipient,
signed by the owner keys). The transaction shapes are in
`packages/tx-builder/src/plans.ts`; the Rust tools are the next build.
