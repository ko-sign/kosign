# Ko-sign recovery — on-chain inscription (Tier 1)

A treasury's operational metadata (compiled scripts, covenant lineage, current state)
lives off-chain in `.secrets/treasuries/<treasuryId>/`. P2SH only commits
`blake2b(redeem)` on chain, so without the redeem scripts you can't build a spend —
losing those files would otherwise strand a treasury. Tier 1 closes the genesis gap by
writing a tiny **recovery inscription** into the genesis transaction's `payload`, so a
treasury can be rebuilt from chain data alone.

## What's where

- **Genesis inscription (this doc, Tier 1)** = the *immutable seed*: initial owners,
  threshold, and the treasury's covenant **lineage**. Enough to regenerate the exact
  scripts — and, unlike a secret, checkable: the lineage is the covenant id the
  genesis mints, so an auditor recomputes it from the transaction and compares.
- **Covenant state on chain** = the *source of truth for the current config*. Owners
  can change via `executeConfig`; the latest owner set is read from the current
  KoRoot UTXO state (revealed on chain when the previous root was spent). The
  genesis inscription is NOT updated on owner changes by design — current owners
  come from the chain scan (see "Owner changes" below).

## Why the genesis tx is the right place

- `covenant_id` (== treasuryId) is `hash(genesis_outpoint, authorized_outputs)` and
  **excludes the payload** (`consensus/core/src/hashing/covenant_id.rs`), so adding
  the inscription does **not** change the treasuryId.
- The transaction payload **is** committed by the schnorr sighash
  (`hashing/sighash.rs::payload_hash`), so it is authenticated/tamper-proof and must
  be set before signing. `tools/wasm-tx` builds it deterministically from the same
  inputs in both the sighash and the build path (`inscription()` over the lineage
  `genesis_covenant_id()` returns), so prepare and submit produce identical bytes.
