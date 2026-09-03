// TN10 on-chain E2E for DYNAMIC covenant-flow fees (genesis / propose /
// approve / reject / execute / config-execute), mirroring wasmTx.js's fee
// logic against the real wasm builders + a public node.
// MANUAL test: spends real TN10 funds from .secrets/wallet.testnet.json.
// Phase 1 recovers the throwaway Treasuries left by the sweep E2E (chain-recovery →
// dynamic-fee propose → execute back to the dev wallet), so it usually leaves
// the wallet RICHER than it started.
//   node frontend/test/e2e-dynamic-fees.manual.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(FRONTEND, "..");
const req = createRequire(`${FRONTEND}/package.json`);
const W = (await import(`${FRONTEND}/test/wasm-loader.mjs`)).default;
const { schnorr } = await import(pathToFileURL(req.resolve("@noble/curves/secp256k1.js")));
const { bytesToHex, hexToBytes } = await import(pathToFileURL(req.resolve("@noble/hashes/utils.js")));
const { connectWrpc } = await import(`${FRONTEND}/src/wrpc.js`);
const { rebuildRoot, rebuildVault, proposalTemplateScript, ROOT_STATE_LAYOUT, PROPOSAL_STATE_LAYOUT } = await import(`${FRONTEND}/src/treasuryRebuild.js`);
const { TEMPLATES } = await import(`${FRONTEND}/src/treasuryTemplates.js`);
const SP = await import(`${FRONTEND}/src/sweepPlan.js`);
const { MIN_RELAY_FEE_RATE, CHANGE_FLOOR, feeMassOf } = SP;
const { recoverTreasuryFromChain } = await import(`${FRONTEND}/src/kaspaRest.js`);
const { walkRoot } = await import(`${FRONTEND}/src/proposalScan.js`);

