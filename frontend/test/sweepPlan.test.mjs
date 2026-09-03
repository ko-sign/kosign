// Unit tests for the pure batch-sweep planner (run: node --test frontend/test).
// The mock massOf mirrors the wasm-measured linear model: mass depends only on
// the tx SHAPE (validated on-chain: 84,463 grams computed = node-observed).
import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_RELAY_FEE_RATE, CHANGE_FLOOR, MASS_TARGET, DUST_FLOOR, MAX_TX_INPUTS,
  pickFrom, sizeFee, fold, splitBatches, perBatchCap, partitionDust, quotePlan, feeMassOf,
  safeSompi, MAX_SAFE_SOMPI, saneFeeDemand, MAX_FEE_DEMAND_MULTIPLE,
} from "../src/sweepPlan.js";

const u = (amount, i = 0) => ({ txid: `${i}`.padStart(64, "0"), index: 0, amount });

test("partitionDust splits on the floor and totals dust", () => {
  const items = [u(10_000_000), u(5_000_000), u(4_999_999), u(100), u(80_000_000)];
  const { keep, dust, dustSompi } = partitionDust(items, DUST_FLOOR);
  assert.equal(keep.length, 3); // 10M, 5M (>= floor), 80M
  assert.equal(dust.length, 2);
  assert.equal(dustSompi, 5_000_099);
  // includeDust mode = floor 0: nothing is dust
  assert.equal(partitionDust(items, 0).dust.length, 0);
});

test("partitionDust adapts item shape via amt getter", () => {
  const { keep } = partitionDust([{ amountSompi: 9e6 }, { amountSompi: 1 }], DUST_FLOOR, (x) => x.amountSompi);
  assert.equal(keep.length, 1);
});

test("splitBatches: 10k strays, no loss, no dup, all within cap", () => {
  const items = Array.from({ length: 10_000 }, (_, i) => u(1_000_000 + i, i));
  const batches = splitBatches(items, 34);
  assert.equal(batches.length, Math.ceil(10_000 / 34));
  assert.ok(batches.every((b) => b.length <= 34 && b.length > 0));
  const flat = batches.flat();
  assert.equal(flat.length, 10_000);
  assert.equal(new Set(flat.map((x) => x.txid + x.amount)).size, 10_000);
  // order preserved (largest-first input order maintained)
  assert.deepEqual(flat, items);
});

test("perBatchCap: contract input cap binds with calibrated budgets", () => {
  // wasm-measured marginals @ ComputeBudget(2): mass is tiny, so the covenant's
  // 16-input script cap (cov + 14 strays + 1 fee input) is the limiter
  const base = 3_913, per = 1_930;
  assert.equal(perBatchCap(base, per), MAX_TX_INPUTS - 2);
  // …and the old over-provisioned budget-120 marginals were also input-bound
  assert.equal(perBatchCap(15_813, 13_730), MAX_TX_INPUTS - 2);
  // mass binds when per-stray mass is huge
  const heavy = 40_000;
  const capHeavy = perBatchCap(15_813, heavy);
  assert.ok(capHeavy < MAX_TX_INPUTS - 2);
  assert.ok(15_813 + capHeavy * heavy <= MASS_TARGET);
  assert.equal(perBatchCap(MASS_TARGET, heavy), 1); // never returns 0
});

test("quotePlan matches the batch/fee closed form", () => {
  const base = 3_913, per = 1_930;
  const cap = perBatchCap(base, per); // 14
  const q = quotePlan(10_000, base, per);
  assert.equal(q.batches, Math.ceil(10_000 / cap)); // 715 chained txs
  assert.equal(q.feeSompi, (10_000 * per + q.batches * base) * MIN_RELAY_FEE_RATE);
  assert.deepEqual(quotePlan(0, base, per), { batches: 0, feeSompi: 0, cap });
});

test("feeMassOf prices max(compute, transient normalized at cofactor 0.5)", () => {
  assert.equal(feeMassOf({ computeMass: 10_000, transientMass: 8_000 }), 10_000); // compute-bound
  assert.equal(feeMassOf({ computeMass: 10_000, transientMass: 30_001 }), 15_001); // transient-bound, ceil
});

// Linear mass model injected as massOf: base + perFund per funding input —
// same shape the wasm reports (validated against the node).
const massModel = (base, perFund) => (picked) => base + perFund * picked.length;

