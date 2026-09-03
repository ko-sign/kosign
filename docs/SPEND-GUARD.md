# The spend guard — reading a transaction back before it goes out

The covenants enforce **no transfer without owner signatures**. Every Kaspa node
checks that, and three on-chain rounds have watched real nodes refuse real attacks
that tried to get around it.

What no covenant can enforce is **that the owner meant this transfer**.

## Where the gap is

An owner sees "send 2 KAS to `kaspatest:qr…`", presses a button, and signs a
sighash. The sighash is a hash of a transaction the wasm builder assembled. If the
builder assembled something else — an ordinary bug, or a blob that is not what
`tools/wasm-tx` says it is — the signature over it is still perfectly valid, the
covenant is satisfied, and the money moves somewhere the owner never saw.

Every guard in `contracts/*.sil` is upstream of that moment and none of them helps.
The contract's question is "are there enough signatures?", and the answer is yes.

Related but separate: [WASM-PROVENANCE.md](WASM-PROVENANCE.md) proves the shipped
binary was built from the published Rust. That closes substitution. It says nothing
about whether the published Rust computes the right transaction, which is what this
does.

## What it does

`frontend/src/txDecode.js` decodes the finished transaction from its bytes —
borsh by hand against the rusty-kaspa layout, addresses rebuilt with its own
cashaddr encoder. It never calls into the wasm. That independence is the entire
point: asking the builder to describe its own output is not a check.

`frontend/src/txGuard.js` then compares that reading against what the caller said
the operation would do. The central rule is about **destinations**, because that is
what a defect actually costs. Every output must be one of exactly three things:

1. a continuation of **this treasury's own covenant lineage**,
2. a payment to an address the caller **declared** — a transfer's recipient, a
   retirement's payout,
3. **change** back to the wallet funding the operation.

There is no fourth legitimate category, so anything else is money leaving for a
destination nobody approved. The lineage half is a real check rather than a
formality: an output continuing a *different* covenant id is exactly the
re-parenting shape that could once have been used to walk off with a treasury's
deposits.

### Conservation — how much leaves, not just where it goes

The destination rules say nothing about arithmetic, and a builder that quietly
overstates the fee sends money nowhere suspicious — it just leaves less behind.
Miners take the remainder whatever it is called, so an unexplained shortfall is
simply the vault losing money, and no destination rule can see it.

Every caller knows exactly what the operation spends out of the treasury's own
covenant UTXOs, because that is what it told the builder to spend. So the guard
checks the difference:

> what left the treasury − what came back to it − what was paid out
> **must not exceed the fee the app displayed**.

A **ceiling, not an equality** — and the difference was not theoretical. The first
version demanded an exact match. An owner-funded proposal spends the KoRoot but
returns it whole and mints the 0.5 KAS bond out of the *proposer's wallet*, so the
treasury ends the transaction ahead. The rule read that gain as a shortfall and
refused **every owner-funded proposal** — in the product, to a real user, twice
before the cause was found. Losing money the owner was not told about is the
danger; gaining it never is.

Two details decide whether this refuses honest work:

- **Who pays.** When the operator's wallet funds the fee the treasury is *fully
  conserved*, and `treasuryFee` is zero. Passing the real fee there would refuse
  every honest owner-funded operation, so a test pins that mistake as a failure.
  This was tested from the start — but only through `approve`, where the treasury's
  value passes straight through. **`propose` is the path where it grows**, and it
  had no test until it failed in front of a user. Testing the dangerous shape on a
  path where it cannot occur is not testing it.
- **Fee retries.** A node demanding a higher fee sends the flow back through
  `rebuild()`, which re-signs with **different numbers**. The rebuilt transaction
  therefore carries a rebuilt guard; checking new bytes against the old fee would
  refuse honest work on the second attempt. Same class of bug as putting the guard
  outside the retry loop.

When a caller cannot state the numbers, the check is **skipped rather than
guessed**. Inventing one would refuse honest transactions, which is worse than the
gap it leaves.

On top of that, three rules the covenants do not state out loud:

| Rule | Why |
|---|---|
| `approve`, `reject`, `propose` and `close-expired` must not spend the vault | Approving is an opinion, not a payment. None of these should be able to move treasury funds under cover of an operation nobody reads as one. |
| A transfer that pays nobody is a failure | Silence is not success. A transaction that quietly drops the payment still spends the proposal. |
| The declared address must be paid exactly once | Two outputs of the right amount to the right address is still the vault paying twice for one approval. |

## Where it runs

At the submit choke point, `submitAndTrack` in `frontend/src/wasmTx.js` — and
**inside its retry loop, not once before it**. When a node asks for a higher fee
the flow goes back through `rebuild()`, which re-signs *different bytes*; a guard
that only inspected the first attempt would wave through everything after it. The
same applies to the `fallback()` path that switches who pays the fee.

Gating at submit rather than at signing is deliberate and costs nothing: a
signature that is never broadcast cannot move money. Gating at signature time
would need an independent reimplementation of Kaspa's sighash, which is a much
larger surface for a strictly smaller gain.

A refusal says what would have happened, in the units a person can check, and ends
with *Nothing has moved*.

## Proving it bites

`scripts/test-js-guards.sh` — the discipline `scripts/test-security.sh` applies to
the covenants, pointed at the code no node checks. It now covers **28 rules across
eight modules**: the spend guard and the transaction decoder here, plus the genesis
auditor, the proposal scanner, the transfer-ceiling policy and the indexer's
current-policy reporting. Each is removed in turn and a **named** test must fail.

