// Owner-funded covenant ops vs the covenant's INPUT CEILING
// (run: node --test frontend/test/opFunding.test.mjs — no install needed).
//
// KoVault sums the vault inputs with a bounded loop, and the compiler emits
// `require(end - start <= maxDepositInputs)` before unrolling it. A spend of the
// vault therefore fails script verification outright once the transaction
// carries more than MAX_TX_INPUTS inputs — it does not merely overpay, it is
// rejected, with an error that reads as a contract bug rather than as "your
// wallet is too fragmented".
//
// The wasm builder attaches every funding UTXO it is handed (tools/wasm-tx
// attach_funding), and it is right to: the ceiling is a property of the covenant
// being spent, not of the builder. So the cap has to live where the operation is
// PLANNED — sweepPlan.sizeOpFee — and it has to account for the inputs the
// covenant itself contributes: 1 for approve/reject (the proposal UTXO), 2 for
// execute and executeConfig (vault-or-root + proposal).
//
// These tests use the real wasm builders with synthetic UTXOs: mass depends only
// on the transaction SHAPE, so txids and amounts are arbitrary.
import test from "node:test";
import assert from "node:assert/strict";
import W from "./wasm-loader.mjs";
import {
  MAX_TX_INPUTS, MIN_RELAY_FEE_RATE, CHANGE_FLOOR, feeMassOf,
  pickFrom, fundingSlots, sizeOpFee,
} from "../src/sweepPlan.js";
import { rebuildRoot, rebuildVault, proposalTemplateScript, PROPOSAL_STATE_LAYOUT, ROOT_STATE_LAYOUT } from "../src/treasuryRebuild.js";
import { TEMPLATES } from "../src/treasuryTemplates.js";

const ZERO_SIG = "00".repeat(64);
const txid = (c) => String(c).repeat(64);
const vaultRedeem = rebuildVault("ab".repeat(32));
const proposalRedeem = proposalTemplateScript();
const ownerAddr = W.pubkey_address("c0".repeat(32), "testnet");
const spkHex = JSON.parse(W.recipient_info(ownerAddr)).spkHex;
const sigs = (n) => JSON.stringify(Array(n).fill(ZERO_SIG));

// execute (transfer): the op that actually spends the vault, i.e. the one the
// contract ceiling binds. 2 covenant inputs — vault + proposal.
const EXEC_COVENANT_INPUTS = 2;
const execInputs = (picked, fee) => JSON.stringify({
  treasuryId: "8b".repeat(32), vaultRedeem, vaultTxid: txid(2), vaultIndex: 0, vaultAmount: 500_000_000,
  proposalRedeem, propTxid: txid(3), propIndex: 0, propAmount: 45_000_000,
  recipientSpkHex: spkHex, amount: 100_000_000, executorIndex: 0,
  ownerAddress: ownerAddr, fundingUtxos: picked, fee,
});
const build = (picked, fee) => JSON.parse(W.execute_build(execInputs(picked, fee), sigs(1 + picked.length)));
const inputCount = (picked, fee) => JSON.parse(W.borsh_to_rpc_json(build(picked, fee).borshHex)).inputs.length;
// the same massOf wasmTx.feeSizedOp injects: probe the built tx at fee 0
const massOf = (picked) => feeMassOf(JSON.parse(W.borsh_masses(build(picked, 0).borshHex)));

const wallet = (n, amount) => Array.from({ length: n }, (_, i) => ({ txid: txid(i % 10), index: i, amount }));

test("the ceiling is real: the builder attaches every funding UTXO handed to it", () => {
  // Not a bug in the builder — a demonstration of why the planner must cap. 15
  // wallet inputs beside the vault and the proposal is a 17-input spend, and
  // KoVault rejects a 17-input spend outright (contracts/KoVault.test.json:
  // "executeProposal REJECTS a 17-input spend that parks a second vault UTXO
  // past the scan window", and its 16-input sibling that passes).
  assert.equal(inputCount(wallet(15, 1_000_000), 1_000), EXEC_COVENANT_INPUTS + 15);
  assert.ok(EXEC_COVENANT_INPUTS + 15 > MAX_TX_INPUTS);
});

test("fundingSlots subtracts the inputs the covenant itself contributes", () => {
  assert.equal(fundingSlots(1), MAX_TX_INPUTS - 1);  // approve / reject: proposal only
  assert.equal(fundingSlots(2), MAX_TX_INPUTS - 2);  // execute / executeConfig: + vault or root
  assert.equal(fundingSlots(MAX_TX_INPUTS + 5), 0);  // never negative
});

test("pickFrom caps the pick and says the cap — not the balance — is why it fell short", () => {
  const fents = wallet(30, 1_000);
  const un = pickFrom(fents, 25_000);                 // uncapped: the old behaviour
  assert.equal(un.picked.length, 25);
  assert.equal(un.capped, false);
  const cap = pickFrom(fents, 25_000, 14);
  assert.equal(cap.picked.length, 14);
  assert.equal(cap.sum, 14_000);
  assert.equal(cap.capped, true);
  // a pick that fits is never flagged, even when it lands exactly on the cap
  assert.equal(pickFrom(fents, 14_000, 14).capped, false);
});

