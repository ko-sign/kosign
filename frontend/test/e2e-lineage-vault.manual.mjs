// TN10 on-chain E2E for the LINEAGE-BOUND VAULT protocol (the two-transaction
// treasury: genesis mints the KoRoot + its covenant id C, bootstrapVault mints the
// KoVault as a CONTINUATION of C and stamps C into the vault's state).
//
// Everything here is a claim about a REAL node, not about the builders:
//   1. the genesis binds EXACTLY ONE output (index 0, authorizing input 0)
//   2. W.genesis_covenant_id(anchor), computed BEFORE signing, is the id the node records
//   3. the KOSGN inscription carries that id (and the policy round-trips)
//   4. bootstrapVault mints the vault at P2SH(rebuildVault(C)) — derived, not read off
//      the tx — and continues the KoRoot UNCHANGED at output 0
//   5. the bootstrap is submitted against an UNCONFIRMED genesis (mempool chain)
//   6. a plain payment to the vault address is absorbed by the deposit path, whole
//   7. THE ADVERSARIAL CASE: a stranger plants a covenant lineage of his own AT the
//      vault address and tries to sweep an incoming payment into it. The node must
//      refuse. (Plus: an honest sweep that drags the alien UTXO along must also fail.)
//   8. propose (A) -> approve (B) -> execute moves KAS out to a plain address
//   9. auditGenesis, fed the REAL REST genesis + the REAL vault script hash, says
//      "clean"/cryptographic — and refuses a DIFFERENT vault
//
// MANUAL test: spends real TN10 funds from .secrets/wallet.testnet.json (~2 KAS,
// of which ~0.2 KAS is deliberately BURNED as the attacker's planted lineage).
//   node frontend/test/e2e-lineage-vault.manual.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
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
const { rebuildRoot, rebuildVault, ROOT_STATE_LAYOUT, PROPOSAL_STATE_LAYOUT } = await import(`${FRONTEND}/src/treasuryRebuild.js`);
const { TEMPLATES } = await import(`${FRONTEND}/src/treasuryTemplates.js`);
const SP = await import(`${FRONTEND}/src/sweepPlan.js`);
const { MIN_RELAY_FEE_RATE, CHANGE_FLOOR, feeMassOf, pickFrom, fundingSlots } = SP;
const { decodeInscription, fetchGenesisTx, restJson } = await import(`${FRONTEND}/src/kaspaRest.js`);
const { auditGenesis, normalizeRestGenesisTx, hashScriptHex } = await import(`${REPO}/packages/descriptor/src/genesis.js`);

// ---- fixtures ---------------------------------------------------------------
const wallet = JSON.parse(readFileSync(`${REPO}/.secrets/wallet.testnet.json`, "utf8"));
const keyB = "22".repeat(32);                       // deterministic co-signer
const pubB = bytesToHex(schnorr.getPublicKey(hexToBytes(keyB)));
const signWith = (priv) => (sh) => bytesToHex(schnorr.sign(hexToBytes(sh), hexToBytes(priv)));
const signA = signWith(wallet.private_key), signB = signWith(keyB);
const NUMS = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
const ZERO_SIG = "00".repeat(64);
const ZERO_ID = "00".repeat(32);
const MAX_COVENANT_FEE = 10_000_000;
const BOND = 50_000_000;
const ROOT_SOMPI = 30_000_000;
const VAULT_SOMPI = 30_000_000;
const PAYMENT = 20_000_000;      // an incoming payment to the vault address
const PLANT = 20_000_000;        // the attacker's own lineage, planted at that address (BURNED)
const TRANSFER = 10_000_000;     // what the 2-of-2 finally spends out

