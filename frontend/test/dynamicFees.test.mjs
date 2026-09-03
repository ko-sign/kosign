// Dynamic covenant-flow fees (run: node --test frontend/test/dynamicFees.test.mjs).
// Uses the real wasm builders (nodejs pkg) with synthetic UTXOs/scripts —
// mass depends only on the tx SHAPE, so txids/amounts are arbitrary.
import test from "node:test";
import assert from "node:assert/strict";
import W from "./wasm-loader.mjs";
import { MIN_RELAY_FEE_RATE, feeMassOf } from "../src/sweepPlan.js";
import { rebuildRoot, rebuildVault, proposalTemplateScript, ROOT_STATE_LAYOUT, PROPOSAL_STATE_LAYOUT } from "../src/treasuryRebuild.js";
import { TEMPLATES } from "../src/treasuryTemplates.js";

const NUMS = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
const ZERO_SIG = "00".repeat(64);
const MAX_COVENANT_FEE = 10_000_000;
const txid = (c) => String(c).repeat(64);
const owners5 = [NUMS, NUMS, NUMS, NUMS, NUMS];
const rootScript = rebuildRoot(3, 2, 2, owners5);
const vaultRedeem = rebuildVault("ab".repeat(32));
const proposalRedeem = proposalTemplateScript();
const ownerAddr = W.pubkey_address("c0".repeat(32), "testnet");
const spkHex = JSON.parse(W.recipient_info(ownerAddr)).spkHex;

const masses = (borshHex) => JSON.parse(W.borsh_masses(borshHex));
const price = (borshHex) => feeMassOf(masses(borshHex)) * MIN_RELAY_FEE_RATE;

const apInputs = (fee) => JSON.stringify({
  proposalRedeem, propTxid: txid(1), propIndex: 0, propAmount: 50_000_000,
  treasuryId: "8b".repeat(32), pStart: PROPOSAL_STATE_LAYOUT.start, ownerIndex: 1,
  ...(fee != null ? { fee } : {}),
});

test("mass is fee-invariant: same shape, different fee → identical masses", () => {
  const a = masses(JSON.parse(W.approve_build(apInputs(5_000_000), ZERO_SIG)).borshHex);
  const b = masses(JSON.parse(W.approve_build(apInputs(1_234_567), ZERO_SIG)).borshHex);
  assert.deepEqual(a, b);
});

test("approve: dynamic fee is real, far below the 0.1 KAS covenant cap, and honored by the builder", () => {
  const fee = price(JSON.parse(W.approve_build(apInputs(null), ZERO_SIG)).borshHex);
  assert.ok(fee > 100_000 && fee < MAX_COVENANT_FEE, `approve fee ${fee}`);
  assert.ok(fee < 5_000_000, "dynamic approve fee should undercut the legacy 0.05 KAS");
  // fee override actually moves the continuation value
  const m5 = JSON.parse(W.approve_build(apInputs(5_000_000), ZERO_SIG));
  const mf = JSON.parse(W.approve_build(apInputs(fee), ZERO_SIG));
  assert.notEqual(m5.txid, mf.txid);
});

test("reject prices like approve", () => {
  const probe = JSON.parse(W.reject_build(apInputs(null), ZERO_SIG)).borshHex;
  const fee = price(probe);
  assert.ok(fee > 100_000 && fee < 5_000_000, `reject fee ${fee}`);
});

