# Genesis provenance — the attack the contracts cannot see

Every Ko-sign treasury is a **covenant domain**: a set of UTXOs sharing one
`covenant_id`. `KoVault.executeProposal` authenticates a proposal by two facts —
the input's script matches the KoProposal *template*, and the input's covenant id
equals the vault's `lineage`. Both are true of every proposal
`KoRoot.createProposal` mints, which is the intent.

They are also true of a proposal that was never minted by KoRoot at all.

## The attack

A covenant id is created once, by whoever builds the treasury's **genesis
transaction**, through rusty-kaspa's `populate_genesis_covenants`. Its unit is

```rust
GenesisCovenantGroup { authorizing_input: u16, outputs: Vec<u32> }
```

— the spender chooses **which outputs join the group**. Ko-sign's builder binds
exactly one (`tools/wasm-tx/src/lib.rs::gen_build`):

```rust
tx.populate_genesis_covenants(&[GenesisCovenantGroup { authorizing_input: 0, outputs: vec![0] }])
//                                                                  output 0 = KoRoot, and nothing else
```

Consensus does not require that. The forged member is a KoProposal-shaped P2SH
whose state its author wrote himself:

```
status        = 1   (Approved)
snapThreshold = 1
ownerCount    = 1
owner0        = his own key
```

It matches the template. If it carries a vault's lineage,
`KoVault.executeProposal` accepts it as a genuine, fully-approved proposal — and
drains that vault whenever he chooses, from a treasury whose addresses, KOSGN
inscription, owner set, balances and indexer entry all look exactly right.

**The vault shuts this out from the outside.** `KoVault`'s state is the treasury's
covenant id, and both of its entrypoints refuse every other one —
`executeProposal` requires `cid == lineage`, `deposit` requires
`cid0 == lineage`. A vault address is
`p2sh(vaultPrefix ‖ push32(lineage) ‖ vaultSuffix)`, so one lineage means one
address and no second lineage can ever transact there. A stranger cannot plant a
covenant of his own at somebody else's treasury address and capture the payments
that arrive there (deposits arrive **unbound**, and are folded in by `deposit`).

What that cannot shut out is the inside. **The author of a genesis decides what
his treasury's lineage IS**, and there are two ways to poison it:

**(a) bind a second output.** `outputs: vec![0, 1]`, where output 1 is the forged
proposal. The lineage now has a member besides the KoRoot, from the moment it
exists.

**(b) bind exactly one — but not the one you think.** `outputs: vec![0]`, where
output **0 is the forged proposal** rather than a KoRoot. This is a genuine
one-member group: the binding set is `[0]`, there is one covenant id, one
authorizing input, at most two outputs, and the covenant id recomputes correctly
from that output *because the group really is that output*. The vault it derives
is a real vault whose `lineage` really is that id — it will honour the forged
proposal because the forged proposal is, technically, its own lineage. Every
count-based and hash-based check agrees. Nothing distinguishes (b) from an honest
genesis except **which contract the one member is** — and shape does not answer
that, because a KoProposal is a P2SH exactly like a KoRoot.

`KoVault.executeProposal` needs only a bound vault input plus a same-id,
template-shaped proposal input; no KoRoot need appear in the transaction at all.
So (b) is not a degenerate case — it is the *cheapest* version of the attack, and
it produces a treasury that is byte-for-byte ordinary from the outside.

## Why no contract can stop it

The complete covenant introspection set is `OpInputCovenantId`,
`OpOutputCovenantId`, `OpCovOutputCount`, `OpCovOutputIdx`,
`OpOutputAuthorizingInput`. **None of them exposes whether an input's covenant
binding was created at genesis or minted later by a rule-following spend.** A
script sees an id; it cannot see the id's provenance. This is not a gap in
Ko-sign's contracts — it is not expressible in the instruction set, so it cannot be
fixed by any contract change, for existing treasuries or future ones.

The contracts *do* govern every binding after genesis: the `OpCovOutputCount` /
`OpCovOutputIdx` guards audited by `scripts/test-security.sh` pin the exact number
of covenant outputs each path may create (`createProposal` and `bootstrapVault` 2,
`executeConfig` / `executeProposal` / `deposit` / `approve` / `reject` / `execute`
1, `closeExpired` 0). **Genesis is the one moment in a treasury's life when
covenant membership is decided by a party rather than by a script.**

## Two transactions, and why the vault is in neither group

