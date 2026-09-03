# Ko-sign client-side signer (import key in the browser)

Ko-sign operations are signed **in the browser** with a key the user imports. The
raw private key lives only in the tab's memory — it is never written to disk and
never sent to the backend. This is what makes a raw key usable for covenant txs.

## Why not Kasware

We first tried the Kasware wallet extension. It can connect and `sendKaspa`, but
it **cannot sign the covenant transactions** (genesis / createProposal / approve):
Kasware bundles a pre-Toccata Kaspa SDK that can't serialize covenant outputs or
produce the raw BIP340 sighash signature the contract's `checkSig` verifies (the
same root cause as the `kaspa-wasm` 0.13.0 panic on TN10). So Kasware was dropped
in favour of a direct key import + client-side Schnorr signer.

## How signing is split

The browser can't *build* Toccata txs (no Toccata JS SDK), and the backend must
not hold owner keys. So each owner-signed op is two phases:

```
prepare ─▶ backend (Rust tool) builds the exact unsigned tx, returns the sighash
   │
   ▼
sign    ─▶ browser signs the 32-byte sighash with the imported key (BIP340 Schnorr,
   │       @noble/curves) → 64-byte signature. Key never leaves the tab.
   ▼
submit  ─▶ backend rebuilds the identical tx and injects the signature, then submits
```

The two phases produce a byte-identical tx (deterministic build: same UTXO, same
state, same params), so the signature made over the prepare-phase sighash is valid
for the submit-phase tx. Genesis additionally persists the chosen funding inputs
(`.secrets/treasury.genesis.unsigned.json`) so the multi-input rebuild can't drift.

Crypto interop was verified: `@noble/curves` derives the same x-only pubkey as the
Rust `keygen` for a given key, and its BIP340 signatures verify — identical to
`secp256k1::sign_schnorr` used by the native tools.

## Tooling

The Rust tools (`genesis`, `create-proposal`, `approve`) select the signer via
`KOSIGN_SIGN_MODE` (see `tools/kaspa-probe/src/lib.rs::sign_mode`):

| mode      | behaviour                                                            |
|-----------|---------------------------------------------------------------------|
| `local`   | sign in-process with a key from `.secrets` (test/"generate" Treasuries)  |
| `sighash` | build the tx, print `KOSIGN_SIGHASH[i]=<hex>`, persist, don't sign  |
| `submit`  | rebuild the tx, inject `KOSIGN_SIGS` (comma-separated 64-byte sigs) |

`execute` needs no owner signature — it's permissionless once the proposal meets
threshold (the covenant enforces the rules), so the backend runs it directly.

Backend endpoints: `POST /api/owner-address` (derive address+balance from a
pubkey) and `POST /api/treasury/:id/{proposal,approve}/{prepare,submit}`.
Creation and recovery are no longer served here — a treasury is minted by the
browser in two transactions (see UNIQUE-ADDRESSES.md), and the single-transaction
route-A path that once backed `/api/create-treasury` and `/api/recover` has been
removed rather than left to mint something the protocol no longer accepts.

## Create + pay flow

Owner 0 is the imported key — it **funds** the genesis (its address must hold
testnet KAS) and **signs** it. Co-signers are added by address (pubkeys baked, no
keys held). So a `2-of-3` treasury = `[your imported addr, tony, pete]`, threshold 2;
you pay `root + vault + fee` from owner 0's wallet.

## Two treasury types in the UI

- **Import key** (production): no backend keys. Each owner imports their key in
  their own tab and signs their own proposals/approvals client-side.
- **Generate test owners** (demo): 5 local keypairs, backend holds the keys and
  signs every step — for end-to-end testing of approve/execute without juggling
  keys. The UI detects this (owners carry `local: true`) and shows per-owner
  approve buttons handled by the backend.
