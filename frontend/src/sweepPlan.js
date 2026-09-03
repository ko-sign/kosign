// Pure planning + fee-sizing logic for sweeping direct deposits ("strays") into
// the vault covenant — including splitting thousands of deposits into a chain of
// mass-capped batch transactions. No wasm or network imports: callers inject a
// massOf(fundingUtxos) closure (grams of fee mass for the batch being sized), so
// the exact same code runs in the browser (web wasm) and in Node tests (nodejs
// wasm). See wasmTx.js sweepClientSide for the engine that drives this.

// The node's mempool rejects any tx paying under max(computeMass, transientMass)
// × the minimum relay feerate — raised network-wide to 100 sompi/gram in node
// v1.2.1-toc.3 (rusty-kaspa ab4c51a).
export const MIN_RELAY_FEE_RATE = 100; // sompi per gram of tx mass
export const SWEEP_FEE_FLOOR = 1_000_000; // 0.01 KAS opening guess before the mass is known

// A small change output is itself non-standard — dust under ~0.0006 KAS, and its
// KIP-9 storage mass (10^12 / change grams) blows past the standard mass cap
// somewhere under 0.02–0.1 KAS — and neither rejection reports a fee the submit
// retry could parse. Change under this floor is folded into the fee instead; it
// only spends the sweeper's own margin, the vault output is untouched.
export const CHANGE_FLOOR = 10_000_000; // 0.1 KAS

// The largest sompi value this build can hold WITHOUT losing a sompi. A JS Number
// is an exact integer only up to 2^53 - 1 (~90,071,992 KAS); above that, reading a
// UTXO amount, summing a set of them, or handing one to the wasm builder (whose
// JSON interface takes amounts as numbers, not strings) rounds to the nearest
// representable integer. A rounded amount that is then SIGNED does not match the
// bytes; a rounded amount that is then CHECKED lets the spend guard's conservation
// pass a real over-loss or refuse an honest payout. Both are "correct by luck",
// which this codebase does not accept. So every amount on the money path is put
// through safeSompi, and anything at or above the limit is refused LOUDLY — split
// the treasury into UTXOs under this size — rather than silently mis-signed or
// mis-checked. Note the check catches the rounded result too: any true value >=
// 2^53 lands on a Number that is itself not a safe integer, so it cannot slip
// through by having already been rounded on the way in.
export const MAX_SAFE_SOMPI = Number.MAX_SAFE_INTEGER; // 2^53 - 1 = 9_007_199_254_740_991

/**
 * Return `v` as a Number, or throw if it cannot be represented exactly in sompi.
 * @param {number|bigint|string} v  a sompi amount from a UTXO, a sum, or a caller
 * @param {string} what             what the amount is, for the error a person reads
 * @returns {number}
 */
export function safeSompi(v, what = "an amount") {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) {
    const kas = (MAX_SAFE_SOMPI / 1e8).toLocaleString("en-US", { maximumFractionDigits: 0 });
    throw new Error(
      `${what} is ${String(v)} sompi, which this build cannot handle exactly — above ${MAX_SAFE_SOMPI} sompi (~${kas} KAS) a value rounds, and a rounded amount would be signed or checked wrong. Refusing rather than risk it. Split this treasury into vault UTXOs each under that size.`);
  }
  return n;
}

// A node that rejects a submit with "required amount of N" names its own price,
// and every retry loop in wasmTx.js re-signs at the N it names. That N is
// UNTRUSTED input. On covenant-funded ops the rebuild clamps to the covenant's
// fee cap, but the owner-funded paths deliberately have no covenant cap (that is
// their point: the treasury keeps its full value) — and the spend guard cannot
// stand in, because it conserves TREASURY value and is never told the wallet
// input total. Without a ceiling here, "required amount of 5000000000" from a
// hostile endpoint re-signs 50 KAS of the owner's wallet into a miner's fee,
// automatically, bounded only by the wallet balance.
//
// The honest fee is already priced from wasm-exact mass at the published relay
// rate, so a legitimate demand can only exceed it by a rate gap. 20× covers any
// plausible gap (the toc floor moved 1→100 sompi/gram network-wide, but a node
// is patched, not 20× dearer, when that happens again); beyond it the demand is
// refused with the node named as the reason. The small absolute floor keeps a
// rounding-level demand on a near-zero-fee shape from tripping the multiple.
export const MAX_FEE_DEMAND_MULTIPLE = 20;
const FEE_DEMAND_FLOOR = 1_000_000; // 0.01 KAS — below this, any demand is honest noise

