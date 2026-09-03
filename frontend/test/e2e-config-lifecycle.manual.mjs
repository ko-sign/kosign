// TN10 on-chain E2E — ROUND 2: the paths that offline contract tests cover but
// no real node has ever run under the lineage-bound-vault protocol.
//
// Round 1 (frontend/test/e2e-lineage-vault.manual.mjs) proved genesis binds one
// output, bootstrapVault mints the vault at the derived address, deposits are
// absorbed, a stranger cannot capture a payment, and propose→approve→execute
// moves KAS. It ran against PUBLIC POOL NODES at server 2.0.1. Everything here
// runs against the .env node, server 1.2.1-toc.3 — a different build.
//
// What this file claims, all of it about a REAL node:
//   0. THE INDEXER FIX (no funds): using the REAL chain data at round 1's vault
//      address — which genuinely carries both a live vault UTXO and a stranger's
//      planted covenant — the new lineage-filtered selection audits CLEAN, the
//      auditor reports the foreign id instead of refusing on it, and the OLD
//      code (checked out of git and executed) really would have refused.
//   1. REJECT: an owner's rejection is recorded on chain; enough rejections make
//      approval arithmetically impossible and the proposal reaches Failed (2);
//      an approve on a Failed proposal is refused by the node.
//   2. ADD AN OWNER: a CONFIG proposal (operation 2) committing
//      blake2b(thr8‖cnt8‖owner0..4), approved to threshold, executed by
//      executeConfig — which now dispatches SELECTOR 2, not the pre-bootstrapVault
//      1. The KoRoot continuation carries the new owner set, the vault address is
//      unchanged, and the treasury still spends with the NEW owner approving.
//   3. REMOVE AN OWNER: same shape back down; the removed owner's signature is
//      then refused by the node at every index, as a SCRIPT failure.
//   4. THE SELECTOR END TO END: proposalScan.walkRoot over this treasury's REAL
//      chain history recovers the current owner set and nonce across the
//      bootstrapVault hop and BOTH executeConfig hops.
//   5. CLOSEEXPIRED: a short-expiry proposal is retired permissionlessly, nothing
//      inherits the lineage, the treasury is untouched.
//   6. recoverTreasuryFromChain agrees with the chain about who the owners are.
//
// The .env node speaks BORSH wRPC only (it accepts the websocket and closes it on
// the first JSON frame), so this talks to it through tools/kaspa-probe/src/bin/
// kobridge.rs — a JSON-line adapter over the native client. That bridge also
// carries the closeExpired builder, because the product does not have one.
//
// MANUAL test: spends real TN10 funds from .secrets/wallet.testnet.json.
//   node frontend/test/e2e-config-lifecycle.manual.mjs            (everything)
//   node frontend/test/e2e-config-lifecycle.manual.mjs --audit    (phase 0 only, free)
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(FRONTEND, "..");
const req = createRequire(`${FRONTEND}/package.json`);
const W = (await import(`${FRONTEND}/test/wasm-loader.mjs`)).default;
const { schnorr } = await import(pathToFileURL(req.resolve("@noble/curves/secp256k1.js")));
const { bytesToHex, hexToBytes } = await import(pathToFileURL(req.resolve("@noble/hashes/utils.js")));
const { rebuildRoot, rebuildVault, ROOT_STATE_LAYOUT, PROPOSAL_STATE_LAYOUT } = await import(`${FRONTEND}/src/treasuryRebuild.js`);
const { TEMPLATES } = await import(`${FRONTEND}/src/treasuryTemplates.js`);
const SP = await import(`${FRONTEND}/src/sweepPlan.js`);
const { MIN_RELAY_FEE_RATE, CHANGE_FLOOR, feeMassOf, pickFrom, fundingSlots } = SP;
const { decodeInscription, fetchGenesisTx, restJson, recoverTreasuryFromChain } = await import(`${FRONTEND}/src/kaspaRest.js`);
const G = await import(`${REPO}/packages/descriptor/src/genesis.js`);
const { auditGenesis, normalizeRestGenesisTx, hashScriptHex, computeCovenantId, deriveVaultFromLineage, p2shScriptHash } = G;
const { walkRoot, scanOpenProposals } = await import(`${FRONTEND}/src/proposalScan.js`);
const { p2shAddressFromSpk } = await import(`${REPO}/indexer/kaspaAddr.mjs`);

const ONLY_AUDIT = process.argv.includes("--audit");
// --analysis: replay only the read-only phases (6 + 7) against a treasury this
// harness already put on chain. The spending phases are one-shot by nature — a
// proposal UTXO that has been approved is gone — so re-verifying the chain
// analysis does not mean re-verifying the spends.
const ANALYSIS = process.argv.includes("--analysis");

// ---- resumability -----------------------------------------------------------
// The wallet holds ~2.9 KAS and a treasury costs ~0.35, so a crash three phases
// in must NOT mean starting over: every step that touches the chain is memoised
// by key. A resumed step re-reads its result from the checkpoint and the live
// root/vault outpoints are re-fetched from the node, never from the file.
const STATE = process.env.KOSIGN_E2E_STATE || join(tmpdir(), "kosign-e2e-config-lifecycle.json");
let st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const saveState = () => writeFileSync(STATE, JSON.stringify(st, null, 1));
const resumed = new Set();
const step = async (key, fn) => {
  if (st[key] !== undefined) { console.log(`  (resumed: ${key})`); resumed.add(key); return st[key]; }
  const v = await fn();
  st[key] = v; saveState();
  return v;
};

// ---- fixtures ---------------------------------------------------------------
const wallet = JSON.parse(readFileSync(`${REPO}/.secrets/wallet.testnet.json`, "utf8"));
const keyB = "22".repeat(32), keyC = "33".repeat(32), keyD = "44".repeat(32);
const pk = (k) => bytesToHex(schnorr.getPublicKey(hexToBytes(k)));
const pubB = pk(keyB), pubC = pk(keyC), pubD = pk(keyD);
const signWith = (priv) => (sh) => bytesToHex(schnorr.sign(hexToBytes(sh), hexToBytes(priv)));
const signA = signWith(wallet.private_key), signB = signWith(keyB), signC = signWith(keyC), signD = signWith(keyD);
const NUMS = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
const ZERO_SIG = "00".repeat(64);
const MAX_COVENANT_FEE = 10_000_000;
const BOND = 50_000_000;          // ROOT_PROPOSAL_VAL, hardcoded in tools/wasm-tx
const ROOT_SOMPI = 12_000_000;
const VAULT_SOMPI = 18_000_000;
const TRANSFER = 3_000_000;
const FEE_CEIL = 5_000_000;