test("sizeOpFee: a healthy wallet pays from one UTXO", () => {
  const s = sizeOpFee(massOf, wallet(4, 2_000_000_000), EXEC_COVENANT_INPUTS);
  assert.equal(s.picked.length, 1);
  assert.equal(s.short, false);
  assert.equal(s.capped, false);
  assert.ok(s.fee >= massOf(s.picked) * MIN_RELAY_FEE_RATE, "fee covers the mass of the pick that pays it");
  assert.ok(s.sum - s.fee >= CHANGE_FLOOR, "change stays above the dust/KIP-9 floor");
  assert.equal(inputCount(s.picked, s.fee), EXEC_COVENANT_INPUTS + 1);
});

test("sizeOpFee: a fragmented-but-solvent wallet stops at the ceiling and still builds", () => {
  // 40 x 0.05 KAS: covering fee + CHANGE_FLOOR would want ~3 of them, and the
  // cap is never reached — but the point is the built transaction fits.
  const s = sizeOpFee(massOf, wallet(40, 5_000_000), EXEC_COVENANT_INPUTS);
  assert.equal(s.short, false);
  assert.ok(s.picked.length <= s.slots);
  assert.ok(inputCount(s.picked, s.fee) <= MAX_TX_INPUTS);
});

test("sizeOpFee: a DUST-fragmented wallet is refused for the right reason", () => {
  // 200 x 0.0001 KAS = 0.02 KAS, spread so thin that the 14 UTXOs which fit
  // cannot pay the fee. Uncapped, this is exactly the 17+-input transaction the
  // covenant rejects; capped, it is an actionable "consolidate your wallet".
  const fents = wallet(200, 10_000);
  const s = sizeOpFee(massOf, fents, EXEC_COVENANT_INPUTS);
  assert.equal(s.picked.length, s.slots, "the pick stops at the ceiling");
  assert.equal(s.slots, MAX_TX_INPUTS - EXEC_COVENANT_INPUTS);
  assert.equal(s.short, true);
  assert.equal(s.capped, true, "capped: the wallet holds more UTXOs, they just do not fit");
  // and the transaction it would have built without the cap does not fit
  const uncapped = pickFrom(fents, s.fee + CHANGE_FLOOR);
  assert.ok(uncapped.picked.length > s.slots, "uncapped selection blows the ceiling");
  assert.ok(EXEC_COVENANT_INPUTS + uncapped.picked.length > MAX_TX_INPUTS);
});

test("sizeOpFee: a genuinely poor wallet is short but NOT capped", () => {
  // The distinction the error message turns on: two UTXOs, nothing to
  // consolidate — the answer is "add funds", not "consolidate".
  const s = sizeOpFee(massOf, wallet(2, 1_000), EXEC_COVENANT_INPUTS);
  assert.equal(s.short, true);
  assert.equal(s.capped, false);
});

test("no wallet shape can build a covenant op past the ceiling", () => {
  // The regression proper: whatever the fragmentation, planner + builder agree
  // with the contract. Every shape either fits, or is refused before it is built.
  for (const covenantInputs of [1, 2]) {
    for (const n of [1, 2, 5, 13, 14, 15, 16, 17, 50, 500]) {
      for (const amount of [1_000, 100_000, 5_000_000, 2_000_000_000]) {
        const s = sizeOpFee(massOf, wallet(n, amount), covenantInputs);
        assert.ok(s.picked.length + covenantInputs <= MAX_TX_INPUTS,
          `${n}x${amount} @ ${covenantInputs} covenant inputs → ${s.picked.length} funding inputs`);
        if (!s.short) assert.ok(inputCount(s.picked, s.fee) <= MAX_TX_INPUTS, "the BUILT transaction fits too");
      }
    }
  }
});

test("approve gets one more slot than execute, because it spends one fewer covenant UTXO", () => {
  const apBuild = (picked, fee) => JSON.parse(W.approve_build(JSON.stringify({
    proposalRedeem, propTxid: txid(1), propIndex: 0, propAmount: 50_000_000,
    treasuryId: "8b".repeat(32), pStart: PROPOSAL_STATE_LAYOUT.start, ownerIndex: 1,
    ownerAddress: ownerAddr, fundingUtxos: picked, fee,
  }), sigs(1 + picked.length)));
  const apMass = (picked) => feeMassOf(JSON.parse(W.borsh_masses(apBuild(picked, 0).borshHex)));
  const fents = wallet(200, 10_000);
  const ap = sizeOpFee(apMass, fents, 1);
  const ex = sizeOpFee(massOf, fents, 2);
  assert.equal(ap.picked.length, MAX_TX_INPUTS - 1);
  assert.equal(ex.picked.length, MAX_TX_INPUTS - 2);
  assert.equal(JSON.parse(W.borsh_to_rpc_json(apBuild(ap.picked, 0).borshHex)).inputs.length, MAX_TX_INPUTS);
});