test("sizeFee converges on a dust-fragmented wallet (review scenario S1)", () => {
  // 1,000 x 200k-sompi UTXOs; base 84,463 g (1 cov + 5 strays + 1 fund), 1,120 g per extra fund
  const fents = Array.from({ length: 1000 }, (_, i) => u(200_000, i));
  const massOf = (picked) => 84_463 + 1_120 * (picked.length - 1);
  const s = fold(sizeFee(massOf, fents, MIN_RELAY_FEE_RATE));
  assert.ok(s.sum >= s.fee, `affordable wallet must not be rejected (fee ${s.fee}, sum ${s.sum})`);
  assert.ok(s.fee >= s.mass * MIN_RELAY_FEE_RATE, "fee covers the sized mass");
  const change = s.sum - s.fee;
  assert.ok(change === 0 || change >= CHANGE_FLOOR, `change ${change} must be 0 or >= CHANGE_FLOOR`);
});

test("fold absorbs a sub-floor change into the fee (review scenario S2)", () => {
  const fents = [u(9_000_000)];
  const s = fold(sizeFee(massModel(84_463, 1_120), fents, MIN_RELAY_FEE_RATE));
  assert.equal(s.sum - s.fee, 0, "tiny change must be folded away");
});

test("genuinely short wallet still reports short", () => {
  const fents = [u(100_000), u(100_000)];
  const s = fold(sizeFee(massModel(84_463, 1_120), fents, MIN_RELAY_FEE_RATE));
  assert.ok(s.sum < s.fee);
});

test("pickFrom picks a minimal largest-first prefix", () => {
  const fents = [u(50), u(30), u(20)];
  assert.deepEqual(pickFrom(fents, 60).picked.map((x) => x.amount), [50, 30]);
  assert.equal(pickFrom(fents, 1000).sum, 100); // exhausts without covering
});

// ---- integer precision on the money path (round 6) --------------------------

test("safeSompi passes any amount a JS Number holds exactly", () => {
  // the ordinary range: strings off the wire and numbers alike
  assert.equal(safeSompi("10000000000", "x"), 10_000_000_000);
  assert.equal(safeSompi(500_000_000), 500_000_000);
  assert.equal(safeSompi(0), 0);
  assert.equal(safeSompi(String(MAX_SAFE_SOMPI)), MAX_SAFE_SOMPI); // exactly at the limit
});

test("safeSompi refuses a value it cannot represent, rather than round it", () => {
  // Above 2^53-1 a Number rounds, and a rounded sompi signed or checked is wrong.
  // The refusal must fire even when the input STRING would round on the way in —
  // Number("9007199254740993") is 9007199254740992, still not a safe integer.
  for (const v of ["9007199254740992", "9007199254740993", "12345678901234567", 2 ** 53, -1]) {
    assert.throws(() => safeSompi(v, "the vault balance"), /cannot handle exactly|cannot handle/i,
      `must refuse ${v}`);
  }
});

// ---- the node-demanded fee is untrusted input (round 8) ----------------------

test("fee ceiling: a node demanding out of all proportion is refused, not re-signed", () => {
  // "required amount of N" is the node writing its own invoice, and the owner-
  // funded rebuild has no covenant cap — without this rule a hostile endpoint's
  // N re-signs the wallet balance into a miner's fee. The guard cannot catch it:
  // it conserves treasury value and is never told the wallet input total.
  const computed = 100_000; // 0.001 KAS, an honest covenant-op fee
  assert.throws(() => saneFeeDemand(computed * MAX_FEE_DEMAND_MULTIPLE + 100_000_000, computed), /over 20×|drains the wallet/);
  assert.throws(() => saneFeeDemand(5_000_000_000, computed), /over 20×|drains the wallet/); // the 50 KAS lie
});

test("fee ceiling: an honest rate gap within the multiple is paid", () => {
  const computed = 100_000;
  assert.equal(saneFeeDemand(computed * MAX_FEE_DEMAND_MULTIPLE, computed), computed * MAX_FEE_DEMAND_MULTIPLE);
  assert.equal(saneFeeDemand(computed + 1, computed), computed + 1);
});

test("fee ceiling: a rounding-level demand on a near-free shape is not refused", () => {
  // a tiny priced fee must not turn an honest few-sompi bump into a refusal —
  // the absolute floor (0.01 KAS) covers the noise band
  assert.equal(saneFeeDemand(900_000, 10), 900_000);
  assert.throws(() => saneFeeDemand(1_000_001, 10), /over 20×|drains the wallet/);
});