const KAS = (s) => (s / 1e8).toFixed(4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = [], failures = [];
const assert = (c, m) => { if (c) { ok.push(m); return true; } failures.push(m); console.error(`  ✗ FAIL: ${m}`); return false; };
const die = (m) => { console.error(`\nFATAL: ${m}`); report(); process.exit(1); };
const must = (c, m) => { if (!assert(c, m)) die(m); return true; };
const txids = [];
const note = (label, txid, what) => { txids.push({ label, txid, what }); console.log(`  TXID ${label.padEnd(20)} ${txid}\n       ${what}`); };
const fees = [];
const price = (borshHex, cap = 0) => {
  const fee = feeMassOf(JSON.parse(W.borsh_masses(borshHex))) * MIN_RELAY_FEE_RATE;
  if (cap) assert(fee <= cap, `fee ${fee} within the ${cap} covenant cap`);
  return fee;
};
const errors = [];
const nodeErr = (what, msg) => { errors.push({ what, msg }); console.log(`  node error (${what}):\n    ${msg}`); };

// ============================================================================
// PHASE 0 — the indexer / auditor fix, on REAL chain data. No funds.
// ============================================================================
// Round 1 left a stranger's covenant planted at a real vault address. The indexer
// used to hand the FIRST covenant id it found at a vault address to the auditor as
// "what the live treasury carries" — which would refuse that honest treasury as
// forged, permanently and in public, for the price of the dust.
const PLANTED_VAULT = "kaspatest:pr5e22e43xdmm23tdxs48uncr3vvrrq5nq8g4z5krcs9t34z077jxyfzz50yr";
const PLANT_TXID = "0bdd807f3378dca0b6afe864a350d7b64d6873716d6682c32d3566442e94e16c";

// ---- the borsh bridge -------------------------------------------------------
const envFile = Object.fromEntries(readFileSync(`${REPO}/.env`, "utf8").split("\n")
  .filter((l) => l.trim() && !l.trim().startsWith("#"))
  .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const RPC_ENV = { ...process.env, KASPA_RPC_URL: envFile.KASPA_RPC_URL, KASPA_NETWORK: envFile.KASPA_NETWORK || "testnet-10" };
const BRIDGE = `${REPO}/tools/kaspa-probe/target/release/kobridge`;
if (!existsSync(BRIDGE)) die(`the bridge is not built: cd tools/kaspa-probe && cargo build --release --bin kobridge`);

function connectBridge() {
  const p = spawn(BRIDGE, [], { cwd: REPO, env: RPC_ENV, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", nextId = 0, readyRes, readyRej;
  const waiters = new Map();
  const ready = new Promise((res, rej) => { readyRes = res; readyRej = rej; });
  p.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id === 0) { readyRes(); continue; }
      const w = waiters.get(m.id);
      if (!w) continue;
      waiters.delete(m.id);
      if (m.error !== undefined) w.rej(new Error(typeof m.error === "string" ? m.error : JSON.stringify(m.error)));
      else w.res(m.result);
    }
  });
  let stderr = "";
  p.stderr.on("data", (d) => { stderr += d.toString(); });
  p.on("exit", (code) => { readyRej(new Error(`bridge exited ${code}: ${stderr.slice(0, 400)}`)); for (const [, w] of waiters) w.rej(new Error("bridge closed")); waiters.clear(); });
  const call = (method, params = {}) => new Promise((res, rej) => {
    const id = ++nextId;
    const t = setTimeout(() => { waiters.delete(id); rej(new Error(`${method} timed out`)); }, 30_000);
    waiters.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    p.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  return { ready, call, close: () => { try { p.stdin.end(); p.kill(); } catch { /* ignore */ } } };
}
const c = connectBridge();
await c.ready;
const info = await c.call("getInfo");
console.log(`node: ${new URL(envFile.KASPA_RPC_URL).host} (borsh wRPC via kobridge)`);
console.log(`      server ${info.serverVersion}, network ${info.networkId}, synced ${info.isSynced}, utxoIndex ${info.hasUtxoIndex}, daa ${info.virtualDaaScore}\n`);
must(info.serverVersion === "1.2.1-toc.3", `the .env node is server 1.2.1-toc.3 (got ${info.serverVersion}) — round 1 ran against 2.0.1, so nothing here is inherited`);
must(info.isSynced, "the node is synced");

const utxosOf = async (addr) => ((await c.call("getUtxosByAddresses", { addresses: [addr] })).entries || []);
const daaNow = async () => Number((await c.call("getBlockDagInfo")).virtualDaaScore);

console.log("PHASE 0 — the indexer/auditor fix, on REAL chain data (no funds spent)");
{
  const entries = await utxosOf(PLANTED_VAULT);
  must(entries.length >= 2, `round 1's vault address still holds ${entries.length} UTXOs — the real vault AND the stranger's plant`);
  const planted = entries.find((e) => e.outpoint.transactionId === PLANT_TXID);
  must(planted, `the stranger's planted covenant ${PLANT_TXID.slice(0, 12)}…:0 is still there`);
  const F = String(planted.utxoEntry.covenantId).toLowerCase();

  // the genesis of THAT treasury, from the public REST indexer (per-output covenant fields)
  let restTx = null;
  for (let i = 0; i < 20 && !restTx; i++) {
    try { restTx = await fetchGenesisTx(PLANTED_VAULT); } catch { /* lag */ }
    if (!restTx) { process.stdout.write("."); await sleep(4000); }
  }
  must(restTx, "the round-1 genesis is readable from the REST indexer");
  const atx = normalizeRestGenesisTx(restTx);

  // vaultOfGenesis, exactly as indexer/server.mjs computes it
  const funding = atx.inputs?.[G.AUTHORIZING_INPUT_INDEX];
  const rootOut = atx.outputs?.[G.ROOT_OUTPUT_INDEX];
  must(p2shScriptHash(rootOut?.spkHex), "the genesis' output 0 is a P2SH KoRoot");
  const lineage = computeCovenantId({ txid: funding.txid, index: funding.index },
    [{ index: G.ROOT_OUTPUT_INDEX, value: rootOut.value, spkVersion: rootOut.spkVersion, spkHex: rootOut.spkHex }]);
  const { vaultHash } = deriveVaultFromLineage(lineage);
  const derivedAddress = p2shAddressFromSpk("kaspatest", `0000aa20${vaultHash}87`);
  const derived = { lineage, vaultHash, address: derivedAddress };
  must(derived.address === PLANTED_VAULT, "the address the genesis DERIVES is the address being audited");
  assert(F !== derived.lineage, `the planted UTXO carries ${F.slice(0, 16)}…, which is NOT the lineage this genesis derives (${derived.lineage.slice(0, 16)}…)`);

  // ---- the OLD selection: the first covenant-bearing UTXO, unfiltered --------
  const oldPick = entries.find((e) => e.utxoEntry?.covenantId);
  const newPick = entries.find((e) => String(e.utxoEntry?.covenantId ?? "").toLowerCase() === derived.lineage);
  must(newPick, "the NEW selection finds the UTXO carrying the lineage the genesis derives");
  assert(newPick.utxoEntry.covenantId.toLowerCase() === derived.lineage, "…and that is the treasury's own vault UTXO");
  console.log(`  node returns ${entries.length} UTXOs at this address, in this order:`);
  for (const e of entries) console.log(`    ${e.outpoint.transactionId.slice(0, 16)}…:${e.outpoint.index}  ${KAS(Number(e.utxoEntry.amount)).padStart(10)} KAS  cid ${String(e.utxoEntry.covenantId).slice(0, 16)}…${String(e.utxoEntry.covenantId).toLowerCase() === derived.lineage ? "  <- the treasury's" : "  <- a stranger's"}`);
  // The old predicate was `entries.find(e => e.utxoEntry?.covenantId)` — no lineage
  // test at all, so which UTXO it returns is whatever the node happens to list
  // first. That order is NOT stable: across runs against this same node minutes
  // apart it returned the stranger's UTXO first, then the treasury's. So the old
  // code was a coin flip on every restart, not a permanent verdict either way —
  // which is worse than a deterministic bug, because a treasury could pass once and
  // be refused on the next follower restart.
  const foreignMatchesOldPredicate = entries.some((e) => e.utxoEntry?.covenantId && String(e.utxoEntry.covenantId).toLowerCase() !== derived.lineage);
  assert(foreignMatchesOldPredicate,
    "the OLD selection (first covenant UTXO, unfiltered) applies NO lineage test, and a UTXO at this address satisfies it while carrying a stranger's id — so the id it hands the auditor depends only on the node's listing order");
  console.log(`  the old predicate would have picked ${String(oldPick?.utxoEntry?.covenantId).slice(0, 16)}… this time — ${String(oldPick?.utxoEntry?.covenantId).toLowerCase() === derived.lineage ? "the treasury's (lucky)" : "the STRANGER's (refusal)"}`);

  // ---- the audit, fed what each selection produces ---------------------------
  const auditWith = (id) => auditGenesis(atx, { vaultAddress: PLANTED_VAULT, vaultScriptHash: derived.vaultHash, treasuryId: id });
  const good = auditWith(String(newPick.utxoEntry.covenantId));
  assert(good.ok && good.verdict === "clean", `the NEW selection audits CLEAN (got ${good.verdict}${good.reason ? `: ${good.reason}` : ""})`);
  assert(good.cryptographic === true, "…and the verdict is cryptographic");

  const withForeign = auditWith(F);
  assert(withForeign.ok && withForeign.verdict === "clean",
    `even fed the STRANGER's id directly, the current auditor comes out CLEAN (got ${withForeign.verdict}${withForeign.reason ? `: ${withForeign.reason}` : ""})`);
  const ick = withForeign.checks.find((k) => k.id === "independent-covenant-id");
  assert(ick && ick.state === "pass", `the check "independent-covenant-id" is present and passes (got ${ick?.state})`);
  assert(ick && /sits at this address/.test(ick.note || ""), "…and it REPORTS the foreign UTXO rather than refusing on it");
  console.log(`  independent-covenant-id: ${ick?.note}`);
  const ick2 = good.checks.find((k) => k.id === "independent-covenant-id");
  assert(ick2 && ick2.state === "pass" && /the same id this genesis mints/.test(ick2.note || ""),
    "…and with the treasury's own id it corroborates instead ('the same id this genesis mints')");

  // ---- and the OLD auditor, executed, really would have refused --------------
  const OLDF = `${REPO}/packages/descriptor/src/genesis.HEAD-for-test.mjs`;
  writeFileSync(OLDF, execFileSync("git", ["show", "HEAD:packages/descriptor/src/genesis.js"], { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 24 }));
  try {
    const OLD = await import(pathToFileURL(OLDF));
    const oldGood = OLD.auditGenesis(atx, { vaultAddress: PLANTED_VAULT, vaultScriptHash: derived.vaultHash, treasuryId: String(newPick.utxoEntry.covenantId) });
    assert(oldGood.ok && oldGood.verdict === "clean", "the OLD auditor was fine when handed the treasury's own id — so the fix changed nothing about honest input");
    const oldBad = OLD.auditGenesis(atx, { vaultAddress: PLANTED_VAULT, vaultScriptHash: derived.vaultHash, treasuryId: F });
    assert(oldBad.ok === false && oldBad.verdict === "refused" && oldBad.code === "treasury-id-mismatch",
      `the OLD auditor, handed what the OLD selection would have picked, REFUSES this honest treasury (verdict ${oldBad.verdict}, code ${oldBad.code}) — the fix is fixing something real`);
    console.log(`  OLD auditor on the old selection: ${oldBad.verdict} / ${oldBad.code}\n    ${oldBad.reason}`);
  } finally { try { unlinkSync(OLDF); } catch { /* ignore */ } }
}

if (ONLY_AUDIT) { report(); c.close(); process.exit(failures.length ? 1 : 0); }

// ============================================================================
// wallet plumbing
// ============================================================================
const spent = new Set();
const markSpent = (borshHex) => {
  for (const i of JSON.parse(W.borsh_to_rpc_json(borshHex)).inputs || []) {
    const o = i.previousOutpoint; if (o) spent.add(`${o.transactionId}:${Number(o.index ?? 0)}`);
  }
};
const toU = (e) => ({ txid: e.outpoint.transactionId, index: e.outpoint.index, amount: Number(e.utxoEntry.amount) });
const walletUtxos = async () => (await utxosOf(wallet.address))
  .filter((e) => !e.utxoEntry.covenantId).map(toU)
  .filter((u) => !spent.has(`${u.txid}:${u.index}`)).sort((a, b) => b.amount - a.amount);
const balance = async () => (await walletUtxos()).reduce((a, u) => a + u.amount, 0);
const rawSubmit = async (borshHex) => {
  const r = await c.call("submitBorsh", { hex: borshHex });
  markSpent(borshHex);
  return r.transactionId;
};
// submit, re-signing if the node quotes a higher required fee
const submitPriced = async (signedAt, fee0, label = "") => {
  let fee = fee0, out = signedAt(fee);
  for (let attempt = 0; ; attempt++) {
    try { return { txid: await rawSubmit(out.borshHex), fee, out }; }
    catch (e) {
      const msg = String(e?.message || e);
      const want = /required amount of (\d+)/.exec(msg);
      if (!want || attempt >= 3) { console.error(`  submit failed${label ? ` (${label})` : ""}: ${msg}`); throw e; }
      fee = Number(want[1]); out = signedAt(fee);
      console.log(`  (node asks >= ${KAS(fee)} KAS — re-signing)`);
    }
  }
};
// a submit we EXPECT the node to refuse; a fee quote is not a refusal, so repay and retry
const expectRefusal = async (at, fee0, what) => {
  let fee = fee0, built = at(fee);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const txid = await rawSubmit(built.borshHex);
      return { accepted: true, txid };
    } catch (e) {
      const msg = String(e?.message || e);
      const want = /required amount of (\d+)/.exec(msg);
      if (want) { fee = Number(want[1]); built = at(fee); continue; }
      nodeErr(what, msg);
      return { accepted: false, msg };
    }
  }
  return { accepted: false, msg: "(kept quoting fees)" };
};
const waitUtxo = async (addr, pred, tries = 120, label = "") => {
  for (let i = 0; i < tries; i++) { const hit = (await utxosOf(addr)).find(pred); if (hit) return hit; await sleep(700); }
  die(`timed out waiting for a UTXO at ${addr.slice(0, 28)}… ${label}`);
};
const p2sh = (redeem) => W.p2sh_address(redeem, "testnet");