A covenant id hashes the scriptPubKeys of its own genesis group. A vault whose
state IS that id would therefore have to contain a hash of itself, so the vault
**cannot** be a genesis output. A treasury is created by two transactions:

```
tx1  GENESIS         input 0: funding
                     output 0: KoRoot            ← the covenant group, alone
                     output 1: change to funder  ← unbound, optional
                     payload:  KOSGN inscription
                     ⇒ C = covenant_id(fundingOutpoint, [(0, rootValue, rootSpk)])

tx2  bootstrapVault  input 0: the KoRoot (a spend of tx1 output 0)
                     output 0: KoRoot, continued UNCHANGED — no nonce bump
                     output 1: KoVault { lineage: C }
                     both bound to C
```

`C` depends on nothing but the funding outpoint and the root, so it is computable
**before the genesis is broadcast** — which is what lets the genesis inscribe its
own lineage in its payload (the covenant id excludes the payload). `KoRoot`'s
constructor bakes `vaultTemplateHash`, and `bootstrapVault` requires the
spender-supplied vault template to hash to it, so the only thing a root can mint
at output 1 is a KoVault carrying its own id.

The consequence is the point of the whole design: **the vault address is a pure
function of the genesis.**

```
vaultRedeem  = TEMPLATES.vault.prefix ‖ 0x20 ‖ C ‖ TEMPLATES.vault.suffix
vaultAddress = p2sh(blake2b-256(vaultRedeem))
```

An auditor does not *observe* the vault in the genesis. He **derives** it.

## The defence: read the genesis before you deposit

The genesis transaction is on chain and immutable. Everything about the covenant
group is recoverable from it, so a client can decide *before the first deposit*
whether the treasury is honest, and simply refuse the ones that are not.

`packages/descriptor/src/genesis.js` is that decision — shared, and self-contained
in the way that matters: it hashes for itself (`@noble/hashes`) and derives from
the covenant templates it ships with (`./treasuryTemplates.js`), so **no call site
can weaken the audit by forgetting to pass something**. (`indexer/genesisAudit.mjs`
is a byte-identical vendored copy, because the indexer ships as a standalone image
with its own Docker build context; both it and its copy of `treasuryTemplates.js`
are pinned by `indexer/test/genesisAudit.test.mjs`, which fails on any drift.)

### Finding the genesis at all

The genesis does not pay the vault and cannot, so it is nowhere in the vault's own
transaction history. Reaching it is a two-hop walk backwards
(`frontend/src/kaspaRest.js::fetchGenesisTx`, and `verifyTreasury` in
`indexer/server.mjs`):

1. the **oldest covenant-bound payment** to the vault address — deposits arrive
   unbound and every later covenant payment (a sweep, an execution) is younger, so
   the oldest bound one is the `bootstrapVault` transaction that minted it;
2. that transaction's **input 0 outpoint**, which names the genesis txid, and its
   **output 0**, which is the KoRoot continued unchanged — i.e. the address the
   genesis paid, and therefore the history the genesis is in.

Both hops are hints and nothing more. The walk matches the genesis by **txid**,
never by "the first KOSGN payload in that history": anyone may pay the root
address and any payment may carry any payload. And what settles it is not the walk
but the audit below, which derives the vault address from whatever transaction it
was handed and refuses anything that does not derive the one being opened. A wrong
hop cannot be certified — it can only fail.

### What an honest genesis looks like

| output | script | covenant |
|---|---|---|
| 0 | **the KoRoot the genesis inscription derives** — `p2sh(rebuildRoot(nonce 0, threshold, ownerCount, owners))` | bound, `authorizing_input = 0` |
| 1 *(optional)* | funder's wallet address (P2PK) | **unbound** |

Output 1 is omitted when the change was folded into the fee. There is never a
third output, and there is **no vault output at genesis**. Note what output 0 is:
not "a P2SH", but *that exact script*. That is the whole difference between the
check that catches (a) and the check that catches (b).

### Layer 1 — structural

Read the reported bindings and refuse unless:

- the transaction has 1 or 2 outputs;
- output 0 is P2SH;
- **exactly one** output carries a covenant binding, and it is output 0;
- it is authorized by input 0;
- output 1, if present, is an ordinary wallet payment — neither P2SH nor bound.

Both sources expose the bindings:

