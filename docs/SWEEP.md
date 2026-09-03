# Sweeping deposits — dynamic fees & batched consolidation

How direct deposits ("strays") at the vault address get consolidated into the
covenant, at any scale — from one deposit to tens of thousands. Everything here
is **measured** (script-engine harness) and **validated on-chain** (TN10,
2.0.1 public node) — see the E2E at `frontend/test/e2e-batched-sweep.manual.mjs`.

## The model

Funds sent straight to the vault P2SH address arrive **unbound** — the UTXO
carries no covenant binding (its covenant id is ZERO), so it is not yet part of
the covenant balance. A **sweep** spends it together with the covenant UTXO into
one consolidated covenant output, which is what binds it.

Unbound is not unprotected, and the distinction matters because it is the one
users ask about. A stray sits at the vault's P2SH address, so spending it at all
means running `KoVault` — and the only entrypoint a ZERO-id input can satisfy is
`deposit` (`executeProposal` requires `cid != 0` on its active input). `deposit`
then forces `output0.scriptPubKey == vaultSpk` and `output0.value ≥ sum(vault-address
inputs)`. So the covenant protects a deposit from the moment it lands: the sole
spend it permits is a sweep back into this same vault. The network fee must come
from the **sweeper's own wallet** (extra P2PK inputs they sign) — the vault keeps
every sompi, which also closes the griefing vector where a stranger could burn
vault funds as fees by spamming sweeps.

### Proven on-chain, not just argued

`tools/kaspa-probe/src/bin/steal_stray.rs` is an adversarial negative test that
attempts a **keyless theft** against a real funded vault, from the attacker's
position: it takes only the public vault address, reads the lineage off the
chain, rebuilds the public redeem script from `treasuryTemplates.js`, asserts it
hashes to the real vault address, then spends via the signature-free `deposit`
path. Three modes, each isolated so exactly one covenant rule can reject it:

| Mode | Attempt | Rule that must stop it |
| --- | --- | --- |
| `A` | output0 carries the real lineage binding but pays the attacker | `outputs[0].scriptPubKey == vaultSpk` |
| `B` | output0 returns to the vault but short by the stray; output1 pays the attacker | `outputs[0].value >= vaultInSum` |
| `C` | spend the lone unbound stray straight to the attacker, no covenant input | `boundVaultIns >= 1` |

Run against TN10 (2026-08-21, vault `kaspatest:ppuvun4dy…jw9f49v`, lineage
`f1e315bf…438c`, 141.8 KAS bound + 12 KAS unbound), **all three were rejected**
with `script ran, but verification failed` — the covenant executed and its
`require`s refused, rather than the node bouncing the tx on some technicality.
Not wired into `npm test`: it needs a live funded testnet vault, so it is a
manual E2E.

```
KASPA_RPC_URL=… VAULT_ADDR=… ATTACKER_ADDR=… VAULT_PREFIX_HEX=… VAULT_SUFFIX_HEX=… \
  STRAY_SOMPI=1200000000 MODE=A tools/kaspa-probe/target/debug/steal-stray
```

## Fee sizing (why 0.05 KAS fixed stopped working)

Node v1.2.1-toc.3 (rusty-kaspa `ab4c51a`) raised the network minimum relay fee
**100×** to **100 sompi/gram**, priced against

```
fee_mass = max(computeMass, ceil(transientMass × L_c/L_t))   // L_c/L_t = 500k/1M = 0.5
```

`sweepPlan.feeMassOf` mirrors this exactly (E2E: zero fee retries across all
batches — the model matches the node to the sompi). The wasm export
`sweep_funded_mass` returns both masses for the exact tx shape (placeholder
65-byte sigs, so sizes match the signed tx). Two safety nets remain in
`wasmTx.js`:

- a node demanding more reports `…required amount of N…` — the engine derives
  the node's rate from N, re-sizes, re-signs and resubmits (≤3 attempts);
- change below **0.1 KAS** is folded into the fee — a small change output is
  itself non-standard (dust < ~0.0006 KAS; KIP-9 storage mass `10^12/value`
  grams blows the 500k standard cap below ~0.02 KAS).

## The covenant caps a sweep at 16 inputs