console.log(`\ndev wallet: ${wallet.address}`);
const balBefore = await balance();
console.log(`balance before: ${KAS(balBefore)} KAS`);

// ============================================================================
// PHASE 1 — a 2-of-3 treasury: genesis + bootstrap
// ============================================================================
console.log("\nPHASE 1 — genesis + bootstrapVault (2-of-3: A, B, C)");
const ownersGenesis = [wallet.xonly_pubkey, pubB, pubC];
let cfg = { threshold: 2, ownerCount: 3, owners5: [...ownersGenesis, NUMS, NUMS] };
const rootRedeem = rebuildRoot(0, cfg.threshold, cfg.ownerCount, cfg.owners5);
const rootAddress = p2sh(rootRedeem);

const gen = await step("genesis", async () => {
  const need = ROOT_SOMPI + VAULT_SOMPI + 2 * FEE_CEIL + CHANGE_FLOOR;
  const fents0 = await walletUtxos();
  const { picked, sum } = pickFrom(fents0, need, fundingSlots(0));
  must(sum >= need, `wallet funds both transactions (${KAS(sum)} >= ${KAS(need)} KAS)`);
  const anchor = { fundingAddress: wallet.address, rootRedeem, rootValue: ROOT_SOMPI, fundingUtxos: picked };
  const id = W.genesis_covenant_id(JSON.stringify(anchor));
  const payload = W.inscription(2n, JSON.stringify(ownersGenesis), id);
  const mkGinp = (change) => JSON.stringify({ ...anchor, change, payloadHex: payload });
  const probeG = JSON.parse(W.genesis_build(mkGinp(sum - ROOT_SOMPI - FEE_CEIL), JSON.stringify(picked.map(() => ZERO_SIG)))).borshHex;
  const signedGenesis = (fee) => {
    const ginp = mkGinp(sum - ROOT_SOMPI - fee);
    const ga = JSON.parse(W.genesis_sighashes(ginp));
    return { ...JSON.parse(W.genesis_build(ginp, JSON.stringify(ga.sighashes.map(signA)))), change: sum - ROOT_SOMPI - fee };
  };
  const g = await submitPriced(signedGenesis, price(probeG), "genesis");
  must(g.out.treasuryId === id, "the genesis mints exactly the precomputed id C");
  return { C: id, txid: g.txid, change: g.out.change, fee: g.fee };
});
const C = gen.C, genesisTxid = gen.txid;
const vaultRedeem = rebuildVault(C);
const vaultAddress = p2sh(vaultRedeem);
const vaultScriptHash = hashScriptHex(vaultRedeem);
console.log(`  covenant id C  = ${C}`);
console.log(`  vault address  = ${vaultAddress}`);
console.log(`  root  address  = ${rootAddress}`);
fees.push({ what: "genesis", fee: gen.fee });
note("genesis", genesisTxid, `2-of-3 treasury [A,B,C]; mints C=${C.slice(0, 12)}… binding output 0 (the KoRoot) only`);

