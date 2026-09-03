// The browser-side covenant walk: how `walkRoot` reads a KoRoot spend and
// `scanOpenProposals` reads a KoProposal spend, and what each decides happened
// (run: node --test frontend/test).
//
// The witness's second-to-last push is an ENTRYPOINT SELECTOR, and silc assigns
// selectors by declaration order — so adding an entrypoint to KoRoot renumbers the
// ones after it. That makes the mapping here a coupling between a contract's source
// order and a client's parser, with no compiler and no type to catch a mismatch: a
// wrong number does not fail to parse, it parses the WRONG witness. Reading a
// bootstrapVault witness as executeConfig, for instance, yields a threshold of 1e154
// and an owner set three slots long, and the next hop dies rebuilding the root — so
// every treasury minted by the two-transaction flow is unopenable in a fresh tab.
// These fixtures pin all three selectors against real witness shapes.
import test from "node:test";
import assert from "node:assert/strict";
import { hashScriptHex } from "../../packages/descriptor/src/genesis.js";

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

const { walkRoot, scanOpenProposals } = await import("../src/proposalScan.js");

// ---- script encoding (the inverse of proposalScan's own parsePushes) ----------
const hex2 = (n) => n.toString(16).padStart(2, "0");
const push = (dataHex) => {
  const n = dataHex.length / 2;
  if (n <= 0x4b) return hex2(n) + dataHex;
  if (n <= 0xff) return "4c" + hex2(n) + dataHex;
  return "4d" + hex2(n & 0xff) + hex2((n >> 8) & 0xff) + dataHex;
};
const opInt = (n) => (n === 0 ? "00" : hex2(0x50 + n)); // OP_0, OP_1..OP_16
const le8 = (v) => { let n = BigInt(v), h = ""; for (let i = 0; i < 8; i++) { h += hex2(Number(n & 0xffn)); n >>= 8n; } return h; };

const GENESIS = "aa".repeat(32);
const BOOTSTRAP = "bb".repeat(32);
const CONFIG_TX = "cc".repeat(32);
const CREATE_TX = "dd".repeat(32);
const ID = "ee".repeat(32);

const OWNERS = ["01", "02", "03", "04", "05"].map((b) => b.repeat(32));
const NEW_OWNERS = ["11", "12", "13", "14", "15"].map((b) => b.repeat(32));

const SIG = push("77".repeat(65));
const ROOT_SCRIPT = push("99".repeat(6869)); // the revealed redeem, ~7 kB — exercises OP_PUSHDATA2
const VAULT_PREFIX = push("6b");
const VAULT_SUFFIX = push("88".repeat(3931)); // the vault template bytes bootstrapVault reveals

// [ownerIndex, sig, vaultTemplatePrefix, vaultTemplateSuffix, SELECTOR=1, rootScript]
const bootstrapWitness = () => opInt(0) + SIG + VAULT_PREFIX + VAULT_SUFFIX + opInt(1) + ROOT_SCRIPT;
// [proposalInputIndex, thr8, cnt8, owner0..4, SELECTOR=2, rootScript]
const executeConfigWitness = (thr, cnt, owners5) =>
  opInt(0) + push(le8(thr)) + push(le8(cnt)) + owners5.map(push).join("") + opInt(2) + ROOT_SCRIPT;
// [proposerIndex, sig, operation, recipientSpkHash, amount, maxFee, expiresAt,
//  executionDelay, SELECTOR=0, rootScript]
const createProposalWitness = () =>
  opInt(0) + SIG + push(le8(1)) + push("aa".repeat(32)) + push(le8(500)) +
  push(le8(0)) + push(le8(0)) + push(le8(0)) + opInt(0) + ROOT_SCRIPT;

// ---- a synthetic chain, addressed exactly as the walk addresses it ------------
// `p2sh` is any injective function of the redeem script; the walk only ever
// compares the address it derives against the one it asked the chain about.
const p2sh = (redeemHex) => `addr:${hashScriptHex(redeemHex)}`;

