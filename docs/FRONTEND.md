# Ko-sign apps — web UI + backend bridge

A browser can't build Toccata covenant transactions (no working WASM SDK) and
shouldn't hold owner keys, so the React UI talks to a **thin local backend**
(`backend`) that wraps the proven native Rust tools in `tools/kaspa-probe`.

```
frontend      React (Vite) UI — treasury overview, create transfer, approve, execute
backend   Node bridge (no deps) — /api/status, /api/proposal, /api/approve, /api/execute
```

## Run (local, against the live TN10 treasury)

Prereqs (one-time): `pnpm build:compiler`, `pnpm build:treasury`, the Rust tools
built (`cd tools/kaspa-probe && cargo build`), and `.env` + `.secrets/` present
(funding wallet, owners, a deployed treasury — see docs/ONCHAIN-FLOW.md).

```bash
# one command — boots the backend bridge (:8787) AND the web UI (:5173) together
npm run dev        # or: pnpm dev   (labeled [api]/[web]; Ctrl+C stops both)
```

Run them separately if you prefer: `npm run dev:api` (backend, reads .env +
.secrets and signs locally) and `npm run dev:web` (Vite UI, proxies /api → :8787).

Open http://localhost:5173. Two tabs:

- **Create treasury** — set the threshold (1..5) + root/vault KAS → generates 5 owner
  keypairs, compiles the covenant contracts for that threshold, and funds genesis
  from the funding wallet (~30–60s). Verified end-to-end (a 2-of-5 treasury created
  via the API funded its 2 KAS vault on-chain).
- **treasury & Transfer** — shows the treasury (policy, vault deposit address + balance,
  owner addresses). Propose a transfer (owner 0), approve as the other owners to
  the threshold, then Execute. Each on-chain step takes a few seconds to confirm;
  the backend retries on unconfirmed UTXOs.

## Verified end-to-end

A full UI-path transfer (create → approve ×2 → execute) moved 1 KAS from the
vault to the recipient on TN10; the funding balance rose by exactly 1 KAS.

## Notes / limits (local dev tool)

- The backend signs with owner private keys from `.secrets/` on the host — fine
  for a local testnet tool, not a production custody model.
- One active proposal at a time (state tracked in `.secrets/treasury.proposal.json`;
  root/vault advancing state in `treasury.root.json` / `treasury.vault.json`).
- Create treasury always generates 5 owner keypairs locally (so the backend can sign
  every approval). Importing co-signers' pubkeys (real distributed multisig with
  PSKT exchange) is future work.
- Treasuries with identical owners/threshold/state share a P2SH address (treasuryId isn't
  baked into the script); tools select UTXOs by covenant_id, so this is safe, but
  balances are covenant-filtered, not raw address balances.