test("execute (transfer): dynamic fee under the covenant cap", () => {
  const inputs = (fee) => JSON.stringify({
    treasuryId: "8b".repeat(32), vaultRedeem, vaultTxid: txid(2), vaultIndex: 0, vaultAmount: 500_000_000,
    proposalRedeem, propTxid: txid(3), propIndex: 0, propAmount: 45_000_000,
    recipientSpkHex: spkHex, amount: 100_000_000, executorIndex: 0,
    ...(fee != null ? { fee } : {}),
  });
  const probe = JSON.parse(W.execute_build(inputs(null), ZERO_SIG)).borshHex;
  const fee = price(probe);
  assert.ok(fee > 100_000 && fee < MAX_COVENANT_FEE, `execute fee ${fee}`);
  assert.ok(fee < 5_000_000, "dynamic execute fee should undercut the legacy 0.05 KAS");
  // the vault change reflects the override exactly
  const o = JSON.parse(W.execute_build(inputs(fee), ZERO_SIG));
  assert.equal(o.vaultChange, 500_000_000 + 45_000_000 - 100_000_000 - fee);
});

test("execute_config: dynamic fee under the covenant cap", () => {
  const inputs = (fee) => JSON.stringify({
    rootScript, rootTxid: txid(4), rootIndex: 0, rootAmount: 30_000_000,
    proposalRedeem, propTxid: txid(5), propIndex: 0, propAmount: 45_000_000,
    treasuryId: "8b".repeat(32), rStart: ROOT_STATE_LAYOUT.start,
    newThreshold: 1, newOwnerCount: 1, newOwners: owners5, executorIndex: 0,
    ...(fee != null ? { fee } : {}),
  });
  const probe = JSON.parse(W.execute_config_build(inputs(null), ZERO_SIG)).borshHex;
  const fee = price(probe);
  assert.ok(fee > 100_000 && fee < 5_000_000, `config-execute fee ${fee}`);
});

test("create_proposal (root-funded + owner-funded): dynamic fee, and the override shifts values", () => {
  const base = {
    rootScript, rootTxid: txid(6), rootIndex: 0, rootAmount: 200_000_000,
    treasuryId: "8b".repeat(32), pPrefix: TEMPLATES.proposal.prefix, pSuffix: TEMPLATES.proposal.suffix, vPrefix: TEMPLATES.vault.prefix, vSuffix: TEMPLATES.vault.suffix,
    rStart: ROOT_STATE_LAYOUT.start, operation: 1, recipientSpkHash: "11".repeat(32),
    amount: 1_000_000, maxFee: 10_000_000, expiresAt: 4_000_000_000, executionDelay: 0, proposerIndex: 0,
  };
  const rootProbe = JSON.parse(W.create_proposal_build(JSON.stringify(base), ZERO_SIG)).borshHex;
  const rootFee = price(rootProbe);
  assert.ok(rootFee > 100_000 && rootFee < 10_000_000, `root-funded create fee ${rootFee}`);

  const funded = { ...base, ownerAddress: ownerAddr, fundingUtxos: [{ txid: txid(7), index: 0, amount: 100_000_000 }] };
  const ofProbe = JSON.parse(W.create_proposal_build(JSON.stringify(funded), JSON.stringify([ZERO_SIG, ZERO_SIG]))).borshHex;
  const ofFee = price(ofProbe);
  assert.ok(ofFee > 100_000 && ofFee < 10_000_000, `owner-funded create fee ${ofFee}`);
  // owner-funded pays from the wallet; the fee override changes the change value → txid
  const a = JSON.parse(W.create_proposal_build(JSON.stringify({ ...funded, fee: ofFee }), JSON.stringify([ZERO_SIG, ZERO_SIG])));
  const b = JSON.parse(W.create_proposal_build(JSON.stringify({ ...funded, fee: ofFee + 1000 }), JSON.stringify([ZERO_SIG, ZERO_SIG])));
  assert.notEqual(a.txid, b.txid);
});

test("probe at fee 0: a bond barely above the real fee is still spendable (no legacy floor)", () => {
  // propAmount 600k < the legacy 5M constant — the old probe-at-default would
  // throw "too low to approve"; the fee-0 probe prices it and it fits
  const tiny = JSON.stringify({
    proposalRedeem, propTxid: txid(9), propIndex: 0, propAmount: 600_000,
    treasuryId: "8b".repeat(32), pStart: PROPOSAL_STATE_LAYOUT.start, ownerIndex: 0, fee: 0,
  });
  const fee = price(JSON.parse(W.approve_build(tiny, ZERO_SIG)).borshHex);
  assert.ok(fee < 600_000, `tiny bond must cover the dynamic fee (${fee})`);
});