| source | field |
|---|---|
| REST (`api[-tn10].kaspa.org`) | `covenant_id`, `covenant_authorizing_input` per output |
| JSON wRPC `getBlock`/`getBlocks` | `output.covenant = { covenantId, authorizingInput }` |

Script shapes are classified from the **bytes** (`aa20…87`, `20…ac`, `21…ab`),
never from the source's own `script_public_key_type` label — the label is exactly
what a hostile indexer would get wrong. This layer catches (a) even if a source
hides the second *binding*, because a forged proposal must be a P2SH to be
spendable. It cannot catch (b) at all.

### Layer 2 — covenant id recompute

`covenant_id` is not an opaque handle. From
`consensus/core/src/hashing/covenant_id.rs`:

```
blake2b-256(key = "CovenantID")(
    genesis_outpoint.txid ‖ le32(outpoint.index) ‖ le64(n)
    ‖ for each authorized output: le32(index) ‖ le64(value) ‖ le16(spkVersion)
                                  ‖ le64(len(spk)) ‖ spk
)
```

It **commits to the number and the exact content of the authorized outputs**. So
recomputing it over `{output 0}` proves the group had no second member — a
two-output group simply cannot hash to a one-output id. Like layer 1, this layer
cannot catch (b): a one-member group's id recomputes correctly no matter which
contract the member is.

The recomputed id is also the value layer 4 derives the vault address from, which
is why a source that withholds the genesis funding outpoint costs the verdict its
`cryptographic` flag rather than merely a cross-check.

### Layer 3 — member identity

This is the layer that catches (b), and the only one that can. Everything above is
satisfied by a genuine one-member group; none of it says **which contract the
member is**.

A P2SH script public key *is* `aa20 ‖ blake2b-256(redeemScript) ‖ 87`. The genesis
payload carries the KOSGN inscription — version, threshold, ownerCount, the
covenant lineage and the owner keys. So the member can be rebuilt and hashed:

```
output 0 must equal  aa20 ‖ blake2b(rootPrefix ‖ state(nonce=0, threshold, ownerCount, owners5) ‖ rootSuffix) ‖ 87
```

— the same reconstruction `frontend/src/treasuryRebuild.js` uses to *operate* a
treasury and `scripts/treasury-version.mjs` uses to report its build, from the same
`treasuryTemplates.js`. `packages/descriptor/test/genesis.test.ts` pins the audit's
copy against both.

The creator writes the inscription, so why is this sound? Because he cannot make a
forged KoProposal hash to the KoRoot his own inscription derives. Whatever policy
he inscribes, output 0 must be the KoRoot **for that policy** — and the inscription
is also what the UI displays as the treasury's owners and threshold. Lying in the
inscription changes the address the audit demands; it does not let a proposal
occupy the root's place.

### Layer 4 — the vault address is this genesis's consequence

Layers 1–3 establish facts about *a transaction someone handed us*. None of them,
on its own, ties that transaction to the address the user is about to pay into. A
stateless vault could not be tied to one at all: its address would commit to
nothing but itself, any number of covenants could transact at it, and "this genesis
is honest" would never have implied "and it governs your money".

The vault carries its lineage in state, so the audit derives the vault address from
the id layer 2 recomputed and requires it to **be** the address being opened
(`deriveVaultFromLineage`, compared as a 32-byte P2SH script hash — no bech32, no
network prefix, works on a bare block transaction with no `verboseData`).

A forged genesis does not fail this check by being detectably forged. It fails by
deriving a *different address*, which is to say it was never this treasury's
genesis at all. There is exactly one genesis per vault address, and this layer
establishes which — which is also why `cryptographic` no longer needs a second
opinion about the treasury's id. **The address the user typed is the second
opinion**, because only one lineage derives it.

Failure is named precisely, because the cases mean different things:

| code | meaning |
|---|---|
| `bad-covenant-group` | the genesis bound something other than exactly output 0 — attack (a) |
| `covenant-id-mismatch` | the id recomputed over `{output 0}` is not the one the treasury carries: the genesis bound a member the source did not report |
| `not-this-build` | output 0 does not reconstruct as the KoRoot the inscription derives — attack (b), or a treasury minted by a different build of the contracts (run `scripts/treasury-version.mjs` to tell) |
| `genesis-not-inscribed` | the payload carries no decodable KOSGN inscription — nothing to re-derive from |
| `vault-not-from-this-genesis` | the transaction is internally fine, but the id it mints derives a different vault address than the one being opened: not that vault's genesis |
| `extra-p2sh-output` | output 1 is a second P2SH — how a forged proposal is smuggled in when its binding is not reported |