/**
 * @param {{spends: {from: {txid: string, index: number}, txid: string, witness: string, cov?: boolean}[],
 *          live: {txid: string, index: number}[]}} chain
 */
function harness(chain) {
  // every spend is reachable from every address we ask about: the walk is
  // outpoint-anchored, so serving one history for all addresses cannot help it.
  const history = chain.spends.map((s) => ({
    transaction_id: s.txid,
    inputs: [{ previous_outpoint_hash: s.from.txid, previous_outpoint_index: s.from.index, signature_script: s.witness }],
    // A vote's proposal continuation AND an execute's vault change both carry the
    // treasury's covenant id, so an id on output 0 cannot tell them apart — only the
    // selector can. closeExpired (`cov: false`) retires the lineage and mints none.
    outputs: [s.cov === false ? { amount: 49_000_000 } : { covenant_id: ID, amount: 49_000_000 }],
  }));
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => history };
  };
  const getUtxos = async (addr) => {
    calls.push(addr);
    return chain.live.map((o) => ({ outpoint: { transactionId: o.txid, index: o.index }, utxoEntry: { amount: 300_000_000, covenantId: ID } }));
  };
  return { getUtxos, calls };
}

const base = { treasuryId: ID, genesisTxid: GENESIS, threshold: 2, ownerCount: 3, owners5: OWNERS };

test("bootstrapVault is selector 1, and it changes nothing the walk tracks", async () => {
  // The FIRST hop out of every genesis: the root is spent to mint the vault and
  // continues UNCHANGED — same nonce, same owners. Read as executeConfig instead,
  // the signature push becomes a threshold and the walk dies on the next rebuild.
  const { getUtxos } = harness({
    spends: [{ from: { txid: GENESIS, index: 0 }, txid: BOOTSTRAP, witness: bootstrapWitness() }],
    live: [{ txid: BOOTSTRAP, index: 0 }],
  });
  const { live, creations } = await walkRoot({ ...base, p2sh, getUtxos });
  assert.ok(live, "the walk must reach the live root through the bootstrap hop");
  assert.equal(live.nonce, 0, "bootstrapVault does not bump the proposal nonce");
  assert.equal(live.threshold, 2);
  assert.equal(live.ownerCount, 3);
  assert.deepEqual(live.owners5, OWNERS, "bootstrapVault does not touch the owner set");
  assert.deepEqual(live.outpoint, { txid: BOOTSTRAP, index: 0 });
  assert.equal(creations.length, 0, "no proposal was created here");
});

test("executeConfig is selector 2, and it installs the owner set from its own witness", async () => {
  const { getUtxos } = harness({
    spends: [
      { from: { txid: GENESIS, index: 0 }, txid: BOOTSTRAP, witness: bootstrapWitness() },
      { from: { txid: BOOTSTRAP, index: 0 }, txid: CONFIG_TX, witness: executeConfigWitness(3, 5, NEW_OWNERS) },
    ],
    live: [{ txid: CONFIG_TX, index: 0 }],
  });
  const { live } = await walkRoot({ ...base, p2sh, getUtxos });
  assert.ok(live, "the walk must land on the root the config change installed");
  assert.equal(live.threshold, 3);
  assert.equal(live.ownerCount, 5);
  assert.deepEqual(live.owners5, NEW_OWNERS);
  assert.equal(live.nonce, 0, "a config change preserves the proposal nonce");
});

