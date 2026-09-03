# Unique treasury addresses — CREATE2 without CREATE2

**Goal:** every treasury you create gets a fresh, unique wallet address — exactly like
[safe.global](https://safe.global) — even when two Treasuries share the same owners and
threshold. The UI uses that vault address as the treasury's id (`/treasury/kaspatest:…`).

## How Safe does it (EVM)

A Safe is a *proxy* deployed with **CREATE2**:

```
address = keccak256(0xff ‖ factory ‖ salt ‖ keccak256(initCode))
salt    = keccak256(saltNonce ‖ keccak256(initializer(owners, threshold)))
```

The user-chosen **`saltNonce`** makes each deployment land at a different address,
even with identical owners. Crucially, the salt feeds the *address* computation —
it is **not** part of the contract's runtime logic. The Safe singleton (the actual
code) is one shared master copy; only each proxy's *address* differs.

## Why the naive port fails on Kaspa

Kaspa L1 has no CREATE2 and no contract accounts. A covenant lives at a
**pay-to-script-hash** address:

```
address = P2SH(redeem_script) = blake2b256(redeem_script)
```

The address is a pure function of the **script bytes**. So to get a different
address you must get different script bytes — there is no separate "salt" slot in
the address derivation.

The contracts take a `byte[32] treasuryId` constructor parameter, so the obvious
idea is to bake a random value there. **It doesn't work:** `treasuryId` is never
*used* in any contract's logic (enforcement is via `OpInputCovenantId` at runtime),
and the Silverscript compiler **constant-folds and strips unused constructor
parameters**. Verified empirically — compiling with two different values produced
**byte-identical** scripts (same sha256, same length). This is the "baking an unused
constant is compiler-fragile" caveat from `RISKS.md`, confirmed.

## Why a random salt is the wrong kind of unique

The first working answer was a no-op salt prefix — `OP_DATA_32 ‖ <32 random bytes>
‖ OP_DROP` spliced onto the compiled vault redeem after `silc` ran, so the
optimiser never saw a dead constant. It produced unique addresses. It also produced
an address that **commits to nothing but itself**.

That distinction is the whole security argument. `KoVault` was stateless, and a
stateless script does not care whose covenant it is spending under. Anyone could
compute a treasury's salted address, plant a covenant lineage **of his own** at it,
wait for an incoming payment — payments arrive UNBOUND, which is what a deposit
address is for — fold it into his lineage with `deposit`, and spend it with a
proposal he had pre-approved for himself. No owner key required. Uniqueness without
identity is not a property worth having in an address that receives money.

## The mechanism: the address IS the treasury's covenant lineage

`KoVault` now carries the treasury's covenant id in **state**, and refuses every
other lineage (`executeProposal` requires `cid == lineage`, `deposit` requires
`cid0 == lineage`). State lives inside the redeem script, so:

```
vaultRedeem  = TEMPLATES.vault.prefix ‖ 0x20 ‖ lineage ‖ TEMPLATES.vault.suffix
vaultAddress = P2SH(blake2b256(vaultRedeem))
```

The lineage is `covenant_id(fundingOutpoint, [(0, rootValue, rootSpk)])`, and a
funding outpoint is spent exactly once, ever. So two treasuries with identical
owners and threshold land on different addresses **for the same reason two Safes
do** — a value the creator supplies that feeds only the address — except this one
is not a random number he keeps. It is a fact about the chain, recomputable by
anyone from the genesis transaction.

One lineage, one vault address, and no second lineage can ever transact there.

## Why it takes two transactions

A covenant id hashes the scriptPubKeys of its own genesis group, so a vault whose
state IS that id would have to contain a hash of itself. The genesis therefore
binds output 0 = KoRoot **alone** (output 1, if present, is ordinary unbound
change; there is no vault output), which fixes the id before broadcast; then
`KoRoot.bootstrapVault` spends the root and mints the vault as a **continuation**
of that id, stamping it into the state. The root continues unchanged — same nonce,
same config. `KoRoot`'s `vaultTemplateHash` constructor argument pins what it is
allowed to mint, so the only thing that can appear at output 1 is a KoVault
carrying this root's own lineage.

See [docs/GENESIS-PROVENANCE.md](GENESIS-PROVENANCE.md) for the full transaction
shapes and the audit that rests on them.

## Scope — only the vault's address moves

`KoRoot` and `KoProposal` are template-identical across treasuries: their state
(nonce, threshold, owner set; the proposal's snapshot) already makes their
addresses per-treasury and per-nonce. Only `KoVault` needed a value in state to
distinguish one treasury's deposit address from another's, and the lineage is that
value — the same value the vault needs anyway to refuse foreign covenants.

## Consequences

- The vault deposit address is a **derived** quantity, not a stored one. The
  browser rebuilds it from the lineage in the KOSGN inscription
  (`deriveVaultFromLineage`), and the genesis auditor derives it from the id it
  recomputes off the genesis and refuses any transaction that yields a different
  one.
- Recovery needs no index and no backend: the inscription carries the lineage, and
  the lineage carries the address. See [docs/RECOVERY.md](RECOVERY.md).
- The genesis transaction cannot be located from the vault's own history — it never
  pays the vault. Clients walk backwards through the `bootstrapVault` transaction
  instead; the walk is a hint, and the derivation is what settles it.

## Status

- ✅ Unique per treasury by construction: the lineage is a hash of a
  once-spendable funding outpoint.
- ✅ Enforced, not merely derived: a foreign covenant reaching a vault input dies
  at the first `require` in either entrypoint (`contracts/KoVault.sil`, covered by
  `contracts/KoVault.test.json` and the LINEAGE family in
  `scripts/test-security.sh`).
- ⏳ Pending: on-chain validation of the two-transaction creation flow — the
  `bootstrapVault` mint chained onto an unconfirmed genesis.