const boot = await step("bootstrap", async () => {
  const bootBase = {
    rootScript: rootRedeem, rootTxid: genesisTxid, rootIndex: 0, rootAmount: ROOT_SOMPI,
    treasuryId: C, vaultPrefix: TEMPLATES.vault.prefix, vaultSuffix: TEMPLATES.vault.suffix,
    vaultValue: VAULT_SOMPI, ownerIndex: 0, ownerAddress: wallet.address,
    fundingUtxos: [{ txid: genesisTxid, index: 1, amount: gen.change }],
  };
  const foldFee = (f) => { const ch = gen.change - VAULT_SOMPI - f; return ch > 0 && ch < CHANGE_FLOOR ? f + ch : f; };
  const signedBootstrap = (fee) => {
    const inp = JSON.stringify({ ...bootBase, fee: foldFee(fee) });
    const shs = JSON.parse(W.bootstrap_sighashes(inp));
    return JSON.parse(W.bootstrap_build(inp, JSON.stringify(shs.map(signA))));
  };
  const probeB = JSON.parse(W.bootstrap_build(JSON.stringify({ ...bootBase, fee: 0 }), JSON.stringify(Array(2).fill(ZERO_SIG)))).borshHex;
  const r = await submitPriced(signedBootstrap, price(probeB), "bootstrap");
  must(r.out.vaultRedeemHex === vaultRedeem, "the bootstrap mints the redeem script rebuildVault(C) derives in JS");
  return { txid: r.txid, fee: r.fee };
});
fees.push({ what: "bootstrap", fee: boot.fee });
note("bootstrap", boot.txid, `mints the KoVault at ${vaultAddress.slice(0, 22)}… as a continuation of C`);

let vaultUtxo, root;
if (!resumed.has("bootstrap")) {
  vaultUtxo = await waitUtxo(vaultAddress, (e) => e.utxoEntry.covenantId === C, 200, "(vault mint)");
  must(Number(vaultUtxo.utxoEntry.amount) === VAULT_SOMPI, `the vault holds the ${KAS(VAULT_SOMPI)} KAS endowment`);
  const ru = await waitUtxo(rootAddress, (e) => e.outpoint.transactionId === boot.txid, 200, "(root continuation)");
  root = { redeem: rootRedeem, txid: boot.txid, index: 0, value: Number(ru.utxoEntry.amount) };
  must(root.value === ROOT_SOMPI, "the KoRoot kept its full value (owner-funded bootstrap)");
} else {
  // Resumed: the treasury has moved on since the mint, so the mint-time values are
  // no longer on chain to re-read. They were asserted in the run that created them.
  root = { redeem: rootRedeem, txid: boot.txid, index: 0, value: ROOT_SOMPI };
  vaultUtxo = (await utxosOf(vaultAddress)).find((e) => e.utxoEntry.covenantId === C);
  must(vaultUtxo, "the vault UTXO is on chain under lineage C");
  console.log(`  (mint-time endowment/root-value asserted in the creating run; live vault now ${KAS(Number(vaultUtxo.utxoEntry.amount))} KAS)`);
}
if (ANALYSIS) {
  const last = st["cp-expiring"];
  must(last, "--analysis needs a completed spending run in the checkpoint");
  // closeExpired does not touch the KoRoot, so the last createProposal's
  // continuation IS the live root.
  root = { redeem: last.rootContHex, txid: last.txid, index: 0, value: ROOT_SOMPI + 2 * BOND };
  console.log("  --analysis: phases 2-5 are already on chain; the live root is taken from the checkpoint");
}
console.log(`  balance now: ${KAS(await balance())} KAS`);
// shared builders
// ============================================================================
const rinfo = (addr) => JSON.parse(W.recipient_info(addr));

async function createProposal(key, { operation, recipientSpkHash, amount, expiresAt, proposerIndex, sign, label }) {
  const done = await step(key, async () => {
  const fents = await walletUtxos();
  const p = pickFrom(fents, BOND + 5_000_000 + CHANGE_FLOOR, fundingSlots(1));
  must(p.sum >= BOND + 2_000_000, `the wallet funds the ${label} proposal bond (${KAS(p.sum)} KAS picked)`);
  const base = {
    rootScript: root.redeem, rootTxid: root.txid, rootIndex: root.index, rootAmount: root.value,
    treasuryId: C, pPrefix: TEMPLATES.proposal.prefix, pSuffix: TEMPLATES.proposal.suffix, vPrefix: TEMPLATES.vault.prefix, vSuffix: TEMPLATES.vault.suffix,
    rStart: ROOT_STATE_LAYOUT.start, operation, recipientSpkHash, amount,
    maxFee: MAX_COVENANT_FEE, expiresAt, executionDelay: 0, proposerIndex,
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
    return JSON.parse(W.create_proposal_build(inputs, JSON.stringify(shs.map((sh, i) => (i === 0 ? sign(sh) : signA(sh))))));
  };
  const r = await submitPriced(at, fee0, label);
  return { txid: r.txid, fee: r.fee, redeem: r.out.proposalRedeemHex, rootContHex: r.out.rootContHex, status: r.out.status, label };
  });
  fees.push({ what: `createProposal (${done.label})`, fee: done.fee });
  const prop = { ...done, index: 1, value: BOND };
  root = { redeem: done.rootContHex, txid: done.txid, index: 0, value: root.value };
  await waitUtxo(p2sh(prop.redeem), (e) => e.outpoint.transactionId === done.txid, 200, `(${done.label} proposal)`);
  await waitUtxo(p2sh(root.redeem), (e) => e.outpoint.transactionId === done.txid && Number(e.outpoint.index) === 0, 200, "(root continuation)");
  return prop;
}

function opBase(prop) {
  return { proposalRedeem: prop.redeem, propTxid: prop.txid, propIndex: prop.index, propAmount: prop.value, treasuryId: C, pStart: PROPOSAL_STATE_LAYOUT.start };
}
async function voteAt(prop, ownerIndex, sign, kind /* "approve" | "reject" */) {
  const build = kind === "approve" ? W.approve_build : W.reject_build;
  const sighashes = kind === "approve" ? W.approve_sighashes : W.reject_sighashes;
  const fents = await walletUtxos();
  const base = { ...opBase(prop), ownerIndex, ownerAddress: wallet.address };
  const massOf = (fund) => feeMassOf(JSON.parse(W.borsh_masses(
    JSON.parse(build(JSON.stringify({ ...base, fundingUtxos: fund, fee: 0 }), JSON.stringify(Array(1 + fund.length).fill(ZERO_SIG)))).borshHex)));
  const s = SP.fold(SP.sizeOpFee(massOf, fents, 1));
  must(!s.short, `the wallet covers the ${kind} fee`);
  const at = (fee) => {
    const inputs = JSON.stringify({ ...base, fundingUtxos: s.picked, fee });
    const shs = JSON.parse(sighashes(inputs));
    return JSON.parse(build(inputs, JSON.stringify(shs.map((sh, i) => (i === 0 ? sign(sh) : signA(sh))))));
  };
  return { at, fee: s.fee };
}