test("committed maxFee decodes from the proposal redeem state (offset 60)", () => {
  const base = {
    rootScript, rootTxid: txid(6), rootIndex: 0, rootAmount: 200_000_000,
    treasuryId: "8b".repeat(32), pPrefix: TEMPLATES.proposal.prefix, pSuffix: TEMPLATES.proposal.suffix, vPrefix: TEMPLATES.vault.prefix, vSuffix: TEMPLATES.vault.suffix,
    rStart: ROOT_STATE_LAYOUT.start, operation: 1, recipientSpkHash: "11".repeat(32),
    amount: 1_000_000, maxFee: 1_234_567, expiresAt: 4_000_000_000, executionDelay: 0, proposerIndex: 0, fee: 0,
  };
  const redeem = JSON.parse(W.create_proposal_build(JSON.stringify(base), ZERO_SIG)).proposalRedeemHex;
  const off = (PROPOSAL_STATE_LAYOUT.start + 60) * 2;
  assert.equal(redeem.slice(off, off + 2), "08"); // enc_int marker
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(parseInt(redeem.slice(off + 2 + i * 2, off + 4 + i * 2), 16));
  assert.equal(Number(v), 1_234_567); // the committed maxFee, where stateMaxFee reads it
});

test("genesis: zero change omits the output (smaller mass), positive change keeps it", () => {
  const ginp = (change) => JSON.stringify({
    fundingAddress: ownerAddr, rootRedeem: rootScript, vaultRedeem,
    rootValue: 30_000_000, vaultValue: 30_000_000, change,
    fundingUtxos: [{ txid: txid(8), index: 0, amount: 100_000_000 }],
    payloadHex: W.inscription(1n, JSON.stringify(["c0".repeat(32)]), "ab".repeat(32)),
  });
  const with0 = masses(JSON.parse(W.genesis_build(ginp(0), JSON.stringify([ZERO_SIG]))).borshHex);
  const with1 = masses(JSON.parse(W.genesis_build(ginp(12_345), JSON.stringify([ZERO_SIG]))).borshHex);
  assert.ok(with0.computeMass < with1.computeMass, "change output must be omitted at 0");
  const fee = feeMassOf(with1) * MIN_RELAY_FEE_RATE;
  assert.ok(fee > 50_000 && fee < 10_000_000, `genesis fee ${fee}`);
  assert.ok(fee < 10_000_000, "dynamic genesis fee should undercut the legacy 0.1 KAS");
});

// ---- Owner-funded covenant ops: the 0.1 KAS covenant cap can never freeze a treasury ----
// The covenant rules are `out >= in - maxFee` CAPS. Paying the fee from the
// owner's wallet leaves the covenant output at FULL value, which satisfies them
// with room to spare — so a network repricing past the cap cannot make a treasury
// unspendable. These tests pin exactly that.
const FUND = [{ txid: txid("a"), index: 0, amount: 2_000_000_000 }]; // 20 KAS
const sigs = (n) => JSON.stringify(Array(n).fill(ZERO_SIG));
const outVal = (borshHex, i) => JSON.parse(W.borsh_to_rpc_json(borshHex)).outputs[i].value;

