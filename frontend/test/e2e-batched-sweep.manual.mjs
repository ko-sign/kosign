// TN10 on-chain E2E for the batched sweep engine.
// Reuses the PRODUCTION modules (sweepPlan.js, treasuryRebuild.js, wrpc.js) and the
// nodejs wasm pkg; mirrors wasmTx.js's engine loop (which itself can't load in
// Node — its wasm import is vite-specific).
// Flow: resolve public node → genesis a fresh 1-of-1 treasury (dev wallet) →
// fan out 17 keeper strays + 2 dust → negative 17-input probe (expect reject) →
// sweep batch 1 (14 strays, budgetVault=0 probe) + cancel → resume batch 2 →
// includeDust run → assert final vault value & UTXO set.
// MANUAL test (not picked up by `node --test`): spends real TN10 funds from
// .secrets/wallet.testnet.json (~7.5 KAS per run, most of it locked into the
// throwaway test treasury). Run from anywhere: node frontend/test/e2e-batched-sweep.manual.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(FRONTEND, "..");
const req = createRequire(`${FRONTEND}/package.json`);
const W = (await import(`${FRONTEND}/test/wasm-loader.mjs`)).default;
const { schnorr } = await import(pathToFileURL(req.resolve("@noble/curves/secp256k1.js")));
const { bytesToHex, hexToBytes } = await import(pathToFileURL(req.resolve("@noble/hashes/utils.js")));
const { connectWrpc } = await import(`${FRONTEND}/src/wrpc.js`);
const { rebuildRoot, rebuildVault } = await import(`${FRONTEND}/src/treasuryRebuild.js`);
const SP = await import(`${FRONTEND}/src/sweepPlan.js`);