The compiled deposit loop unrolls over at most **16 tx inputs**: covenant +
14 deposits + 1 fee input passes, one more input fails script verification
outright. Measured with the script engine at both the pinned rev (`42b734f`)
and the deployed line (`ab4c51a`), and confirmed live — the E2E's 17-input
probe is rejected by the node. **This cap, not tx mass, bounds a batch.**

## Compute-budget calibration (fees ~7× down)

Each tx input declares a compute budget; every declared unit costs 100 grams of
mass whether used or not. The builders declared `ComputeBudget(120)` = 1.2M
script units per vault input — but the deposit branch actually executes in
**≤ 5,001 units** even at the 16-input cap (~4,000 base + 93 per extra input;
salt length 1–75 shifts it < 150). `tools/wasm-tx` now declares
**`VAULT_DEPOSIT_BUDGET = 2`** (29,999 allowed units, ~6× margin); fee inputs
stay at 10 (exact: a schnorr sigop costs 100,000 units, budget 9 fails).
On-chain proof: the E2E submits its first batch with a `budgetVault: 0`
override (≤ 9,999 units) and the node accepts it at 16 inputs.

Per-deposit sweep mass: 13,730 → **~3,460 grams** (transient-bound after
calibration) ≈ **0.0035 KAS** per deposit.

## Batching thousands of deposits

`sweepClientSide` (frontend/src/wasmTx.js) is a queue engine over the pure
planner in `frontend/src/sweepPlan.js`:

1. **Partition dust** — deposits under 0.05 KAS (default, UI-toggleable) are
   skipped: sweeping one costs ~0.0035 KAS regardless of value, and anyone can
   shower a public vault address. KIP-9 already makes such showers expensive
   to create (an output of value v costs ~`10^12/v` grams to create).
2. **Split** largest-first into batches of ≤ 14 (`perBatchCap` = contract cap
   or mass cap, whichever binds; a shrink loop drops deposits from a batch when
   the fee needs several wallet inputs so the 16-input cap always holds —
   including on fee retries).
3. **Chain** — each batch spends the previous batch's **still-in-mempool**
   covenant output (`{txid, 0}`) and reuses its fee change (`{txid, 1}`) as the
   next fee input. No confirmation waits; a brief orphan-wait retry covers
   propagation races.
4. **Cancel/resume is free** — every accepted batch is final on-chain; the
   remaining strays just stay pending. Re-running the sweep continues from
   whatever is left (idempotent by construction).

The UI (Assets page) shows a pre-sweep quote (`N deposits → M txs · est. fee`),
per-batch progress in the button, and a "stop after current batch" control.

Scale reference (measured shapes):

| deposits | txs | total fees | wall-clock |
|---|---|---|---|
| 14 | 1 | ~0.05 KAS | ~1 s |
| 1,000 | 72 | ~3.8 KAS | ~1–2 min |
| 10,000 | 715 | ~35–40 KAS | ~10 min |

## Re-calibrating (when a node upgrade changes pricing)

If sweeps start bouncing with `ExceededCommittedScriptUnits` or a changed
`required amount`, re-run the calibration: build a harness against the node's
rusty-kaspa rev that constructs the funded sweep (mirror `sweep_funded_build`),
executes each input with `TxScriptEngine::from_transaction_input` (unlimited
units) and reads `vm.used_script_units()`; set `VAULT_DEPOSIT_BUDGET` to cover
the 16-input worst case with ≥ 2× margin, rebuild the wasm, and re-run the E2E.
Gotchas at newer revs: `TransactionInput.mass` is renamed `compute_commit`
(2.0), and `ScriptBuilder` enforces the pre-Toccata 520-byte element cap — the
engine allows 1MB post-Toccata, so build the redeem push manually.

## Testing

- `node --test frontend/test/sweepPlan.test.mjs` — planner unit tests (batch
  split, dust, fee sizing fixed point, change fold, review-found scenarios).
- `node frontend/test/e2e-batched-sweep.manual.mjs` — **manual, spends real
  TN10 funds** from `.secrets/wallet.testnet.json` (~7.5 KAS/run, most locked
  into a throwaway treasury): genesis → fan-out (via the multi-output `send` probe
  tool) → 17-input negative probe → chained 14+3 batches in one run →
  budget-0 probe → dust skip + includeDust → exact final-value asserts.