test("approve owner-funded: bond keeps FULL value, fee comes from the wallet", () => {
  const inp = (fee) => JSON.stringify({
    proposalRedeem, propTxid: txid(1), propIndex: 0, propAmount: 50_000_000,
    treasuryId: "8b".repeat(32), pStart: PROPOSAL_STATE_LAYOUT.start, ownerIndex: 1,
    ownerAddress: ownerAddr, fundingUtxos: FUND, fee,
  });
  const o = JSON.parse(W.approve_build(inp(3_000_000), sigs(2)));
  assert.equal(o.ownerFunded, true);
  assert.equal(Number(outVal(o.borshHex, 0)), 50_000_000, "bond must stay whole");
  assert.equal(Number(outVal(o.borshHex, 1)), 2_000_000_000 - 3_000_000, "wallet change = funding - fee");
  // covenant rule out >= in - maxFee: 50M >= 50M - maxFee holds for ANY maxFee
  // one sighash per input
  assert.equal(JSON.parse(W.approve_sighashes(inp(3_000_000))).length, 2);
});

test("FREEZE-PROOF: fees far ABOVE the 0.1 KAS covenant cap still build owner-funded", () => {
  // 1 KAS fee = 10x the compiled cap — impossible covenant-funded, fine here
  const HUGE = 100_000_000;
  const mk = (extra) => JSON.stringify({ ...extra, ownerAddress: ownerAddr, fundingUtxos: FUND, fee: HUGE });

  const ap = JSON.parse(W.approve_build(mk({ proposalRedeem, propTxid: txid(1), propIndex: 0, propAmount: 50_000_000, treasuryId: "8b".repeat(32), pStart: PROPOSAL_STATE_LAYOUT.start, ownerIndex: 1 }), sigs(2)));
  assert.equal(Number(outVal(ap.borshHex, 0)), 50_000_000);

  const rj = JSON.parse(W.reject_build(mk({ proposalRedeem, propTxid: txid(1), propIndex: 0, propAmount: 50_000_000, treasuryId: "8b".repeat(32), pStart: PROPOSAL_STATE_LAYOUT.start, ownerIndex: 1 }), sigs(2)));
  assert.equal(Number(outVal(rj.borshHex, 0)), 50_000_000);

  const ex = JSON.parse(W.execute_build(mk({ treasuryId: "8b".repeat(32), vaultRedeem, vaultTxid: txid(2), vaultIndex: 0, vaultAmount: 500_000_000, proposalRedeem, propTxid: txid(3), propIndex: 0, propAmount: 45_000_000, recipientSpkHex: spkHex, amount: 100_000_000, executorIndex: 0 }), sigs(2)));
  assert.equal(ex.vaultChange, 500_000_000 + 45_000_000 - 100_000_000, "vault keeps everything but the transfer");
  assert.equal(Number(outVal(ex.borshHex, 2)), 2_000_000_000 - HUGE, "wallet pays the whole fee");

  const ec = JSON.parse(W.execute_config_build(mk({ rootScript, rootTxid: txid(4), rootIndex: 0, rootAmount: 30_000_000, proposalRedeem, propTxid: txid(5), propIndex: 0, propAmount: 45_000_000, treasuryId: "8b".repeat(32), rStart: ROOT_STATE_LAYOUT.start, newThreshold: 1, newOwnerCount: 1, newOwners: owners5, executorIndex: 0 }), sigs(2)));
  assert.equal(Number(outVal(ec.borshHex, 0)), 30_000_000 + 45_000_000, "root keeps root + bond in full");

  // …and the SAME fee is unbuildable covenant-funded — that is exactly the
  // freeze this change removes (a 0.5 KAS bond simply cannot pay a 1 KAS fee)
  const capped = JSON.stringify({ proposalRedeem, propTxid: txid(1), propIndex: 0, propAmount: 50_000_000, treasuryId: "8b".repeat(32), pStart: PROPOSAL_STATE_LAYOUT.start, ownerIndex: 1, fee: HUGE });
  assert.throws(() => W.approve_build(capped, ZERO_SIG), /too low to approve/);
  // and even a fee the bond COULD pay violates the covenant cap once it exceeds
  // maxFee: the continuation would leak 0.2 KAS > the 0.1 KAS the rule allows
  const overCap = JSON.stringify({ proposalRedeem, propTxid: txid(1), propIndex: 0, propAmount: 50_000_000, treasuryId: "8b".repeat(32), pStart: PROPOSAL_STATE_LAYOUT.start, ownerIndex: 1, fee: 20_000_000 });
  const leak = 50_000_000 - Number(outVal(JSON.parse(W.approve_build(overCap, ZERO_SIG)).borshHex, 0));
  assert.ok(leak > MAX_COVENANT_FEE, "covenant-funded at 0.2 KAS leaks past the 0.1 KAS rule → node would reject");
});