// executeConfig: spends the KoRoot (SELECTOR 2 — shifted by bootstrapVault) plus
// the Approved CONFIG proposal, and continues the root with the new owner set.
async function executeConfig(approved, newCfg, newOwners5, label) {
  const fents = await walletUtxos();
  const base = {
    rootScript: root.redeem, rootTxid: root.txid, rootIndex: root.index, rootAmount: root.value,
    treasuryId: C, proposalRedeem: approved.redeem, propTxid: approved.txid, propIndex: approved.index, propAmount: approved.value,
    rStart: ROOT_STATE_LAYOUT.start, newThreshold: newCfg.threshold, newOwnerCount: newCfg.ownerCount,
    newOwners: newOwners5, executorIndex: 0, ownerAddress: wallet.address,
  };
  const massOf = (fund) => feeMassOf(JSON.parse(W.borsh_masses(
    JSON.parse(W.execute_config_build(JSON.stringify({ ...base, fundingUtxos: fund, fee: 0 }), JSON.stringify(Array(1 + fund.length).fill(ZERO_SIG)))).borshHex)));
  const s = SP.fold(SP.sizeOpFee(massOf, fents, 2));
  must(!s.short, `the wallet covers the ${label} fee`);
  const at = (fee) => {
    const inputs = JSON.stringify({ ...base, fundingUtxos: s.picked, fee });
    const shs = JSON.parse(W.execute_config_sighashes(inputs));
    return JSON.parse(W.execute_config_build(inputs, JSON.stringify(shs.map(signA))));
  };
  const x = await submitPriced(at, s.fee, label);
  return { txid: x.txid, fee: x.fee, newRootHex: x.out.newRootHex };
}

// A vote that is submitted once and then remembered, so a resumed run does not
// try to re-spend a proposal UTXO that is already gone.
async function vote(key, prop, ownerIndex, sign, kind, label) {
  const done = await step(key, async () => {
    const v = await voteAt(prop, ownerIndex, sign, kind);
    const r = await submitPriced(v.at, v.fee, label);
    return { txid: r.txid, fee: r.fee, newRedeemHex: r.out.newRedeemHex, status: r.out.status,
      bitmap: r.out.bitmap, count: r.out.count, rejectBitmap: r.out.rejectBitmap, rejectCount: r.out.rejectCount };
  });
  fees.push({ what: label, fee: done.fee });
  return done;
}

// ============================================================================
// PHASE 2 — ADD AN OWNER (CONFIG proposal, operation 2, executeConfig SELECTOR 2)
// ============================================================================
console.log("\nPHASE 2 — ADD AN OWNER: 2-of-3 [A,B,C] -> 2-of-4 [A,B,C,D]");
const ownersAdd5 = [wallet.xonly_pubkey, pubB, pubC, pubD, NUMS];
const cfgAdd = { threshold: 2, ownerCount: 4, owners5: ownersAdd5 };
const commitAdd = W.config_commit(BigInt(cfgAdd.threshold), BigInt(cfgAdd.ownerCount), JSON.stringify(ownersAdd5));
console.log(`  config commitment = blake2b(thr8‖cnt8‖owner0..4) = ${commitAdd.slice(0, 24)}…`);
if (!ANALYSIS) {
  // amount 1, not 0: KoRoot.createProposal has `require(amount > 0)` on EVERY
  // proposal, CONFIG included (executeConfig never reads it). This is what the
  // shipped UI does too — frontend/src/wasmTx.js line 1095.
  const prop = await createProposal("cp-config-add", { operation: 2, recipientSpkHash: commitAdd, amount: 1, expiresAt: 4_000_000_000, proposerIndex: 0, sign: signA, label: "CONFIG add" });
  assert(prop.status === 0, "the CONFIG proposal is born Pending (1 of 2)");
  note("cp-config-add", prop.txid, `A proposes operation 2 (CONFIG) committing the 2-of-4 owner set; fee ${KAS(fees.at(-1).fee)} KAS`);

  const r = await vote("approve-config-add", prop, 1, signB, "approve", "approve (CONFIG add)");
  assert(r.status === 1, "B's approval takes it to Approved (2 of 2)");
  note("approve-config-add", r.txid, `B approves; status Approved; fee ${KAS(r.fee)} KAS`);
  await waitUtxo(p2sh(r.newRedeemHex), (e) => e.outpoint.transactionId === r.txid, 200, "(approved CONFIG)");
  const approved = { redeem: r.newRedeemHex, txid: r.txid, index: 0, value: BOND };

  // ---- executeConfig. THE SELECTOR: 2, not the pre-bootstrapVault 1 ----------
  const x = await step("execcfg-add", () => executeConfig(approved, cfgAdd, ownersAdd5, "executeConfig add"));
  fees.push({ what: "executeConfig (add)", fee: x.fee });
  note("executeConfig-add", x.txid, `installs 2-of-4 [A,B,C,D] in KoRoot state; fee ${KAS(x.fee)} KAS`);

  // the root's ADDRESS is a pure function of its state, so landing at the address
  // rebuildRoot(nonce, 2, 4, [A,B,C,D,NUMS]) derives IS the new owner set on chain
  const expectRedeem = rebuildRoot(1, cfgAdd.threshold, cfgAdd.ownerCount, ownersAdd5);
  must(x.newRootHex === expectRedeem, "the built continuation is byte-identical to rebuildRoot(nonce=1, 2, 4, [A,B,C,D,NUMS])");
  const nr = await waitUtxo(p2sh(expectRedeem), (e) => e.outpoint.transactionId === x.txid && Number(e.outpoint.index) === 0, 200, "(new root)");
  assert(nr.utxoEntry.covenantId === C, "the new KoRoot continuation still carries the treasury's lineage C");
  assert(Number(nr.utxoEntry.amount) === root.value + BOND, `the root absorbed the ${KAS(BOND)} KAS bond (${KAS(Number(nr.utxoEntry.amount))} KAS)`);
  ok.push("ADD: the KoRoot continuation carries the NEW owner set [A,B,C,D] and the NEW threshold 2-of-4 — proven by the address it landed on, which is that state's own hash");
  console.log(`  new root address = ${p2sh(expectRedeem)}`);

  // ---- the whole point of mutable owners: the vault address does not move ----
  assert(p2sh(rebuildVault(C)) === vaultAddress, "the vault address is UNCHANGED by the owner change (it is a function of C alone)");
  const stillThere = (await utxosOf(vaultAddress)).find((e) => e.utxoEntry.covenantId === C);
  assert(stillThere && Number(stillThere.utxoEntry.amount) === Number(vaultUtxo.utxoEntry.amount),
    `the vault UTXO is untouched by the owner change, at the same address and the same value (${KAS(Number(stillThere?.utxoEntry?.amount ?? 0))} KAS)`);
  root = { redeem: expectRedeem, txid: x.txid, index: 0, value: Number(nr.utxoEntry.amount) };
  cfg = cfgAdd;
}
console.log(`  balance now: ${KAS(await balance())} KAS`);