test("createProposal is selector 0, and it advances the nonce with the config held", async () => {
  const { getUtxos } = harness({
    spends: [
      { from: { txid: GENESIS, index: 0 }, txid: BOOTSTRAP, witness: bootstrapWitness() },
      { from: { txid: BOOTSTRAP, index: 0 }, txid: CREATE_TX, witness: createProposalWitness() },
    ],
    live: [{ txid: CREATE_TX, index: 0 }],
  });
  const { live, creations } = await walkRoot({ ...base, p2sh, getUtxos });
  assert.ok(live);
  assert.equal(live.nonce, 1, "one proposal minted ⇒ the root continues at nonce 1");
  assert.equal(creations.length, 1);
  assert.equal(creations[0].nonce, 0, "the proposal was minted BY the nonce-0 root");
  assert.equal(creations[0].threshold, 2, "a creation carries the config that was live when it happened");
  assert.deepEqual(creations[0].owners5, OWNERS);
});

test("an unknown selector stops the walk rather than guessing what the spend did", async () => {
  // A treasury minted by a build whose KoRoot has entrypoints this client does not
  // know about must not have its state invented; `live: null` is the honest answer.
  const unknown = opInt(0) + SIG + opInt(9) + ROOT_SCRIPT;
  const { getUtxos } = harness({
    spends: [{ from: { txid: GENESIS, index: 0 }, txid: BOOTSTRAP, witness: unknown }],
    live: [{ txid: BOOTSTRAP, index: 0 }],
  });
  const { live } = await walkRoot({ ...base, p2sh, getUtxos });
  assert.equal(live, null);
});

// ---- the proposal side: KoProposal's four entrypoints ------------------------
// Same coupling as above, one degree worse: KoRoot's four witnesses all carry the
// same two leading pushes, but KoProposal's do NOT. approve/reject take
// (ownerIndex, sig), execute takes (pairedInputIndex, ownerIndex, sig), and
// closeExpired takes NOTHING — it is permissionless, so its entire witness is the
// selector and the redeem reveal. Only the offset from the END is constant. Read at
// a fixed offset from the front, a retired proposal has no selector there at all and
// reads as an EXECUTED one: the scan reports status 3 and an "executed" event for a
// proposal that moved not one sompi, and wasmTx's rescan (status >= 2 ⇒ the chain
// view wins) writes that over the correct local record. Chain-confirmed on TN10.
const PROP_SCRIPT = push("55".repeat(1731)); // the revealed proposal redeem (prefix+state+suffix)
const APPROVE_TX = "1a".repeat(32);
const REJECT1_TX = "2a".repeat(32);
const REJECT2_TX = "2b".repeat(32);
const EXEC_TX = "3a".repeat(32);
const CLOSE_TX = "4a".repeat(32);

// [ownerIndex, sig, SELECTOR=0, proposalScript]                     (wasm-tx approve_build)
const approveWitness = (owner) => opInt(owner) + SIG + opInt(0) + PROP_SCRIPT;
// [pairedInputIndex, ownerIndex, sig, SELECTOR=1, proposalScript]   (wasm-tx execute_build)
const executeWitness = (owner) => opInt(0) + opInt(owner) + SIG + opInt(1) + PROP_SCRIPT;
// [SELECTOR=2, proposalScript]                                     (kobridge build_close_expired)
const closeExpiredWitness = () => opInt(2) + PROP_SCRIPT;
// [ownerIndex, sig, SELECTOR=3, proposalScript]                     (wasm-tx reject_build)
const rejectWitness = (owner) => opInt(owner) + SIG + opInt(3) + PROP_SCRIPT;

// Genesis → bootstrapVault → createProposal, so the walk hands scanOpenProposals a
// real creation; the proposal itself lives at createProposal output 1.
const P0 = { txid: CREATE_TX, index: 1 };
const rootSpends = [
  { from: { txid: GENESIS, index: 0 }, txid: BOOTSTRAP, witness: bootstrapWitness() },
  { from: { txid: BOOTSTRAP, index: 0 }, txid: CREATE_TX, witness: createProposalWitness() },
];
async function scanChain(propSpends, propLive = []) {
  const { getUtxos } = harness({
    spends: [...rootSpends, ...propSpends],
    live: [{ txid: CREATE_TX, index: 0 }, ...propLive], // the root continues at nonce 1
  });
  const { creations } = await walkRoot({ ...base, p2sh, getUtxos });
  assert.equal(creations.length, 1);
  return scanOpenProposals({ treasuryId: ID, creations, p2sh, getUtxos });
}