// ---------------------------------------------------------- createProposal --
// KoRoot used to have no bounded input scan, so this path was deliberately left
// uncapped. It has one now (both createProposal and executeConfig walk the
// root-input set), which means the proposer's own funding UTXOs share the same
// 16-input ceiling as every other covenant spend — with one covenant input, not
// two, because a proposal spends only the root.
const NUMS = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
const PROPOSAL_COST = 60_000_000; // wasmTx.js: PROPOSAL_BOND + fee headroom
const PROPOSAL_COVENANT_INPUTS = 1;
const rootScript = rebuildRoot(3, 2, 2, [NUMS, NUMS, NUMS, NUMS, NUMS]);
const cpInputs = (picked, fee) => JSON.stringify({
  rootScript, rootTxid: txid(6), rootIndex: 0, rootAmount: 200_000_000,
  treasuryId: "8b".repeat(32), pPrefix: TEMPLATES.proposal.prefix, pSuffix: TEMPLATES.proposal.suffix, vPrefix: TEMPLATES.vault.prefix, vSuffix: TEMPLATES.vault.suffix,
  rStart: ROOT_STATE_LAYOUT.start, operation: 1, recipientSpkHash: "11".repeat(32),
  amount: 1_000_000, maxFee: 10_000_000, expiresAt: 4_000_000_000, executionDelay: 0, proposerIndex: 0,
  ownerAddress: ownerAddr, fundingUtxos: picked, fee,
});
const cpBuild = (picked, fee) => JSON.parse(W.create_proposal_build(cpInputs(picked, fee), sigs(1 + picked.length)));
const cpInputCount = (picked, fee) => JSON.parse(W.borsh_to_rpc_json(cpBuild(picked, fee).borshHex)).inputs.length;

test("createProposal: the builder attaches every funding UTXO here too, so the planner must cap", () => {
  assert.equal(cpInputCount(wallet(20, 5_000_000), 1_000), PROPOSAL_COVENANT_INPUTS + 20);
  assert.ok(PROPOSAL_COVENANT_INPUTS + 20 > MAX_TX_INPUTS);
});

test("createProposal: a solvent wallet funds the bond well inside the ceiling", () => {
  // The normal case: the target is the whole 0.6 KAS bond, not a sub-cent fee,
  // so even a 0.1-KAS-per-UTXO wallet reaches it in 6 of its 15 slots.
  const p = pickFrom(wallet(30, 10_000_000), PROPOSAL_COST, fundingSlots(PROPOSAL_COVENANT_INPUTS));
  assert.equal(p.capped, false);
  assert.ok(p.sum >= PROPOSAL_COST);
  assert.equal(cpInputCount(p.picked, 1_000), PROPOSAL_COVENANT_INPUTS + p.picked.length);
  assert.ok(cpInputCount(p.picked, 1_000) <= MAX_TX_INPUTS);
});

test("createProposal: a dust-fragmented wallet is capped, not silently over-built", () => {
  // 200 x 0.001 KAS = 0.2 KAS. Uncapped this would pick 60 UTXOs for a 61-input
  // transaction that KoRoot now rejects outright; capped it falls short at the
  // ceiling, which is what tells the caller to fall back to the root-funded path
  // with "consolidate your wallet" instead of failing at submit time.
  const fents = wallet(200, 100_000);
  const slots = fundingSlots(PROPOSAL_COVENANT_INPUTS);
  const p = pickFrom(fents, PROPOSAL_COST, slots);
  assert.equal(p.picked.length, slots);
  assert.equal(p.capped, true);
  assert.ok(p.sum < PROPOSAL_COST);
  const uncapped = pickFrom(fents, PROPOSAL_COST);
  assert.ok(PROPOSAL_COVENANT_INPUTS + uncapped.picked.length > MAX_TX_INPUTS,
    "the uncapped pick is exactly the transaction the covenant rejects");
});

test("createProposal: no wallet shape can build a proposal past the ceiling", () => {
  for (const n of [1, 2, 15, 16, 17, 100, 500]) {
    for (const amount of [100_000, 5_000_000, 70_000_000]) {
      const p = pickFrom(wallet(n, amount), PROPOSAL_COST, fundingSlots(PROPOSAL_COVENANT_INPUTS));
      assert.ok(p.picked.length + PROPOSAL_COVENANT_INPUTS <= MAX_TX_INPUTS,
        `${n}x${amount} → ${p.picked.length} funding inputs`);
      if (p.sum >= PROPOSAL_COST) assert.ok(cpInputCount(p.picked, 1_000) <= MAX_TX_INPUTS, "the BUILT transaction fits too");
    }
  }
});