// createProposal gained a value FLOOR on 2026-08-19: the root continuation and
// the minted proposal must TOGETHER retain `reserveIn - maxProposalFee`. That
// makes the root-funded path capped like every other covenant-funded op, and
// leaves the owner-funded path uncapped — the same freeze-proof shape as above.
test("create_proposal: the root-funded path is capped by the new value floor; owner-funded is not", () => {
  const base = {
    rootScript, rootTxid: txid(6), rootIndex: 0, rootAmount: 200_000_000,
    treasuryId: "8b".repeat(32), pPrefix: TEMPLATES.proposal.prefix, pSuffix: TEMPLATES.proposal.suffix, vPrefix: TEMPLATES.vault.prefix, vSuffix: TEMPLATES.vault.suffix,
    rStart: ROOT_STATE_LAYOUT.start, operation: 1, recipientSpkHash: "11".repeat(32),
    amount: 1_000_000, maxFee: 10_000_000, expiresAt: 4_000_000_000, executionDelay: 0, proposerIndex: 0,
  };
  const idBearingSum = (borshHex) => Number(outVal(borshHex, 0)) + Number(outVal(borshHex, 1));

  // root-funded at the real dynamic fee: the pair keeps well over the floor
  const okFee = price(JSON.parse(W.create_proposal_build(JSON.stringify({ ...base, fee: 0 }), ZERO_SIG)).borshHex);
  assert.ok(okFee < MAX_COVENANT_FEE, `root-funded create fee ${okFee} must sit under the cap`);
  const ok = JSON.parse(W.create_proposal_build(JSON.stringify({ ...base, fee: okFee }), ZERO_SIG));
  assert.ok(idBearingSum(ok.borshHex) >= base.rootAmount - MAX_COVENANT_FEE, "floor holds at the real fee");

  // root-funded at 2x the cap: the pair falls under the floor → the covenant
  // rejects it, which is why buildProposal clamps this path client-side
  const over = JSON.parse(W.create_proposal_build(JSON.stringify({ ...base, fee: 20_000_000 }), ZERO_SIG));
  assert.ok(idBearingSum(over.borshHex) < base.rootAmount - MAX_COVENANT_FEE,
    "root-funded at 0.2 KAS breaks the floor → node would reject");

  // owner-funded at 10x the cap: KoRoot is untouched, so the floor holds anyway
  const funded = JSON.parse(W.create_proposal_build(JSON.stringify({
    ...base, ownerAddress: ownerAddr, fundingUtxos: FUND, fee: 100_000_000,
  }), sigs(2)));
  assert.ok(idBearingSum(funded.borshHex) >= base.rootAmount - MAX_COVENANT_FEE,
    "owner-funded keeps the pair whole at ANY fee — no ceiling");
});

test("owner-funded: exact-fee funding omits the dust change output", () => {
  const exact = [{ txid: txid("b"), index: 0, amount: 3_000_000 }];
  const o = JSON.parse(W.approve_build(JSON.stringify({
    proposalRedeem, propTxid: txid(1), propIndex: 0, propAmount: 50_000_000,
    treasuryId: "8b".repeat(32), pStart: PROPOSAL_STATE_LAYOUT.start, ownerIndex: 1,
    ownerAddress: ownerAddr, fundingUtxos: exact, fee: 3_000_000,
  }), sigs(2)));
  assert.equal(JSON.parse(W.borsh_to_rpc_json(o.borshHex)).outputs.length, 1, "no zero-value change output");
});