// ============================================================================
// PHASE 3 — the treasury still spends, with the NEWLY ADDED owner approving
// ============================================================================
console.log("\nPHASE 3 — propose (A) -> approve (D, the new owner) -> execute");
const recipient = W.pubkey_address(pubD, "testnet");
const rd = rinfo(recipient);
if (!ANALYSIS) {
  const prop = await createProposal("cp-transfer", { operation: 1, recipientSpkHash: rd.spkHash, amount: TRANSFER, expiresAt: 4_000_000_000, proposerIndex: 0, sign: signA, label: "transfer" });
  note("cp-transfer", prop.txid, `A proposes ${KAS(TRANSFER)} KAS -> ${recipient.slice(0, 22)}…; fee ${KAS(fees.at(-1).fee)} KAS`);
  // owner index 3 = D, an owner only because of the config change
  const r = await vote("approve-by-D", prop, 3, signD, "approve", "approve (by the new owner D)");
  assert(r.status === 1, "the NEWLY ADDED owner D's approval is accepted and takes the proposal to Approved");
  note("approve-by-D", r.txid, `D (owner index 3, added by the CONFIG change) approves; fee ${KAS(r.fee)} KAS`);
  await waitUtxo(p2sh(r.newRedeemHex), (e) => e.outpoint.transactionId === r.txid, 200, "(approved transfer)");

  const x = await step("execute", async () => {
    const base = {
      treasuryId: C, vaultRedeem, vaultTxid: vaultUtxo.outpoint.transactionId, vaultIndex: vaultUtxo.outpoint.index,
      vaultAmount: Number(vaultUtxo.utxoEntry.amount),
      proposalRedeem: r.newRedeemHex, propTxid: r.txid, propIndex: 0, propAmount: BOND,
      recipientSpkHex: rd.spkHex, amount: TRANSFER, executorIndex: 3,
    };
    const probe = JSON.parse(W.execute_build(JSON.stringify({ ...base, fee: 0 }), ZERO_SIG)).borshHex;
    const at = (fee) => {
      const inputs = JSON.stringify({ ...base, fee });
      return JSON.parse(W.execute_build(inputs, signD(W.execute_sighash(inputs))));
    };
    const e = await submitPriced(at, price(probe, MAX_COVENANT_FEE), "execute");
    return { txid: e.txid, fee: e.fee };
  });
  fees.push({ what: "execute (transfer)", fee: x.fee });
  note("execute", x.txid, `D executes: ${KAS(TRANSFER)} KAS leaves the vault; fee ${KAS(x.fee)} KAS (treasury-paid)`);
  const got = await waitUtxo(recipient, (e) => e.outpoint.transactionId === x.txid, 200, "(recipient)");
  assert(Number(got.utxoEntry.amount) === TRANSFER, `the recipient received ${KAS(TRANSFER)} KAS — the treasury is still spendable after the owner change`);
  const change = await waitUtxo(vaultAddress, (e) => e.outpoint.transactionId === x.txid && e.utxoEntry.covenantId, 200, "(vault change)");
  assert(change.utxoEntry.covenantId === C, "the vault change still carries C");
  vaultUtxo = change;
  ok.push("ADD: the treasury is still spendable after the config change, and the newly added owner's key is what made the quorum");
}
console.log(`  balance now: ${KAS(await balance())} KAS`);

// ============================================================================
// PHASE 4 — REMOVE AN OWNER
// ============================================================================
console.log("\nPHASE 4 — REMOVE AN OWNER: 2-of-4 [A,B,C,D] -> 2-of-3 [A,B,D]");
const ownersRm5 = [wallet.xonly_pubkey, pubB, pubD, NUMS, NUMS];
const cfgRm = { threshold: 2, ownerCount: 3, owners5: ownersRm5 };
const commitRm = W.config_commit(BigInt(cfgRm.threshold), BigInt(cfgRm.ownerCount), JSON.stringify(ownersRm5));
if (!ANALYSIS) {
  const prop = await createProposal("cp-config-remove", { operation: 2, recipientSpkHash: commitRm, amount: 1, expiresAt: 4_000_000_000, proposerIndex: 0, sign: signA, label: "CONFIG remove" });
  note("cp-config-remove", prop.txid, `A proposes operation 2 (CONFIG) removing owner C; fee ${KAS(fees.at(-1).fee)} KAS`);
  const r = await vote("approve-config-remove", prop, 1, signB, "approve", "approve (CONFIG remove)");
  assert(r.status === 1, "B's approval takes the removal to Approved");
  note("approve-config-remove", r.txid, `B approves; fee ${KAS(r.fee)} KAS`);
  await waitUtxo(p2sh(r.newRedeemHex), (e) => e.outpoint.transactionId === r.txid, 200, "(approved CONFIG)");
  const approved = { redeem: r.newRedeemHex, txid: r.txid, index: 0, value: BOND };
  const x = await step("execcfg-remove", () => executeConfig(approved, cfgRm, ownersRm5, "executeConfig remove"));
  fees.push({ what: "executeConfig (remove)", fee: x.fee });
  note("executeConfig-remove", x.txid, `installs 2-of-3 [A,B,D]; C is no longer an owner; fee ${KAS(x.fee)} KAS`);
  const expectRedeem = rebuildRoot(3, cfgRm.threshold, cfgRm.ownerCount, ownersRm5);
  must(x.newRootHex === expectRedeem, "the continuation is byte-identical to rebuildRoot(nonce=3, 2, 3, [A,B,D,NUMS,NUMS])");
  const nr = await waitUtxo(p2sh(expectRedeem), (e) => e.outpoint.transactionId === x.txid && Number(e.outpoint.index) === 0, 200, "(new root)");
  assert(nr.utxoEntry.covenantId === C, "the KoRoot continuation still carries C after the removal");
  assert(p2sh(rebuildVault(C)) === vaultAddress, "the vault address is STILL unchanged after the second config change");
  const stillThere = (await utxosOf(vaultAddress)).find((e) => e.utxoEntry.covenantId === C);
  assert(stillThere, "the vault UTXO is still at the same address under C");
  root = { redeem: expectRedeem, txid: x.txid, index: 0, value: Number(nr.utxoEntry.amount) };
  cfg = cfgRm;
  ok.push("REMOVE: the KoRoot continuation carries [A,B,D] at 2-of-3 and the vault address never moved");
}
console.log(`  balance now: ${KAS(await balance())} KAS`);

