# Ko-sign Architecture

This document explains how the frontend operates a covenant multisig with no
backend. For the protocol rationale and security analysis, read the
[whitepaper](../public/whitepaper.html) first.

## 1. The covenant model

A treasury is three cooperating Silverscript contracts bound into a single lineage
by a network-enforced 32-byte **covenant id** (KIP-20). Creating one takes two
transactions, because the id hashes the scriptPubKeys of its own genesis group and
the vault's state IS that id — a vault inside the group would contain a hash of
itself:

```
genesis tx
├─ output 0 → KoRoot   (governance anchor: owners, threshold, nonce — mutable STATE)
├─ output 1 → change   (ordinary, UNBOUND, omitted when folded into the fee)
└─ payload  → "KOSGN" inscription (version, threshold, owner pubkeys, lineage)
   ⇒ lineage C = covenant_id(fundingOutpoint, [(0, rootValue, rootSpk)])

bootstrapVault tx  (spends the root)
├─ output 0 → KoRoot   continued UNCHANGED — same nonce, same config
└─ output 1 → KoVault { lineage: C }   (the treasury's deposit address)
```

The vault address is therefore a pure function of the genesis:
`P2SH(vaultPrefix ‖ push32(C) ‖ vaultSuffix)` — one lineage, one address, and no
other covenant can ever transact there.

- **KoRoot** — factory + registry. Spending it with `createProposal` mints a
  KoProposal and a root continuation (nonce+1). Spending it with
  `executeConfig` installs a new owner set / threshold *in state* — the vault
  address never changes.
- **KoProposal** — one UTXO per proposal, carrying operation, recipient
  commitment, amount, expiry, approval/rejection bitmaps and count. Each
  approve/reject spends it into its own continuation with the bitmap advanced;
  scripts verify a BIP340 signature against the owner's pubkey *inside the
  script* (KIP-10 introspection).
- **KoVault** — pay-to-script-hash treasury, holding the treasury's lineage in
  state and refusing every other one. Its spend paths are `execute` (requires
  consuming an Approved proposal of the same covenant id in the same transaction)
  and `deposit`/sweep (must preserve value: `outputs[0].value ≥ sum(vault inputs)` —
  the sweeper pays the fee from their own inputs). Both begin by requiring the
  spending covenant id to equal that lineage, which is what stops a stranger
  planting a covenant of his own at a treasury address and capturing the payments
  that arrive there unbound.

Proposal lifecycle:

```
createProposal ──▶ Pending ──approve──▶ … ──▶ Approved ──execute──▶ Executed
   (bond 0.5)        │                            │
                     └─reject… (N−R < M) ─▶ Failed┘        expiry ─▶ Closed
```

Fees are **owner-funded**: the proposer pays the proposal bond + fee from
their own wallet; approve/execute fees come out of the bond; sweeps cost the
sweeper. The vault itself never bleeds value to operations.

## 2. Route B — everything in the browser

The frontend builds every covenant transaction locally in a Rust→WASM bundle
(`src/wasm/`, ~650 KB, a generated artifact — see the README):

```
UI (TreasuryView.jsx)
  └─ wasmTx.js            orchestration per operation
       ├─ wasm bundle     tx building, sighash computation, borsh encoding
       ├─ signer.js       BIP340 Schnorr over the sighash (@noble/curves)
       └─ wrpc.js         submit → Kaspa node (JSON wRPC over WebSocket)
```

