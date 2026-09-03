# Mutable owners — add / remove signer at a stable address

**Goal:** treasury.global parity for owner management — add an owner, remove an owner,
or change the threshold via a threshold-approved on-chain action, while the treasury's
**vault address stays the same**.

## Why the current design can't do it

Today the owners (5 `pubkey` params) and `threshold` are **constructor
parameters**, baked into the immutable redeem script of all three contracts
(`KoProposal` bakes them; `KoVault`/`KoRoot` bake the proposal *template*,
which is derived from them). Since `address = P2SH(script)`, the owner set is part
of the treasury's on-chain identity — change owners → change script → change address →
a different treasury. (See `UNIQUE-ADDRESSES.md`: this is exactly why the address is
deterministic.)

## Feasibility — proven

The address can only stay stable if the owners move **out of the immutable script
and into the UTXO state**, and the script reads them from state for `checkSig`.
Verified that Silverscript supports this:

```silverscript
contract Test(int threshold, byte[32] initOwnerKey) {
    int thr = threshold;
    byte[32] ownerKey = initOwnerKey;            // owner lives in STATE
    entrypoint function check(sig ownerSig) {
        require(checkSig(ownerSig, pubkey(ownerKey)));   // cast state byte[32] -> pubkey
    }
}
```

Compiles cleanly; `state_layout` shows `ownerKey` in the **variable state region**
(the immutable part is 9 bytes). So a `pubkey` read from state and used in
`checkSig` via the `pubkey(...)` cast works — owners can be mutable state, and the
script (hence address) becomes owner-agnostic.

## Design

### Owners + threshold live in state

- **KoRoot** becomes the authoritative **config registry**. Its state carries
  `threshold`, `ownerCount`, `owner0..owner4` (byte[32], NUMS-padded) in addition
  to `proposalNonce`. The redeem script no longer bakes owners → **stable root
  address**.
- **KoProposal** **snapshots** the current owner set + threshold into its own
  state when it is created from KoRoot. `approve`/`execute` `checkSig` against
  this snapshot (`pubkey(ownerK)`), so approvals are evaluated against the owner
  set as of proposal creation — a config change applies to *future* proposals.
  The redeem script is owner-agnostic → the proposal **template** (prefix/suffix)
  is owner-agnostic → **stable template hash**.

  **The security corollary, stated plainly: rotating a signer out does NOT
  revoke what they already touched.** A pending or approved proposal keeps its
  snapshot, so a removed signer can still vote on — and execute — any proposal
  minted before the change, for as long as it lives (its committed expiry; the
  UI now defaults to 30 days and warns when a signer change is proposed while
  proposals are open). If the point of the rotation is a compromised key, first
  `reject` the open proposals (or retire the expired ones), then rotate. The
  one thing a removed signer can never do is create a *new* proposal —
  `createProposal` checks the live root set. CONFIG proposals are the
  exception with teeth: `executeConfig`'s generation gate ties an approved
  config to the *current* root config, so an executed rotation invalidates
  every prior approved-but-unexecuted config.
- **KoVault** keeps baking the (now owner-agnostic) template → **stable vault
  address**. Combined with the per-treasury vault salt (`UNIQUE-ADDRESSES.md`), two
  Treasuries are still distinct, and a single treasury's address is invariant under owner
  changes.

### Config-change proposal (`operation = 2`)

Owner management is just another proposal type, approved like a transfer:

1. **Propose** a config change carrying the *desired* new owner set + threshold.
2. **Approve** to threshold by the *current* owners (the proposal's snapshot).
3. **Execute** consumes `KoRoot + config-proposal` → emits a **new KoRoot**
   whose state holds the new owner set/threshold (the Vault is untouched). Add,
   remove, and threshold change are all expressed as "here is the full new owner
   array + threshold".

Validity rules at execute: `1 <= newThreshold <= newOwnerCount <= 5`, owners
distinct, and the continuation writes exactly the proposed config into the new
KoRoot state.

### What changes

- `contracts/KoRoot.sil` — owners/threshold to state; add a config-execute path.
- `contracts/KoProposal.sil` — owners/threshold to a state snapshot; `approve`/
  `execute` use `pubkey(stateOwner)`; add `operation == 2` config semantics.
- `contracts/KoVault.sil` — unchanged logic; recompiles against the new
  (owner-agnostic) template.
- `packages/descriptor` — state encoders/layout for the enlarged KoRoot +
  KoProposal state (owner arrays); template derivation.
- `tools/kaspa-probe` — genesis seeds owners into KoRoot state; create_proposal
  snapshots owners; approve/execute read owners from state; new `config` tool.
- `backend` + UI — a Settings "Manage signers" flow (add/remove owner, change
  threshold) that drives a config proposal through propose → approve → execute.

### Trade-offs / notes

- **New template** (owner-agnostic) ⇒ all existing Treasuries are invalidated; a fresh
  genesis is required (same as prior template changes).
- Larger state (5 × 32-byte owners snapshotted per proposal) ⇒ a bit more storage
  mass per proposal UTXO.
- **On-chain validation is mandatory** before trusting this (the project has a
  history of bugs that surface only on-chain). Blocked until a synced TN10 node is
  available (`getInfo.isSynced == true`).

### Status

Feasibility proven (above). **Implemented offline** (all four layers compile and
are mutually consistent); on-chain validation is the only thing left, blocked on a
synced TN10 node.

### As built

- **`operation == 2` = CONFIG** (the old `MIGRATE_TREASURY` path was removed — owners
  are mutable now, so the treasury never needs to move; the Vault lost its
  `migrateToNewTreasury` entrypoint).
- **Commitment.** A config proposal commits
  `recipientSpkHash = blake2b(newThreshold8 ‖ newOwnerCount8 ‖ newOwner0..4)` —
  the two counts as 8-byte little-endian, each owner as raw 32 bytes (176-byte
  preimage). `amount = 1` (a >0 sentinel; the Vault never reads a CONFIG proposal
  because it requires `operation == 1`).
- **`KoRoot.executeConfig(proposalInputIndex, newThreshold8, newOwnerCount8,
  newOwner0..4)`** — pairs KoRoot with the approved proposal by covenant id,
  reads the proposal state (`readInputStateWithTemplate`), requires
  `status == 1 && operation == 2`, recomputes the commitment from the revealed
  config and requires it equals `p.recipientSpkHash`, decodes the counts with
  `OpBin2Num`, checks `1 <= thr <= cnt <= 5`, then continues KoRoot at output 0
  with the new owner state (nonce preserved) and bounds reserve leakage to
  `maxProposalFee`. The Vault is not in the tx.
- **KoProposal reuses `execute`** for the config pairing — its `pairedInputIndex`
  is the KoRoot input here (vs the Vault input for a transfer). No proposal-side
  changes were needed beyond the rename/comment.
- **KoRoot gained two ctor ints** (`proposalTemplatePrefixLen/SuffixLen`) so
  `executeConfig` can call `readInputStateWithTemplate` without re-pushing the
  578-byte suffix.
- **Selector gotcha.** Adding `executeConfig` made KoRoot a *multi-entrypoint*
  contract, so the compiler now prepends a selector (state region moved start
  0 → 1). Every KoRoot spend must push a selector: `create_proposal` now pushes
  `0` (createProposal), `execute_config` pushes `1`. Removing the Vault's migrate
  path likewise shifted `deposit`'s selector 2 → 1.
- **Tools:** `create_proposal` gained a CONFIG mode (`KOSIGN_OP=2`,
  `KOSIGN_NEW_THRESHOLD/OWNER_COUNT/OWNERS`); new `execute_config` binary applies
  it and records the new owner config into `treasury.root.json`.
- **Backend:** `POST /api/treasury/:id/config-proposal` and `/config-execute` (each with
  `prepare`/`submit`/local phases), `ownersFromAddrs` resolves the new set, and on a
  successful apply the new `owners.json` + `manifest` (threshold + 5 pubkeys) are
  installed so the UI/list reflect the change.
- **UI:** Settings → **Manage signers** edits the address list + threshold and
  proposes a CONFIG change; the Transactions queue renders it as a "Signer change"
  card and routes its execute to `config-execute`.

### Distinctness — where the "owners distinct" validity rule is enforced (2026-08-19)

The rule above ("owners distinct") was a rule on paper only; nothing checked it.
It matters because **identity here is the SLOT, not the key**: `ownerAt(i)`
returns the key in slot *i*, `maskFor(i)` returns bit *i*, and the
duplicate-vote guard compares **bitmap bits, never keys**. One key in several
live slots is therefore several owners to every later check, and approves once
per slot it occupies — `[A, A, A, B, C]` at threshold 3 is a 1-of-3 treasury
presenting itself as 3-of-5. Every other bound (`1 <= thr <= cnt <= 5`) passes
for that set.

Enforced in three places, all comparing **only slots below `ownerCount`** — the
unused tail is padded with one shared NUMS point, so comparing all five would
reject every treasury of fewer than five owners:

- `KoRoot.createProposal` — the genesis set, checked on the only path that can
  create a proposal (and therefore the only path to moving vault funds), before
  it authenticates anyone.
- `KoRoot.executeConfig` — the set an approved CONFIG proposal installs.
  Bounding the counts is not enough on its own: without this the honest path
  could write exactly the registry state the genesis check rejects.
- `packages/descriptor` (`koRootArgs`, `koProposalArgs`) — refuses to build the
  constructor args, so an integrating wallet gets an error instead of a Safe
  that cannot be used.

**Not** enforced in `KoProposal`: the pairwise test costs ~280 bytes of compiled
script revealed in the signature script of every approve/reject/execute (against
~60 for the snapshot bounds it does check), and it buys nothing in the case that
motivates those bounds — whoever can plant a snapshot with a repeated owner can
equally plant one naming a single key they hold. A duplicate-owner snapshot that
somehow reaches a covenant-bound proposal UTXO (a pre-existing Safe, or the
genesis-covenant-group hole) is therefore still votable once per slot; the fix
for that class is client-side, at genesis binding.

Be precise about what that leaves open, because the two halves are easy to
conflate. A duplicate-owner set can no longer be *created*: `createProposal`
refuses to mint from one and `executeConfig` refuses to install one. But a
proposal UTXO that already carries such a snapshot stays votable once per slot —
`KoProposal` has no distinctness rule, so one key holding three live slots of a
3-of-5 approves three times, reaches Approved, and executes alone. That is why
the class is closed at genesis binding rather than here: it is the only place a
snapshot can appear without passing `KoRoot`.
