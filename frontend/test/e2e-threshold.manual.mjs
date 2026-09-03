// TN10 on-chain E2E — ROUND 3: THE THRESHOLD, and closeExpired on a PENDING proposal.
//
// Rounds 1 and 2 (e2e-lineage-vault.manual.mjs, e2e-config-lifecycle.manual.mjs)
// proved genesis/bootstrap/deposit/propose/approve/execute, reject->Failed, and
// owner ADD + REMOVE via KoRoot.executeConfig. Both config proposals there moved
// ownerCount only (3->4->3) and held threshold at 2 throughout, so the
// `newThreshold` path in KoRoot.executeConfig has NEVER run on a node — and it is
// the rule that decides how many signatures move money. Round 2 also retired a
// FAILED proposal (status 2) with closeExpired; a PENDING one (status 0) has never
// been retired on a node, and the EXPIRY GATE itself has never been tested at all.
//
// What this file claims, all of it against a REAL node, on ONE 4-owner treasury:
//   1. RAISING BINDS. A CONFIG proposal raises 2-of-4 -> 3-of-4. The KoRoot
//      continuation's on-chain scriptPubKey equals the one rebuildRoot(nonce,3,4,
//      owners) derives in JS — the chain's own bytes say "threshold 3" — and the
//      2-of-4 derivation does NOT match that address. Then it BITES: a proposal
//      minted under 3-of-4 with only 2 approvals is refused by the node in SCRIPT,
//      and the SAME proposal executes once the third approval lands.
//   2. LOWERING RELEASES. Back to 2-of-4; a proposal minted after the move
//      executes on 2 approvals — the exact count the node refused above.
//   3. THE SNAPSHOT IS WHAT COUNTS. KoRoot.createProposal snapshots (owners,
//      threshold) into the proposal; KoProposal.approve flips to Approved on
//      `newCount >= snapThreshold` and execute gates on `approvalCount >=
//      snapThreshold`; KoVault.executeProposal / KoRoot.executeConfig read only
//      `p.status == 1`. NOTHING re-reads KoRoot's current threshold. So:
//        (a) a proposal minted under 2-of-4 still Approves and still EXECUTES on
//            two approvals after the treasury has become 3-of-4, and
//        (b) a proposal minted under 3-of-4 still needs THREE after the treasury
//            has gone back to 2-of-4 — two approvals leave it Pending and the
//            node refuses the execute.
//      Both proposals sit on chain carrying their own snapThreshold while KoRoot
//      carries a different one; this harness decodes both off the live scripts.
//   4. THE VAULT ADDRESS never moves across either threshold change.
//   5. CLOSEEXPIRED ON A PENDING (status 0) PROPOSAL: retired permissionlessly —
//      no owner index, no signature — lock_time is the committed expiresAt
//      (confirmed by fetching the CONTAINING BLOCK, since the REST tx endpoint
//      does not report it), ZERO outputs inherit the lineage, the bond returns as
//      a plain unbound coin, and vault + root are untouched.
//   6. AND THE EXPIRY GATE: retiring the same proposal BEFORE it expires is
//      refused — both when the transaction tells the truth about its lock time
//      (the node's finality rule) and when it lies (KoProposal's own
//      `tx.time >= expiresAt`, a SCRIPT refusal).
//
// The .env node speaks BORSH wRPC only, so RPC goes through tools/kaspa-probe/
// src/bin/kobridge.rs. Unlike round 2, closeExpired is built by the SHIPPED
// builder (wasm close_expired_build), not the bridge's copy.
//
// MANUAL test: spends real TN10 funds from .secrets/wallet.testnet.json.
//   node frontend/test/e2e-threshold.manual.mjs
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
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
const G = await import(`${REPO}/packages/descriptor/src/genesis.js`);
const { hashScriptHex } = G;

// ---- resumability -----------------------------------------------------------
const STATE = process.env.KOSIGN_E2E_STATE || join(tmpdir(), "kosign-e2e-threshold.json");
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
const signA = signWith(wallet.private_key), signB = signWith(keyB), signC = signWith(keyC);
const NUMS = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
const ZERO_SIG = "00".repeat(64);
const MAX_COVENANT_FEE = 10_000_000;
const BOND = 50_000_000;          // ROOT_PROPOSAL_VAL, hardcoded in tools/wasm-tx
const ROOT_SOMPI = 12_000_000;
const VAULT_SOMPI = 30_000_000;
const TRANSFER = 3_000_000;
const FEE_CEIL = 5_000_000;
const FOREVER = 4_000_000_000;

const KAS = (s) => (s / 1e8).toFixed(4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = [], failures = [];
const assert = (c, m) => { if (c) { ok.push(m); console.log(`  ✓ ${m}`); return true; } failures.push(m); console.error(`  ✗ FAIL: ${m}`); return false; };
const die = (m) => { console.error(`\nFATAL: ${m}`); report(); process.exit(1); };
const must = (c, m) => { if (!assert(c, m)) die(m); return true; };
const txids = [];
const note = (label, txid, what) => { txids.push({ label, txid, what }); console.log(`  TXID ${label.padEnd(22)} ${txid}\n       ${what}`); };
const fees = [];
const price = (borshHex, cap = 0) => {
  const fee = feeMassOf(JSON.parse(W.borsh_masses(borshHex))) * MIN_RELAY_FEE_RATE;
  if (cap) assert(fee <= cap, `fee ${fee} within the ${cap} covenant cap`);
  return fee;
};
const errors = [];
const nodeErr = (what, msg) => { if (!errors.some((e) => e.what === what)) errors.push({ what, msg }); console.log(`  node error (${what}):\n    ${msg}`); };

// ---- state decoders: read the numbers straight off a live redeem script -----
// Silverscript int = OP_PUSHBYTES_8 (0x08) then 8 LE bytes. Byte offsets inside
// the state region mirror tools/wasm-tx/src/lib.rs (OFF_* constants).
const decInt = (hex, byteOff) => {
  const h = hex.slice(byteOff * 2, byteOff * 2 + 18);
  if (h.slice(0, 2) !== "08") throw new Error(`no int at byte ${byteOff}: ${h}`);
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(parseInt(h.slice(2 + i * 2, 4 + i * 2), 16));
  return Number(v);
};
const PS = PROPOSAL_STATE_LAYOUT.start, RS = ROOT_STATE_LAYOUT.start;
const propState = (redeem) => ({
  proposalId: decInt(redeem, PS + 0), operation: decInt(redeem, PS + 9),
  amount: decInt(redeem, PS + 51), expiresAt: decInt(redeem, PS + 69),
  approvalBitmap: decInt(redeem, PS + 87), approvalCount: decInt(redeem, PS + 96),
  status: decInt(redeem, PS + 105), snapThreshold: decInt(redeem, PS + 114),
  ownerCount: decInt(redeem, PS + 123),
});
const rootState = (redeem) => ({
  nonce: decInt(redeem, RS + 0), threshold: decInt(redeem, RS + 9), ownerCount: decInt(redeem, RS + 18),
});
// the scriptPubKey a P2SH redeem lands on: version 0 ‖ OP_BLAKE2B ‖ PUSH32 ‖ hash ‖ OP_EQUAL
const spkOf = (redeem) => `0000aa20${hashScriptHex(redeem)}87`;

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
const NODE_HOST = new URL(envFile.KASPA_RPC_URL).host;
console.log(`node: ${NODE_HOST} (borsh wRPC via kobridge)`);
console.log(`      server ${info.serverVersion}, network ${info.networkId}, synced ${info.isSynced}, utxoIndex ${info.hasUtxoIndex}, daa ${info.virtualDaaScore}\n`);
must(info.isSynced, "the node is synced");
const utxosOf = async (addr) => ((await c.call("getUtxosByAddresses", { addresses: [addr] })).entries || []);
const daaNow = async () => Number((await c.call("getBlockDagInfo")).virtualDaaScore);

// ---- public REST (per-output covenant fields; blocks carry lock_time) -------
const REST = "https://api-tn10.kaspa.org";
const rest = async (path) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(`${REST}${path}`, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${path} -> ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
};

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
    try { return { accepted: true, txid: await rawSubmit(built.borshHex) }; }
    catch (e) {
      const msg = String(e?.message || e);
      const want = /required amount of (\d+)/.exec(msg);
      if (want) { fee = Number(want[1]); built = at(fee); continue; }
      nodeErr(what, msg);
      return { accepted: false, msg };
    }
  }
  return { accepted: false, msg: "(kept quoting fees)" };
};
const waitUtxo = async (addr, pred, tries = 200, label = "") => {
  for (let i = 0; i < tries; i++) { const hit = (await utxosOf(addr)).find(pred); if (hit) return hit; await sleep(700); }
  die(`timed out waiting for a UTXO at ${addr.slice(0, 28)}… ${label}`);
};
// A step replayed from the checkpoint may have had its output SPENT by a later
// step, so waiting for it forever would hang a resumed run. Look once; if it is
// gone, say so — the assertions on it were made by the run that created it.
const settle = async (key, addr, pred, label, tries = 300) => {
  if (!resumed.has(key)) return waitUtxo(addr, pred, tries, label);
  const hit = (await utxosOf(addr)).find(pred);
  if (!hit) console.log(`  (resumed: ${label} is already spent by a later step; it was asserted when it was created)`);
  return hit || null;
};
const p2sh = (redeem) => W.p2sh_address(redeem, "testnet");