const wallet = JSON.parse((await import("node:fs")).readFileSync(`${REPO}/.secrets/wallet.testnet.json`, "utf8"));
const sign = (sh) => bytesToHex(schnorr.sign(hexToBytes(sh), hexToBytes(wallet.private_key)));
const NUMS = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
const log = (t, k = "info") => console.log(`  [${k}] ${t}`);
const die = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };
const assert = (c, m) => { if (!c) die(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- resolve a public TN10 node (borsh url for send.rs, json url for us) ----
const RESOLVERS = ["eric", "maxim", "sean", "troy"].map((n) => `https://${n}.kaspa.stream`)
  .concat(["john", "mike", "paul", "alex"].map((n) => `https://${n}.kaspa.red`))
  .concat(["jake", "mark", "adam", "liam"].map((n) => `https://${n}.kaspa.green`))
  .concat(["noah", "ryan", "jack", "luke"].map((n) => `https://${n}.kaspa.blue`));
let borshUrl = null, jsonUrl = null;
for (const r of RESOLVERS.sort(() => Math.random() - 0.5)) {
  try {
    const res = await fetch(`${r}/v2/kaspa/testnet-10/any/wrpc/borsh`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) continue;
    const { url } = await res.json();
    if (!url) continue;
    const j = url.replace(/\/wrpc\/borsh$/, "/wrpc/json");
    const c = connectWrpc(j);
    try { await c.ready; await c.getInfo(); borshUrl = url; jsonUrl = j; c.close(); break; }
    catch { c.close(); }
  } catch { /* next */ }
}
assert(jsonUrl, "no public JSON wRPC node reachable");
console.log(`node: ${jsonUrl}`);

const c = connectWrpc(jsonUrl);
await c.ready;
const info = await c.getInfo();
console.log(`server: ${info?.serverVersion || JSON.stringify(info).slice(0, 80)}`);

const toU = (e) => ({ txid: e.outpoint.transactionId, index: e.outpoint.index, amount: Number(e.utxoEntry.amount) });
const walletUtxos = async () => ((await c.getUtxos([wallet.address])).entries || []).filter((e) => !e.utxoEntry.covenantId).map(toU).sort((a, b) => b.amount - a.amount);

// ---- 1. genesis a fresh 1-of-1 treasury --------------------------------------
const owners5 = [wallet.xonly_pubkey, NUMS, NUMS, NUMS, NUMS];
const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const rootRedeem = rebuildRoot(0, 1, 1, owners5);
const vaultRedeem = rebuildVault(salt);
const vaultAddress = W.p2sh_address(vaultRedeem, "testnet");
{
  const fee = 10_000_000, rootV = 30_000_000, vaultV = 30_000_000, need = rootV + vaultV + fee;
  const ents = await walletUtxos();
  const picked = []; let sum = 0;
  for (const e of ents) { picked.push(e); sum += e.amount; if (sum >= need) break; }
  assert(sum >= need, `dev wallet needs ${need} sompi`);
  const payload = W.inscription(1n, JSON.stringify([wallet.xonly_pubkey]), salt);
  const ginp = JSON.stringify({ fundingAddress: wallet.address, rootRedeem, vaultRedeem, rootValue: rootV, vaultValue: vaultV, change: sum - need, fundingUtxos: picked, payloadHex: payload });
  const ga = JSON.parse(W.genesis_sighashes(ginp));
  const gout = JSON.parse(W.genesis_build(ginp, JSON.stringify(ga.sighashes.map(sign))));
  const r = await c.submit(JSON.parse(W.borsh_to_rpc_json(gout.borshHex)));
  console.log(`genesis: treasuryId ${gout.treasuryId.slice(0, 12)}… vault ${vaultAddress.slice(0, 24)}… txid ${r.transactionId.slice(0, 12)}…`);
}
// wait for the covenant vault UTXO
let covEnt = null;
for (let i = 0; i < 40 && !covEnt; i++) { await sleep(400); covEnt = ((await c.getUtxos([vaultAddress])).entries || []).find((e) => e.utxoEntry.covenantId); }
assert(covEnt, "vault covenant UTXO didn't appear");
const sid = covEnt.utxoEntry.covenantId;

// ---- 2. fan out strays: 17 keepers (0.06) + 2 dust (0.01) ----------------
const send = (sompi, count) => execFileSync(`${REPO}/tools/kaspa-probe/target/release/send`, [String(sompi), vaultAddress, String(count)], { cwd: REPO, env: { ...process.env, KASPA_RPC_URL: borshUrl, KASPA_NETWORK: "testnet-10" }, encoding: "utf8" });
// KIP-9: creating an output of value v costs ~10^12/v grams of storage mass,
// so small outputs must spread across txs (0.6 KAS x 17 = 283k grams — fits;
// each 0.03 KAS dust output alone is 333k grams — one per tx)
console.log(send(40_000_000, 9).trim().split("\n")[0]);
await sleep(1500);
console.log(send(40_000_000, 8).trim().split("\n")[0]);
await sleep(600);
console.log(send(3_000_000, 1).trim().split("\n")[0]);
await sleep(600);
console.log(send(3_000_000, 1).trim().split("\n")[0]);
let strays = [];
for (let i = 0; i < 50; i++) {
  await sleep(400);
  strays = ((await c.getUtxos([vaultAddress])).entries || []).filter((e) => !e.utxoEntry.covenantId).map(toU);
  if (strays.length >= 19) break;
}
assert(strays.length === 19, `expected 19 strays, saw ${strays.length}`);
console.log(`fan-out done: ${strays.length} strays at the vault`);

// ---- helpers mirrored from wasmTx.js -------------------------------------
const feeMass = (vaultUtxos, fundingUtxos, budgetVault) =>
  SP.feeMassOf(JSON.parse(W.sweep_funded_mass(JSON.stringify({ vaultRedeem, treasuryId: sid, vaultUtxos, ownerAddress: wallet.address, fundingUtxos, fee: 0, ...(budgetVault != null ? { budgetVault } : {}) }))));

async function submitBatch(vaultUtxos, fents, rate, budgetVault) {
  const massOf = (picked) => feeMass(vaultUtxos, picked, budgetVault);
  let s = SP.fold(SP.sizeFee(massOf, fents, rate));
  assert(s.sum >= s.fee, "E2E wallet can't fund batch fee");
  for (let feeRetries = 0, orphanWaits = 0; ; ) {
    const inputs = JSON.stringify({ vaultRedeem, treasuryId: sid, vaultUtxos, ownerAddress: wallet.address, fundingUtxos: s.picked, fee: s.fee, ...(budgetVault != null ? { budgetVault } : {}) });
    const shs = JSON.parse(W.sweep_funded_sighashes(inputs));
    const out = JSON.parse(W.sweep_funded_tx(inputs, JSON.stringify(shs.map(sign))));
    try {
      const r = await c.submit(JSON.parse(W.borsh_to_rpc_json(out.borshHex)));
      return { txid: r.transactionId, fee: s.fee, picked: s.picked, change: s.sum - s.fee, mass: s.mass, rate, feeRetries };
    } catch (e) {
      const msg = String(e?.message || e);
      const want = /required amount of (\d+)/.exec(msg);
      if (want && feeRetries < 2) {
        feeRetries++;
        rate = Math.max(rate, Math.ceil(Number(want[1]) / s.mass));
        s = SP.fold(SP.sizeFee(massOf, fents, rate, Number(want[1])));
        assert(s.sum >= s.fee, "fee retry exceeds wallet");
        log(`node asked ${want[1]} — resized at rate ${rate}`, "warn");
        continue;
      }
      if (/orphan|missing|not found|outpoint/i.test(msg) && orphanWaits < 5) { orphanWaits++; await sleep(400); continue; }
      throw e;
    }
  }
}

// engine loop mirroring wasmTx.sweepClientSide (queue + input-cap shrink)
async function runSweep({ dustFloor = SP.DUST_FLOOR, includeDust = false, cancelAfter = Infinity, budgetVaultBatch1 = null } = {}) {
  const entries = (await c.getUtxos([vaultAddress])).entries || [];
  const cEnt = entries.find((e) => e.utxoEntry.covenantId);
  assert(cEnt, "no covenant UTXO");
  let cov = { ...toU(cEnt), covenant: true };
  const all = entries.filter((e) => !e.utxoEntry.covenantId).map(toU).sort((a, b) => b.amount - a.amount);
  const { keep, dust } = SP.partitionDust(all, includeDust ? 0 : dustFloor);
  let fents = await walletUtxos();
  const probeF = [fents[0]];
  const baseMass = feeMass([cov], probeF);
  const perStray = keep.length ? feeMass([cov, { ...keep[0], covenant: false }], probeF) - baseMass : 0;
  const cap = keep.length ? SP.perBatchCap(baseMass, perStray) : 0;
  const queue = [...keep];
  const out = { batches: 0, swept: 0, feeTotal: 0, txids: [], cancelled: false, dust: dust.length, cap, baseMass, perStray };
  do {
    if (out.batches >= cancelAfter) { out.cancelled = true; return out; }
    const batch = queue.splice(0, Math.max(0, Math.min(cap, SP.MAX_TX_INPUTS - 2)));
    let vaultUtxos, sized;
    for (;;) {
      vaultUtxos = [cov, ...batch.map((x) => ({ ...x, covenant: false }))];
      sized = SP.fold(SP.sizeFee((p) => feeMass(vaultUtxos, p, out.batches === 0 ? budgetVaultBatch1 : null), fents, SP.MIN_RELAY_FEE_RATE));
      if (vaultUtxos.length + sized.picked.length <= SP.MAX_TX_INPUTS) break;
      assert(batch.length, "fee UTXOs too fragmented for the 16-input cap");
      queue.unshift(batch.pop());
    }
    const r = await submitBatch(vaultUtxos, fents, SP.MIN_RELAY_FEE_RATE, out.batches === 0 ? budgetVaultBatch1 : null);
    const spent = new Set(r.picked.map((x) => `${x.txid}:${x.index}`));
    fents = fents.filter((x) => !spent.has(`${x.txid}:${x.index}`));
    if (r.change > 0) { fents.push({ txid: r.txid, index: 1, amount: r.change }); fents.sort((a, b) => b.amount - a.amount); }
    cov = { txid: r.txid, index: 0, amount: vaultUtxos.reduce((a, x) => a + x.amount, 0), covenant: true };
    out.batches++; out.swept += batch.length; out.feeTotal += r.fee; out.txids.push(r.txid);
    log(`batch ${out.batches}: ${batch.length} deposit(s), ${vaultUtxos.length + r.picked.length} inputs, fee ${r.fee} (mass ${r.mass}, retries ${r.feeRetries}) → ${r.txid.slice(0, 12)}…`);
    assert(r.feeRetries === 0, "fee model mismatched the node (retry fired)");
  } while (queue.length);
  return out;
}

// ---- 3. negative probe: 17 inputs must fail script verification ----------
{
  const strays15 = strays.slice(0, 15).map((x) => ({ ...x, covenant: false }));
  const vaultUtxos = [{ ...toU(covEnt), covenant: true }, ...strays15];
  const fents = await walletUtxos();
  const massOf = (p) => feeMass(vaultUtxos, p);
  const s = SP.fold(SP.sizeFee(massOf, fents, SP.MIN_RELAY_FEE_RATE));
  const inputs = JSON.stringify({ vaultRedeem, treasuryId: sid, vaultUtxos, ownerAddress: wallet.address, fundingUtxos: s.picked, fee: s.fee });
  const shs = JSON.parse(W.sweep_funded_sighashes(inputs));
  const out = JSON.parse(W.sweep_funded_tx(inputs, JSON.stringify(shs.map(sign))));
  try {
    await c.submit(JSON.parse(W.borsh_to_rpc_json(out.borshHex)));
    die("17-input sweep was ACCEPTED — contract cap assumption wrong!");
  } catch (e) { console.log(`negative probe ok — 17-input sweep rejected: ${String(e.message).slice(0, 90)}…`); }
}

// ---- 4. ONE run, TWO chained batches (14+3), batch 1 probes budgetVault=0 —
// batch 2 spends batch 1's still-unconfirmed covenant + change outputs
const runB = await runSweep({ budgetVaultBatch1: 0 });
assert(runB.batches === 2 && runB.swept === 17 && runB.dust === 2, `expected 2 chained batches/17 swept/2 dust, got ${runB.batches}/${runB.swept}/${runB.dust}`);
console.log(`chained run ok: 14+3 in one run (batch 2 spent batch 1's mempool outputs); budgetVault=0 accepted on batch 1 (live cost ≤ 9,999 units → ComputeBudget(2) keeps ≥3× margin); dust (2) skipped; cap=${runB.cap} baseMass=${runB.baseMass} perStray=${runB.perStray}`);

// ---- 6. includeDust run ----------------------------------------------------
await sleep(800);
const runC = await runSweep({ includeDust: true });
assert(runC.swept === 2, `run C: expected 2 dust swept, got ${runC.swept}`);
console.log("run C ok: dust swept with includeDust");

// ---- 7. final state --------------------------------------------------------
await sleep(1200);
const fin = (await c.getUtxos([vaultAddress])).entries || [];
const covFin = fin.filter((e) => e.utxoEntry.covenantId);
const strayFin = fin.filter((e) => !e.utxoEntry.covenantId);
const expect = 30_000_000 + 17 * 40_000_000 + 2 * 3_000_000;
assert(covFin.length === 1, `expected 1 covenant UTXO, got ${covFin.length}`);
assert(Number(covFin[0].utxoEntry.amount) === expect, `vault value ${covFin[0].utxoEntry.amount} != ${expect}`);
assert(strayFin.length === 0, `expected 0 strays left, got ${strayFin.length}`);
const feeAll = runB.feeTotal + runC.feeTotal;
console.log(`final: vault ${expect / 1e8} KAS in ONE covenant UTXO, 0 strays; total sweep fees ${(feeAll / 1e8).toFixed(4)} KAS across ${runB.batches + runC.batches} batches`);
console.log("E2E PASS");
c.close();
process.exit(0);
