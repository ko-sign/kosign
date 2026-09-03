# Fees — dynamic, mass-priced, everywhere

Every Ko-sign transaction now prices its network fee from the **node-exact mass
of the actual tx**, replacing the old fixed constants. Measured on-chain (TN10,
zero fee retries across the full matrix):

| flow | old fixed | dynamic (measured) | cheaper | covenant cap |
|---|---|---|---|---|
| genesis | 0.10 KAS | **0.0026** | 38× | — |
| create proposal | 0.10 | **0.0097** | 10× | maxProposalFee (0.1, compiled) † |
| approve / reject | 0.05 | **0.0051** | 10× | maxFee (0.1, in state) |
| execute (transfer) | 0.05 | **0.0183** | 2.7× | p.maxFee (vault side) |
| execute (config) | 0.05 | **0.0206** | 2.4× | maxProposalFee (0.1, compiled) |
| sweep (per deposit) | 0.0137 | **0.0035** | 4× | — (sweeper-funded) |

† Added 2026-08-19 with `createProposal`'s value floor (the two id-bearing
outputs must together retain `reserveIn − maxProposalFee`). It applies only to
the root-funded fallback; the wallet-funded path leaves both outputs whole. See
"Who pays" below.

## How pricing works

The node's mempool requires `fee ≥ max(computeMass, ceil(transientMass × 0.5))
× 100 sompi/gram` (min relay feerate raised 100× in node v1.2.1-toc.3; the 0.5
is the transient cofactor from the 500k/1M block limits). Two wasm exports make
this exact client-side:

- `sweep_funded_mass(inputs)` — the sweep's masses (see [SWEEP.md](SWEEP.md));
- `borsh_masses(borshHex)` — masses of **any** built tx: every covenant flow
  builds a PROBE with dummy zero signatures **at fee 0** (probing at a legacy
  default would re-introduce the old constants as availability floors — a bond
  barely above the real fee must stay spendable), measures it, then signs at
  the priced fee. A fee change only moves fixed-width output values — never
  the serialized size — so the probe's mass is exact for the final tx
  (unit-tested as the fee-invariance property).

Every Rust builder accepts an optional `fee` in its inputs JSON (defaults = the
old constants, so older callers are untouched). The fee must be identical in
the Phase A sighash call and Phase B build call — the sighash commits to every
output value.

## Who pays: the wallet first, the treasury as fallback

approve / reject / execute / config-execute can pay their fee **from the
connected owner's wallet** (extra P2PK inputs the owner signs, plus a change
output). The covenant output then keeps its **full** value — the treasury pays
nothing at all, and the fee caps below stop being a ceiling. This is the
default whenever the wallet has spendable funds; if it doesn't, the flows fall
back to paying from covenant value (the bond / vault / root), which is the
capped path. genesis and sweeps are always wallet-funded. create-proposal
prefers the wallet too, but its fallback spends the KoRoot reserve — and since
2026-08-19 that fallback is capped like every other covenant-funded op, so the
same reasoning applies to it: fund the proposer's wallet and the cap cannot bind.

Why this matters: those four ops have **no other way** to pay — there is no
external fee field in a Kaspa transaction, so a covenant-funded op's fee is
literally value leaving the covenant output, and the contracts cap that leak at
0.1 KAS. If the network's minimum feerate ever rose past the cap (it rose 100×
in a single node release in July 2026), covenant-funded ops would become
**unbuildable** and a treasury would be frozen: pay under the cap and the network
rejects it, pay over and the covenant rejects it. Wallet-funded ops sidestep
that entirely — validated on-chain by submitting an approve with a **0.2 KAS
fee, 2× the cap**, which the node accepted.

## How many wallet UTXOs may pay

A covenant spend is capped at **16 inputs total**. `KoVault` sums the vault
inputs with a bounded loop, and `KoRoot` does the same over the root-input set in
`createProposal` and `executeConfig`; the compiler emits
`require(end - start <= MAX)` before unrolling either, so a 17-input spend of the
vault **or of the root** is not merely expensive — it **fails script verification
outright**, with an error that reads like a contract bug rather than "your wallet
is too fragmented". The wasm builder
attaches every funding UTXO it is handed (`attach_funding`), correctly: the
ceiling belongs to the covenant being spent, not to the builder.

So the cap lives where the operation is planned — `sweepPlan.sizeOpFee`, used by
`wasmTx.feeSizedOp` — and it subtracts the inputs the covenant itself brings:

| op | covenant inputs | wallet UTXOs it may spend |
| --- | --- | --- |
| approve, reject | 1 (proposal) | 15 |
| execute, config-execute | 2 (vault-or-root + proposal) | 14 |
| create-proposal | 1 (root) | 15 |
| sweep | 1 + strays | the rest, shrinking the batch (see [SWEEP.md](SWEEP.md)) |

A wallet fragmented past that gets an actionable message — *consolidate your
wallet, or fund the fee from a single UTXO* — and the treasury pays the fee
instead, so no operation is blocked by fragmentation alone. On the submit-retry
path (the node demanded a higher fee, and there is no fallback left) the same
condition is thrown as an error rather than being allowed to build a transaction
the covenant will reject.

`createProposal` is capped the same way, in `wasmTx.proposerFunding` rather than
in `sizeOpFee` (it funds a fixed bond, not a mass-priced fee). It was exempt when
this section was first written, on the grounds that KoRoot had no bounded input
scan — that stopped being true in the same round: `createProposal` and
`executeConfig` now walk the root-input set with the same loop form, so the
compiler emits `require(tx.inputs.length <= 16)` for them too and a 17-input
proposal fails script verification. The root is the only covenant input, so the
proposer may add 15 wallet UTXOs; a wallet too fragmented to reach the 0.6 KAS
bond within them falls back to the root-funded path with the same *consolidate
your wallet* message. In practice the target is the whole bond rather than a
sub-cent fee, so a solvent wallet reaches it in one or two UTXOs.

Pinned by `frontend/test/opFunding.test.mjs`, which drives the real wasm builders
and counts the inputs of the transaction that comes out — for all five ops, over
wallet shapes from one fat UTXO to 500 dust ones.

## Why the covenants allow this without recompiling

All three contracts bound fee leakage with **caps, not equalities**:
`KoProposal.approve/reject` require the continuation to keep
`≥ inVal − maxFee`; `KoVault.executeProposal` bounds vault-side leakage by
`p.maxFee`; `KoRoot.executeConfig` by the compiled `maxProposalFee`; `KoRoot.createProposal`
by the same `maxProposalFee`, over the SUM of the root continuation and the
minted proposal (it had no value rule at all until 2026-08-19, which let one
owner shrink both id-bearing outputs to dust — nothing stolen, but KIP-9 storage
mass grows as output values shrink, so every later covenant op becomes expensive
to relay); genesis has no value rule (wallet-funded).
All caps are 0.1 KAS in the deployed templates, and every proposal commits
`maxFee = 0.1 KAS`. Paying externally leaves the covenant output whole, so the
inequality holds by a wide margin **whatever the fee is** — that is precisely
why wallet-funded ops have no ceiling. The capped fallback path still fails
loudly (`…exceeds this covenant's 0.1 KAS fee cap — fund your wallet…`) rather
than building a tx the covenant would reject.