/**
 * Refuse a node-demanded fee that is out of all proportion to the honest one.
 * @param {number} asked     sompi the node's "required amount of N" names
 * @param {number} computed  sompi this client priced the same shape at (mass × rate)
 * @returns {number} `asked`, when it is sane
 */
export function saneFeeDemand(asked, computed) {
  const a = safeSompi(asked, "the node-demanded fee");
  const ceiling = Math.max(safeSompi(computed, "the priced fee") * MAX_FEE_DEMAND_MULTIPLE, FEE_DEMAND_FLOOR);
  if (a > ceiling) {
    throw new Error(
      `the node demands a ${(a / 1e8).toFixed(4)} KAS fee for a transaction this client prices at ${(computed / 1e8).toFixed(4)} KAS — over ${MAX_FEE_DEMAND_MULTIPLE}×. A node that names its own fee is how a hostile endpoint drains the wallet paying it, so nothing was re-signed. If your node honestly charges this, it is misconfigured — switch endpoints (⚙) and retry.`);
  }
  return a;
}

// Per-tx mass budget for batch splitting. The standard (= block) cap is 500,000
// grams; keep headroom for the fee inputs the sizing loop adds afterwards.
export const MASS_TARGET = 480_000; // grams
const FUNDING_RESERVE = 12_000; // grams reserved for ~10 fee inputs within MASS_TARGET

// The vault covenant's compiled deposit loop unrolls over at most 16 tx inputs:
// a 17-input spend fails script verification outright (engine-measured — 14
// strays + covenant + 1 fee input passes, one more stray fails). Since the
// compute-budget calibration this contract cap, not tx mass, is what bounds a
// batch. The sweep engine additionally shrinks a batch when the fee needs more
// than one wallet input.
// KoRoot now carries the same bound (its createProposal / executeConfig walks
// over the root-input set use the same loop form), so every covenant spend in
// this app — sweep, vote, execute and propose alike — shares this one ceiling.
// contracts/KoVault.test.json and contracts/KoRoot.test.json each pin it with a
// 16-input spend that passes and a 17-input spend that does not.
export const MAX_TX_INPUTS = 16;

// Strays below this are skipped by default: sweeping one costs the sweeper a
// per-input fee (~0.01–0.014 KAS) regardless of its value, and anyone can shower
// a vault address with tiny deposits. Unswept strays are safe to leave — the
// deposit branch only ever lets them be consolidated back into the vault.
export const DUST_FLOOR = 5_000_000; // 0.05 KAS

// Fee mass the node prices: max(compute, transient normalized to the compute
// scale). Post-toccata block limits are 500k compute / 1M transient grams, so
// the transient cofactor is 0.5 (check_transaction_standard compares the fee
// against masses.compute.max(ceil(transient × L_c/L_t)) × rate). Against an
// older compute-only node this only ever overpays; a future repricing is
// caught by the "required amount of N" submit retry.
export const feeMassOf = (m) => Math.max(Number(m.computeMass), Math.ceil(Number(m.transientMass) / 2));

// Greedy largest-first coin selection over `fents` (assumed sorted descending),
// taking at most `maxCount` of them. The cap exists because a covenant spend is
// bounded at MAX_TX_INPUTS inputs TOTAL: the funding inputs share that budget
// with the inputs the covenant itself contributes, so an uncapped pick on a
// fragmented wallet builds a transaction the vault script rejects outright.
// `capped` says the cap — not the balance — is why `sum` fell short, which is
// what lets the caller say "consolidate your wallet" instead of "add funds".
export const pickFrom = (fents, need, maxCount = Infinity) => {
  const picked = []; let sum = 0;
  for (const e of fents) {
    if (picked.length >= maxCount) break;
    picked.push(e); sum += e.amount;
    if (sum >= need) break;
  }
  return { picked, sum, capped: sum < need && picked.length >= maxCount };
};

// Wallet UTXOs a covenant operation may attach: the ceiling less the inputs the
// covenant itself brings — 1 for approve/reject (the proposal UTXO), 2 for
// execute/executeConfig (vault-or-root + proposal).
export const fundingSlots = (covenantInputs) => Math.max(0, MAX_TX_INPUTS - covenantInputs);