test("owner-funded: wallet short of the fee is a clear error, not a bad tx", () => {
  assert.throws(() => W.approve_build(JSON.stringify({
    proposalRedeem, propTxid: txid(1), propIndex: 0, propAmount: 50_000_000,
    treasuryId: "8b".repeat(32), pStart: PROPOSAL_STATE_LAYOUT.start, ownerIndex: 1,
    ownerAddress: ownerAddr, fundingUtxos: [{ txid: txid("c"), index: 0, amount: 1000 }], fee: 3_000_000,
  }), sigs(2)), /can't cover/);
});

// ---- review-confirmed regressions, pinned ----------------------------------
test("owner-funded fee is priced from true mass, not sweepPlan's 0.01 KAS sweep floor", async () => {
  const SP = await import("../src/sweepPlan.js");
  const inputs0 = { proposalRedeem, propTxid: txid(1), propIndex: 0, propAmount: 50_000_000, treasuryId: "8b".repeat(32), pStart: PROPOSAL_STATE_LAYOUT.start, ownerIndex: 1 };
  const fents = [{ txid: txid("d"), index: 0, amount: 5_000_000_000 }];
  const massOf = (picked) => feeMassOf(JSON.parse(W.borsh_masses(
    JSON.parse(W.approve_build(JSON.stringify({ ...inputs0, ownerAddress: ownerAddr, fundingUtxos: picked, fee: 0 }), sigs(1 + picked.length))).borshHex)));
  const trueFee = massOf(fents) * MIN_RELAY_FEE_RATE;
  assert.ok(trueFee < 1_000_000, `true owner-funded approve fee ${trueFee} must be under the sweep floor`);
  // sizeFee at the sweep default would return the floor; the op path must not
  assert.equal(SP.sizeFee(massOf, fents, MIN_RELAY_FEE_RATE).fee, SP.SWEEP_FEE_FLOOR);
  assert.equal(SP.sizeFee(massOf, fents, MIN_RELAY_FEE_RATE, 0).fee, trueFee);
});

test("owner-funded pick leaves change above CHANGE_FLOOR (no wallet value folded away)", async () => {
  const SP = await import("../src/sweepPlan.js");
  const inputs0 = { proposalRedeem, propTxid: txid(1), propIndex: 0, propAmount: 50_000_000, treasuryId: "8b".repeat(32), pStart: PROPOSAL_STATE_LAYOUT.start, ownerIndex: 1 };
  // wallet of 0.08 KAS UTXOs: a naive pick would fold ~0.073 KAS into the fee
  const fents = Array.from({ length: 6 }, (_, i) => ({ txid: txid(i + 1), index: 0, amount: 8_000_000 }));
  const massOf = (picked) => feeMassOf(JSON.parse(W.borsh_masses(
    JSON.parse(W.approve_build(JSON.stringify({ ...inputs0, ownerAddress: ownerAddr, fundingUtxos: picked, fee: 0 }), sigs(1 + picked.length))).borshHex)));
  // mirror wasmTx.feeSizedOp's sizing loop
  let picked = [], sum = 0, fee = 0;
  for (let i = 0; i < 6; i++) {
    ({ picked, sum } = SP.pickFrom(fents, Math.max(1, fee && fee + SP.CHANGE_FLOOR)));
    const f = massOf(picked) * MIN_RELAY_FEE_RATE;
    if (f <= fee) break;
    fee = f;
  }
  const change = sum - fee;
  assert.ok(change >= SP.CHANGE_FLOOR || sum < fee, `change ${change} must clear the floor (picked ${picked.length} UTXOs)`);
  assert.ok(fee < 2_000_000, `fee ${fee} must stay near the true price, not swallow the pick`);
});