const wallet = JSON.parse(readFileSync(`${REPO}/.secrets/wallet.testnet.json`, "utf8"));
const keyB = "22".repeat(32); // deterministic second owner for the 2-of-2 matrix
const pubB = bytesToHex(schnorr.getPublicKey(hexToBytes(keyB)));
const signWith = (priv) => (sh) => bytesToHex(schnorr.sign(hexToBytes(sh), hexToBytes(priv)));
const signA = signWith(wallet.private_key), signB = signWith(keyB);
const NUMS = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
const ZERO_SIG = "00".repeat(64);
const MAX_COVENANT_FEE = 10_000_000;
const BOND = 50_000_000;
const die = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };
const assert = (c, m) => { if (!c) die(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KAS = (s) => (s / 1e8).toFixed(4);

// every fee this run pays, asserted dynamic (< the legacy constant) at the end
const paidFees = [];
const price = (borshHex, cap = MAX_COVENANT_FEE) => {
  const fee = feeMassOf(JSON.parse(W.borsh_masses(borshHex))) * MIN_RELAY_FEE_RATE;
  assert(!cap || fee <= cap, `fee ${fee} exceeds covenant cap`);
  return fee;
};

// ---- node ------------------------------------------------------------------
const RESOLVERS = ["eric.kaspa.stream", "john.kaspa.red", "jake.kaspa.green", "noah.kaspa.blue", "maxim.kaspa.stream", "mike.kaspa.red"];
let c = null;
for (const r of RESOLVERS.sort(() => Math.random() - 0.5)) {
  try {
    const { url } = await (await fetch(`https://${r}/v2/kaspa/testnet-10/any/wrpc/borsh`, { signal: AbortSignal.timeout(5000) })).json();
    const t = connectWrpc(url.replace(/\/wrpc\/borsh$/, "/wrpc/json"));
    await t.ready; await t.getInfo(); c = t; console.log(`node: ${url.replace(/\/wrpc\/borsh$/, "/wrpc/json")}`); break;
  } catch { /* next */ }
}
assert(c, "no public node reachable");

const toU = (e) => ({ txid: e.outpoint.transactionId, index: e.outpoint.index, amount: Number(e.utxoEntry.amount) });
const utxosOf = async (addr) => ((await c.getUtxos([addr])).entries || []);
const walletUtxos = async (addr) => (await utxosOf(addr)).filter((e) => !e.utxoEntry.covenantId).map(toU).sort((a, b) => b.amount - a.amount);
const submit = async (borshHex) => (await c.submit(JSON.parse(W.borsh_to_rpc_json(borshHex)))).transactionId;
const waitUtxo = async (addr, pred, tries = 50) => {
  for (let i = 0; i < tries; i++) { const hit = (await utxosOf(addr)).find(pred); if (hit) return hit; await sleep(400); }
  return null;
};

// ---- dynamic-fee flow drivers (mirror wasmTx.js) -----------------------------
// covenant-funded (legacy path, capped at 0.1 KAS by the contracts)
const singleSig = (buildFn, sighashFn, inputs0, signer) => {
  const probe = JSON.parse(buildFn(JSON.stringify({ ...inputs0, fee: 0 }), ZERO_SIG)).borshHex;
  const fee = price(probe);
  const inp = JSON.stringify({ ...inputs0, fee });
  const out = JSON.parse(buildFn(inp, signer(sighashFn(inp))));
  paidFees.push({ fee, legacy: 5_000_000 });
  return { fee, out };
};

// owner-funded (the freeze-proof path): the covenant output keeps FULL value
// and the fee comes from the wallet — no covenant cap applies. `forceFee`
// deliberately overpays to prove fees ABOVE the 0.1 KAS cap are submittable.
async function ownerFunded(buildFn, sighashesFn, inputs0, signer, forceFee) {
  const fents = await walletUtxos(wallet.address);
  const dummy = (n) => JSON.stringify(Array(n).fill(ZERO_SIG));
  const build0 = (picked, fee) => JSON.parse(buildFn(JSON.stringify({ ...inputs0, ownerAddress: wallet.address, fundingUtxos: picked, fee }), dummy(1 + picked.length)));
  const massOf = (picked) => feeMassOf(JSON.parse(W.borsh_masses(build0(picked, 0).borshHex)));
  let s = SP.fold(SP.sizeFee(massOf, fents, MIN_RELAY_FEE_RATE));
  if (forceFee) { const p2 = SP.pickFrom(fents, forceFee); s = SP.fold({ ...p2, fee: forceFee, mass: 0 }); }
  assert(s.sum >= s.fee, "wallet can't cover the owner-funded fee");
  const inp = JSON.stringify({ ...inputs0, ownerAddress: wallet.address, fundingUtxos: s.picked, fee: s.fee });
  const shs = JSON.parse(sighashesFn(inp));
  const out = JSON.parse(buildFn(inp, JSON.stringify(shs.map((sh, i) => signer(sh, i)))));
  assert(out.ownerFunded === true, "builder must report ownerFunded");
  if (!forceFee) paidFees.push({ fee: s.fee, legacy: 5_000_000 });
  return { fee: s.fee, out };
}

async function propose(ctx, { operation = 1, recipientSpkHash, amount, proposerIndex, signer }) {
  // owner-funded from the dev wallet (KoRoot untouched), like production
  const fents = await walletUtxos(wallet.address);
  const picked = []; let sum = 0;
  for (const u of fents) { picked.push(u); sum += u.amount; if (sum >= BOND + MAX_COVENANT_FEE) break; }
  assert(sum >= BOND + MAX_COVENANT_FEE, "dev wallet can't fund a proposal");
  const base0 = {
    rootScript: ctx.rootRedeem, rootTxid: ctx.root.txid, rootIndex: ctx.root.index, rootAmount: ctx.root.value,
    treasuryId: ctx.treasuryId, pPrefix: TEMPLATES.proposal.prefix, pSuffix: TEMPLATES.proposal.suffix, vPrefix: TEMPLATES.vault.prefix, vSuffix: TEMPLATES.vault.suffix,
    rStart: ROOT_STATE_LAYOUT.start, operation, recipientSpkHash, amount,
    maxFee: MAX_COVENANT_FEE, expiresAt: 4_000_000_000, executionDelay: 0, proposerIndex,
    ownerAddress: wallet.address, fundingUtxos: picked,
  };
  const nSigs = 1 + picked.length;
  const probe = JSON.parse(W.create_proposal_build(JSON.stringify(base0), JSON.stringify(Array(nSigs).fill(ZERO_SIG)))).borshHex;
  let fee = price(probe, 0); // create fee is not covenant-capped
  const change = sum - BOND - fee;
  if (change > 0 && change < CHANGE_FLOOR) fee += change;
  const inputs = JSON.stringify({ ...base0, fee });
  const shs = JSON.parse(W.create_proposal_sighashes(inputs));
  const out = JSON.parse(W.create_proposal_build(inputs, JSON.stringify(shs.map((sh) => signer(sh)))));
  const txid = await submit(out.borshHex);
  paidFees.push({ fee, legacy: 10_000_000 });
  console.log(`  propose op${operation} fee ${KAS(fee)} → ${txid.slice(0, 12)}… status ${out.status}`);
  return { ...out, createTxid: txid, fee };
}

// ---- Phase 1: recover the sweep-E2E throwaway treasuries --------------------------
const THROWAWAY_VAULTS = [
  "kaspatest:pr2kddygp8je4806e0nl6t88ukq2lvwhdyguqhgp83j0n9vrukrkwdx8wetx2",
  "kaspatest:pzx4lp2m3qwv8wevgqhvulcvjtw6ry5jnzttmmtczerhfeaexvjcxxtyhh2a6",
];
const balBefore = (await walletUtxos(wallet.address)).reduce((a, u) => a + u.amount, 0);
console.log(`dev wallet before: ${KAS(balBefore)} KAS`);

let recovered = 0;
for (const vaultAddress of THROWAWAY_VAULTS) {
  console.log(`recovering ${vaultAddress.slice(0, 28)}…`);
  let rec;
  try { rec = await recoverTreasuryFromChain(vaultAddress); } catch (e) { console.log(`  skip (REST): ${e.message}`); continue; }
  if (!rec?.ok) { console.log("  skip: inscription not found/indexed yet"); continue; }
  const owners = rec.status.owners.map((o) => o.pubkey);
  const owners5 = [...owners]; while (owners5.length < 5) owners5.push(NUMS);
  assert(owners[0] === wallet.xonly_pubkey && rec.status.threshold === 1, "throwaway treasury isn't 1-of-1 dev-owned");
  const vaultRedeem = rebuildVault(rec.status.lineage);
  const covEnt = (await utxosOf(vaultAddress)).find((e) => e.utxoEntry.covenantId);
  if (!covEnt) { console.log("  skip: no covenant UTXO"); continue; }
  const treasuryId = covEnt.utxoEntry.covenantId;
  if (Number(covEnt.utxoEntry.amount) < 100_000_000) { console.log(`  skip: vault ${KAS(Number(covEnt.utxoEntry.amount))} KAS < the 0.5 KAS bond a drain costs`); continue; }
  const { live } = await walkRoot({
    treasuryId, genesisTxid: rec.status.genesisTxId, threshold: 1, ownerCount: owners.length, owners5,
    p2sh: (hex) => W.p2sh_address(hex, "testnet"),
    getUtxos: async (addr) => utxosOf(addr),
  });
  assert(live, "root walk failed");
  const ctx = { treasuryId, rootRedeem: live.redeem, root: { txid: live.outpoint.txid, index: live.outpoint.index, value: live.value } };
  const vaultBal = Number(covEnt.utxoEntry.amount);
  const rinfo = JSON.parse(W.recipient_info(wallet.address));
  const prop = await propose(ctx, { recipientSpkHash: rinfo.spkHash, amount: vaultBal, proposerIndex: 0, signer: signA });
  assert(prop.status === 1, "1-of-1 proposal must be born Approved");
  assert(await waitUtxo(W.p2sh_address(prop.proposalRedeemHex, "testnet"), (e) => e.outpoint.transactionId === prop.createTxid), "proposal UTXO didn't appear");
  const { fee, out } = singleSig(W.execute_build, W.execute_sighash, {
    treasuryId, vaultRedeem, vaultTxid: covEnt.outpoint.transactionId, vaultIndex: covEnt.outpoint.index, vaultAmount: vaultBal,
    proposalRedeem: prop.proposalRedeemHex, propTxid: prop.createTxid, propIndex: 1, propAmount: BOND,
    recipientSpkHex: rinfo.spkHex, amount: vaultBal, executorIndex: 0,
  }, signA);
  const xtxid = await submit(out.borshHex);
  console.log(`  execute fee ${KAS(fee)} → ${xtxid.slice(0, 12)}… drained ${KAS(vaultBal)} KAS back`);
  recovered += vaultBal;
  await sleep(600);
}
console.log(`phase 1 done: recovered ${KAS(recovered)} KAS from throwaway treasuries`);

// ---- Phase 2: fresh 2-of-2 — full matrix with dynamic fees -------------------
console.log("phase 2: 2-of-2 matrix (genesis/propose/approve/reject/execute/config)…");
const owners2 = [wallet.xonly_pubkey, pubB];
const owners5b = [...owners2, NUMS, NUMS, NUMS];
const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const rootRedeem0 = rebuildRoot(0, 2, 2, owners5b);
const vaultRedeem2 = rebuildVault(salt);
const vaultAddr2 = W.p2sh_address(vaultRedeem2, "testnet");

// genesis with a mass-priced fee
let treasuryId2, genTxid;
{
  const rootV = 30_000_000, vaultV = 30_000_000, ceil = 10_000_000;
  const fents = await walletUtxos(wallet.address);
  const picked = []; let sum = 0;
  for (const u of fents) { picked.push(u); sum += u.amount; if (sum >= rootV + vaultV + ceil) break; }
  assert(sum >= rootV + vaultV + ceil, "wallet too low for genesis");
  const payload = W.inscription(2n, JSON.stringify(owners2), salt);
  const mk = (fee, change) => JSON.stringify({ fundingAddress: wallet.address, rootRedeem: rootRedeem0, vaultRedeem: vaultRedeem2, rootValue: rootV, vaultValue: vaultV, change, fundingUtxos: picked, payloadHex: payload });
  const probe = JSON.parse(W.genesis_build(mk(ceil, 1), JSON.stringify(picked.map(() => ZERO_SIG)))).borshHex;
  let fee = price(probe, 0);
  let change = sum - rootV - vaultV - fee;
  if (change > 0 && change < CHANGE_FLOOR) { fee += change; change = 0; }
  const ginp = mk(fee, change);
  const ga = JSON.parse(W.genesis_sighashes(ginp));
  const gout = JSON.parse(W.genesis_build(ginp, JSON.stringify(ga.sighashes.map((sh) => signA(sh)))));
  genTxid = await submit(gout.borshHex);
  treasuryId2 = gout.treasuryId;
  paidFees.push({ fee, legacy: 10_000_000 });
  console.log(`  genesis 2-of-2 fee ${KAS(fee)} → ${genTxid.slice(0, 12)}… treasuryId ${treasuryId2.slice(0, 12)}…`);
}
assert(await waitUtxo(vaultAddr2, (e) => e.utxoEntry.covenantId), "2-of-2 vault didn't appear");

// Track the root locally like production treasuryState does (owner-funded proposes
// keep the root VALUE; every root spend moves the outpoint to output 0) — the
// REST indexer lags seconds-old addresses, so walking mid-run is flaky.
let root2 = { redeem: rootRedeem0, txid: genTxid, index: 0, value: 30_000_000 };
const ctxOf = () => ({ treasuryId: treasuryId2, rootRedeem: root2.redeem, root: { txid: root2.txid, index: root2.index, value: root2.value } });

// propose (A) → Pending; approve (B) → Approved; execute (A) → funds move
{
  const rinfo = JSON.parse(W.recipient_info(wallet.address));
  const amount = 10_000_000; // move 0.1 KAS of the vault
  const prop = await propose(ctxOf(), { recipientSpkHash: rinfo.spkHash, amount, proposerIndex: 0, signer: signA });
  root2 = { ...root2, redeem: prop.rootContHex, txid: prop.createTxid, index: 0 };
  assert(prop.status === 0, "2-of-2 proposal must start Pending");
  await waitUtxo(W.p2sh_address(prop.proposalRedeemHex, "testnet"), (e) => e.outpoint.transactionId === prop.createTxid);
  // owner-funded approve: the bond stays WHOLE (owner A's wallet pays; owner B
  // signs the covenant input) — this is the path that removes the fee ceiling
  const ap = await ownerFunded(W.approve_build, W.approve_sighashes, {
    proposalRedeem: prop.proposalRedeemHex, propTxid: prop.createTxid, propIndex: 1, propAmount: BOND,
    treasuryId: treasuryId2, pStart: PROPOSAL_STATE_LAYOUT.start, ownerIndex: 1,
  }, (sh, i) => (i === 0 ? signB(sh) : signA(sh))); // owner B approves; owner A's wallet pays
  const apTxid = await submit(ap.out.borshHex);
  assert(ap.out.status === 1, "approve by B must reach threshold");
  console.log(`  approve fee ${KAS(ap.fee)} OWNER-FUNDED (bond stays ${KAS(BOND)}) → ${apTxid.slice(0, 12)}… status 1`);
  const covEnt = (await utxosOf(vaultAddr2)).find((e) => e.utxoEntry.covenantId);
  await sleep(600);
  const ex = singleSig(W.execute_build, W.execute_sighash, {
    treasuryId: treasuryId2, vaultRedeem: vaultRedeem2, vaultTxid: covEnt.outpoint.transactionId, vaultIndex: covEnt.outpoint.index, vaultAmount: Number(covEnt.utxoEntry.amount),
    proposalRedeem: ap.out.newRedeemHex, propTxid: apTxid, propIndex: 0, propAmount: BOND, // owner-funded approve kept the bond whole
    recipientSpkHex: rinfo.spkHex, amount, executorIndex: 0,
  }, signA);
  const exTxid = await submit(ex.out.borshHex);
  console.log(`  execute fee ${KAS(ex.fee)} → ${exTxid.slice(0, 12)}…`);
}

// propose (A) → reject (B) → Failed at 2-of-2 (1 remaining approver < threshold)
{
  await sleep(600);
  const rinfo = JSON.parse(W.recipient_info(wallet.address));
  const prop = await propose(ctxOf(), { recipientSpkHash: rinfo.spkHash, amount: 1_000_000, proposerIndex: 0, signer: signA });
  root2 = { ...root2, redeem: prop.rootContHex, txid: prop.createTxid, index: 0 };
  await waitUtxo(W.p2sh_address(prop.proposalRedeemHex, "testnet"), (e) => e.outpoint.transactionId === prop.createTxid);
  const rj = singleSig(W.reject_build, W.reject_sighash, {
    proposalRedeem: prop.proposalRedeemHex, propTxid: prop.createTxid, propIndex: 1, propAmount: BOND,
    treasuryId: treasuryId2, pStart: PROPOSAL_STATE_LAYOUT.start, ownerIndex: 1,
  }, signB);
  const rjTxid = await submit(rj.out.borshHex);
  assert(rj.out.status === 2, "reject by B must Fail the 2-of-2 proposal");
  console.log(`  reject fee ${KAS(rj.fee)} → ${rjTxid.slice(0, 12)}… status 2 (Failed)`);
}

// config proposal (A) → approve (B) → executeConfig → 1-of-1 (drop owner B)
{
  await sleep(600);
  const owners1 = [wallet.xonly_pubkey, NUMS, NUMS, NUMS, NUMS];
  const commit = W.config_commit(1n, 1n, JSON.stringify(owners1));
  const prop = await propose(ctxOf(), { operation: 2, recipientSpkHash: commit, amount: 1, proposerIndex: 0, signer: signA });
  root2 = { ...root2, redeem: prop.rootContHex, txid: prop.createTxid, index: 0 };
  await waitUtxo(W.p2sh_address(prop.proposalRedeemHex, "testnet"), (e) => e.outpoint.transactionId === prop.createTxid);
  // FREEZE-PROOF, on-chain: pay 0.2 KAS — TWICE the 0.1 KAS cap the covenants
  // allow to leak from the bond. Only possible because the wallet pays and the
  // bond stays whole; covenant-funded this tx could not exist at all.
  const OVER_CAP = 20_000_000;
  const ap = await ownerFunded(W.approve_build, W.approve_sighashes, {
    proposalRedeem: prop.proposalRedeemHex, propTxid: prop.createTxid, propIndex: 1, propAmount: BOND,
    treasuryId: treasuryId2, pStart: PROPOSAL_STATE_LAYOUT.start, ownerIndex: 1,
  }, (sh, i) => (i === 0 ? signB(sh) : signA(sh)), OVER_CAP);
  assert(ap.fee === OVER_CAP && ap.fee > MAX_COVENANT_FEE, "forced over-cap fee not applied");
  const apTxid = await submit(ap.out.borshHex);
  console.log(`  approve fee ${KAS(ap.fee)} = ${(OVER_CAP / MAX_COVENANT_FEE).toFixed(1)}× the covenant cap, ACCEPTED on-chain → ${apTxid.slice(0, 12)}… (freeze-proof)`);
  await sleep(600);
  const ec = singleSig(W.execute_config_build, W.execute_config_sighash, {
    rootScript: root2.redeem, rootTxid: root2.txid, rootIndex: root2.index, rootAmount: root2.value,
    proposalRedeem: ap.out.newRedeemHex, propTxid: apTxid, propIndex: 0, propAmount: BOND, // owner-funded approve kept the bond whole
    treasuryId: treasuryId2, rStart: ROOT_STATE_LAYOUT.start,
    newThreshold: 1, newOwnerCount: 1, newOwners: owners1, executorIndex: 0,
  }, signA);
  const ecTxid = await submit(ec.out.borshHex);
  console.log(`  config-execute fee ${KAS(ec.fee)} → ${ecTxid.slice(0, 12)}… now 1-of-1`);
  root2 = { redeem: ec.out.newRootHex, txid: ecTxid, index: 0, value: root2.value + BOND - ec.fee };
  // the node accepting the continuation at the NEW root address proves the
  // config state landed; the born-Approved drain below proves it functionally
  assert(await waitUtxo(W.p2sh_address(ec.out.newRootHex, "testnet"), (e) => e.outpoint.transactionId === ecTxid), "new-config root UTXO didn't appear");
}

// final drain: now 1-of-1 → propose (auto-approved) + execute the whole vault back
{
  await sleep(600);
  const covEnt = (await utxosOf(vaultAddr2)).find((e) => e.utxoEntry.covenantId);
  const vaultBal = Number(covEnt.utxoEntry.amount);
  const rinfo = JSON.parse(W.recipient_info(wallet.address));
  const prop = await propose(ctxOf(), { recipientSpkHash: rinfo.spkHash, amount: vaultBal, proposerIndex: 0, signer: signA });
  assert(prop.status === 1, "post-config 1-of-1 proposal must be born Approved");
  await waitUtxo(W.p2sh_address(prop.proposalRedeemHex, "testnet"), (e) => e.outpoint.transactionId === prop.createTxid);
  const ex = singleSig(W.execute_build, W.execute_sighash, {
    treasuryId: treasuryId2, vaultRedeem: vaultRedeem2, vaultTxid: covEnt.outpoint.transactionId, vaultIndex: covEnt.outpoint.index, vaultAmount: vaultBal,
    proposalRedeem: prop.proposalRedeemHex, propTxid: prop.createTxid, propIndex: 1, propAmount: BOND,
    recipientSpkHex: rinfo.spkHex, amount: vaultBal, executorIndex: 0,
  }, signA);
  await submit(ex.out.borshHex);
  console.log(`  final drain fee ${KAS(ex.fee)} — vault emptied back to the dev wallet`);
}

await sleep(1500);
const balAfter = (await walletUtxos(wallet.address)).reduce((a, u) => a + u.amount, 0);
assert(paidFees.every((f) => f.fee < f.legacy), "every dynamic fee must undercut its legacy constant");
const totalFees = paidFees.reduce((a, f) => a + f.fee, 0);
const legacyFees = paidFees.reduce((a, f) => a + f.legacy, 0);
console.log(`dev wallet after: ${KAS(balAfter)} KAS (Δ ${KAS(balAfter - balBefore)})`);
console.log(`fees: ${paidFees.length} txs, paid ${KAS(totalFees)} vs legacy ${KAS(legacyFees)} (${(legacyFees / totalFees).toFixed(1)}× cheaper)`);
console.log("E2E PASS");
c.close();
process.exit(0);