// Fee-size a covenant OPERATION paid from the owner's wallet. Same fixed point
// as sizeFee — the mass depends on how many funding inputs the fee needs, and
// the fee is that mass × rate — with two differences: it opens at the true mass
// price (SWEEP_FEE_FLOOR is a sweep-sized guess, several times a covenant op's
// real fee) and picks enough to leave change above CHANGE_FLOOR, so no wallet
// value is folded away; and the pick is bounded by the input ceiling above.
// massOf(picked) is injected by the caller (wasm), so this stays pure.
// Returns { fee, picked, sum, slots, short, capped } — `short` = the pick can't
// cover the fee; `capped` = ...and the ceiling is the reason, i.e. the wallet
// holds further UTXOs that simply do not fit.
export const sizeOpFee = (massOf, fents, covenantInputs, minFee = 0, rate = MIN_RELAY_FEE_RATE, rounds = 6) => {
  const slots = fundingSlots(covenantInputs);
  let picked = [], sum = 0, fee = minFee;
  for (let i = 0; i < rounds; i++) {
    ({ picked, sum } = pickFrom(fents, Math.max(1, fee && fee + CHANGE_FLOOR), slots));
    const f = Math.max(minFee, massOf(picked) * rate);
    if (f <= fee) break;
    fee = f;
  }
  const short = sum < fee;
  return { fee, picked, sum, slots, short, capped: short && picked.length >= slots && fents.length > picked.length };
};

// fee = mass × rate, but the mass depends on how many funding inputs the fee
// needs — iterate to the fixed point (mass only grows when the pick grows).
export const sizeFee = (massOf, fents, rate, floor = SWEEP_FEE_FLOOR) => {
  let fee = floor, picked, sum, mass = 0;
  for (let i = 0; i < 20; i++) {
    ({ picked, sum } = pickFrom(fents, fee));
    mass = massOf(picked);
    if (mass * rate <= fee) return { fee, picked, sum, mass }; // pick covers fee, fee covers this pick's mass
    fee = mass * rate;
  }
  // cap exhausted (heavily fragmented wallet): re-pick so picked/sum match the
  // final fee — any residual shortfall surfaces via the submit retry
  ({ picked, sum } = pickFrom(fents, fee));
  return { fee, picked, sum, mass };
};

export const fold = (s) => { if (s.sum > s.fee && s.sum - s.fee < CHANGE_FLOOR) s.fee = s.sum; return s; };

// Split items (already sorted largest-first) into batches of ≤ perBatch.
export const splitBatches = (items, perBatch) => {
  const out = [];
  for (let i = 0; i < items.length; i += perBatch) out.push(items.slice(i, i + perBatch));
  return out;
};

// How many strays fit one tx: the contract's input cap (covenant + strays + one
// fee input ≤ MAX_TX_INPUTS) and the mass budget, whichever binds first.
export const perBatchCap = (baseMass, perStrayMass, massTarget = MASS_TARGET) =>
  Math.max(1, Math.min(
    MAX_TX_INPUTS - 2, // covenant input + 1 fee input reserved
    Math.floor((massTarget - baseMass - FUNDING_RESERVE) / Math.max(1, perStrayMass)),
  ));

// Partition strays into sweep-worthy vs dust (below `floor`). amt() adapts the
// item shape (node entries use .amount, UI strays use .amountSompi).
export const partitionDust = (items, floor, amt = (x) => x.amount) => {
  const keep = [], dust = [];
  for (const it of items) (amt(it) >= floor ? keep : dust).push(it);
  return { keep, dust, dustSompi: dust.reduce((a, x) => a + amt(x), 0) };
};

// Closed-form pre-sweep quote from the measured marginals (mass is independent
// of txids/amounts, so two wasm calls calibrate it exactly).
export const quotePlan = (strayCount, baseMass, perStrayMass, rate = MIN_RELAY_FEE_RATE, massTarget = MASS_TARGET) => {
  const cap = perBatchCap(baseMass, perStrayMass, massTarget);
  if (strayCount <= 0) return { batches: 0, feeSompi: 0, cap };
  const batches = Math.ceil(strayCount / cap);
  return { batches, feeSompi: (strayCount * perStrayMass + batches * baseMass) * rate, cap };
};
