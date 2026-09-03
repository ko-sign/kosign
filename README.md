# Ko-sign

**Multisig, enforced by Kaspa L1.** A Gnosis-Safe-style multisig built as a
native Kaspa **covenant** (Toccata / Silverscript, KIP-10 introspection +
KIP-20 covenant ids). M-of-N approvals are stored on-chain as proposal state —
the treasury can only move when it consumes an *Approved* proposal of the same
covenant lineage. No custodian, no admin key.

**Try it: [app.ko-sign.org](https://app.ko-sign.org/)** — the hosted UI, running
on testnet-10. It talks to a Kaspa node directly and keeps your keys in the
browser, so it is the same app this repo builds, not a privileged deployment.

> **Status (2026-09): testnet-10 only.** The full lifecycle — genesis →
> createProposal → approve ×N → executeProposal — is live and verified on TN10,
> moving real testnet KAS, and the covenants have been through eight internal
> adversarial review rounds with a mutation harness pinning every guard
> ([SECURITY.md](SECURITY.md), [docs/RISKS.md](docs/RISKS.md)). Do not put
> mainnet funds behind it.

## What works

- ✅ **Contracts** — `KoRoot` / `KoVault` / `KoProposal` (+ 4 probes) compile against the real Silverscript compiler; logic verified in the source debugger.
- ✅ **On-chain, end-to-end on TN10** — create a treasury (any M-of-5), propose a transfer, approve to threshold, execute. Recipient receives the funds; verified live.
- ✅ **Web UI** (`frontend/`, hosted at [app.ko-sign.org](https://app.ko-sign.org/)) — Kaspa-themed landing page + wallet (create treasury, deposit address, propose/approve/execute). Covenant transactions are built in the browser via wasm and submitted straight to a node — no backend.
- ✅ **Verifiable from source** — the vault address is a pure function of the compiled covenants, so anyone can rebuild `treasuryTemplates.js` from `contracts/` and check an address against the chain. The committed wasm is reproducible ([docs/WASM-PROVENANCE.md](docs/WASM-PROVENANCE.md)) and the frontend build is deterministic.
- ✅ **`@kosign/descriptor`** — template hash / prefix-suffix / P2SH / state codec (unit-tested); plus `indexer`/`signer`/`tx-builder` (TxPlan layouts).

## Quickstart

```bash
pnpm install
pnpm build:compiler                         # clones + builds Silverscript (rustc >= 1.90)
cp .env.example .env                        # set KASPA_RPC_URL (a Toccata node)

# contracts: compile + verify logic offline + the full test suite
pnpm compile:contracts
pnpm verify:contracts
pnpm test

# the committed wasm really is what tools/wasm-tx builds (see docs/WASM-PROVENANCE.md).
# `pnpm test` already checks it against a recorded manifest with no toolchain;
# this rebuilds and compares the bytes.
pnpm verify:wasm
```

## Run the web app

```bash
npm run dev        # (or: pnpm dev) — the UI (:5173); everything runs client-side
```

Open **http://localhost:5173** — landing page, then **Launch App**: create an
M-of-5 treasury, see the vault deposit address + balance, propose a transfer, approve
as the owners, execute. See [docs/FRONTEND.md](docs/FRONTEND.md).

## Read next

- [SECURITY.md](SECURITY.md) — threat model, what is in scope, how to report.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to build, test, and send a change.
- [CHANGELOG.md](CHANGELOG.md) — feature-level history, one entry per shipped capability.
- [docs/DEVLOG.md](docs/DEVLOG.md) — how this was built, milestone by milestone.
- [docs/ONCHAIN-FLOW.md](docs/ONCHAIN-FLOW.md) — full lifecycle live on TN10 (txids).
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — covenant model, state layout, tx flows.
- [docs/SPEND-GUARD.md](docs/SPEND-GUARD.md) — the client-side check that reads every transaction back before it is signed.
- [docs/FEES.md](docs/FEES.md) — dynamic mass-priced fees for every flow (2.4–38× cheaper).
- [docs/SWEEP.md](docs/SWEEP.md) — batched deposit consolidation at any scale.
- [docs/GENESIS-PROVENANCE.md](docs/GENESIS-PROVENANCE.md) — the one attack the covenant scripts cannot see, and the client-side check that refuses it.
- [docs/RISKS.md](docs/RISKS.md) — gotchas found (bitwise width, storage mass, shared addresses, timelock).
- [docs/PLAN_VS_REALITY.md](docs/PLAN_VS_REALITY.md) — how the original plan held up.
- [contracts/README.md](contracts/README.md) — the covenants and how to compile them.

## Layout

```
contracts/   Silverscript covenants (+ probes/, args/)
packages/    descriptor · rpc · tx-builder · signer · indexer  (TypeScript)
tools/       wasm-tx — the browser's covenant transaction builder
frontend/    React (Vite) — Kaspa-themed landing page + wallet UI
scripts/     build-compiler · build-wasm · compile · verify · guard mutation suites
docs/        devlog, architecture, on-chain flow, risks, plan-vs-reality
```

## License

MIT — see [LICENSE](LICENSE).

Security: `.env`, API keys, and `.secrets/` (testnet keys) are gitignored —
never commit them. `.tooling/` (cloned compiler) and `target/` are too.