Signing is **two-phase**: the wasm returns sighashes for every input that
needs an owner signature (covenant reveal + the owner's own P2PK fee inputs),
`signer.js` signs them locally, and the signatures are injected to finalize
the transaction. Private keys never enter the wasm and never leave the tab.

Node access uses the public **kaspa-resolver** network by default (the
resolver returns borsh endpoints; the same nodes answer JSON wRPC on the
sibling `/wrpc/json` path). Users can point ⚙ at their own node. `wrpc.js`
enforces connect/call deadlines and flushes in-flight waiters on socket death
— pool nodes are flaky and silent hangs are worse than errors.

## 3. State: cache, never truth

`localStorage` tracks the operating state per treasury (root outpoint, open
proposals, history) so operations don't re-scan the chain, via
`treasuryState.js`:

- After every submit, `applyUpdate` mirrors the state transition locally and
  the UI updates instantly.
- `rescanFromChain` (in `wasmTx.js`) periodically re-walks the truth:
  `walkRoot` follows the KoRoot's spend chain from genesis (every
  `createProposal` advances the nonce; every `executeConfig` swaps the owner
  set), and `scanOpenProposals` replays each proposal's approve/reject/execute
  history from raw transaction witnesses — reconstructing full audit logs
  (who signed what, when) from chain data alone.
- Merges are defensive: chain-closed proposals win; locally-newer approval
  counts win; a submit that lands mid-scan is re-read at save time so a stale
  snapshot can never clobber it.

**Recovery path:** given only a vault address, `kaspaRest.js` walks back to the
genesis transaction (the vault's oldest covenant-bound payment is its
`bootstrapVault` mint; that transaction's input 0 names the genesis and its output 0
is the root's address), decodes the `KOSGN` inscription (owners, threshold,
lineage), `treasuryRebuild.js` reconstructs the covenant scripts from the embedded
templates (`treasuryTemplates.js`), and `seedFromChain` locates the live root —
the treasury is fully operable again on a machine that has never seen it.

## 4. Live updates

`kaspaLive.js` subscribes (`utxosChanged`, JSON wRPC) to the vault address,
the root's current P2SH address and every open proposal's current address —
a co-owner acting in another browser spends one of those UTXOs, which fires a
refresh plus staggered rescans (0/10/25/45 s) to ride out REST-indexer lag.
Where a JSON subscription isn't available the UI falls back to 30 s polling;
the "live/steady" pill in the dashboard reflects which mode is active.

## 5. Trust boundaries

| Component | Trust required |
|---|---|
| Covenant scripts | None — consensus-enforced; the on-chain scripts can be verified byte-for-byte against the bundled templates |
| This frontend | Display honesty only; it cannot move funds without owner signatures |
| Kaspa node (wRPC) | Availability + UTXO reads; submissions are signed, tamper-evident |
| REST indexer | Read-only convenience (history, activity feed); cross-checked against node UTXOs for operations |
| Stats indexer | None — optional, one-way, receives only public vault addresses |

The deliberate weak point is the browser as key store (`localStorage`,
unencrypted): XSS or a malicious extension can reach an imported key. Treat
imported keys as hot-wallet keys. Hardware-signer integration over the
two-phase sighash flow is the intended long-term answer.

## 6. Module reference

| Module | Responsibility |
|---|---|
| `App.jsx` | hash routing, shell, landing vs app chrome |
| `Landing.jsx` | marketing page, live usage stats (cached, backoff retry) |
| `CreateTreasury.jsx` | client-side genesis: template rebuild → owner-funded funding → sign → submit |
| `TreasuryView.jsx` | dashboard (Assets / Transactions / Settings), confirm modals, live wiring |
| `wasmTx.js` | per-operation orchestration, node-direct submit, chain rescans |
| `proposalScan.js` | root walk + proposal history replay from raw witnesses |
| `treasuryRebuild.js` / `treasuryTemplates.js` | covenant script reconstruction (generated templates) |
| `treasuryState.js` | localStorage state, optimistic updates, status shaping |
| `signer.js` / `kasware.js` / `WalletModal.jsx` | key sources: manual (full) / KasWare (identity+deposit) |
| `wrpc.js` / `kaspaLive.js` | JSON wRPC client + subscriptions |
| `kaspaRest.js` | REST reads, KOSGN inscription decode, activity classification |
| `network.js` | per-network config, public-node resolver |
| `stats.js` | optional telemetry (vault address only), stats fetch with cache |
| `Terminal.jsx` | the console dock — every operation logs its real steps |
