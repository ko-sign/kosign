# Ko-sign

**Multisig, enforced by Kaspa L1.**

Ko-sign is an M-of-N multisig wallet built as native Kaspa **covenants**. Approvals are not off-chain signatures collected in a backend — they are on-chain UTXO state. The vault can only move by consuming an *Approved* proposal of its own covenant lineage, and that rule is enforced by network consensus, not by this app.

[![License: MIT](https://img.shields.io/badge/license-MIT-2bd3e6.svg)](LICENSE)
[![Network](https://img.shields.io/badge/network-Kaspa%20testnet--10-49eacb.svg)](https://explorer-tn10.kaspa.org)
[![Status](https://img.shields.io/badge/status-experimental-f4c761.svg)](#status--disclaimer)

> 📄 Read the [whitepaper](public/whitepaper.html) · 🏗 [Architecture](docs/ARCHITECTURE.md) · 🔒 [Security policy](SECURITY.md) · 🤝 [Contributing](CONTRIBUTING.md)

---

## Why covenants, not signatures

A classic multisig says *"M-of-N signatures can spend."* Ko-sign says something stronger:

- Every **proposal** is an on-chain covenant UTXO carrying recipient, amount, expiry and an approval bitmap.
- Every **approval / rejection** is an on-chain state transition of that UTXO — no duplicate votes, fully auditable.
- **Execution** consumes the Vault and an Approved Proposal *together*; the covenant script enforces the payout. Fake or replayed proposals are impossible: a network-enforced 32-byte covenant id ties the KoRoot, KoVault and every Proposal into one lineage (KIP-20), validated with transaction introspection (KIP-10).
- **Signer changes are state, not scripts**: owners and threshold live in mutable covenant state, so adding/removing signers keeps the same vault address.

## Zero backend

This frontend is the entire product — there is no server:

| Concern | Where it happens |
|---|---|
| Transaction building | In your browser (Rust → WASM bundle, `src/wasm/`) |
| Signing | In your browser — BIP340 Schnorr via [@noble/curves](https://github.com/paulmillr/noble-curves); keys never leave the tab |
| Submission | Browser → Kaspa node, direct JSON wRPC over WebSocket |
| State | `localStorage` + rebuilt from chain at any time |
| Recovery | The genesis transaction carries a `KOSGN` inscription (owners, threshold, covenant lineage) — a treasury can be reconstructed **from the chain alone**, on a fresh machine, with zero cooperation from us |
| Live updates | Direct `utxosChanged` subscriptions on the vault, root and open proposals |

If this website disappears, your funds and your governance do not: any copy of this frontend (or any independent implementation) can rebuild and operate every treasury from on-chain data.

## Quick start

```sh
npm install
npm run dev        # http://localhost:5173
```

Production build:

```sh
npm run build      # emits dist/ — deploy to any static host
npm run preview    # serve the build locally
```

The app is a static site. No server-side rendering, no API to deploy.

## Configuration

All configuration is optional — the app works out of the box on testnet-10 using the public node resolver and public REST indexers.

Build-time (optional landing-page usage stats — read-only: any service
exposing the `/api/stats` shape consumed by `src/stats.js`):

| Env var | Purpose |
|---|---|
| `VITE_INDEXER_URL_TN10` | Stats service URL for testnet-10 (strip hidden when unset) |
| `VITE_INDEXER_URL_MAINNET` | Stats service URL for mainnet |

Runtime (the ⚙ panel in the app):

- **Network** — testnet-10 (default) or mainnet
- **Node endpoint** — *Official* (resolved from the public Kaspa node network) or *Custom* (your own `wss://…/wrpc/json` endpoint)

## Wallets

| Method | Capabilities |
|---|---|
| **Manual key** | Full access: create Treasuries, propose, approve, reject, execute, sweep. The key stays in this browser. |
| **KasWare** | Identity + deposits only. KasWare's `signPskt` can only sign inputs owned by its own addresses, so it cannot sign covenant P2SH inputs. Use a manual key for full functionality. |

## Security model

- **What the chain enforces:** threshold approval, covenant lineage, proposal expiry, value-preserving sweeps. A malicious frontend cannot move funds without M valid owner signatures landing on-chain.
- **What the browser holds:** your imported private key lives in `localStorage`, unencrypted. This is an explicit trade-off for a zero-backend wallet — treat the browser profile as a hot wallet. Do not import high-value mainnet keys; prefer a dedicated browser profile.
- **What is public:** everything. Proposals, approvals, rejections, owner pubkeys and the treasury's configuration are on-chain by design. The genesis inscription contains **public keys only — never private keys**.

Found a vulnerability? Please follow the [security policy](SECURITY.md).

## Project structure

```
frontend/
├─ src/
│  ├─ App.jsx              routing + shell
│  ├─ Landing.jsx          marketing page + live usage stats
│  ├─ CreateTreasury.jsx       client-side treasury genesis (owner-funded)
│  ├─ TreasuryView.jsx         per-treasury dashboard: Assets / Transactions / Settings
│  ├─ wasmTx.js            Route B: every covenant op built in wasm + submitted node-direct
│  ├─ wasm/                compiled tx-builder (Rust → wasm-bindgen, generated)
│  ├─ proposalScan.js      rebuild proposals + audit logs from raw chain history
│  ├─ treasuryRebuild.js       reconstruct covenant scripts from templates + owner set
│  ├─ treasuryTemplates.js     covenant script templates (generated)
│  ├─ treasuryState.js         localStorage state tracking + status shaping
│  ├─ signer.js            manual-key signer (BIP340) + wallet-source store
│  ├─ kasware.js           KasWare wallet bridge
│  ├─ wrpc.js              minimal JSON wRPC client (deadlines, waiter flush)
│  ├─ kaspaLive.js         utxosChanged subscriptions
│  ├─ kaspaRest.js         REST indexer reads + KOSGN inscription decoding
│  ├─ network.js           network config + public-node resolver
│  └─ stats.js             optional usage telemetry (vault address only)
├─ public/whitepaper.html  self-contained whitepaper
└─ docs/ARCHITECTURE.md    how it all fits together
```

## Generated artifacts

Two files in `src/` are build outputs, not hand-written code: `src/wasm/`
(the compiled covenant transaction builder, Rust → wasm-bindgen) and
`src/treasuryTemplates.js` (the covenant script templates). They are shipped in
the repo so the app builds and runs from a plain `npm install` — but treat
them as artifacts: never edit them by hand, and note that what actually
protects funds is the on-chain script, which anyone can verify independently
against these templates byte-for-byte.

## Status & disclaimer

Ko-sign runs on **Kaspa testnet-10** against the Toccata feature set (KIP-10 transaction introspection, KIP-20 covenant id). These consensus features are not yet on mainnet. The full lifecycle — genesis, propose, approve, reject, execute, signer change, sweep — is validated continuously on live testnet, but the project is **experimental software, provided as-is, without warranty**. Do not use it to secure funds you cannot afford to lose.

## License

[MIT](LICENSE) © 2026 Ko-sign contributors