// ============================================================================
// PHASE 5 — the removed owner is refused; rejections Fail the proposal;
//           the expired proposal is retired permissionlessly.
// ============================================================================
console.log("\nPHASE 5 — removed-owner refusal + reject -> Failed + closeExpired");
const EXPIRES_AT = await step("expires-at", async () => (await daaNow()) + 700); // ~70 s at 10 bps; polled below, never assumed
console.log(`  daa now ${await daaNow()}; this proposal expires at DAA ${EXPIRES_AT}`);
if (!ANALYSIS) {
  const prop = await createProposal("cp-expiring", { operation: 1, recipientSpkHash: rd.spkHash, amount: TRANSFER, expiresAt: EXPIRES_AT, proposerIndex: 0, sign: signA, label: "short-expiry transfer" });
  note("cp-expiring", prop.txid, `A proposes a ${KAS(TRANSFER)} KAS transfer expiring at DAA ${EXPIRES_AT}; fee ${KAS(fees.at(-1).fee)} KAS`);
  let cur = prop;

  // ---- (a) THE REMOVED OWNER. C's key at every index the snapshot has --------
  for (const idx of [0, 1, 2]) {
    const r = await step(`removed-owner-refusal-${idx}`, async () => {
      const v = await voteAt(cur, idx, signC, "approve");
      return expectRefusal(v.at, v.fee, `removed owner C approving at index ${idx}`);
    });
    if (r.accepted) { assert(false, `CRITICAL: the removed owner C's approval at index ${idx} was ACCEPTED (${r.txid})`); }
    else {
      if (!errors.some((e) => e.what.includes(`index ${idx}`))) errors.push({ what: `removed owner C approving at index ${idx}`, msg: r.msg });
      assert(/script ran, but verification failed/.test(r.msg),
        `the removed owner C's approval at index ${idx} is refused by the node as a SCRIPT failure (not a fee or policy rejection)`);
    }
  }
  ok.push("REMOVE: the removed owner C can no longer approve at ANY index — the node refuses every attempt in script");

  // ---- (b) REJECT: recorded on chain ----------------------------------------
  {
    const r = await vote("reject-B", cur, 1, signB, "reject", "reject (B)");
    assert(Number(r.rejectCount) === 1, `the on-chain proposal state records rejectCount = 1 (got ${r.rejectCount})`);
    assert(Number(r.rejectBitmap) === 2, `rejectBitmap records owner 1 (bit 1 => 2; got ${r.rejectBitmap})`);
    assert(Number(r.status) === 0, "one rejection out of 3 owners at threshold 2 leaves the proposal Pending (3-1 >= 2)");
    note("reject-B", r.txid, `B rejects; rejectCount 1, still Pending; fee ${KAS(r.fee)} KAS`);
    const live = await waitUtxo(p2sh(r.newRedeemHex), (e) => e.outpoint.transactionId === r.txid, 200, "(rejected once)");
    assert(live.utxoEntry.covenantId === C, "the rejected proposal continues under the treasury's lineage C");
    cur = { redeem: r.newRedeemHex, txid: r.txid, index: 0, value: BOND };
  }
  // ---- (c) enough rejections that approval is arithmetically impossible ------
  {
    const r = await vote("reject-D", cur, 2, signD, "reject", "reject (D)");
    assert(Number(r.rejectCount) === 2, `rejectCount = 2 (got ${r.rejectCount})`);
    assert(Number(r.status) === 2, `ownerCount - rejectCount = 3 - 2 = 1 < threshold 2, so the proposal reaches FAILED (status 2; got ${r.status})`);
    note("reject-D-fails", r.txid, `D rejects; approval now arithmetically impossible; status Failed(2); fee ${KAS(r.fee)} KAS`);
    const live = await waitUtxo(p2sh(r.newRedeemHex), (e) => e.outpoint.transactionId === r.txid, 200, "(failed proposal)");
    assert(live.utxoEntry.covenantId === C, "the FAILED proposal UTXO is on chain carrying C");
    cur = { redeem: r.newRedeemHex, txid: r.txid, index: 0, value: BOND };
  }
  // ---- (d) an approve on a Failed proposal is refused ------------------------
  {
    const r = await step("failed-approve-refusal", async () => {
      const v = await voteAt(cur, 1, signB, "approve");
      return expectRefusal(v.at, v.fee, "approving a Failed proposal");
    });
    if (r.accepted) assert(false, `CRITICAL: an approve on a FAILED proposal was accepted (${r.txid})`);
    else {
      if (!errors.some((e) => e.what === "approving a Failed proposal")) errors.push({ what: "approving a Failed proposal", msg: r.msg });
      assert(/script ran, but verification failed/.test(r.msg),
        "an approve on a FAILED proposal is refused by the node as a SCRIPT failure (KoProposal.approve requires status == 0)");
    }
  }
  // ---- (e) closeExpired: permissionless, and nothing inherits the lineage ----
  console.log(`  waiting for DAA to pass ${EXPIRES_AT}…`);
  for (let i = 0; i < 200; i++) { const d = await daaNow(); if (d > EXPIRES_AT + 20) { console.log(`  daa ${d} > ${EXPIRES_AT} — expired`); break; } process.stdout.write("."); await sleep(3000); }
  let budget = 30, done = st["closeExpired"] ?? null, lastMsg = "";
  if (done) console.log("  (resumed: closeExpired)");
  for (let attempt = 0; attempt < 6 && !done; attempt++) {
    const fee = 600_000 * (attempt + 1);
    const built = await c.call("buildCloseExpired", {
      proposalRedeem: cur.redeem, propTxid: cur.txid, propIndex: cur.index, propAmount: cur.value,
      lockTime: EXPIRES_AT, payoutAddress: wallet.address, fee, budget,
    });
    try { done = { txid: await rawSubmit(built.borshHex), fee, out: built }; st["closeExpired"] = done; saveState(); }
    catch (e) {
      const msg = String(e?.message || e); lastMsg = msg;
      const want = /required amount of (\d+)/.exec(msg);
      if (want) {
        const b2 = await c.call("buildCloseExpired", { proposalRedeem: cur.redeem, propTxid: cur.txid, propIndex: cur.index, propAmount: cur.value, lockTime: EXPIRES_AT, payoutAddress: wallet.address, fee: Number(want[1]), budget });
        try { done = { txid: await rawSubmit(b2.borshHex), fee: Number(want[1]), out: b2 }; st["closeExpired"] = done; saveState(); continue; } catch (e2) { lastMsg = String(e2?.message || e2); }
      }
      if (/ScriptUnits|exceeded/i.test(lastMsg)) { budget *= 2; console.log(`  (compute budget too small — retrying at ${budget})`); continue; }
      break;
    }
  }
  if (!assert(done, `closeExpired was accepted by the node (last error: ${lastMsg})`)) { if (lastMsg) nodeErr("closeExpired", lastMsg); }
  if (done) {
    fees.push({ what: "closeExpired", fee: done.fee });
    note("closeExpired", done.txid, `the expired proposal retired PERMISSIONLESSLY — no owner index, no signature, only the selector and the redeem reveal; fee ${KAS(done.fee)} KAS`);
    const shape = JSON.parse(W.borsh_to_rpc_json(done.out.borshHex));
    assert(shape.outputs.every((o) => !o.covenant), "NOTHING inherits the lineage: the retiring transaction has zero covenant outputs (KoProposal.closeExpired: OpCovOutputCount(cid) == 0)");
    assert(Number(shape.lockTime) === EXPIRES_AT, `the transaction's lockTime is the proposal's expiry (${shape.lockTime})`);
    assert(shape.inputs[0].signatureScript.startsWith("52"), "the witness is the closeExpired selector (OP_2) and nothing else before the redeem reveal");
    const back = await waitUtxo(wallet.address, (e) => e.outpoint.transactionId === done.txid, 200, "(bond back)");
    assert(!back.utxoEntry.covenantId, `the retired bond came back to the wallet as a PLAIN coin (${KAS(Number(back.utxoEntry.amount))} KAS)`);
    const gone = (await utxosOf(p2sh(cur.redeem))).find((e) => e.outpoint.transactionId === cur.txid);
    assert(!gone, "the proposal UTXO is gone from the chain");
    // the treasury is unaffected
    const v = (await utxosOf(vaultAddress)).find((e) => e.utxoEntry.covenantId === C);
    const rr = (await utxosOf(p2sh(root.redeem))).find((e) => e.utxoEntry.covenantId === C);
    assert(v && Number(v.utxoEntry.amount) === Number(vaultUtxo.utxoEntry.amount), "the vault is unaffected by the retirement");
    assert(rr && Number(rr.utxoEntry.amount) === root.value, "the KoRoot is unaffected by the retirement");
  }
}
console.log(`  balance now: ${KAS(await balance())} KAS`);