- The genesis is where the treasury's lineage comes into existence, and the lineage
  is what every address is derived from. It does **not** pay the vault (see "Finding
  the genesis" below), so the payload is written into the one transaction that a
  treasury provably has exactly one of.

## Inscription format (`KOSGN` v1)

Built/parsed by `tools/kaspa-probe/src/lib.rs` (`encode_recovery` / `decode_recovery`):

```
offset  bytes  field
0       5      magic   = "KOSGN"
5       1      version = 1
6       1      threshold
7       1      ownerCount        (1..5, REAL owners only)
8       32     covenant lineage (the id this genesis mints)
40      32*n   owner[0..ownerCount]   x-only pubkeys; NUMS padding reconstructed
total = 40 + 32*ownerCount bytes   (e.g. 104 bytes for 2 owners)
```

Only real owners are stored; the unused slots (NUMS) are re-added on recovery.

## Finding the genesis

A covenant id hashes the scriptPubKeys of its own genesis group, so a vault whose
state IS that id cannot be inside the group that mints it. The genesis binds the
KoRoot alone and never pays the vault; `KoRoot.bootstrapVault` mints the vault one
transaction later, as a continuation, and that transaction carries an empty payload.
**The genesis is therefore nowhere in the vault's own history.** Reaching it is a
two-hop walk backwards:

```
vault address  kaspatest:pqj2…
  → the OLDEST covenant-bound payment to it   (deposits arrive UNBOUND, and every
     later covenant payment is younger ⇒ this is the bootstrapVault tx that minted it)
  → its input 0 outpoint names the genesis TXID, and its output 0 is the KoRoot
     continued unchanged — i.e. the address the genesis paid
  → that txid in the KoRoot's history          ⇒ the genesis, payload and all
```

Both hops are hints. What settles it is the audit: it recomputes the covenant id
from the transaction it was handed, derives the one vault address that id can
produce, and refuses anything that does not derive the address being opened. A wrong
hop cannot be certified — only failed.

## Recovery flow

```
genesis tx payload
  → decode_inscription <payload-hex>   → {version, threshold, ownerCount, lineage, owners}
  → vaultAddress = P2SH(vaultPrefix ‖ push32(lineage) ‖ vaultSuffix)
  → reconstruct owners.json (real owners + NUMS padding to 5)
  → rebuild root/vault/proposal redeem scripts from the published templates
  → treasuryId = the lineage (== covenant_id of the live UTXOs)
  → (if the treasury has been operated) scan the chain by covenant_id for current
     state: nonce, current owners, live proposals
```

`decode_inscription <payload-hex>` (a kaspa-probe bin) is the reusable codec for
the indexer and a future `recover` tool.

## Frontend (backend-free) recovery

`frontend/src/kaspaRest.js` recovers a **read-only** treasury view straight from the
chain — no backend, no `.secrets/`. When `TreasuryView` can't resolve the URL's vault
address against the backend (`/api/treasuries` misses it, or the backend is down), it
falls back to `recoverTreasuryFromChain(vaultAddress)`:

1. `fetchGenesisTx(vaultAddress)` walks the two hops above over
   `GET /addresses/{address}/full-transactions`, paging backwards. The genesis is
   matched by **txid**, never by "the first KOSGN payload in the root's history" —
   anyone may pay the root address and any payment may carry any payload, and a
   payload-picked candidate would hand a stranger a permanently-cached refusal
2. `decodeInscription(payload)` — the genesis auditor's own decoder, so the app can
   never recover a treasury the audit did not certify → `{threshold, ownerCount,
   lineage, owners}`
3. `GET /addresses/{vaultAddress}/balance` for the vault balance

Recovery is **gated on genesis provenance** (`docs/GENESIS-PROVENANCE.md`). Step 1
above hands the genesis transaction to `frontend/src/genesisAudit.js` before any of
this renders, and a treasury whose genesis bound anything beyond its KoRoot — or
whose single covenant member is not the KoRoot that very inscription derives — is
refused outright: not recovered read-only, not annotated, refused. So is a genesis
that derives a **different** vault address than the one being recovered.
This matters most here: recovering from an address someone gave you is exactly the
case where the covenant might not be yours. A KOSGN inscription proves only that
*someone* wrote one; it says nothing about which outputs that genesis bound into
the covenant, so an attacker can hand out a perfectly valid-looking recovery record
for a treasury he can drain. The genesis audit is what separates the two, and it is
why recovery never shows a deposit address before it has run. When the chain cannot
be reached the verdict is `unverified` and the treasury also stays closed (retrying
automatically), because "we could not check" is not "it is fine".

The page then renders Assets (balance) + Settings (owners as x-only pubkeys,
threshold) behind a "Recovered read-only from chain" banner; propose / approve /
sweep / manage-signers are hidden (they need the backend's covenant tooling). The
TN10 REST API has open CORS (`access-control-allow-origin: *`), so the browser
calls it directly.

## Owner changes

Changing owners (a CONFIG proposal → `executeConfig`) does **not** affect fund
recovery: the vault is owner-agnostic and its address depends only on the lineage,
so it's always rebuildable from the genesis inscription. The *current owner set* after
a change is **not** re-inscribed; it is read from the chain (the latest KoRoot
UTXO state / the `executeConfig` tx). This is "Option A" — the covenant state is the
single source of truth and the recovery scanner is needed for current state anyway
(nonce, live proposals). Re-inscribing on each config change ("Option B") was
deliberately deferred; it only helps a *generic, covenant-unaware* explorer, which
Ko-sign's own indexer makes unnecessary.

## Verified offline

`encode_recovery`/`decode_recovery` round-trip (unit tests), and rebuilding a treasury
from the inscription alone reproduces its vault/root/proposal scripts byte-for-byte
from the decoded lineage/threshold/owners — **provided the rebuilding build is the
build that minted the treasury**.

That qualifier is load-bearing, and it was not true when this section was written as
an unconditional claim. Rebuilding splices the recovered STATE into the scripts the
CURRENT contracts compile to, so it reproduces the treasury the current build would
mint, not necessarily the one on chain. The two diverge whenever a contract's bytes
change, and the covenants do not change together: the genesis-bounds change altered
**KoRoot** while leaving the vault template byte-identical, so for a treasury minted
before it the rebuilt vault still matched and the rebuilt **root did not**.

What that costs you: the vault ADDRESS is derived from the lineage and the vault
TEMPLATE, so where the funds sit is in doubt exactly when `KoVault`'s bytes have
moved — check before trusting a rebuild. Spending the funds runs through KoRoot
(`createProposal` is the only path to a proposal, and a proposal is the only path out
of the vault), so an older treasury has to be rebuilt at the build that minted it.
`node scripts/treasury-version.mjs <vaultAddress>` reports, per covenant, which of the
two the current build reproduces — check it before trusting a rebuild.

On-chain validation (a real genesis tx carrying the payload, then recovery from a live
node/indexer) is pending a synced TN10 node.

## Not covered by Tier 1

- **Pruning.** A vanilla node prunes old blocks; the genesis tx may disappear. The
  durable answer is an **archival indexer** (Tier 2) that records the inscription
  while the block is still reachable. Tier 1 is the trustless on-chain anchor;
  Tier 2 is the fast/durable cache, always rebuildable from Tier 1. Note that the genesis
  provenance audit depends on the same record: if the genesis cannot be fetched,
  the treasury is `unverified` and stays closed. An archival indexer is therefore
  not only a convenience — it is what keeps an old treasury openable at all.
- **The identity of the creator.** The inscription records owners, threshold and
  lineage; it does not record who built the genesis or which outputs that genesis
  bound into the covenant. That question is answered by the genesis audit
  (`docs/GENESIS-PROVENANCE.md`), not by the inscription.
- **Current dynamic state** (nonce / live proposals) — recovered by a covenant-aware
  chain scan, not from the inscription.