console.log(`dev wallet: ${wallet.address}`);
const balBefore = await balance();
console.log(`balance before: ${KAS(balBefore)} KAS`);

// ============================================================================
// PHASE 1 — a 2-of-4 treasury: genesis + bootstrapVault
// ============================================================================
console.log("\nPHASE 1 — genesis + bootstrapVault (2-of-4: A, B, C, D)");
const owners4 = [wallet.xonly_pubkey, pubB, pubC, pubD];
const owners5 = [...owners4, NUMS];
const THR_LOW = 2, THR_HIGH = 3, OWNERS = 4;
let cfg = { threshold: THR_LOW, ownerCount: OWNERS };
const rootRedeem = rebuildRoot(0, THR_LOW, OWNERS, owners5);
const rootAddress = p2sh(rootRedeem);

const gen = await step("genesis", async () => {
  const need = ROOT_SOMPI + VAULT_SOMPI + 2 * FEE_CEIL + CHANGE_FLOOR;
  const fents0 = await walletUtxos();
  const { picked, sum } = pickFrom(fents0, need, fundingSlots(0));
  must(sum >= need, `wallet funds both transactions (${KAS(sum)} >= ${KAS(need)} KAS)`);
  const anchor = { fundingAddress: wallet.address, rootRedeem, rootValue: ROOT_SOMPI, fundingUtxos: picked };
  const id = W.genesis_covenant_id(JSON.stringify(anchor));
  const payload = W.inscription(BigInt(THR_LOW), JSON.stringify(owners4), id);
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
console.log(`  covenant id C  = ${C}`);
console.log(`  vault address  = ${vaultAddress}`);
console.log(`  root  address  = ${rootAddress}  (2-of-4)`);
fees.push({ what: "genesis", fee: gen.fee });
note("genesis", genesisTxid, `2-of-4 treasury [A,B,C,D]; mints C=${C.slice(0, 12)}… binding output 0 (the KoRoot) only`);
must(rootState(rootRedeem).threshold === THR_LOW && rootState(rootRedeem).ownerCount === OWNERS,
  "the genesis KoRoot script encodes threshold 2, ownerCount 4");

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

let vaultUtxo = await waitUtxo(vaultAddress, (e) => e.utxoEntry.covenantId === C, 300, "(vault mint)");
let root;
{
  const ru = await settle("bootstrap", rootAddress, (e) => e.outpoint.transactionId === boot.txid, "the post-bootstrap KoRoot");
  root = { redeem: rootRedeem, txid: boot.txid, index: 0, value: ru ? Number(ru.utxoEntry.amount) : ROOT_SOMPI };
  if (ru) must(root.value === ROOT_SOMPI, "the KoRoot kept its full value (owner-funded bootstrap)");
}
const VAULT_ADDRESS_AT_BIRTH = vaultAddress;
console.log(`  balance now: ${KAS(await balance())} KAS`);

// ============================================================================
// shared builders
// ============================================================================
const rinfo = (addr) => JSON.parse(W.recipient_info(addr));
const recipient = W.pubkey_address(pubD, "testnet");
const rd = rinfo(recipient);

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
  const pu = await settle(key, p2sh(prop.redeem), (e) => e.outpoint.transactionId === done.txid, `the ${done.label} proposal UTXO`);
  if (pu) prop.value = Number(pu.utxoEntry.amount);
  await settle(key, p2sh(root.redeem), (e) => e.outpoint.transactionId === done.txid && Number(e.outpoint.index) === 0, "the root continuation");
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
// one vote, submitted once and remembered; returns the new proposal handle
async function vote(key, prop, ownerIndex, sign, kind, label) {
  const done = await step(key, async () => {
    const v = await voteAt(prop, ownerIndex, sign, kind);
    const r = await submitPriced(v.at, v.fee, label);
    return { txid: r.txid, fee: r.fee, newRedeemHex: r.out.newRedeemHex, status: r.out.status, bitmap: r.out.bitmap, count: r.out.count };
  });
  fees.push({ what: label, fee: done.fee });
  const live = await settle(key, p2sh(done.newRedeemHex), (e) => e.outpoint.transactionId === done.txid, `the ${label} continuation`);
  if (live) assert(live.utxoEntry.covenantId === C, `the ${label} continuation carries the treasury lineage C`);
  return { ...done, next: { redeem: done.newRedeemHex, txid: done.txid, index: 0, value: live ? Number(live.utxoEntry.amount) : BOND } };
}

// executeConfig: spends the KoRoot (selector 2) + the Approved CONFIG proposal
function executeConfigAt(approved, newCfg, newOwners5, fents) {
  const base = {
    rootScript: root.redeem, rootTxid: root.txid, rootIndex: root.index, rootAmount: root.value,
    treasuryId: C, proposalRedeem: approved.redeem, propTxid: approved.txid, propIndex: approved.index, propAmount: approved.value,
    rStart: ROOT_STATE_LAYOUT.start, newThreshold: newCfg.threshold, newOwnerCount: newCfg.ownerCount,
    newOwners: newOwners5, executorIndex: 0, ownerAddress: wallet.address,
  };
  const massOf = (fund) => feeMassOf(JSON.parse(W.borsh_masses(
    JSON.parse(W.execute_config_build(JSON.stringify({ ...base, fundingUtxos: fund, fee: 0 }), JSON.stringify(Array(1 + fund.length).fill(ZERO_SIG)))).borshHex)));
  const s = SP.fold(SP.sizeOpFee(massOf, fents, 2));
  const at = (fee) => {
    const inputs = JSON.stringify({ ...base, fundingUtxos: s.picked, fee });
    const shs = JSON.parse(W.execute_config_sighashes(inputs));
    return JSON.parse(W.execute_config_build(inputs, JSON.stringify(shs.map(signA))));
  };
  return { at, fee: s.fee, short: s.short };
}
async function executeConfig(key, approved, newCfg, newOwners5, label) {
  const done = await step(key, async () => {
    const b = executeConfigAt(approved, newCfg, newOwners5, await walletUtxos());
    must(!b.short, `the wallet covers the ${label} fee`);
    const x = await submitPriced(b.at, b.fee, label);
    return { txid: x.txid, fee: x.fee, newRootHex: x.out.newRootHex };
  });
  fees.push({ what: label, fee: done.fee });
  return done;
}

// a TRANSFER execution: KoVault + the Approved proposal, owner-funded fee
function executeTransferAt(prop, executorIndex, sign, fents) {
  const base = {
    treasuryId: C, vaultRedeem, vaultTxid: vaultUtxo.outpoint.transactionId, vaultIndex: vaultUtxo.outpoint.index,
    vaultAmount: Number(vaultUtxo.utxoEntry.amount),
    proposalRedeem: prop.redeem, propTxid: prop.txid, propIndex: prop.index, propAmount: prop.value,
    recipientSpkHex: rd.spkHex, amount: TRANSFER, executorIndex, ownerAddress: wallet.address,
  };
  const massOf = (fund) => feeMassOf(JSON.parse(W.borsh_masses(
    JSON.parse(W.execute_build(JSON.stringify({ ...base, fundingUtxos: fund, fee: 0 }), JSON.stringify(Array(1 + fund.length).fill(ZERO_SIG)))).borshHex)));
  const s = SP.fold(SP.sizeOpFee(massOf, fents, 2));
  const at = (fee) => {
    const inputs = JSON.stringify({ ...base, fundingUtxos: s.picked, fee });
    const shs = JSON.parse(W.execute_sighashes(inputs));
    return JSON.parse(W.execute_build(inputs, JSON.stringify(shs.map((sh, i) => (i === 0 ? sign(sh) : signA(sh))))));
  };
  return { at, fee: s.fee, short: s.short };
}
async function executeTransfer(key, prop, executorIndex, sign, label) {
  const done = await step(key, async () => {
    const b = executeTransferAt(prop, executorIndex, sign, await walletUtxos());
    must(!b.short, `the wallet covers the ${label} fee`);
    const x = await submitPriced(b.at, b.fee, label);
    return { txid: x.txid, fee: x.fee, vaultChange: x.out.vaultChange };
  });
  fees.push({ what: label, fee: done.fee });
  const got = await settle(key, recipient, (e) => e.outpoint.transactionId === done.txid, "the recipient output");
  if (got) assert(Number(got.utxoEntry.amount) === TRANSFER, `${label}: the recipient received ${KAS(TRANSFER)} KAS`);
  const change = await settle(key, vaultAddress, (e) => e.outpoint.transactionId === done.txid && e.utxoEntry.covenantId, "the vault change");
  if (change) { assert(change.utxoEntry.covenantId === C, `${label}: the vault change still carries C`); vaultUtxo = change; }
  else vaultUtxo = (await utxosOf(vaultAddress)).find((e) => e.utxoEntry.covenantId === C) || vaultUtxo;
  return done;
}

// after an executeConfig: derive the expected root INDEPENDENTLY and check the chain
async function assertRootInstalled(key, x, nonce, newCfg, newOwners5, tag) {
  const expectRedeem = rebuildRoot(nonce, newCfg.threshold, newCfg.ownerCount, newOwners5);
  const expectAddr = p2sh(expectRedeem);
  const expectSpk = spkOf(expectRedeem);
  must(x.newRootHex === expectRedeem,
    `${tag}: the built continuation is byte-identical to rebuildRoot(nonce=${nonce}, ${newCfg.threshold}, ${newCfg.ownerCount}, owners)`);
  const nr = await settle(key, expectAddr, (e) => e.outpoint.transactionId === x.txid && Number(e.outpoint.index) === 0, "the new KoRoot continuation");
  if (nr) assert(String(nr.utxoEntry.scriptPublicKey).toLowerCase() === expectSpk.toLowerCase(),
    `${tag}: the ON-CHAIN scriptPubKey of the KoRoot continuation equals the one derived from rebuildRoot(nonce=${nonce}, threshold=${newCfg.threshold}, ownerCount=${newCfg.ownerCount}) — the chain's own bytes carry the new threshold`);
  // the negative: the OTHER threshold does not derive this address
  const otherThr = newCfg.threshold === THR_HIGH ? THR_LOW : THR_HIGH;
  assert(p2sh(rebuildRoot(nonce, otherThr, newCfg.ownerCount, newOwners5)) !== expectAddr,
    `${tag}: rebuildRoot with threshold ${otherThr} derives a DIFFERENT address — the threshold really is what moved`);
  if (nr) assert(nr.utxoEntry.covenantId === C, `${tag}: the new KoRoot continuation still carries the treasury's lineage C`);
  assert(rootState(expectRedeem).threshold === newCfg.threshold && rootState(expectRedeem).nonce === nonce,
    `${tag}: decoding the live root script gives threshold ${newCfg.threshold} at nonce ${nonce}`);
  // second, independent source: the public REST indexer's view of output 0
  let restOk = null;
  for (let i = 0; i < 12 && restOk === null; i++) {
    try {
      const t = await rest(`/transactions/${x.txid}?resolve_previous_outpoints=no`);
      const o0 = t.outputs.find((o) => Number(o.index) === 0);
      restOk = String(o0.script_public_key).toLowerCase() === expectSpk.slice(4).toLowerCase();
    } catch { await sleep(5000); }
  }
  if (restOk !== null) assert(restOk, `${tag}: the public REST indexer reports the same scriptPubKey for output 0`);
  else console.log(`  (REST indexer did not answer in time — the node-side scriptPubKey check above stands on its own)`);
  // the vault does not move
  assert(p2sh(rebuildVault(C)) === VAULT_ADDRESS_AT_BIRTH, `${tag}: the vault address is UNCHANGED (it is a function of C alone)`);
  const stillThere = (await utxosOf(vaultAddress)).find((e) => e.utxoEntry.covenantId === C);
  assert(stillThere && Number(stillThere.utxoEntry.amount) === Number(vaultUtxo.utxoEntry.amount),
    `${tag}: the vault UTXO is untouched by the threshold change, same address, same value (${KAS(Number(stillThere?.utxoEntry?.amount ?? 0))} KAS)`);
  root = { redeem: expectRedeem, txid: x.txid, index: 0, value: nr ? Number(nr.utxoEntry.amount) : root.value + BOND };
  cfg = newCfg;
  console.log(`  root now ${newCfg.threshold}-of-${newCfg.ownerCount} at ${expectAddr}`);
  return expectRedeem;
}

// ============================================================================
// PHASE 2 — mint the IN-FLIGHT proposal P1 under 2-of-4 and leave it Pending
// ============================================================================
console.log("\nPHASE 2 — P1: a TRANSFER minted under 2-of-4, left Pending (1 approval)");
let P1 = await createProposal("p1-create", { operation: 1, recipientSpkHash: rd.spkHash, amount: TRANSFER, expiresAt: FOREVER, proposerIndex: 0, sign: signA, label: "P1 transfer (snapshot 2-of-4)" });
{
  const s = propState(P1.redeem);
  assert(s.snapThreshold === THR_LOW && s.ownerCount === OWNERS, `P1's on-chain snapshot is ${s.snapThreshold}-of-${s.ownerCount}`);
  assert(s.approvalCount === 1 && s.status === 0, `P1 is Pending with the proposer's single implicit approval (count ${s.approvalCount}, status ${s.status})`);
  note("p1-create", P1.txid, `A proposes ${KAS(TRANSFER)} KAS while the treasury is 2-of-4; snapThreshold 2 is now frozen into the proposal`);
}

// ============================================================================
// PHASE 3 — RAISE THE THRESHOLD: 2-of-4 -> 3-of-4
// ============================================================================
console.log("\nPHASE 3 — RAISE: CONFIG proposal 2-of-4 -> 3-of-4 (same four owners)");
const cfgHigh = { threshold: THR_HIGH, ownerCount: OWNERS };
const commitHigh = W.config_commit(BigInt(THR_HIGH), BigInt(OWNERS), JSON.stringify(owners5));
console.log(`  config commitment = blake2b(thr8‖cnt8‖owner0..4) = ${commitHigh.slice(0, 24)}…`);
{
  const prop = await createProposal("raise-create", { operation: 2, recipientSpkHash: commitHigh, amount: 1, expiresAt: FOREVER, proposerIndex: 0, sign: signA, label: "CONFIG raise" });
  note("raise-create", prop.txid, `A proposes operation 2 (CONFIG) committing threshold 3 with the SAME owner set — only the quorum moves`);
  const r = await vote("raise-approve-B", prop, 1, signB, "approve", "approve (CONFIG raise)");
  assert(Number(r.status) === 1, "B's approval takes the raise to Approved (2 of 2 under the OLD 2-of-4 policy)");
  note("raise-approve-B", r.txid, `B approves; status Approved`);
  const x = await executeConfig("raise-exec", r.next, cfgHigh, owners5, "executeConfig (raise to 3-of-4)");
  note("executeConfig-raise", x.txid, `installs threshold 3 in KoRoot state — the newThreshold path, first time on a node`);
  await assertRootInstalled("raise-exec", x, 2, cfgHigh, owners5, "RAISE");
  ok.push("RAISE BINDS: KoRoot.executeConfig wrote a NEW THRESHOLD (2 -> 3) into the root's state, and the chain's own scriptPubKey is the one rebuildRoot derives for threshold 3");
}
console.log(`  balance now: ${KAS(await balance())} KAS`);

// ============================================================================
// PHASE 4 — THE RAISE BITES: 2 approvals cannot move money under 3-of-4
// ============================================================================
console.log("\nPHASE 4 — P2: minted under 3-of-4. Two approvals must NOT execute; three must.");
let P2 = await createProposal("p2-create", { operation: 1, recipientSpkHash: rd.spkHash, amount: TRANSFER, expiresAt: FOREVER, proposerIndex: 0, sign: signA, label: "P2 transfer (3-of-4)" });
{
  const s = propState(P2.redeem);
  assert(s.snapThreshold === THR_HIGH, `P2's snapshot threshold is 3 — it inherited the RAISED policy (got ${s.snapThreshold})`);
  note("p2-create", P2.txid, `A proposes ${KAS(TRANSFER)} KAS under the raised 3-of-4 policy; snapThreshold 3`);
}
{
  const r = await vote("p2-approve-B", P2, 1, signB, "approve", "approve P2 (B, 2nd of 3)");
  const s = propState(r.newRedeemHex);
  assert(s.approvalCount === 2 && s.status === 0,
    `TWO approvals leave P2 PENDING under 3-of-4 (on-chain state: approvalCount ${s.approvalCount}, status ${s.status}) — the same two that were enough before the raise`);
  note("p2-approve-B", r.txid, `B approves; approvalCount 2 < snapThreshold 3, so status stays Pending(0)`);
  P2 = r.next;
}
// ---- the refusal. Structurally identical to the execute that succeeds below;
//      the ONLY difference is approvalCount 2 vs 3 in the proposal's own state.
{
  const res = await step("p2-execute-refusal", async () => {
    const b = executeTransferAt(P2, 0, signA, await walletUtxos());
    must(!b.short, "the wallet covers the (refused) execute fee");
    return expectRefusal(b.at, b.fee, "executing a 2-approval proposal under a 3-of-4 snapshot");
  });
  if (res.accepted) assert(false, `CRITICAL: a 2-approval proposal EXECUTED under a 3-of-4 snapshot (${res.txid})`);
  else {
    nodeErr("executing a 2-approval proposal under a 3-of-4 snapshot", res.msg);
    assert(/script ran, but verification failed/.test(res.msg),
      "the node refuses the execute as a SCRIPT failure — not a fee or policy rejection (KoProposal.execute requires status == 1, and approve only writes 1 at approvalCount >= snapThreshold)");
  }
}
// ---- the third approval, and the SAME proposal executes ---------------------
{
  const r = await vote("p2-approve-C", P2, 2, signC, "approve", "approve P2 (C, 3rd of 3)");
  const s = propState(r.newRedeemHex);
  assert(s.approvalCount === 3 && s.status === 1,
    `C's third approval flips P2 to Approved (on-chain state: approvalCount ${s.approvalCount}, status ${s.status})`);
  note("p2-approve-C", r.txid, `C approves; approvalCount 3 >= snapThreshold 3, status Approved(1)`);
  P2 = r.next;
  const x = await executeTransfer("p2-execute", P2, 0, signA, "execute P2 (3 approvals)");
  note("p2-execute", x.txid, `the SAME proposal the node refused one approval ago now moves ${KAS(TRANSFER)} KAS`);
  ok.push("RAISE BITES: under 3-of-4 the node refused an execute at 2 approvals in script and accepted the identical execute at 3 — the raised threshold is enforced by consensus, not by the UI");
}
console.log(`  balance now: ${KAS(await balance())} KAS`);

// ============================================================================
// PHASE 5 — THE SNAPSHOT (a): P1, minted 2-of-4, under a 3-of-4 treasury
// ============================================================================
console.log("\nPHASE 5 — P1 (minted under 2-of-4) while KoRoot now says 3-of-4");
{
  const live = rootState(root.redeem), snap = propState(P1.redeem);
  assert(live.threshold === THR_HIGH && snap.snapThreshold === THR_LOW,
    `the chain holds BOTH at once: KoRoot threshold ${live.threshold}, P1 snapThreshold ${snap.snapThreshold}`);
  const r = await vote("p1-approve-B", P1, 1, signB, "approve", "approve P1 (B)");
  const s = propState(r.newRedeemHex);
  assert(s.approvalCount === 2 && s.status === 1,
    `P1 reaches APPROVED on TWO approvals although the treasury is now 3-of-4 (on-chain state: count ${s.approvalCount}, status ${s.status}) — approve gates on the proposal's own snapThreshold`);
  note("p1-approve-B", r.txid, `B approves P1; 2 >= snapThreshold 2, status Approved(1) under a 3-of-4 treasury`);
  P1 = r.next;
  const x = await executeTransfer("p1-execute", P1, 0, signA, "execute P1 (2 approvals, 3-of-4 treasury)");
  note("p1-execute", x.txid, `${KAS(TRANSFER)} KAS moves on TWO approvals while KoRoot's live threshold is 3 — the snapshot governs`);
  ok.push("SNAPSHOT (a): a proposal minted under 2-of-4 approved and EXECUTED on two signatures after the treasury moved to 3-of-4 — exactly what the contracts say, and the same two signatures were refused for a proposal minted under 3-of-4");
}
console.log(`  balance now: ${KAS(await balance())} KAS`);

// ============================================================================
// PHASE 6 — mint P3 under 3-of-4, THEN lower the threshold back to 2-of-4
// ============================================================================
console.log("\nPHASE 6 — P3: minted under 3-of-4 and left Pending, then LOWER to 2-of-4");
let P3 = await createProposal("p3-create", { operation: 1, recipientSpkHash: rd.spkHash, amount: TRANSFER, expiresAt: FOREVER, proposerIndex: 0, sign: signA, label: "P3 transfer (snapshot 3-of-4)" });
{
  const s = propState(P3.redeem);
  assert(s.snapThreshold === THR_HIGH && s.approvalCount === 1 && s.status === 0,
    `P3 carries snapThreshold 3 and is Pending on one approval (got ${s.snapThreshold}, count ${s.approvalCount}, status ${s.status})`);
  note("p3-create", P3.txid, `A proposes ${KAS(TRANSFER)} KAS under 3-of-4; this proposal will outlive the policy that minted it`);
}
const cfgLow = { threshold: THR_LOW, ownerCount: OWNERS };
const commitLow = W.config_commit(BigInt(THR_LOW), BigInt(OWNERS), JSON.stringify(owners5));
{
  const prop = await createProposal("lower-create", { operation: 2, recipientSpkHash: commitLow, amount: 1, expiresAt: FOREVER, proposerIndex: 0, sign: signA, label: "CONFIG lower" });
  note("lower-create", prop.txid, `A proposes operation 2 (CONFIG) committing threshold 2 — and, minted under 3-of-4, it needs three approvals itself`);
  const r1 = await vote("lower-approve-B", prop, 1, signB, "approve", "approve (CONFIG lower, B)");
  const s1 = propState(r1.newRedeemHex);
  assert(s1.approvalCount === 2 && s1.status === 0, `the CONFIG-lower proposal is still Pending at 2 approvals (its own snapshot is 3-of-4)`);
  note("lower-approve-B", r1.txid, `B approves; 2 < 3, still Pending`);
  const r2 = await vote("lower-approve-C", r1.next, 2, signC, "approve", "approve (CONFIG lower, C)");
  assert(Number(r2.status) === 1, "C's third approval takes the CONFIG-lower proposal to Approved");
  note("lower-approve-C", r2.txid, `C approves; 3 >= 3, Approved`);
  const x = await executeConfig("lower-exec", r2.next, cfgLow, owners5, "executeConfig (lower to 2-of-4)");
  note("executeConfig-lower", x.txid, `installs threshold 2 in KoRoot state`);
  await assertRootInstalled("lower-exec", x, 5, cfgLow, owners5, "LOWER");
  ok.push("LOWER BINDS: KoRoot.executeConfig moved the threshold back down (3 -> 2) and the chain's scriptPubKey is the one rebuildRoot derives for threshold 2; the vault address never moved across either change");
}
console.log(`  balance now: ${KAS(await balance())} KAS`);

// ============================================================================
// PHASE 7 — THE SNAPSHOT (b): P3, minted 3-of-4, under a 2-of-4 treasury
// ============================================================================
console.log("\nPHASE 7 — P3 (minted under 3-of-4) while KoRoot now says 2-of-4");
{
  const live = rootState(root.redeem), snap = propState(P3.redeem);
  assert(live.threshold === THR_LOW && snap.snapThreshold === THR_HIGH,
    `the chain holds BOTH at once: KoRoot threshold ${live.threshold}, P3 snapThreshold ${snap.snapThreshold}`);
  const r = await vote("p3-approve-B", P3, 1, signB, "approve", "approve P3 (B)");
  const s = propState(r.newRedeemHex);
  assert(s.approvalCount === 2 && s.status === 0,
    `P3 stays PENDING at two approvals although the treasury is now 2-of-4 (on-chain state: count ${s.approvalCount}, status ${s.status}) — the relaxed policy does not reprice an in-flight proposal`);
  note("p3-approve-B", r.txid, `B approves P3; 2 < snapThreshold 3, still Pending under a 2-of-4 treasury`);
  P3 = r.next;
  const res = await step("p3-execute-refusal", async () => {
    const b = executeTransferAt(P3, 0, signA, await walletUtxos());
    must(!b.short, "the wallet covers the (refused) P3 execute fee");
    return expectRefusal(b.at, b.fee, "executing a 2-approval proposal whose snapshot is 3-of-4, under a 2-of-4 treasury");
  });
  if (res.accepted) assert(false, `CRITICAL: an in-flight 3-of-4 proposal executed on two approvals after the treasury relaxed to 2-of-4 (${res.txid})`);
  else {
    nodeErr("executing a 2-approval proposal whose snapshot is 3-of-4, under a 2-of-4 treasury", res.msg);
    assert(/script ran, but verification failed/.test(res.msg),
      "the node refuses it as a SCRIPT failure — an in-flight proposal does NOT silently re-price its own quorum when the treasury relaxes");
  }
  const r2 = await vote("p3-approve-C", P3, 2, signC, "approve", "approve P3 (C, 3rd)");
  assert(Number(r2.status) === 1, "C's third approval takes P3 to Approved — three is still what its snapshot demands");
  note("p3-approve-C", r2.txid, `C approves; 3 >= snapThreshold 3, Approved`);
  P3 = r2.next;
  const x = await executeTransfer("p3-execute", P3, 0, signA, "execute P3 (3 approvals)");
  note("p3-execute", x.txid, `P3 finally executes — on three approvals, the count its own snapshot fixed`);
  ok.push("SNAPSHOT (b): a proposal minted under 3-of-4 still needed THREE approvals after the treasury relaxed to 2-of-4 — two left it Pending and the node refused the execute in script");
}
console.log(`  balance now: ${KAS(await balance())} KAS`);

// ============================================================================
// PHASE 8 — LOWERING RELEASES: a proposal minted under 2-of-4 moves on two
// ============================================================================
console.log("\nPHASE 8 — P4: minted AFTER the lowering; two approvals must move money");
let P4 = await createProposal("p4-create", { operation: 1, recipientSpkHash: rd.spkHash, amount: TRANSFER, expiresAt: FOREVER, proposerIndex: 0, sign: signA, label: "P4 transfer (2-of-4)" });
{
  const s = propState(P4.redeem);
  assert(s.snapThreshold === THR_LOW, `P4's snapshot threshold is 2 — it inherited the LOWERED policy (got ${s.snapThreshold})`);
  note("p4-create", P4.txid, `A proposes ${KAS(TRANSFER)} KAS under the lowered 2-of-4 policy`);
  const r = await vote("p4-approve-B", P4, 1, signB, "approve", "approve P4 (B)");
  const ps = propState(r.newRedeemHex);
  assert(ps.approvalCount === 2 && ps.status === 1,
    `TWO approvals now reach Approved (count ${ps.approvalCount}, status ${ps.status}) — the exact count the node refused in PHASE 4`);
  note("p4-approve-B", r.txid, `B approves; 2 >= snapThreshold 2, Approved`);
  P4 = r.next;
  const x = await executeTransfer("p4-execute", P4, 0, signA, "execute P4 (2 approvals)");
  note("p4-execute", x.txid, `${KAS(TRANSFER)} KAS moves on TWO approvals — lowering the threshold really released the quorum`);
  ok.push("LOWERING RELEASES: after the move back to 2-of-4 a freshly minted proposal moved treasury funds on two approvals — the same two the node refused in script while the treasury was 3-of-4");
}
console.log(`  balance now: ${KAS(await balance())} KAS`);

// ============================================================================
// PHASE 9 — closeExpired on a PENDING (status 0) proposal, and the expiry gate
// ============================================================================
console.log("\nPHASE 9 — closeExpired on a PENDING proposal + the expiry gate");
// On a RESUMED run the replayed checkpoint stops at whatever step was last
// recorded, but the chain may have moved past it — the root address differs only
// in the nonce, so walk it forward until the live UTXO turns up. On a fresh run
// this matches at the first try and does nothing.
{
  const from = rootState(root.redeem).nonce;
  let found = null;
  for (let n = from; n <= from + 12 && !found; n++) {
    const redeem = rebuildRoot(n, cfg.threshold, cfg.ownerCount, owners5);
    const hit = (await utxosOf(p2sh(redeem))).find((e) => e.utxoEntry.covenantId === C);
    if (hit) found = { redeem, txid: hit.outpoint.transactionId, index: Number(hit.outpoint.index), value: Number(hit.utxoEntry.amount), nonce: n };
  }
  must(found, `the live KoRoot is on chain at some nonce >= ${from}`);
  if (found.nonce !== from) console.log(`  (resynced the live KoRoot from nonce ${from} to ${found.nonce})`);
  root = { redeem: found.redeem, txid: found.txid, index: found.index, value: found.value };
}
const EXPIRES_AT = await step("expires-at", async () => (await daaNow()) + 700); // ~70 s at 10 bps; polled, never assumed
console.log(`  daa now ${await daaNow()}; this proposal expires at DAA ${EXPIRES_AT}`);
let P5 = await createProposal("p5-create", { operation: 1, recipientSpkHash: rd.spkHash, amount: TRANSFER, expiresAt: EXPIRES_AT, proposerIndex: 0, sign: signA, label: "P5 short-expiry transfer" });
{
  const s = propState(P5.redeem);
  assert(s.status === 0 && s.approvalCount === 1, `P5 is PENDING (status ${s.status}, approvalCount ${s.approvalCount}) — never approved to threshold, never rejected`);
  assert(s.expiresAt === EXPIRES_AT, `P5 commits expiresAt = ${EXPIRES_AT} in its own state`);
  note("p5-create", P5.txid, `A proposes a ${KAS(TRANSFER)} KAS transfer expiring at DAA ${EXPIRES_AT}; left PENDING on purpose`);
}
const buildClose = (fee, lockTime) => JSON.parse(W.close_expired_build(JSON.stringify({
  proposalRedeem: P5.redeem, propTxid: P5.txid, propIndex: P5.index, propAmount: P5.value,
  lockTime, payoutAddress: wallet.address, fee,
})));

// ---- (a) the NEGATIVE, truthful: lock_time = expiresAt, which is still ahead
const WHAT_A = "closeExpired BEFORE expiry, lock_time = the committed expiresAt (truthful)";
const WHAT_B = "closeExpired BEFORE expiry, lock_time understated to a DAA the chain has passed";
{
  const res = await step("close-early-truthful", async () => {
    const d = await daaNow();
    if (d >= EXPIRES_AT) return { skipped: `already expired (daa ${d} >= ${EXPIRES_AT})` };
    console.log(`  attempting the retirement EARLY: daa ${d} < expiresAt ${EXPIRES_AT}`);
    return { ...(await expectRefusal((fee) => buildClose(fee, EXPIRES_AT), 600_000, WHAT_A)), daa: d };
  });
  if (res.skipped) assert(false, `the pre-expiry retirement could not be attempted: ${res.skipped}`);
  else if (res.accepted) assert(false, `CRITICAL: an UNEXPIRED proposal was retired (${res.txid})`);
  else {
    nodeErr(WHAT_A, res.msg);
    // A truthful lock_time is AHEAD of the chain, so the transaction is not yet
    // spendable at all and never reaches the script: this is the node's finality
    // rule, and it says so. That is a refusal, but it is not the covenant's — see
    // (b), which removes the finality excuse and leaves only the script.
    assert(/is not finalized/.test(res.msg),
      `retiring an UNEXPIRED proposal with a TRUTHFUL lock_time is REFUSED by the node's finality rule ("transaction input #0 is not finalized"), attempted at daa ${res.daa} against expiresAt ${EXPIRES_AT}`);
  }
}
// ---- (b) the NEGATIVE, lying: lock_time in the past, below the committed expiry
{
  const res = await step("close-early-lying", async () => {
    const d = await daaNow();
    if (d >= EXPIRES_AT) return { skipped: `already expired (daa ${d} >= ${EXPIRES_AT})` };
    const past = d - 200;
    console.log(`  attempting the retirement EARLY with lock_time ${past} (already passed) < expiresAt ${EXPIRES_AT}`);
    return { ...(await expectRefusal((fee) => buildClose(fee, past), 600_000, WHAT_B)), daa: d, lockTime: past };
  });
  if (res.skipped) assert(false, `the understated-lock_time retirement could not be attempted: ${res.skipped}`);
  else if (res.accepted) assert(false, `CRITICAL: an UNEXPIRED proposal was retired by understating the lock time (${res.txid})`);
  else {
    nodeErr(WHAT_B, res.msg);
    // This transaction IS final (its lock_time is a DAA the chain has passed), so
    // the finality rule lets it through and the script runs. It fails there — but
    // the engine reports the CLTV violation specifically rather than the generic
    // "script ran, but verification failed" every other refusal in this file
    // produces, and it NAMES the expiry it measured against. Assert both: that it
    // is a signature-script verification failure, and that the number it refused
    // on is the proposal's own committed expiresAt.
    assert(/failed to verify the signature script/.test(res.msg),
      `…and understating the lock time (${res.lockTime}) to get past the node's finality rule is refused as a SIGNATURE-SCRIPT verification failure — not a fee or policy rejection`);
    assert(new RegExp(`locktime is greater than the transaction locktime: ${EXPIRES_AT} > ${res.lockTime}`).test(res.msg),
      `…and the engine names the exact number it refused on — the proposal's committed expiresAt ${EXPIRES_AT} against the claimed lock time ${res.lockTime} — which is KoProposal.closeExpired's \`tx.time >= expiresAt\` and nothing else`);
  }
}
// ---- the positive: wait for the expiry, then retire it ---------------------
console.log(`  waiting for DAA to pass ${EXPIRES_AT}…`);
for (let i = 0; i < 300; i++) { const d = await daaNow(); if (d > EXPIRES_AT + 20) { console.log(`\n  daa ${d} > ${EXPIRES_AT} — expired`); break; } process.stdout.write("."); await sleep(3000); }
{
  let done = st["close-expired"] ?? null, lastMsg = "";
  if (done) console.log("  (resumed: close-expired)");
  for (let attempt = 0; attempt < 6 && !done; attempt++) {
    const fee = 600_000 * (attempt + 1);
    const built = buildClose(fee, EXPIRES_AT);
    try { done = { txid: await rawSubmit(built.borshHex), fee, out: built }; st["close-expired"] = done; saveState(); }
    catch (e) {
      const msg = String(e?.message || e); lastMsg = msg;
      const want = /required amount of (\d+)/.exec(msg);
      if (want) {
        const b2 = buildClose(Number(want[1]), EXPIRES_AT);
        try { done = { txid: await rawSubmit(b2.borshHex), fee: Number(want[1]), out: b2 }; st["close-expired"] = done; saveState(); continue; }
        catch (e2) { lastMsg = String(e2?.message || e2); }
      }
      break;
    }
  }
  if (!assert(done, `closeExpired on a PENDING proposal was accepted by the node (last error: ${lastMsg})`)) { if (lastMsg) nodeErr("closeExpired (pending)", lastMsg); }
  if (done) {
    fees.push({ what: "closeExpired (pending)", fee: done.fee });
    note("closeExpired", done.txid, `a PENDING (status 0) proposal retired PERMISSIONLESSLY; fee ${KAS(done.fee)} KAS`);
    const shape = JSON.parse(W.borsh_to_rpc_json(done.out.borshHex));
    const sig = shape.inputs[0].signatureScript;
    assert(shape.outputs.every((o) => !o.covenant), "ZERO outputs inherit the lineage (KoProposal.closeExpired: OpCovOutputCount(cid) == 0)");
    assert(Number(shape.lockTime) === EXPIRES_AT, `the built transaction's lockTime is the committed expiresAt (${shape.lockTime})`);
    // witness = OP_2 (the closeExpired selector) then ONE push, the redeem reveal.
    // No owner index, no signature: reconstruct it byte for byte and compare.
    assert(sig.startsWith("52"), "the witness opens with the closeExpired selector (OP_2) — no owner index precedes it");
    const b1 = (n) => n.toString(16).padStart(2, "0");
    const pushOf = (hex) => { const n = hex.length / 2;
      if (n < 0x4c) return b1(n);
      if (n <= 0xff) return `4c${b1(n)}`;
      if (n <= 0xffff) return `4d${b1(n & 0xff)}${b1((n >> 8) & 0xff)}`;
      return `4e${b1(n & 0xff)}${b1((n >> 8) & 0xff)}${b1((n >> 16) & 0xff)}${b1((n >> 24) & 0xff)}`; };
    const expectSig = `52${pushOf(P5.redeem)}${P5.redeem.toLowerCase()}`;
    assert(sig.toLowerCase() === expectSig,
      `the witness is EXACTLY the selector plus the redeem reveal — no owner index and NO SIGNATURE anywhere in it (${sig.length / 2} bytes)`);
    assert(shape.outputs.length === 1, "the retirement has a single plain output — the bond going home");
    const back = await waitUtxo(wallet.address, (e) => e.outpoint.transactionId === done.txid, 300, "(bond back)");
    assert(!back.utxoEntry.covenantId, `the retired bond came back as a PLAIN, UNBOUND coin (${KAS(Number(back.utxoEntry.amount))} KAS, covenantId ${back.utxoEntry.covenantId})`);
    assert(Number(back.utxoEntry.amount) === P5.value - done.fee, `the bond returned in full less the fee (${P5.value} - ${done.fee})`);
    const gone = (await utxosOf(p2sh(P5.redeem))).find((e) => e.outpoint.transactionId === P5.txid);
    assert(!gone, "the PENDING proposal UTXO is gone from the chain");
    // ---- lock_time straight off the chain: the REST tx endpoint does not carry
    //      it, so fetch the CONTAINING BLOCK, which does.
    let chainLock = null, blockHash = null, restTx = null;
    for (let i = 0; i < 30 && chainLock === null; i++) {
      try {
        if (!restTx) {
          restTx = await rest(`/transactions/${done.txid}?resolve_previous_outpoints=no`);
          blockHash = (restTx.block_hash || [])[0];
          assert(restTx.lock_time === undefined, "the REST transaction endpoint really does not report lock_time (which is why this reads the containing block)");
        }
        const blk = await rest(`/blocks/${blockHash}?includeColor=false`);
        const btx = (blk.transactions || []).find((z) => z.verboseData?.transactionId === done.txid);
        if (btx) chainLock = Number(btx.lockTime); else await sleep(5000);
      } catch { await sleep(5000); }
    }
    if (chainLock !== null) {
      assert(chainLock === EXPIRES_AT,
        `the CHAIN's copy of the retirement carries lock_time ${chainLock} = the proposal's committed expiresAt ${EXPIRES_AT} (read from block ${String(blockHash).slice(0, 16)}…)`);
    } else assert(false, "could not read lock_time from the containing block via REST");
    // ---- REST's per-output covenant view: nothing inherited
    try {
      const t = restTx || await rest(`/transactions/${done.txid}?resolve_previous_outpoints=no`);
      assert(t.outputs.every((o) => !o.covenant_id), "the public REST indexer also reports covenant_id null on every output of the retirement");
      assert(String(t.inputs[0].covenant_id).toLowerCase() === C, "…while the INPUT it spent was genuinely bound to the treasury's lineage C");
    } catch (e) { console.log(`  (REST per-output check skipped: ${e.message})`); }
    // ---- the treasury is untouched
    const v = (await utxosOf(vaultAddress)).find((e) => e.utxoEntry.covenantId === C);
    const rr = (await utxosOf(p2sh(root.redeem))).find((e) => e.utxoEntry.covenantId === C);
    assert(v && Number(v.utxoEntry.amount) === Number(vaultUtxo.utxoEntry.amount), "the vault is unaffected by the retirement");
    assert(rr && Number(rr.utxoEntry.amount) === root.value, "the KoRoot is unaffected by the retirement");
    assert(rootState(root.redeem).threshold === THR_LOW, "…and the root still carries the threshold the last CONFIG installed");
    ok.push("CLOSEEXPIRED ON A PENDING PROPOSAL: a status-0 proposal was retired permissionlessly after its expiry — no owner index, no signature, lock_time = the committed expiresAt (confirmed from the containing block), zero covenant outputs, bond home as a plain coin, vault and root untouched");
    ok.push("THE EXPIRY GATE HOLDS: the same retirement was refused twice before the expiry — once by the node's finality rule with a truthful lock_time, once in SCRIPT when the lock_time understated the committed expiry");
  }
}

// ============================================================================
// PHASE 11 — THE SNAPSHOT ON THE CONFIG PATH, not just the vault path
// ============================================================================
// Phases 5 and 7 proved the snapshot governs a TRANSFER, which is gated by
// KoVault.executeProposal. A CONFIG change is gated by a DIFFERENT contract —
// KoRoot.executeConfig — which reads the same `p.status == 1` and likewise never
// consults its own live `threshold`. Reading the contract says an in-flight
// CONFIG proposal keeps its own quorum too; this runs it.
//
// Two CONFIG proposals are minted under 2-of-4 (so both snapshot threshold 2) and
// both approved to two. One is executed, raising the treasury to 3-of-4. The
// OTHER is then executed under that 3-of-4 treasury, still carrying only two
// approvals — and it installs 4-of-4, which also puts threshold == ownerCount on
// chain for the first time.
console.log("\nPHASE 11 — an in-flight CONFIG proposal under a raised treasury (KoRoot.executeConfig)");
const cfgFull = { threshold: 4, ownerCount: OWNERS };
const commitFull = W.config_commit(BigInt(4), BigInt(OWNERS), JSON.stringify(owners5));
{
  must(rootState(root.redeem).threshold === THR_LOW, "PHASE 11 starts from a 2-of-4 treasury");
  // (a) the proposal that will be held in flight: 2-of-4 -> 4-of-4
  const pa = await createProposal("p11a-create", { operation: 2, recipientSpkHash: commitFull, amount: 1, expiresAt: FOREVER, proposerIndex: 0, sign: signA, label: "CONFIG 4-of-4 (held in flight)" });
  assert(propState(pa.redeem).snapThreshold === THR_LOW, "the held CONFIG proposal snapshots threshold 2");
  note("p11a-create", pa.txid, `A proposes CONFIG threshold 4 while the treasury is 2-of-4; snapThreshold 2`);
  const ra = await vote("p11a-approve-B", pa, 1, signB, "approve", "approve (CONFIG 4-of-4)");
  assert(propState(ra.newRedeemHex).status === 1 && propState(ra.newRedeemHex).approvalCount === 2,
    "the held CONFIG proposal is APPROVED on two approvals under 2-of-4, and is now parked");
  note("p11a-approve-B", ra.txid, `B approves; Approved at 2 of 2 — then left unexecuted on purpose`);
  const held = ra.next;

  // (b) a second CONFIG proposal, executed immediately, raises the treasury to 3-of-4
  const pb = await createProposal("p11b-create", { operation: 2, recipientSpkHash: commitHigh, amount: 1, expiresAt: FOREVER, proposerIndex: 0, sign: signA, label: "CONFIG raise (again)" });
  note("p11b-create", pb.txid, `A proposes CONFIG threshold 3, to move the treasury out from under the held proposal`);
  const rb = await vote("p11b-approve-B", pb, 1, signB, "approve", "approve (CONFIG raise again)");
  assert(Number(rb.status) === 1, "the second CONFIG proposal reaches Approved on two approvals");
  const xb = await executeConfig("p11b-exec", rb.next, cfgHigh, owners5, "executeConfig (raise again)");
  note("executeConfig-raise-2", xb.txid, `treasury back to 3-of-4`);
  await assertRootInstalled("p11b-exec", xb, 10, cfgHigh, owners5, "RAISE-2");

  // (c) THE POINT: execute the HELD proposal — two approvals, snapshot 2 — under a
  //     treasury that now demands three. KoRoot.executeConfig must still take it.
  const hs = propState(held.redeem), ls = rootState(root.redeem);
  assert(ls.threshold === THR_HIGH && hs.snapThreshold === THR_LOW && hs.approvalCount === 2,
    `the chain holds both: KoRoot threshold ${ls.threshold}, the held CONFIG proposal snapThreshold ${hs.snapThreshold} with ${hs.approvalCount} approvals`);
  const xa = await executeConfig("p11a-exec", held, cfgFull, owners5, "executeConfig (held 4-of-4)");
  note("executeConfig-held", xa.txid, `the held 2-approval CONFIG proposal installs 4-of-4 under a 3-of-4 treasury`);
  await assertRootInstalled("p11a-exec", xa, 10, cfgFull, owners5, "HELD-CONFIG");
  assert(rootState(root.redeem).threshold === 4 && rootState(root.redeem).ownerCount === 4,
    "the treasury is now 4-of-4 — threshold == ownerCount, the upper edge of KoRoot.executeConfig's `newThreshold <= newOwnerCount`, on chain for the first time");
  ok.push("SNAPSHOT ON THE CONFIG PATH: an in-flight CONFIG proposal minted and approved under 2-of-4 was still executable by KoRoot.executeConfig after the treasury moved to 3-of-4 — the snapshot rule is the same on the root path as on the vault path, and executeConfig never consults its own live threshold");
}
console.log(`  balance now: ${KAS(await balance())} KAS`);

// ============================================================================
console.log("\nPHASE 10 — the vault address across the whole run");
assert(p2sh(rebuildVault(C)) === VAULT_ADDRESS_AT_BIRTH,
  `the vault address is IDENTICAL to the one minted at genesis, after two threshold changes: ${VAULT_ADDRESS_AT_BIRTH}`);
{
  const live = (await utxosOf(VAULT_ADDRESS_AT_BIRTH)).find((e) => e.utxoEntry.covenantId === C);
  assert(live, "the live treasury UTXO still sits at that same address under lineage C");
  console.log(`  vault ${KAS(Number(live?.utxoEntry?.amount ?? 0))} KAS at ${VAULT_ADDRESS_AT_BIRTH}`);
}

report();
const balAfter = await balance();
console.log(`\nwallet ${KAS(balBefore)} -> ${KAS(balAfter)} KAS (Δ ${KAS(balAfter - balBefore)})`);
console.log(`treasury: root ${KAS(root.value)} KAS (${cfg.threshold}-of-${cfg.ownerCount}) + vault under lineage ${C}`);
console.log(`node: ${NODE_HOST}, server ${info.serverVersion}`);
c.close();
process.exit(failures.length ? 1 : 0);

function report() {
  if (txids.length) {
    console.log("\n================ TXIDS ================");
    for (const t of txids) console.log(`${t.label.padEnd(22)} ${t.txid}\n                       ${t.what}`);
  }
  if (fees.length) {
    console.log("\n================ FEES =================");
    for (const f of fees) console.log(`${f.what.padEnd(40)} ${KAS(f.fee)} KAS (${f.fee} sompi)`);
    console.log(`${"total".padEnd(40)} ${KAS(fees.reduce((a, f) => a + f.fee, 0))} KAS`);
  }
  if (errors.length) {
    console.log("\n=========== NODE REFUSALS (verbatim) ===========");
    for (const e of errors) console.log(`${e.what}:\n  ${e.msg}`);
  }
  console.log(`\n============ ASSERTIONS: ${ok.length} passed, ${failures.length} failed ============`);
  for (const a of ok) console.log(`  ✓ ${a}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
}