All are **refusals**, not `unverified`: `unverified` is the one verdict a user may
acknowledge and continue past, and every one of these is a state in which "the
member is a pre-approved proposal" or "this is not this vault's genesis" has not
been ruled out.

`not-this-build` deserves a word. It is not an accusation — a treasury minted by an
earlier build is honest, just not reconstructible here. But this build cannot say
what governs that money (it cannot even derive the vault's own address, so it
cannot operate it either), and "I cannot tell" must never render as "verified".
Same verdict `scripts/treasury-version.mjs` reaches independently, and the refusal
message points at it.

## What the check proves — and what it does not

**Proves**

- Genesis paid **this treasury's** KoRoot at output 0 — identified by
  redeem-script hash, re-derived from the on-chain inscription under the covenant
  templates this build publishes, not merely "a P2SH in the right place".
- The covenant group at genesis was exactly that one output and nothing else.
  Every later member is minted under the contracts' own
  `OpCovOutputCount`/`OpCovOutputIdx` rules, so this closes the only unguarded
  moment.
- That **this** genesis, and no other transaction, is the genesis of the vault
  address being opened — because that address is a function of the id this
  transaction mints, and the vault refuses every other lineage.

**Does not prove**

- Anything about *who holds the owner keys*, or that the creator is not simply one
  of the owners. A 1-of-2 treasury whose other owner is the attacker is a perfectly
  honest genesis. The inscription is *identified* against the root script, so what
  it claims is what the covenant enforces — but who those keys belong to is outside
  the chain.
- Anything when the genesis cannot be fetched, or when the source withholds the
  funding outpoint the covenant id is recomputed from. Both are `unverified`, and
  the second has its own code, `vault-binding-unestablished`. The treasury stays
  closed and no deposit address is shown.

  This paragraph used to describe the second case as "a `clean` verdict with
  `cryptographic: false`", and asserted that no deposit address is shown for it.
  That was wrong on the second half, and it is where round 5 got in: the deposit
  address keyed off the verdict word, so withholding one field the *source*
  controls bought a clean verdict — for a genesis that is REFUSED when reported in
  full, since the address it derives is somebody else's. The same absent field
  also nulls the lineage `liveTreasuryId` filters your node's UTXOs by, so the
  independent second opinion silently corroborates nothing.

  Demanding the field costs an honest reader nothing: **finding the genesis at all
  already required it**, on the mint transaction, from the same endpoint and the
  same response shape. Supplying it for the mint and withholding it for the
  genesis is an asymmetry no honest indexer produces.
- Anything about a refusal's *durability* being evidence. A `refused` verdict is
  written to `localStorage` and returned before any network call, because a genesis
  is immutable — which is true of the transaction that was READ. A source that
  served a corrupted one gets that refusal frozen too, and an honest treasury is
  then closed in that browser until the site's storage is cleared.

  Kept deliberately: the alternative lets a refusal be re-rolled until it passes,
  and failing closed is the right direction for a control that stands between an
  owner and a forged covenant. Ordinary network trouble does not trigger it — a
  throw, a 500 and an empty history all produce `unverified`, which is never
  cached. It takes a structurally valid response with wrong content. The refused
  screen now says when a verdict came from storage rather than from the chain, so
  the two cases can be told apart.

- The REST API exposes no scriptPublicKey **version** field, so version 0 is
  assumed (true of every script Kaspa mints today). A wrong assumption can only
  cause a covenant-id *mismatch* — a refusal — never a missed forgery.
- The rules are pinned to today's builders and today's contracts. A future genesis
  layout would be refused until `GENESIS_AUDIT_VERSION` (now **4**) and the rules
  are updated together; the version is part of the client's verdict-cache key, so
  bumping it re-audits everything. Likewise a contract change regenerates
  `treasuryTemplates.js`, after which treasuries minted by the previous build
  report `not-this-build` — which is the honest answer, and the same one
  `scripts/treasury-version.mjs` gives.

## Where it runs