The harness treats two of its own failure modes as bugs rather than results,
because both produced confident nonsense while it was being written:

- **A mutation that breaks syntax** fails every test in the file, which reads like
  a very well-guarded rule and means nothing. `node --check` rejects those.
- **Counting lines that look like failures** counts the summary block too, which is
  how six different rules all appeared to be pinned by "3 tests". Only named tests
  under `failing tests:` are counted.

- **Its own `pipefail`.** `grep` returns non-zero when it matches nothing, which is
  exactly the case worth reporting. Unguarded, `set -e` killed the run silently at
  the first rule with no test behind it — the harness died precisely when it found
  something, and printed a clean partial list on the way out.
- **Asking the wrong suite.** The repo runs two test runners. Pointing every genesis
  rule at the indexer's `node --test` file made three well-guarded rules report as
  having no test at all, including the fix for the 0.2 KAS defamation vector — its
  adversarial fixtures live in `packages/descriptor`'s vitest suite. A false alarm
  costs more than silence, so a rule is pinned if **either** runner catches it.

And the control run matters as much as the mutations: if the unmutated file does
not pass, every failure above it is noise. That is the lesson from the covenants'
STATE family, whose pinning numbers were once read off signature rot.

Two files that are byte-identical by design — `packages/descriptor/src/genesis.js`
and `indexer/genesisAudit.mjs`, with a tripwire test asserting it — are mutated
together. Mutating one alone trips the tripwire instead of the rule, and the
harness would report a bite it never earned.

The harness immediately earned its place: it found that the
**pay-the-declared-address-twice rule had no test behind it at all**. Reaching that
rule meant splitting `inspectDecoded` out of `inspectSpend`, because the real
builder will not produce that shape — and a rule only reachable through the
builder is a rule the builder decides whether to test.

One more thing is pinned, in `frontend/test/txGuard.test.mjs` rather than the
harness: that **every** `submitAndTrack` call site passes a guard, and that the
call sits inside the retry loop. A new entrypoint that forgot one would submit
unchecked, and nothing else in the repo would notice.

## A covenant id is not an address

The destination rule accepts a covenant output as "ours" once its id matches the
treasury's lineage. A covenant id is a **tag** the builder writes into the output
next to the script — not a property of the script. So an output paying an attacker
while carrying the right tag read as an honest continuation, and its value even
counted as "came back" in the conservation sum, so the arithmetic balanced too.

Consensus rejects that transaction: `KoVault.executeProposal` requires the change
output's scriptPubKey to equal the vault's own. It is checked here regardless. The
premise of this module is that being right because the node happens to catch it is
not the same as being right — and authenticating a continuation by the tag beside
it is the builder describing its own output, which is the one thing this module
exists not to do.

`execute` therefore also carries `vaultSpk`, and the guard requires the treasury's
money to come home to that exact script:

```
what the treasury put in  −  what it paid out  −  the fee it was told it would cost
    must arrive at the vault's OWN scriptPubKey
```

Only the vault, and only where it is spent. Its script is fixed and is the address
the owner has been reading all along. The root's and the proposal's change on every
operation — nonce, bitmap and status live in the redeem script, so the P2SH follows
— and pre-computing them would mean re-implementing the covenants' state
transitions in JavaScript, a second implementation to keep in step and a larger
liability than the gap it closes. The vault is also where the money is: the root
holds a small reserve and the proposal a 0.5 KAS bond.

## What it does not do

- It does not verify the sighash. It verifies the bytes that are about to be
  broadcast, which is where the money is.
- It cannot help if the page itself is hostile — a malicious bundle can simply not
  call it. That is what a reproducible frontend build addresses, and it has not
  been done.
- It checks that the fee is the one the app showed, not that the fee is *sensible*.
  The covenants cap fees; `proposalPolicy.js` prices them.
- Conservation covers the treasury's own UTXOs. The operator's wallet-side change
  is checked only for destination, since overpaying from your own wallet is your
  business.
- It runs on the six covenant operations. Three other paths reach a node without
  it — `submitSweepBatch`, `submitBootstrap` and the genesis submit — because a
  sweep's destination is enforced by `KoVault.deposit` (which sums every input at
  the vault address, strays included, and requires output 0 to keep the lot), and
  the two creation paths run before a treasury has any value to protect. The one
  thing those paths produce that a covenant cannot vouch for is the vault address
  they publish afterwards, since that is a return value rather than part of any
  transaction; `submitBootstrap` derives it from the lineage and refuses to publish
  a builder's that disagrees.
- Covenant continuations are checked by script only for the vault, and only in
  `execute`. The root's and the proposal's scripts move with their state, so the
  guard still takes their covenant id on trust — the covenants pin those outputs
  themselves.
- It has a hard ceiling of 2^53 - 1 sompi (~90,071,992 KAS) on any single value it
  reasons about, because amounts are held as JS Numbers. `treasuryIn` reaches the
  guard as a Number, and above the ceiling it no longer equals the u64 the bytes
  encode — so rather than compare an exact figure against a rounded one, the guard
  refuses outright when the treasury's own value is not exactly representable. The
  same ceiling is enforced at every amount the app reads (`safeSompi`), so a
  too-large treasury is refused at the door, not signed or checked wrong. Supporting
  larger treasuries would mean a string-based amount interface end to end, including
  a rebuilt wasm builder.