test("closeExpired is selector 2, and a retired proposal is closed — never executed", async () => {
  // Two pushes, no owner index, no signature. Nothing moved: the bond went to
  // whoever paid for the retiring transaction, the treasury was untouched.
  const found = await scanChain([
    { from: P0, txid: CLOSE_TX, witness: closeExpiredWitness(), cov: false },
  ]);
  assert.equal(found.length, 1);
  const p = found[0];
  assert.ok(!p.events.some((e) => e.type === "executed"), "a retired proposal never paid out");
  assert.equal(p.status, 2, "closed, not Executed(3)");
  assert.ok(p.status >= 2, "and still final, so wasmTx's rescan keeps the chain view");
  assert.equal(p.closedReason, "expired");
  assert.deepEqual(p.events.at(-1), { type: "closed", owner: null, at: null });
  assert.equal(p.executedTxid, CLOSE_TX, "the closing tx is still linkable");
});

test("execute is selector 1 behind a leading paired index, and it names the executor", async () => {
  // The one witness with THREE arguments: the front push is the vault/root input
  // index, not an owner. Owner 1's approval carries the 2-of-3 to Approved, then
  // owner 1 executes — and the execute tx carries a covenant output of its own (the
  // vault's change), so nothing but the selector separates it from a vote.
  const found = await scanChain([
    { from: P0, txid: APPROVE_TX, witness: approveWitness(1) },
    { from: { txid: APPROVE_TX, index: 0 }, txid: EXEC_TX, witness: executeWitness(1) },
  ]);
  assert.equal(found.length, 1);
  const p = found[0];
  assert.equal(p.status, 3, "an execute really did close this one out");
  assert.equal(p.approvalCount, 2);
  assert.equal(p.executedTxid, EXEC_TX);
  assert.equal(p.closedReason, undefined, "an execution is not a close");
  assert.deepEqual(p.events.at(-1), { type: "executed", owner: 1, at: null }, "the executor, not the paired input index");
});

test("approve and reject continue the proposal instead of closing it", async () => {
  // Two rejections out of three owners put a 2-of-3 beyond reach — status 2 (Failed)
  // on a proposal UTXO that is still very much alive, so it carries no closing tx.
  const found = await scanChain(
    [
      { from: P0, txid: REJECT1_TX, witness: rejectWitness(1) },
      { from: { txid: REJECT1_TX, index: 0 }, txid: REJECT2_TX, witness: rejectWitness(2) },
    ],
    [{ txid: REJECT2_TX, index: 0 }],
  );
  assert.equal(found.length, 1);
  const p = found[0];
  assert.equal(p.status, 2, "Failed");
  assert.equal(p.rejectCount, 2);
  assert.equal(p.rejectBitmap, 0b110, "owners 1 and 2 voted it down");
  assert.equal(p.approvalCount, 1, "the proposer's own approval, and no more");
  assert.equal(p.executedTxid, undefined, "still an unspent UTXO — nothing closed it");
  assert.deepEqual(p.events.map((e) => [e.type, e.owner]), [["created", 0], ["rejected", 1], ["rejected", 2]]);
});

test("an unrecognised proposal selector closes without inventing a payout", async () => {
  // A spend this client cannot read is not evidence that the treasury paid anyone.
  const found = await scanChain([
    { from: P0, txid: CLOSE_TX, witness: opInt(0) + SIG + opInt(9) + PROP_SCRIPT },
  ]);
  assert.equal(found[0].status, 2);
  assert.equal(found[0].closedReason, "unknown");
  assert.ok(!found[0].events.some((e) => e.type === "executed"));
});