const KAS = (s) => (s / 1e8).toFixed(4);
const die = (m) => { console.error(`\nFAIL: ${m}`); process.exit(1); };
const ok = [];
const assert = (c, m) => { if (!c) die(m); ok.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txids = [];
const note = (label, txid, what) => { txids.push({ label, txid, what }); console.log(`  TXID ${label.padEnd(18)} ${txid}  — ${what}`); };
const fees = [];
const price = (borshHex, cap = 0) => {
  const fee = feeMassOf(JSON.parse(W.borsh_masses(borshHex))) * MIN_RELAY_FEE_RATE;
  if (cap) assert(fee <= cap, `fee ${fee} within the ${cap} covenant cap`);
  return fee;
};

// ---- node -------------------------------------------------------------------
const RESOLVERS = ["eric.kaspa.stream", "john.kaspa.red", "jake.kaspa.green", "noah.kaspa.blue",
  "maxim.kaspa.stream", "mike.kaspa.red", "mark.kaspa.green", "ryan.kaspa.blue"];
let c = null, borshUrl = null;
for (const r of RESOLVERS.sort(() => Math.random() - 0.5)) {
  try {
    const { url } = await (await fetch(`https://${r}/v2/kaspa/testnet-10/any/wrpc/borsh`, { signal: AbortSignal.timeout(5000) })).json();
    const j = url.replace(/\/wrpc\/borsh$/, "/wrpc/json");
    const t = connectWrpc(j);
    await t.ready; const info = await t.getInfo();
    c = t; borshUrl = url;
    console.log(`node: ${j}  (server ${info.serverVersion}, synced ${info.isSynced})`);
    break;
  } catch { /* next */ }
}
assert(c, "a public TN10 node is reachable");

const spent = new Set();
const markSpent = (rpcTx) => { for (const i of rpcTx.inputs || []) { const o = i.previousOutpoint || i.previous_outpoint; if (o) spent.add(`${o.transactionId ?? o.transaction_id}:${Number(o.index ?? 0)}`); } };
const utxosOf = async (addr) => ((await c.getUtxos([addr])).entries || []);
const toU = (e) => ({ txid: e.outpoint.transactionId, index: e.outpoint.index, amount: Number(e.utxoEntry.amount) });
const walletUtxos = async () => (await utxosOf(wallet.address))
  .filter((e) => !e.utxoEntry.covenantId).map(toU)
  .filter((u) => !spent.has(`${u.txid}:${u.index}`)).sort((a, b) => b.amount - a.amount);
const rawSubmit = async (borshHex) => {
  const rpcTx = JSON.parse(W.borsh_to_rpc_json(borshHex));
  const txid = (await c.submit(rpcTx)).transactionId;
  markSpent(rpcTx);
  return txid;
};
// submit, re-signing once or twice if the node quotes a higher required fee
const submitPriced = async (signedAt, fee0) => {
  let fee = fee0, out = signedAt(fee);
  for (let attempt = 0; ; attempt++) {
    try { return { txid: await rawSubmit(out.borshHex), fee, out }; }
    catch (e) {
      const want = /required amount of (\d+)/.exec(String(e?.message || e));
      if (!want || attempt >= 2) throw e;
      fee = Number(want[1]); out = signedAt(fee);
      console.log(`  (node asks >= ${KAS(fee)} KAS — re-signing)`);
    }
  }
};
const waitUtxo = async (addr, pred, tries = 90, label = "") => {
  for (let i = 0; i < tries; i++) { const hit = (await utxosOf(addr)).find(pred); if (hit) return hit; await sleep(500); }
  die(`timed out waiting for a UTXO at ${addr.slice(0, 24)}… ${label}`);
};
const sendPlain = async (sompi, dest) => {
  const out = execFileSync(`${REPO}/tools/kaspa-probe/target/release/send`, [String(sompi), dest], {
    cwd: REPO, env: { ...process.env, KASPA_RPC_URL: borshUrl, KASPA_NETWORK: "testnet-10" }, encoding: "utf8",
  });
  const txid = /txid ([0-9a-f]{64})/.exec(out)?.[1];
  assert(txid, "the plain payment was accepted by the node");
  return txid;
};

console.log(`dev wallet: ${wallet.address}`);
const balBefore = (await walletUtxos()).reduce((a, u) => a + u.amount, 0);
console.log(`balance before: ${KAS(balBefore)} KAS\n`);

// ============================================================================
// PHASE 1 — genesis (binds the KoRoot ALONE) + bootstrap (mints the vault),
// the second submitted against the UNCONFIRMED first.
// ============================================================================
console.log("PHASE 1 — genesis + bootstrap (2-of-2)");
const owners2 = [wallet.xonly_pubkey, pubB];
const owners5 = [...owners2, NUMS, NUMS, NUMS];
const rootRedeem = rebuildRoot(0, 2, 2, owners5);
const rootAddress = W.p2sh_address(rootRedeem, "testnet");

const FEE_CEIL = 10_000_000;
const need = ROOT_SOMPI + VAULT_SOMPI + 2 * FEE_CEIL;
const fents0 = await walletUtxos();
const { picked, sum } = pickFrom(fents0, need, fundingSlots(0));
assert(sum >= need, `wallet funds both transactions (${KAS(sum)} >= ${KAS(need)} KAS)`);

// The id, BEFORE anything is signed. It depends only on the authorizing input's
// outpoint and the root output — not on the payload, the change or the fee.
const anchor = { fundingAddress: wallet.address, rootRedeem, rootValue: ROOT_SOMPI, fundingUtxos: picked };
const C = W.genesis_covenant_id(JSON.stringify(anchor));
console.log(`  precomputed covenant id C = ${C}`);
const vaultRedeem = rebuildVault(C);                      // derived from C, in JS
const vaultAddress = W.p2sh_address(vaultRedeem, "testnet");
const vaultScriptHash = hashScriptHex(vaultRedeem);
console.log(`  derived vault address     = ${vaultAddress}`);

const payload = W.inscription(2n, JSON.stringify(owners2), C);
const mkGinp = (change) => JSON.stringify({ ...anchor, change, payloadHex: payload });
const probeG = JSON.parse(W.genesis_build(mkGinp(sum - ROOT_SOMPI - FEE_CEIL), JSON.stringify(picked.map(() => ZERO_SIG)))).borshHex;
const signedGenesis = (fee) => {
  const ginp = mkGinp(sum - ROOT_SOMPI - fee);
  const ga = JSON.parse(W.genesis_sighashes(ginp));
  const built = JSON.parse(W.genesis_build(ginp, JSON.stringify(ga.sighashes.map((sh) => signA(sh)))));
  return { ...built, change: sum - ROOT_SOMPI - fee };
};
const g = await submitPriced(signedGenesis, price(probeG));
const genesisTxid = g.txid, genesisChange = g.out.change;
assert(g.out.treasuryId === C, "the built genesis mints exactly the id genesis_covenant_id precomputed (claim 2, builder side)");
note("genesis", genesisTxid, `mints C=${C.slice(0, 12)}… binding output 0 (KoRoot) only; fee ${KAS(g.fee)} KAS`);
fees.push({ what: "genesis", fee: g.fee });

// --- claim 5: the bootstrap spends the genesis CHANGE, which is still in the
// mempool. Submit it immediately, with no wait and no utxoindex lookup.
// Prove the parent really is unconfirmed FIRST: the node's utxoindex is fed from
// virtual state, so an outpoint it does not know is an outpoint no block has
// accepted yet. Checked before a single sompi of the vault endowment is spent, so
// a run that loses the race fails cheap and can simply be repeated.
const parentIndexed = async () => (await utxosOf(wallet.address)).some((e) => e.outpoint.transactionId === genesisTxid);
// Timing-dependent, so informational rather than fatal: on a fast node the
// utxoindex can absorb the genesis before we look, and then this run simply
// does not EXERCISE the mempool-chaining claim (it proves nothing against it —
// the bootstrap below still spends the genesis output either way).
const chainedInMempool = !(await parentIndexed());
if (chainedInMempool) ok.push("claim 5: at the moment the bootstrap is built, the genesis output it spends is NOT in the node's utxoindex — the parent is still unconfirmed");
else console.log("  (genesis already indexed — the mempool-chaining half of claim 5 is not exercised this run)");
const bootBase = {
  rootScript: rootRedeem, rootTxid: genesisTxid, rootIndex: 0, rootAmount: ROOT_SOMPI,
  treasuryId: C, vaultPrefix: TEMPLATES.vault.prefix, vaultSuffix: TEMPLATES.vault.suffix,
  vaultValue: VAULT_SOMPI, ownerIndex: 0, ownerAddress: wallet.address,
  fundingUtxos: [{ txid: genesisTxid, index: 1, amount: genesisChange }],
};
const foldFee = (f) => { const ch = genesisChange - VAULT_SOMPI - f; return ch > 0 && ch < CHANGE_FLOOR ? f + ch : f; };
const signedBootstrap = (fee) => {
  const inp = JSON.stringify({ ...bootBase, fee: foldFee(fee) });
  const shs = JSON.parse(W.bootstrap_sighashes(inp));
  return JSON.parse(W.bootstrap_build(inp, JSON.stringify(shs.map((sh) => signA(sh)))));
};
const probeB = JSON.parse(W.bootstrap_build(JSON.stringify({ ...bootBase, fee: 0 }), JSON.stringify(Array(2).fill(ZERO_SIG)))).borshHex;
const b = await submitPriced(signedBootstrap, price(probeB));
const bootstrapTxid = b.txid;
assert(JSON.parse(W.borsh_to_rpc_json(b.out.borshHex)).inputs.some((i) => i.previousOutpoint.transactionId === genesisTxid),
  "the bootstrap really does spend an output of the genesis (its funding input is the genesis change)");
if (chainedInMempool) assert(true, "claim 5: the bootstrap was ACCEPTED while its funding parent (the genesis) was still unconfirmed — the two-transaction mempool chain works on a real node");
assert(b.out.vaultRedeemHex === vaultRedeem, "the wasm bootstrap builder mints the very redeem script rebuildVault(C) derives in JS");
assert(b.out.ownerFunded === true, "the bootstrap is owner-funded (the KoRoot value floor cannot bind)");
note("bootstrap", bootstrapTxid, `mints the KoVault at ${vaultAddress.slice(0, 20)}… as a continuation of C; fee ${KAS(b.fee)} KAS`);
fees.push({ what: "bootstrap", fee: b.fee });
console.log(`  BOOTSTRAP_ROOT_BUDGET = 40 (tools/wasm-tx/src/lib.rs) PASSED script verification on chain`);

// ---- claim 4: the vault exists, at the DERIVED address, carrying C ----------
const vaultUtxo0 = await waitUtxo(vaultAddress, (e) => e.utxoEntry.covenantId === C, 120, "(vault mint)");
assert(Number(vaultUtxo0.utxoEntry.amount) === VAULT_SOMPI, `the vault UTXO holds exactly the ${KAS(VAULT_SOMPI)} KAS endowment`);
assert(vaultUtxo0.outpoint.transactionId === bootstrapTxid && vaultUtxo0.outpoint.index === 1, "the vault is output 1 of the bootstrap");
assert(vaultUtxo0.utxoEntry.covenantId === C, "claim 4: the vault UTXO at P2SH(rebuildVault(C)) carries covenant id C");

// ---- claim 4b: the root continued at output 0, state UNCHANGED --------------
const rootUtxo = await waitUtxo(rootAddress, (e) => e.outpoint.transactionId === bootstrapTxid, 120, "(root continuation)");
assert(rootUtxo.outpoint.index === 0, "the KoRoot continued at output 0 of the bootstrap");
assert(rootUtxo.utxoEntry.covenantId === C, "the continued KoRoot still carries C");
assert(Number(rootUtxo.utxoEntry.amount) === ROOT_SOMPI, "the KoRoot kept its full value (owner-funded bootstrap)");
// the root ADDRESS is a pure function of its state (nonce ‖ threshold ‖ ownerCount ‖ owners5),
// so landing back at the same address IS the proof that nothing in that state moved
assert(W.p2sh_address(rootRedeem, "testnet") === rootAddress, "root address is the state's own function");
console.log(`  root state unchanged: nonce 0, 2-of-2, owners [${owners2.map((o) => o.slice(0, 8)).join(", ")}] — the continuation landed back at ${rootAddress.slice(0, 24)}…`);
ok.push("claim 4b: the bootstrap continued the KoRoot at output 0 with its state byte-identical (same P2SH => same nonce/threshold/owners) and its value untouched");

let root = { redeem: rootRedeem, txid: bootstrapTxid, index: 0, value: ROOT_SOMPI };

// ============================================================================
// PHASE 2 — an incoming payment is absorbed by the deposit path (claim 6)
// ============================================================================
console.log("\nPHASE 2 — an incoming payment is absorbed");
const payTxid = await sendPlain(PAYMENT, vaultAddress);
note("payment-1", payTxid, `${KAS(PAYMENT)} KAS paid to the vault address — arrives UNBOUND`);
const stray1 = await waitUtxo(vaultAddress, (e) => e.outpoint.transactionId === payTxid, 120, "(payment 1)");
assert(!stray1.utxoEntry.covenantId, "an incoming payment arrives with NO covenant binding (unbound), as the design assumes");

const sweepMass = (vRedeem, tid, vaultUtxos) => (fund) => feeMassOf(JSON.parse(W.sweep_funded_mass(JSON.stringify({
  vaultRedeem: vRedeem, treasuryId: tid, vaultUtxos, ownerAddress: wallet.address, fundingUtxos: fund, fee: 0,
}))));
async function buildSweep(vRedeem, tid, vaultUtxos) {
  const fents = await walletUtxos();
  const s = SP.fold(SP.sizeFee(sweepMass(vRedeem, tid, vaultUtxos), fents, MIN_RELAY_FEE_RATE));
  assert(s.sum >= s.fee, "the wallet covers the sweep fee");
  const at = (fee) => {
    const inputs = JSON.stringify({ vaultRedeem: vRedeem, treasuryId: tid, vaultUtxos, ownerAddress: wallet.address, fundingUtxos: s.picked, fee });
    const shs = JSON.parse(W.sweep_funded_sighashes(inputs));
    return JSON.parse(W.sweep_funded_tx(inputs, JSON.stringify(shs.map((sh) => signA(sh)))));
  };
  return { at, fee: s.fee };
}
const vaultIn = (e, covenant) => ({ txid: e.outpoint.transactionId, index: e.outpoint.index, amount: Number(e.utxoEntry.amount), covenant });
{
  const set = [vaultIn(vaultUtxo0, true), vaultIn(stray1, false)];
  const { at, fee } = await buildSweep(vaultRedeem, C, set);
  const r = await submitPriced(at, fee);
  note("deposit-sweep", r.txid, `absorbs the ${KAS(PAYMENT)} KAS payment into lineage C; fee ${KAS(r.fee)} KAS (wallet-paid)`);
  fees.push({ what: "deposit sweep", fee: r.fee });
  const merged = await waitUtxo(vaultAddress, (e) => e.outpoint.transactionId === r.txid && e.utxoEntry.covenantId, 120, "(swept vault)");
  assert(merged.utxoEntry.covenantId === C, "claim 6: the consolidated vault output still carries C");
  assert(Number(merged.utxoEntry.amount) === VAULT_SOMPI + PAYMENT,
    `claim 6: not one sompi went missing — ${KAS(VAULT_SOMPI)} + ${KAS(PAYMENT)} = ${KAS(Number(merged.utxoEntry.amount))} KAS`);
  var vaultUtxo = merged;
}

// ============================================================================
// PHASE 3 — THE ADVERSARIAL CASE (claim 7)
// A stranger mints a covenant lineage of his OWN — his own populate_genesis_covenants
// group, output 0 at THIS vault address — then tries to sweep an incoming payment
// into it. Under the old stateless vault this succeeded and the money was his.
// ============================================================================
console.log("\nPHASE 3 — the adversarial case");
// (a) plant the foreign lineage. gen_build binds output 0 = P2SH(the script we hand
//     it); hand it the REAL vault redeem, so the planted UTXO sits at the treasury's
//     own deposit address under an id of the attacker's making.
let F, plantTxid, plantUtxo;
{
  const fents = await walletUtxos();
  const p = pickFrom(fents, PLANT + FEE_CEIL, fundingSlots(0));
  assert(p.sum >= PLANT + FEE_CEIL, "the attacker can fund his own genesis");
  const aAnchor = { fundingAddress: wallet.address, rootRedeem: vaultRedeem, rootValue: PLANT, fundingUtxos: p.picked };
  F = W.genesis_covenant_id(JSON.stringify(aAnchor));
  assert(F !== C && F !== ZERO_ID, `the planted lineage F=${F.slice(0, 12)}… is a DIFFERENT covenant id from the treasury's C`);
  const mk = (change) => JSON.stringify({ ...aAnchor, change, payloadHex: "" });
  const probe = JSON.parse(W.genesis_build(mk(p.sum - PLANT - FEE_CEIL), JSON.stringify(p.picked.map(() => ZERO_SIG)))).borshHex;
  const signed = (fee) => {
    const inp = mk(p.sum - PLANT - fee);
    const ga = JSON.parse(W.genesis_sighashes(inp));
    return JSON.parse(W.genesis_build(inp, JSON.stringify(ga.sighashes.map((sh) => signA(sh)))));
  };
  const r = await submitPriced(signed, price(probe));
  plantTxid = r.txid;
  note("attacker-plant", plantTxid, `a STRANGER's covenant lineage F=${F.slice(0, 12)}… minted AT the vault address — the node accepts it, as consensus permits`);
  fees.push({ what: "attacker plant", fee: r.fee });
  plantUtxo = await waitUtxo(vaultAddress, (e) => e.outpoint.transactionId === plantTxid, 120, "(planted lineage)");
  assert(plantUtxo.utxoEntry.covenantId === F, "the planted UTXO sits at the treasury's own vault address carrying the attacker's id F — consensus does NOT prevent this, which is exactly why the vault must carry its lineage in state");
}
// (b) the payment the attacker wants
const payTxid2 = await sendPlain(PAYMENT, vaultAddress);
note("payment-2", payTxid2, `${KAS(PAYMENT)} KAS paid to the vault address (the payment the attacker is after) — arrives UNBOUND`);
const stray2 = await waitUtxo(vaultAddress, (e) => e.outpoint.transactionId === payTxid2, 120, "(payment 2)");
assert(!stray2.utxoEntry.covenantId, "payment 2 also arrives unbound");

// (c) THE CAPTURE ATTEMPT. Output 0 continues F, not C. No owner key anywhere.
let captureError = null, captureShape = null, rescueShape = null;
{
  const set = [vaultIn(plantUtxo, true), vaultIn(stray2, false)];
  const { at, fee } = await buildSweep(vaultRedeem, F, set);
  let built = at(fee);
  captureShape = JSON.parse(W.borsh_to_rpc_json(built.borshHex));
  for (let attempt = 0; attempt < 3 && !captureError; attempt++) {
    try {
      const txid = await rawSubmit(built.borshHex);
      console.error(`\nCRITICAL: the capture transaction was ACCEPTED — txid ${txid}`);
      console.error("A stranger just swept a payment made to this treasury's address into a lineage of his own.");
      console.error("The lineage-in-state fix DOES NOT HOLD on a real node. Stop and fix the contracts.");
      process.exit(2);
    } catch (e) {
      const msg = String(e?.message || e);
      const want = /required amount of (\d+)/.exec(msg);
      if (want) { built = at(Number(want[1])); continue; } // a fee refusal proves nothing — repay and retry
      captureError = msg;
    }
  }
  assert(captureError, "the capture attempt was REFUSED by the node");
  assert(/script ran, but verification failed/.test(captureError),
    "claim 7: the refusal is a SCRIPT refusal — the covenant itself rejected the spend, not a fee or policy check");
  console.log(`  node error (capture attempt):\n    ${captureError}`);
  ok.push("claim 7: a stranger CANNOT sweep a payment made to this vault address into a lineage of his own — the node refuses the transaction outright");
}
// (d) and the alien UTXO cannot be dragged into an honest sweep either
let alienError = null;
{
  const set = [vaultIn(vaultUtxo, true), vaultIn(plantUtxo, false), vaultIn(stray2, false)];
  const { at, fee } = await buildSweep(vaultRedeem, C, set);
  let built = at(fee);
  for (let attempt = 0; attempt < 3 && !alienError; attempt++) {
    try { const txid = await rawSubmit(built.borshHex); die(`the alien-input sweep was ACCEPTED (${txid}) — KoVault.deposit's alienVaultIns rule does not hold on chain`); }
    catch (e) {
      const msg = String(e?.message || e);
      const want = /required amount of (\d+)/.exec(msg);
      if (want) { built = at(Number(want[1])); continue; }
      alienError = msg;
    }
  }
  assert(alienError, "an honest sweep that drags the alien UTXO along is ALSO refused (KoVault.deposit: alienVaultIns == 0)");
  assert(/script ran, but verification failed/.test(alienError), "that refusal is a SCRIPT refusal too");
  console.log(`  node error (alien input in an honest sweep):\n    ${alienError}`);
}
// (e) ...but the treasury can still absorb the payment. The money was only ever
//     claimable by the real lineage.
{
  const set = [vaultIn(vaultUtxo, true), vaultIn(stray2, false)];
  const { at, fee } = await buildSweep(vaultRedeem, C, set);
  rescueShape = JSON.parse(W.borsh_to_rpc_json(at(fee).borshHex));
  const r = await submitPriced(at, fee);
  note("rescue-sweep", r.txid, `the SAME payment absorbed into the real lineage C; fee ${KAS(r.fee)} KAS`);
  fees.push({ what: "rescue sweep", fee: r.fee });
  const merged = await waitUtxo(vaultAddress, (e) => e.outpoint.transactionId === r.txid && e.utxoEntry.covenantId, 120, "(rescued vault)");
  assert(merged.utxoEntry.covenantId === C, "the rescued vault output carries C");
  assert(Number(merged.utxoEntry.amount) === VAULT_SOMPI + 2 * PAYMENT,
    `the payment the attacker could not take is now in the treasury (${KAS(Number(merged.utxoEntry.amount))} KAS)`);
  vaultUtxo = merged;
}

// ============================================================================
// PHASE 4 — the full spend path: propose (A) -> approve (B) -> execute (claim 8)
// ============================================================================
console.log("\nPHASE 4 — propose (A) -> approve (B) -> execute");
const recipientAddress = W.pubkey_address(pubB, "testnet");
const rinfo = JSON.parse(W.recipient_info(recipientAddress));
let prop;
{
  const fents = await walletUtxos();
  const p = pickFrom(fents, BOND + MAX_COVENANT_FEE, fundingSlots(1));
  assert(p.sum >= BOND + MAX_COVENANT_FEE, "the wallet funds the proposal bond");
  const base = {
    rootScript: root.redeem, rootTxid: root.txid, rootIndex: root.index, rootAmount: root.value,
    treasuryId: C, pPrefix: TEMPLATES.proposal.prefix, pSuffix: TEMPLATES.proposal.suffix, vPrefix: TEMPLATES.vault.prefix, vSuffix: TEMPLATES.vault.suffix,
    rStart: ROOT_STATE_LAYOUT.start, operation: 1, recipientSpkHash: rinfo.spkHash, amount: TRANSFER,
    maxFee: MAX_COVENANT_FEE, expiresAt: 4_000_000_000, executionDelay: 0, proposerIndex: 0,
    ownerAddress: wallet.address, fundingUtxos: p.picked,
  };
  const nSigs = 1 + p.picked.length;
  const probe = JSON.parse(W.create_proposal_build(JSON.stringify({ ...base, fee: 0 }), JSON.stringify(Array(nSigs).fill(ZERO_SIG)))).borshHex;
  let fee0 = price(probe);
  const change = p.sum - BOND - fee0;
  if (change > 0 && change < CHANGE_FLOOR) fee0 += change;
  const at = (fee) => {
    const inputs = JSON.stringify({ ...base, fee });
    const shs = JSON.parse(W.create_proposal_sighashes(inputs));
    return JSON.parse(W.create_proposal_build(inputs, JSON.stringify(shs.map((sh) => signA(sh)))));
  };
  const r = await submitPriced(at, fee0);
  prop = { ...r.out, txid: r.txid };
  fees.push({ what: "createProposal", fee: r.fee });
  assert(prop.status === 0, "claim 8: a 2-of-2 proposal is born PENDING (one approval, threshold 2)");
  note("createProposal", r.txid, `owner A proposes ${KAS(TRANSFER)} KAS -> ${recipientAddress.slice(0, 20)}…; status Pending; fee ${KAS(r.fee)} KAS`);
  root = { redeem: prop.rootContHex, txid: r.txid, index: 0, value: root.value };
  await waitUtxo(W.p2sh_address(prop.proposalRedeemHex, "testnet"), (e) => e.outpoint.transactionId === r.txid, 120, "(proposal)");
}
let approved;
{
  const fents = await walletUtxos();
  const base = {
    proposalRedeem: prop.proposalRedeemHex, propTxid: prop.txid, propIndex: 1, propAmount: BOND,
    treasuryId: C, pStart: PROPOSAL_STATE_LAYOUT.start, ownerIndex: 1,
    ownerAddress: wallet.address,
  };
  const massOf = (fund) => feeMassOf(JSON.parse(W.borsh_masses(
    JSON.parse(W.approve_build(JSON.stringify({ ...base, fundingUtxos: fund, fee: 0 }), JSON.stringify(Array(1 + fund.length).fill(ZERO_SIG)))).borshHex)));
  const s = SP.fold(SP.sizeOpFee(massOf, fents, 1));
  assert(!s.short, "the wallet covers the approve fee");
  const at = (fee) => {
    const inputs = JSON.stringify({ ...base, fundingUtxos: s.picked, fee });
    const shs = JSON.parse(W.approve_sighashes(inputs));
    return JSON.parse(W.approve_build(inputs, JSON.stringify(shs.map((sh, i) => (i === 0 ? signB(sh) : signA(sh))))));
  };
  const r = await submitPriced(at, s.fee);
  approved = r.out;
  fees.push({ what: "approve", fee: r.fee });
  assert(approved.status === 1, "claim 8: owner B's approval takes the proposal to APPROVED (2 of 2)");
  note("approve", r.txid, `owner B approves (owner A's wallet pays the fee, the ${KAS(BOND)} KAS bond stays whole); status Approved; fee ${KAS(r.fee)} KAS`);
  await waitUtxo(W.p2sh_address(approved.newRedeemHex, "testnet"), (e) => e.outpoint.transactionId === r.txid, 120, "(approved proposal)");
  var approveTxid = r.txid;
}
{
  const base = {
    treasuryId: C, vaultRedeem, vaultTxid: vaultUtxo.outpoint.transactionId, vaultIndex: vaultUtxo.outpoint.index,
    vaultAmount: Number(vaultUtxo.utxoEntry.amount),
    proposalRedeem: approved.newRedeemHex, propTxid: approveTxid, propIndex: 0, propAmount: BOND,
    recipientSpkHex: rinfo.spkHex, amount: TRANSFER, executorIndex: 0,
  };
  const probe = JSON.parse(W.execute_build(JSON.stringify({ ...base, fee: 0 }), ZERO_SIG)).borshHex;
  const at = (fee) => {
    const inputs = JSON.stringify({ ...base, fee });
    return JSON.parse(W.execute_build(inputs, signA(W.execute_sighash(inputs))));
  };
  const r = await submitPriced(at, price(probe, MAX_COVENANT_FEE));
  fees.push({ what: "execute", fee: r.fee });
  note("execute", r.txid, `owner A executes: ${KAS(TRANSFER)} KAS leaves the vault; fee ${KAS(r.fee)} KAS`);
  const got = await waitUtxo(recipientAddress, (e) => e.outpoint.transactionId === r.txid, 120, "(recipient)");
  assert(Number(got.utxoEntry.amount) === TRANSFER, `claim 8: the recipient actually received ${KAS(TRANSFER)} KAS at ${recipientAddress.slice(0, 24)}…`);
  assert(!got.utxoEntry.covenantId, "the recipient's coin is plain (no covenant binding)");
  const change = await waitUtxo(vaultAddress, (e) => e.outpoint.transactionId === r.txid && e.utxoEntry.covenantId, 120, "(vault change)");
  assert(change.utxoEntry.covenantId === C, "claim 8: the vault change still carries C");
  assert(Number(change.utxoEntry.amount) === Number(vaultUtxo.utxoEntry.amount) + BOND - TRANSFER - r.fee,
    `the vault change is exactly vault + bond - transfer - fee (${KAS(Number(change.utxoEntry.amount))} KAS)`);
  vaultUtxo = change;
}

// ============================================================================
// PHASE 5 — the audit agrees with the chain (claim 9)
// ============================================================================
console.log("\nPHASE 5 — REST + audit");
// The production recovery walk: vault address -> its mint (bootstrapVault) -> the
// KoRoot it spent -> the genesis. Everything below is the REST indexer's copy of
// what the node actually stored, fetched back independently of anything we built.
let restTx = null;
for (let i = 0; i < 40 && !restTx; i++) {
  try { restTx = await fetchGenesisTx(vaultAddress); } catch { /* indexer lag */ }
  if (!restTx) { process.stdout.write("."); await sleep(6000); }
}
if (!restTx) {
  console.log("\n  (the two-hop walk has not been indexed yet — falling back to a direct fetch)");
  for (let i = 0; i < 40 && !restTx; i++) {
    try {
      const t = await restJson(`/transactions/${genesisTxid}?inputs=true&outputs=true&resolve_previous_outpoints=no`);
      if (t?.transaction_id) restTx = t;
    } catch { /* lag */ }
    if (!restTx) { process.stdout.write("."); await sleep(6000); }
  }
}
assert(restTx, "the genesis transaction can be read back from the public REST indexer");
console.log(`\n  REST genesis ${restTx.transaction_id}`);
assert(restTx.transaction_id === genesisTxid, "the walk/fetch found the genesis this run created");

// ---- claim 1: EXACTLY ONE bound output, index 0, authorizing input 0 --------
const bound = (restTx.outputs || []).filter((o) => o.covenant_id);
assert(bound.length === 1, `claim 1: the genesis binds EXACTLY ONE output into its covenant (found ${bound.length} of ${restTx.outputs.length})`);
assert(Number(bound[0].index) === 0, "claim 1: that output is index 0 — the KoRoot");
assert(Number(bound[0].covenant_authorizing_input) === 0, "claim 1: its authorizing input is input 0");
assert(bound[0].script_public_key_address === rootAddress, "the bound output pays the KoRoot address the policy derives");
// ---- claim 2: the precomputed id IS the id the node recorded ---------------
assert(String(bound[0].covenant_id).toLowerCase() === C,
  "claim 2: W.genesis_covenant_id(anchor), computed BEFORE signing, equals the covenant id the node recorded on output 0");
// ---- claim 3: the inscription carries it ----------------------------------
const ins = decodeInscription(restTx.payload);
assert(ins, "the genesis payload decodes as a KOSGN v1 inscription");
assert(ins.lineage === C, "claim 3: the inscription's 32-byte slot is exactly C");
assert(ins.threshold === 2 && ins.ownerCount === 2, "claim 3: threshold/ownerCount round-trip (2-of-2)");
assert(ins.owners.length === 2 && ins.owners[0] === owners2[0] && ins.owners[1] === owners2[1], "claim 3: both owner keys round-trip");

// ---- claim 9: the audit --------------------------------------------------
const norm = normalizeRestGenesisTx(restTx);
// treasuryId here is the id read off the LIVE vault UTXO's covenant binding —
// a source genuinely independent of the genesis bytes being audited, which is
// exactly what the independent-covenant-id check wants corroborated.
const verdict = auditGenesis(norm, { vaultAddress, vaultScriptHash, treasuryId: vaultUtxo.utxoEntry.covenantId });
console.log(`  audit verdict: ${verdict.verdict} (cryptographic ${verdict.cryptographic})`);
for (const ck of verdict.checks) console.log(`    ${ck.state.toUpperCase().padEnd(4)} ${ck.id}`);
assert(verdict.ok && verdict.verdict === "clean", `claim 9: auditGenesis on the REAL chain data returns verdict "clean" (got ${verdict.verdict}: ${verdict.reason})`);
assert(verdict.cryptographic === true, "claim 9: the verdict is CRYPTOGRAPHIC — the id was recomputed and it derives the vault being opened");
assert(verdict.treasuryId === C, "claim 9: the audit's recomputed treasury id is C");
assert(verdict.vaultScriptHash === vaultScriptHash, "claim 9: the audit derived our exact vault script hash from the genesis alone");
assert(verdict.checks.length > 0 && verdict.checks.every((k) => k.state === "pass"),
  `claim 9: every check passed with NONE skipped (${verdict.checks.map((k) => `${k.id}=${k.state}`).join(", ")})`);

// ---- claim 9b: a DIFFERENT vault is refused -------------------------------
const otherHash = hashScriptHex(rebuildVault("11".repeat(32)));
const refused = auditGenesis(norm, { vaultAddress: "kaspatest:someone-elses-vault", vaultScriptHash: otherHash });
assert(refused.ok === false && refused.verdict === "refused", "claim 9b: the audit REFUSES a vault this genesis does not derive");
assert(refused.code === "vault-not-from-this-genesis", `claim 9b: the refusal code is "vault-not-from-this-genesis" (got ${refused.code})`);
assert(refused.cryptographic === false, "claim 9b: a refused audit is never cryptographic");

// ---- the differential: the refused capture and the accepted rescue are the SAME
// transaction shape. Nothing but the lineage decided which one the chain took.
assert(captureShape.outputs[0].scriptPublicKey === rescueShape.outputs[0].scriptPublicKey,
  "the refused capture and the accepted rescue pay output 0 to the very same vault scriptPubKey");
assert(captureShape.outputs[0].covenant?.authorizingInput === rescueShape.outputs[0].covenant?.authorizingInput,
  "both bind output 0 to the same authorizing input index");
assert(captureShape.outputs[0].covenant?.covenantId === F && rescueShape.outputs[0].covenant?.covenantId === C,
  "…and the ONLY difference between them is the lineage output 0 continues: F (refused) vs C (accepted)");

// ---- and the attacker's planted coin is stuck there forever ----------------
{
  const still = (await utxosOf(vaultAddress)).find((e) => e.outpoint.transactionId === plantTxid);
  assert(still && still.utxoEntry.covenantId === F,
    `the attacker's planted ${KAS(PLANT)} KAS is still sitting at the vault address under F — unspendable by him (no lineage match) and by the owners (alienVaultIns), i.e. burned`);
}

// ============================================================================
// PHASE 6 — closeExpired: the bond returns to the VAULT, and ONLY the vault
// (RISKS #17). A proposal is minted to expire in ~a minute; a close that routes
// the bond to a wrong P2SH must die in SCRIPT on the live node; the honest close
// lands the WHOLE bond at the vault address as an unbound stray, and the vault's
// covenant UTXO is untouched throughout.
// ============================================================================
console.log("\nPHASE 6 — closeExpired: the bond comes home to the vault");
{
  const daaOf = async () => Number((await c.call("getBlockDagInfo", {})).virtualDaaScore);
  const EXP = (await daaOf()) + 600; // ~60 s at 10 blocks/s
  let prop2;
  {
    const fents = await walletUtxos();
    const p = pickFrom(fents, BOND + MAX_COVENANT_FEE, fundingSlots(1));
    assert(p.sum >= BOND + MAX_COVENANT_FEE, "the wallet funds the short-lived proposal's bond");
    const base = {
      rootScript: root.redeem, rootTxid: root.txid, rootIndex: root.index, rootAmount: root.value,
      treasuryId: C, pPrefix: TEMPLATES.proposal.prefix, pSuffix: TEMPLATES.proposal.suffix, vPrefix: TEMPLATES.vault.prefix, vSuffix: TEMPLATES.vault.suffix,
      rStart: ROOT_STATE_LAYOUT.start, operation: 1, recipientSpkHash: rinfo.spkHash, amount: TRANSFER,
      maxFee: MAX_COVENANT_FEE, expiresAt: EXP, executionDelay: 0, proposerIndex: 0,
      ownerAddress: wallet.address, fundingUtxos: p.picked,
    };
    const nSigs = 1 + p.picked.length;
    const probe = JSON.parse(W.create_proposal_build(JSON.stringify({ ...base, fee: 0 }), JSON.stringify(Array(nSigs).fill(ZERO_SIG)))).borshHex;
    let fee0 = price(probe);
    const change = p.sum - BOND - fee0;
    if (change > 0 && change < CHANGE_FLOOR) fee0 += change;
    const at = (fee) => {
      const inputs = JSON.stringify({ ...base, fee });
      const shs = JSON.parse(W.create_proposal_sighashes(inputs));
      return JSON.parse(W.create_proposal_build(inputs, JSON.stringify(shs.map((sh) => signA(sh)))));
    };
    const r = await submitPriced(at, fee0);
    prop2 = { ...r.out, txid: r.txid };
    fees.push({ what: "createProposal #2", fee: r.fee });
    note("createProposal#2", r.txid, `short-lived proposal (expires at DAA ${EXP}); fee ${KAS(r.fee)} KAS`);
    root = { redeem: prop2.rootContHex, txid: r.txid, index: 0, value: root.value };
    await waitUtxo(W.p2sh_address(prop2.proposalRedeemHex, "testnet"), (e) => e.outpoint.transactionId === r.txid, 120, "(proposal #2)");
  }

  // wait out the expiry (node relays a lock_time only once the DAA passes it)
  for (let d = await daaOf(); d <= EXP + 10; d = await daaOf()) {
    process.stdout.write("."); await sleep(3000);
  }
  console.log(` expired (DAA > ${EXP})`);

  const closeBase = (redeem, fund, fee) => JSON.stringify({
    proposalRedeem: prop2.proposalRedeemHex, propTxid: prop2.txid, propIndex: 1, propAmount: BOND,
    vaultRedeem: redeem, lockTime: EXP,
    ownerAddress: wallet.address, fundingUtxos: fund, fee,
  });
  const closeAt = (redeem) => (fund, fee) => {
    const inputs = closeBase(redeem, fund, fee);
    const shs = JSON.parse(W.close_expired_sighashes(inputs));
    return JSON.parse(W.close_expired_build(inputs, JSON.stringify(shs.map((sh) => signA(sh)))));
  };
  const fents = await walletUtxos();
  const massOf = (fund) => feeMassOf(JSON.parse(W.borsh_masses(
    JSON.parse(W.close_expired_build(closeBase(vaultRedeem, fund, 0), JSON.stringify(fund.map(() => ZERO_SIG)))).borshHex)));
  const s = SP.fold(SP.sizeOpFee(massOf, fents, 1));
  assert(!s.short, "the wallet covers the retirement fee (the bond may no longer pay it)");

  // NEGATIVE — the closer bounty, attempted on the live node: same close, but the
  // bond routed to a DIFFERENT (attacker) P2SH. Only KoProposal's new destination
  // rule stands between the bond and this transaction.
  {
    const wrong = closeAt(rebuildVault("11".repeat(32)))(s.picked, s.fee);
    let refused = null;
    try { await rawSubmit(wrong.borshHex); } catch (e) { refused = String(e?.message || e); }
    assert(refused && /signature script|script/i.test(refused),
      `the node REFUSES a close that routes the bond anywhere but the committed vault (in SCRIPT): ${String(refused).slice(0, 100)}`);
  }

  // HONEST — the whole bond comes home as an unbound stray at the vault address.
  const before = Number(vaultUtxo.utxoEntry.amount);
  const r = await submitPriced((fee) => closeAt(vaultRedeem)(s.picked, fee), s.fee);
  fees.push({ what: "closeExpired", fee: r.fee });
  note("closeExpired", r.txid, `bond ${KAS(BOND)} KAS returns to the vault as a stray; closer pays ${KAS(r.fee)} KAS from the wallet`);
  const stray = await waitUtxo(vaultAddress, (e) => e.outpoint.transactionId === r.txid && !e.utxoEntry.covenantId, 120, "(bond stray)");
  assert(Number(stray.utxoEntry.amount) === BOND, `the WHOLE ${KAS(BOND)} KAS bond arrived at the vault address — the closer took nothing`);
  const covStill = (await utxosOf(vaultAddress)).find((e) => e.utxoEntry.covenantId === C);
  assert(covStill && Number(covStill.utxoEntry.amount) === before, "the vault's covenant UTXO is untouched by the retirement");
}

await sleep(2000);
const balAfter = (await walletUtxos()).reduce((a, u) => a + u.amount, 0);
console.log("\n================ TXIDS ================");
for (const t of txids) console.log(`${t.label.padEnd(16)} ${t.txid}\n                 ${t.what}`);
console.log("\n================ FEES =================");
for (const f of fees) console.log(`${f.what.padEnd(18)} ${KAS(f.fee)} KAS (${f.fee} sompi)`);
console.log(`total fees        ${KAS(fees.reduce((a, f) => a + f.fee, 0))} KAS`);
console.log(`\nwallet ${KAS(balBefore)} -> ${KAS(balAfter)} KAS (Δ ${KAS(balAfter - balBefore)}); ${KAS(PLANT)} KAS of that is the attacker's planted UTXO, permanently unspendable by anyone`);
console.log(`treasury: root ${KAS(ROOT_SOMPI)} KAS + vault ${KAS(Number(vaultUtxo.utxoEntry.amount))} KAS under lineage ${C}`);
console.log("\n============ ASSERTIONS PASSED ============");
for (const a of ok) console.log(`  ✓ ${a}`);
console.log(`\nE2E PASS — ${ok.length} assertions`);
c.close();
process.exit(0);