Headroom on the **capped fallback** alone, for reference (measured):
approve/reject ~20×, execute ~30×, config-execute ~27× — the bond flowing back
into the vault/root raises the latter two above the bare 0.1 KAS cap.

## Safety nets

- **"required amount of N" retry**: a node demanding more reports the exact
  fee; `submitAndTrack` re-signs at N via the flow's `rebuild` closure (≤2
  retries; genesis has its own inline loop). Fixed shapes ⇒ N is exact.
  N is also **untrusted input** — the node names its own price, and on the
  owner-funded paths no covenant cap stands behind it. Every retry site clamps
  N with `saneFeeDemand` (sweepPlan.js): a demand beyond 20× the honestly
  mass-priced fee (or a 0.01 KAS floor for near-free shapes) is refused with
  the node named as the reason, anchored to the fee priced BEFORE any retry so
  a two-step lie cannot walk the anchor. See `docs/RISKS.md` #16.
- **Wallet-funded shape refused → the treasury pays**: the extra change output
  raises KIP-9 storage mass, which can trip the 500k standard cap for tiny
  transfers, and the node's UTXO view is mempool-blind so a just-spent wallet
  UTXO can collide. Any non-fee rejection triggers one automatic rebuild on the
  covenant-funded path; outpoints spent by a submitted tx are excluded from
  later picks for the rest of the session.
- **Small-change fold**: owner change below 0.1 KAS (genesis, owner-funded
  proposals, sweeps) folds into the fee — a smaller change output is itself
  non-standard (dust < ~0.0006 KAS; KIP-9 storage mass `10^12/value` grams
  above the 500k cap below ~0.02 KAS). The genesis builder omits a 0-value
  change output entirely.
- **Exact state tracking**: the actual fee travels in `meta.fee` into the
  local state deltas (treasuryState.js) and backend mirrors — those tracked values
  feed back into later builders as previous-output amounts and enter the
  sighash, so they must match the chain to the sompi. Chain rescans re-read
  true values and self-heal older records (fallbacks = the legacy constants).

## Testing

- `node --test frontend/test/dynamicFees.test.mjs` — fee-invariance property,
  per-flow price ranges vs caps, override plumbing, genesis change omission.
- `node frontend/test/e2e-dynamic-fees.manual.mjs` — **manual, spends real
  TN10 funds**: recovers throwaway test Treasuries from chain (inscription →
  propose → execute, usually leaving the dev wallet richer), then runs a fresh
  2-of-2 matrix — genesis, propose (Pending), approve (→Approved), execute,
  propose + reject (→Failed), config proposal → executeConfig (→1-of-1),
  born-Approved drain — all at dynamic fees, asserting every fee undercuts its
  legacy constant and no retry fires.

Covenant-op fees are sized from the true tx mass with no floor, and the pick
targets `fee + 0.1 KAS` so wallet change never has to be folded away; if
healthy change is unreachable the treasury pays instead (cheaper than burning it).

Related: [SWEEP.md](SWEEP.md) (batched sweeps, budget calibration),
[RISKS.md](RISKS.md).