// ============================================================================
// PHASE 6 — THE SELECTOR, END TO END: walkRoot over the real chain history
// ============================================================================
console.log("\nPHASE 6 — proposalScan.walkRoot over this treasury's REAL chain history");
{
  const getU = async (addr) => utxosOf(addr);
  let live = null, creations = [];
  for (let i = 0; i < 40; i++) {
    const r = await walkRoot({
      treasuryId: C, genesisTxid, threshold: 2, ownerCount: 3, owners5: [...ownersGenesis, NUMS, NUMS],
      p2sh, getUtxos: getU, log: (t) => console.log(`    ${t}`),
    });
    if (r.live) { live = r.live; creations = r.creations; break; }
    process.stdout.write("."); await sleep(8000); // the public REST indexer lags
  }
  if (assert(live, "walkRoot reached the LIVE KoRoot by walking the chain from the genesis")) {
    assert(live.threshold === 2 && live.ownerCount === 3, `walkRoot recovers the CURRENT threshold/ownerCount 2-of-3 (got ${live.threshold}-of-${live.ownerCount})`);
    assert(live.owners5.slice(0, 3).join(",") === ownersRm5.slice(0, 3).join(","),
      `walkRoot recovers the CURRENT owner set [A,B,D] — the removed owner C is gone and the added owner D is there (got [${live.owners5.slice(0, 3).map((o) => o.slice(0, 8)).join(", ")}])`);
    assert(!live.owners5.slice(0, live.ownerCount).includes(pubC), "the removed owner C does not appear in the recovered owner set");
    assert(live.owners5.slice(0, live.ownerCount).includes(pubD), "the added owner D does appear in the recovered owner set");
    assert(live.nonce === 4, `walkRoot recovers the CURRENT nonce 4 — one per createProposal (4 of them), none for bootstrapVault or either executeConfig (got ${live.nonce})`);
    assert(live.outpoint.txid === root.txid && Number(live.outpoint.index) === root.index, "walkRoot lands on the live root outpoint this run actually created");
    assert(creations.length === 4, `walkRoot found all 4 createProposal hops (got ${creations.length})`);
    ok.push("THE SELECTOR IS RIGHT END TO END: the walk crossed the bootstrapVault hop (selector 1) and BOTH executeConfig hops (selector 2) and landed on the correct owner set and nonce — the stale selector-1 dispatch would have stopped it dead at the first config change");
    // ---- the regression, demonstrated rather than asserted ------------------
    // 787f6e7 shifted KoRoot's selectors (createProposal=0, bootstrapVault=1,
    // executeConfig=2) and this walk was fixed by hand in the same commit. Run its
    // PARENT — the code as it actually was — over the very same chain history.
    const PRE = `${FRONTEND}/src/proposalScan.PREFIX-for-test.mjs`;
    writeFileSync(PRE, execFileSync("git", ["show", "787f6e7^:frontend/src/proposalScan.js"], { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 24 }));
    try {
      const OLDSCAN = await import(pathToFileURL(PRE));
      let oldWalk = null, threw = null;
      try {
        oldWalk = await OLDSCAN.walkRoot({
          treasuryId: C, genesisTxid, threshold: 2, ownerCount: 3, owners5: [...ownersGenesis, NUMS, NUMS],
          p2sh, getUtxos: getU, log: () => {},
        });
      } catch (e) { threw = String(e?.message || e); }
      // The pre-fix walk reads the bootstrapVault hop (selector 1) as an
      // executeConfig and pulls an owner set out of [ownerIndex, sig, vaultPrefix,
      // vaultSuffix, …] — six pushes where it wants ten. It does not return a wrong
      // answer, it dies on the FIRST hop out of every genesis in existence.
      assert(threw || !oldWalk?.live,
        `the PRE-FIX walk (executeConfig dispatched as selector 1) cannot recover this treasury from the same chain: ${threw ? `it throws "${threw}"` : `it returns live=null`}. That is the production failure the hand fix avoided, and no offline contract test can see it.`);
      console.log(`    pre-fix walkRoot: ${threw ? `THREW "${threw}"` : `live=${oldWalk?.live ? "found" : "null"}, creations=${oldWalk?.creations?.length}`}  (the fixed walk found the live root and 4 creations)`);
    } finally { try { unlinkSync(PRE); } catch { /* ignore */ } }

    const scanned = await scanOpenProposals({ treasuryId: C, creations, p2sh, getUtxos: getU, log: (t) => console.log(`    ${t}`) });
    // FINDING (confirmed on chain, this run): a closeExpired witness is only two
    // pushes — [SELECTOR=2, redeem] — because the entrypoint takes no arguments and
    // no signature. proposalScan.js:166 reads the selector at sps[2], which every
    // OTHER path has (approve/reject put it there; execute pushes an extra leading
    // index so sps[2] is the signature). For closeExpired sps[2] does not exist, the
    // selector reads as null, and `executed = selector !== 2n` is therefore TRUE. A
    // permissionlessly retired proposal is recorded as status 3 with an "executed"
    // event — the UI's chain-recovered history tells the user a rejected proposal
    // paid out. wasmTx.js:461 lets that chain view overwrite the correct local one.
    const closed = scanned.find((p) => p.status === 2 && p.executedTxid);
    assert(closed, "scanOpenProposals reads the closeExpired spend back as a CLOSED (expired) proposal, status 2 — NOT as 'executed'");
    const cfgProps = scanned.filter((p) => p.operation === 2);
    assert(cfgProps.length === 2, `scanOpenProposals sees both CONFIG proposals (got ${cfgProps.length})`);
  }
}

// ============================================================================
// PHASE 7 — recoverTreasuryFromChain
// ============================================================================
console.log("\nPHASE 7 — kaspaRest.recoverTreasuryFromChain against the vault address");
{
  let rec = null;
  for (let i = 0; i < 25 && !rec?.ok; i++) {
    try { rec = await recoverTreasuryFromChain(vaultAddress); } catch (e) { rec = { ok: false, reason: String(e.message || e) }; }
    if (!rec.ok) { process.stdout.write("."); await sleep(6000); }
  }
  // FINDING (confirmed on chain, this run): recoverTreasuryFromChain reads the
  // owner set out of the genesis KOSGN inscription and nothing else, so it reports
  // the owners a treasury was BORN with, for the rest of its life. After the two
  // config changes above it still names C — removed two transactions ago — and does
  // not name D. Two surfaces show it: TreasuryView's read-only path renders
  // r.status.owners directly (TreasuryView.jsx:163/908/926) whenever no RPC node is
  // configured, and the public indexer registers ins.threshold/ins.ownerCount
  // (server.mjs:672) and never revisits them. The node-direct path is unaffected —
  // seedFromChain feeds this result to walkRoot, which corrects it (proven above).
  if (assert(rec?.ok, `recoverTreasuryFromChain resolves the vault address (${rec?.reason ?? ""})`)) {
    const got = rec.status.owners.map((o) => o.pubkey);
    console.log(`  recovered: threshold ${rec.status.threshold}, owners [${got.map((o) => o.slice(0, 8)).join(", ")}], lineage ${String(rec.status.lineage).slice(0, 16)}…`);
    assert(rec.status.lineage === C, "the recovered lineage is C");
    assert(rec.status.genesisTxId === genesisTxid, "the recovered genesis txid is this run's genesis");
    assert(got.length === 3 && got.includes(pubD) && !got.includes(pubC),
      `recoverTreasuryFromChain returns the CURRENT owner set (post add/remove) — D present, C absent. Got [${got.map((o) => o.slice(0, 10)).join(", ")}]`);
  }
}

// ============================================================================
report();
const balAfter = await balance();
console.log(`\nwallet ${KAS(balBefore)} -> ${KAS(balAfter)} KAS (Δ ${KAS(balAfter - balBefore)})`);
console.log(`treasury: root ${KAS(root.value)} KAS + vault ${KAS(Number(((await utxosOf(vaultAddress)).find((e) => e.utxoEntry.covenantId === C))?.utxoEntry?.amount ?? 0))} KAS under lineage ${C}`);
console.log(`vault address (unchanged throughout): ${vaultAddress}`);
c.close();
process.exit(failures.length ? 1 : 0);

function report() {
  if (txids.length) {
    console.log("\n================ TXIDS ================");
    for (const t of txids) console.log(`${t.label.padEnd(22)} ${t.txid}\n                       ${t.what}`);
  }
  if (fees.length) {
    console.log("\n================ FEES =================");
    for (const f of fees) console.log(`${f.what.padEnd(34)} ${KAS(f.fee)} KAS (${f.fee} sompi)`);
    console.log(`${"total".padEnd(34)} ${KAS(fees.reduce((a, f) => a + f.fee, 0))} KAS`);
  }
  if (errors.length) {
    console.log("\n=========== NODE REFUSALS (verbatim) ===========");
    for (const e of errors) console.log(`${e.what}:\n  ${e.msg}`);
  }
  console.log(`\n============ ASSERTIONS: ${ok.length} passed, ${failures.length} failed ============`);
  for (const a of ok) console.log(`  ✓ ${a}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
}