**Frontend** (`frontend/src/genesisAudit.js` → `TreasuryView`). The gate runs on
the vault address before anything else, and hands the auditor the P2SH script hash
that address commits to — the value the audit derives and compares. A `refused`
treasury renders a dead-end explanation screen: it cannot be opened, no balance, no
proposals, and above all **no deposit address**, with no override — a forged
covenant id can never be re-minted, so there is nothing to wait for. An
`unverified` treasury also stays closed, but retries automatically (a treasury
created moments ago lags the indexer, and its `bootstrapVault` may not have landed
yet) and offers a clearly-labelled, session-scoped "open unverified" escape for the
case where the chain is simply unreachable. The deposit address is withheld
whenever the genesis is not verified, override or no override.

The independent covenant-id lookup against your own wRPC node is still made, and
still travels with the verdict as `independent.why`/`.note` when it comes back
empty (no endpoint configured, the node errored, no UTXO yet, entries carrying no
`covenantId`). It now *strengthens* a verdict rather than being the only thing that
can make it cryptographic: it confirms the live treasury carries the id the genesis
minted, on a second view of the chain. Only final answers are cached per
network+vault in `localStorage`: `refused`, and `clean` that reached
`cryptographic: true`. A clean-but-partial verdict — one that never got as far as
deriving the vault address — is deliberately not cached, so the proof completes by
itself as soon as the chain source supplies the whole genesis.

Nothing is written to `localStorage` for a treasury that has not cleared the gate:
resolution and node-direct seeding are held back until it does.

**Indexer** (`indexer/server.mjs`). Both discovery paths audit before registering,
and neither reads a treasury's address out of the genesis — the address is a
*consequence* of the transaction (`vaultOfGenesis`), so recomputing the covenant id
and deriving the one vault that can carry it reads the chain's claim rather than
the creator's:

- the chain follower audits the genesis in the block from its own node against the
  address it just derived, then — once the vault's UTXO appears — **re-runs the
  audit with the covenant id that UTXO carries**. The block and the UTXO set are
  two views of the chain, so this pass records `assurance: "independent"`;
- `verifyTreasury` (the REST second line behind `POST /api/register`) walks the
  two hops described above and audits the genesis it lands on. One source, so it
  records `assurance: "lineage"` — the derivation held, but no second view
  confirmed the id.

`assurance` therefore has three levels: `independent` (derived **and**
cross-checked against a node's UTXO set), `lineage` (derived, one source),
`structural` (the genesis was verified but its vault address could not be derived
— e.g. a source that reports no funding outpoint). It is recorded with each
treasury as `genesisAudit: { version, assurance }` and exposed on
`/api/treasuries`, with a tally on `/api/health` — a registry that cannot say which
of its entries were only structurally checked is claiming more than it verified.
(The field is in-memory: it describes the check, not the treasury, so a restart
that reloads the registry from Postgres reports `"unrecorded"` rather than
inventing a stronger claim.)

A refused treasury never enters the registry, never counts toward the public
stats, and is listed under `refusedGenesis` on `/api/health` — a registry that
silently drops them tells nobody the attack was attempted. `POST /api/register`
answers `{ ok: false, reason: "forged-genesis", code, reason, genesisTxid }`.
A genesis that cannot be verified is *queued*, not rejected and not registered —
including the ordinary case of a treasury whose `bootstrapVault` has not landed
yet, which is indistinguishable from a slow index and must never be turned into a
permanent "no genesis".

## Tests

| suite | covers |
|---|---|
| `packages/descriptor/test/genesis.test.ts` | the rules, on REST + wRPC fixtures and on synthetic forgeries — a second bound member, a hidden one caught only by the recomputation, a lying inscription, and an honest genesis that simply derives a *different* vault. Also the ground truth: `rebuildVaultRedeem` agrees byte-for-byte with `frontend/src/treasuryRebuild.js`, and `deriveGenesisMembers` reproduces a live treasury's on-chain KoRoot script hash under the pinned templates of the build that minted it (`fixtures/tn10-build-470be03-templates.json`) |
| `frontend/test/genesisAudit.test.mjs` | the gate's decisions against an address-keyed REST mock: that the genesis is nowhere in the vault's own history and the walk reaches it anyway, that a vault whose `bootstrapVault` has not landed is UNVERIFIED and shows no deposit address, refusal of both attack shapes and of a genesis that derives another vault, each of the three ways the independent lookup can come back empty, and that a partial verdict is never cached as final |
| `indexer/test/genesisAudit.test.mjs` | both indexer input shapes, the follower's second pass, an inscription that lies about the lineage, plus the byte-identity tripwires against the canonical module and the canonical templates |
