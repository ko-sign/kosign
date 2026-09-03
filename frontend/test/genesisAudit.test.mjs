// The frontend half of the genesis provenance gate: fetching, the address the gate
// is gating, the independent cross-check, caching, and the verdict TreasuryView
// keys its refusal screen off (run: node --test frontend/test).
//
// The pure rules live in packages/descriptor (see its genesis.test.ts). What is
// tested here is the part that decides whether a user gets to open a treasury, and
// on how much evidence: that an honest genesis derives the very address being
// opened, that a KOSGN transaction belonging to some other lineage is REFUSED even
// though it is itself honest, that a smuggled covenant member is REFUSED, that the
// independent covenant-id lookup can never fail SILENTLY, that an unreachable chain
// produces UNVERIFIED, and that only final answers are cached.
import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeInscription, deriveGenesisMembers, deriveVaultFromLineage, computeCovenantId, hashScriptHex,
} from "../../packages/descriptor/src/genesis.js";
import { TEMPLATES } from "../../packages/descriptor/src/treasuryTemplates.js";

// Kaspa's cashaddr encoder (rusty-kaspa, crypto/addresses) — the exact inverse of
// the decode the gate performs on the address it is opening. The vault address is
// a consequence of the genesis now, so the fixtures have to MINT it the way a
// wallet does; hard-coding one would let the honest case pass on a coincidence.
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const polymod = (values) => {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    if (c0 & 0x01n) c ^= 0x98f2bc8e61n;
    if (c0 & 0x02n) c ^= 0x79b76d99e2n;
    if (c0 & 0x04n) c ^= 0xf33e5fb3c4n;
    if (c0 & 0x08n) c ^= 0xae2eabe2a8n;
    if (c0 & 0x10n) c ^= 0x1e4f43e470n;
  }
  return c ^ 1n;
};
const p2shAddress = (prefix, hashHex, version = 8) => {
  const five = [];
  let acc = 0, bits = 0;
  for (const b of [version, ...hashHex.match(/../g).map((h) => parseInt(h, 16))]) {
    acc = ((acc << 8) | b) & 0xfff;
    bits += 8;
    while (bits >= 5) { bits -= 5; five.push((acc >> bits) & 31); }
  }
  if (bits) five.push((acc << (5 - bits)) & 31);
  const cs = polymod([...[...prefix].map((ch) => ch.charCodeAt(0) & 0x1f), 0, ...five, 0, 0, 0, 0, 0, 0, 0, 0]);
  const tail = [];
  for (let i = 0; i < 8; i++) tail.push(Number((cs >> BigInt(5 * (7 - i))) & 31n));
  return `${prefix}:${[...five, ...tail].map((v) => CHARSET[v]).join("")}`;
};

// A real TN10 treasury's policy: KOSGN v1, 1-of-2, these two owner keys. The
// inscription's 32-byte slot is the covenant LINEAGE, so it cannot be picked
// before the genesis exists — it is filled in below, once the id is known.
const OWNERS = [
  "8b4c2c1606b66a981d382a18b09bc7d68dab9c321d00b2f199a594a0dea89d39",
  "9ee0065d79b74ae7b0bd7559e9a1aec1853870d04717df90f26102befd0a5822",
];
const inscribe = (lineageHex) =>
  `4b4f53474e0101${OWNERS.length.toString(16).padStart(2, "0")}${lineageHex}${OWNERS.join("")}`;

const FUNDING = { txid: "be6288e9c53947279abeef00afd3029c0835ea052e8eed53512b98cb608117a5", index: 1 };
const FUNDER = "kaspatest:qz95ctqkq6mx4xqa8q4p3vymcltgm2uuxgwspvh3nxjefgx74zwnjul8qyjtu";
const FUNDER_SPK = "208b4c2c1606b66a981d382a18b09bc7d68dab9c321d00b2f199a594a0dea89d39ac";
const GENESIS_TXID = "38d06bdcb0c283ecb684325d40075703ced62ccadf544dbe8cbb0384dcf3ff72";
const BOOTSTRAP_TXID = "7c1d4f0e2a9b6c3d8e5f1a0b7c4d9e6f2a8b5c1d3e7f9a0b4c6d8e2f1a3b5c7d";
const ROOT_VALUE = 30000000, CHANGE_VALUE = 819989352932446, VAULT_VALUE = 20000000;

// The one covenant member an honest genesis pays, under THIS build's templates —
// derived rather than hard-coded so the honest case follows the contracts instead
// of pinning one historical treasury. The lineage slot plays no part in it, which
// is what makes the ordering below possible.
const M = deriveGenesisMembers(decodeInscription(inscribe("00".repeat(32))));
// … which fixes the covenant id the genesis mints, …
const LINEAGE = computeCovenantId(FUNDING, [
  { index: 0, value: ROOT_VALUE, spkVersion: 0, spkHex: M.rootSpkHex },
]);
// … which fixes the vault address, and no other. This is the whole point: the
// address is a function of the genesis, so the gate can DERIVE it rather than
// believe that a transaction and an address belong together.
const V = deriveVaultFromLineage(LINEAGE);
const VAULT = p2shAddress("kaspatest", V.vaultHash);
const ROOT_ADDR = p2shAddress("kaspatest", M.rootHash);
const PAYLOAD = inscribe(LINEAGE);

// the attacker's pre-approved proposal: the real published proposal template
const FORGED_P2SH = `aa20${hashScriptHex(TEMPLATES.proposal.prefix + "00".repeat(TEMPLATES.proposal.stateLen) + TEMPLATES.proposal.suffix)}87`;

// browser globals the module touches, before it is imported
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.sessionStorage = { getItem: () => null, setItem: () => {} };
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

// A stand-in for the user's own wRPC node — the INDEPENDENT source. `nodeMode`
// selects which of the ways the lookup can come back empty (or disagree) is
// exercised.
let nodeMode = "covenant"; // "covenant" | "wrong-id" | "no-covenant-field" | "no-utxo" | "error"
const RPC_URL = "ws://node.test/kaspa";
const OTHER_ID = "f".repeat(64);
globalThis.WebSocket = class FakeWebSocket {
  constructor() {
    this.listeners = {};
    queueMicrotask(() => {
      if (nodeMode === "error") this.emit("error", {});
      else this.emit("open", {});
    });
  }
  emit(type, ev) { for (const fn of this.listeners[type] || []) fn(ev); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  close() { this.emit("close", {}); }
  send(raw) {
    const { id } = JSON.parse(raw);
    const utxoEntry = { amount: "30000000" };
    if (nodeMode === "covenant") utxoEntry.covenantId = LINEAGE;
    if (nodeMode === "wrong-id") utxoEntry.covenantId = OTHER_ID;
    const entries = nodeMode === "no-utxo" ? [] : [{ address: VAULT, utxoEntry }];
    queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id, params: { entries } }) }));
  }
};

const { auditTreasuryGenesis, p2shHashFromAddress } = await import("../src/genesisAudit.js");

// The genesis of VAULT as api-tn10.kaspa.org reports it, minted by this build:
// output 0 is the KoRoot and the covenant's only member, output 1 is ordinary
// change back to the funder. The vault is not here — it cannot be, since it is
// built around the id this transaction mints.
const honest = () => ({
  transaction_id: GENESIS_TXID,
  block_time: 1787107718863,
  payload: PAYLOAD,
  inputs: [{ previous_outpoint_hash: FUNDING.txid, previous_outpoint_index: String(FUNDING.index) }],
  outputs: [
    { index: 0, amount: ROOT_VALUE, script_public_key: M.rootSpkHex, script_public_key_address: ROOT_ADDR, script_public_key_type: "scripthash", covenant_authorizing_input: 0, covenant_id: LINEAGE },
    { index: 1, amount: CHANGE_VALUE, script_public_key: FUNDER_SPK, script_public_key_address: FUNDER, script_public_key_type: "pubkey", covenant_authorizing_input: null, covenant_id: null },
  ],
});

// A genesis that binds a SECOND output — the documented attack. The extra member
// is a KoProposal its creator wrote already-approved; KoVault cannot tell it from
// a real one, so the covenant domain must contain nothing but the KoRoot.
const secondMember = () => {
  const t = honest();
  t.outputs[1] = { index: 1, amount: 50000000, script_public_key: FORGED_P2SH, script_public_key_address: "kaspatest:pforged", script_public_key_type: "scripthash", covenant_authorizing_input: 0, covenant_id: LINEAGE };
  return t;
};

// A one-member genesis whose member is the forged proposal rather than the KoRoot.
// Every structural rule and the covenant-id recomputation pass; only identity
// separates it from an honest treasury.
const forgedRoot = () => {
  const t = honest();
  t.outputs[0].script_public_key = FORGED_P2SH;
  t.outputs[0].script_public_key_address = "kaspatest:prforgedproposal";
  t.outputs[0].covenant_id = computeCovenantId(FUNDING, [
    { index: 0, value: ROOT_VALUE, spkVersion: 0, spkHex: FORGED_P2SH },
  ]);
  return t;
};

// A perfectly honest Ko-sign genesis — of a DIFFERENT treasury. Anyone can pay a
// KOSGN-inscribed transaction into any address, so "a KOSGN tx in this address's
// history" is a claim, not a fact. It is spent from another outpoint, so it mints
// another lineage, so it derives another vault address than the one being opened.
const otherTreasury = () => {
  const outpoint = { txid: "11".repeat(32), index: 0 };
  const t = honest();
  t.inputs = [{ previous_outpoint_hash: outpoint.txid, previous_outpoint_index: String(outpoint.index) }];
  t.outputs[0].covenant_id = computeCovenantId(outpoint, [
    { index: 0, value: ROOT_VALUE, spkVersion: 0, spkHex: M.rootSpkHex },
  ]);
  return t;
};

// The same honest genesis from a source that does not report the funding outpoint:
// the covenant id cannot be recomputed, so the vault address cannot be derived from
// it either, and nothing ties the transaction to the address.
const noOutpoint = () => {
  const t = honest();
  delete t.inputs;
  return t;
};

// The chain as the REST indexer serves it: per-ADDRESS histories, because that is
// the only view the gate has and the genesis is not in the vault's. A genesis pays
// the KoRoot and the funder; one transaction later bootstrapVault continues that
// root and mints the vault. So the KOSGN inscription lives at the ROOT's address,
// and the only route to it is the transaction that minted the vault. A stub that
// answered every address with the genesis would test a chain that cannot exist.
const bootstrapOf = (genesisTx) => {
  const root = genesisTx.outputs[0];
  return {
    transaction_id: BOOTSTRAP_TXID,
    block_time: (genesisTx.block_time || 0) + 1000,
    payload: "", // bootstrapVault carries no inscription (tools/wasm-tx/src/lib.rs, bv_build)
    inputs: [{ previous_outpoint_hash: genesisTx.transaction_id, previous_outpoint_index: "0" }],
    outputs: [
      { index: 0, amount: ROOT_VALUE, script_public_key: root.script_public_key, script_public_key_address: root.script_public_key_address, script_public_key_type: "scripthash", covenant_authorizing_input: 0, covenant_id: root.covenant_id },
      { index: 1, amount: VAULT_VALUE, script_public_key: V.vaultSpkHex, script_public_key_address: VAULT, script_public_key_type: "scripthash", covenant_authorizing_input: 0, covenant_id: root.covenant_id },
    ],
  };
};
const chainOf = (genesisTx) => {
  if (!genesisTx) return {};
  const mint = bootstrapOf(genesisTx);
  return { [VAULT]: [mint], [genesisTx.outputs[0].script_public_key_address]: [mint, genesisTx] };
};

// an unbound deposit: anyone may pay a vault address, and such a payment mints
// nothing — it is not the transaction the walk is looking for
const deposit = () => ({
  transaction_id: "de".repeat(32), block_time: 500, payload: "",
  inputs: [{ previous_outpoint_hash: FUNDING.txid, previous_outpoint_index: "0" }],
  outputs: [{ index: 0, amount: 100000, script_public_key: V.vaultSpkHex, script_public_key_address: VAULT, script_public_key_type: "scripthash", covenant_authorizing_input: null, covenant_id: null }],
});

let respond = () => chainOf(honest());
let calls = 0;
const seen = [];
globalThis.fetch = async (url) => {
  calls++;
  seen.push(String(url));
  const chain = respond();
  if (chain instanceof Error) throw chain;
  const at = /\/addresses\/([^/]+)\/full-transactions/.exec(url);
  if (at) return { ok: true, json: async () => chain[decodeURIComponent(at[1])] || [] };
  return { ok: true, json: async () => ({ balance: VAULT_VALUE }) };
};

const reset = (mode = "covenant") => { store.clear(); calls = 0; seen.length = 0; nodeMode = mode; respond = () => chainOf(honest()); };

test("the gate recovers the script hash the address it is opening commits to", () => {
  assert.equal(p2shHashFromAddress(VAULT), V.vaultHash);
  assert.equal(p2shHashFromAddress(ROOT_ADDR), M.rootHash);
  assert.equal(p2shHashFromAddress(FUNDER), null, "a wallet address commits to no script");
  assert.equal(p2shHashFromAddress(VAULT.replace("kaspatest:p", "kaspatest:q")), null, "checksum");
  assert.equal(p2shHashFromAddress("kaspatest:notanaddress"), null);
});

test("the genesis is nowhere in the vault's own history — the gate walks to it", async () => {
  reset("covenant");
  const v = await auditTreasuryGenesis(VAULT);
  assert.equal(v.verdict, "clean");
  assert.equal(v.genesisTxid, GENESIS_TXID);
  const vaultHistory = chainOf(honest())[VAULT];
  assert.ok(!vaultHistory.some((t) => (t.payload || "").startsWith("4b4f53474e")), "fixture check: no inscription at the vault");
  assert.ok(seen.some((u) => u.includes(ROOT_ADDR)), "the walk has to reach the KoRoot's history");
});

test("SECURITY: a vault whose bootstrap has not landed is UNVERIFIED, and shows no deposit address", async () => {
  reset("covenant");
  respond = () => ({ [VAULT]: [deposit()] }); // paid, but nothing has minted the vault yet
  const v = await auditTreasuryGenesis(VAULT);
  assert.equal(v.verdict, "unverified");
  assert.equal(v.code, "no-genesis");
  assert.equal(v.ok, false);
});

test("an honest genesis clears the gate: the id it mints derives exactly this address", async () => {
  reset("covenant");
  const v = await auditTreasuryGenesis(VAULT, { rpcUrl: RPC_URL });
  assert.equal(v.verdict, "clean");
  assert.equal(v.ok, true);
  assert.equal(v.identified, true);          // the KoRoot was re-derived from the inscription
  assert.equal(v.independentId, true);       // the id also came from the node, not just the indexer
  assert.equal(v.cryptographic, true);
  assert.equal(v.treasuryId, LINEAGE);
  assert.equal(v.rootAddress, ROOT_ADDR);
  assert.equal(v.vaultScriptHash, p2shHashFromAddress(VAULT));
});

test("the address itself is the second opinion — no node needed for a full verdict", async () => {
  reset("covenant");
  const v = await auditTreasuryGenesis(VAULT); // no rpcUrl at all
  assert.equal(v.verdict, "clean");
  assert.equal(v.identified, true);
  assert.equal(v.independentId, false);
  assert.equal(v.cryptographic, true, "only one lineage derives this address, whoever reported the tx");
  assert.equal(v.independent.why, "no-endpoint");
});

test("SECURITY: a KOSGN transaction that is not this vault's genesis is REFUSED", async () => {
  reset("covenant");
  respond = () => chainOf(otherTreasury());
  const v = await auditTreasuryGenesis(VAULT);
  assert.equal(v.verdict, "refused");
  assert.equal(v.code, "vault-not-from-this-genesis");
  assert.match(v.reason, /not that vault's genesis/);
  assert.equal(v.cryptographic, false);
});

test("SECURITY: a genesis binding a second covenant member is REFUSED", async () => {
  reset("covenant");
  respond = () => chainOf(secondMember());
  const v = await auditTreasuryGenesis(VAULT, { rpcUrl: RPC_URL });
  assert.equal(v.verdict, "refused");
  assert.equal(v.ok, false);
  assert.equal(v.code, "bad-covenant-group");
  assert.match(v.reason, /binds exactly output 0/);
  assert.ok(v.checks.some((c) => c.state === "fail"));
});

test("SECURITY: a one-member covenant whose member is a forged proposal is REFUSED", async () => {
  reset("covenant");
  respond = () => chainOf(forgedRoot());
  const v = await auditTreasuryGenesis(VAULT); // not even a node is needed
  assert.equal(v.verdict, "refused");
  assert.equal(v.code, "not-this-build");
  assert.equal(v.identified, false);
  assert.equal(v.cryptographic, false);
});

test("SECURITY: a stranger's covenant parked at the vault address is IGNORED, not treated as the treasury's", async () => {
  // Anyone can create an output at any address, so a stranger can park a covenant of
  // his own at a treasury's published deposit address for the price of the dust —
  // confirmed on chain. KoVault already denies him the money. Taking the first
  // covenant id found there as "what the live treasury carries" would hand the
  // auditor his id and refuse an HONEST treasury as forged, permanently and in
  // public. The lineage the genesis derives is the filter.
  reset("wrong-id");
  const v = await auditTreasuryGenesis(VAULT, { rpcUrl: RPC_URL });
  assert.equal(v.verdict, "clean");
  assert.equal(v.code, null);
  assert.equal(v.independentId, false, "a foreign id must not count as a cross-check");
  assert.equal(v.independent.why, "foreign-covenant-only");
  assert.match(v.independent.note, /can never be spent/);
});

test("SECURITY: a node that reports no covenantId does not pass for a cross-check", async () => {
  reset("no-covenant-field");
  const v = await auditTreasuryGenesis(VAULT, { rpcUrl: RPC_URL });
  assert.equal(v.verdict, "clean");
  assert.equal(v.independentId, false);
  assert.equal(v.independent.why, "no-covenant-field");
  assert.match(v.independent.note, /covenantId/);
});

test("a vault the node has no UTXO for yet is reported, not counted as a cross-check", async () => {
  reset("no-utxo");
  const v = await auditTreasuryGenesis(VAULT, { rpcUrl: RPC_URL });
  assert.equal(v.verdict, "clean");
  assert.equal(v.independentId, false);
  assert.equal(v.independent.why, "no-utxo");
});

test("SECURITY: a node that cannot be reached is reported, not swallowed", async () => {
  reset("error");
  const v = await auditTreasuryGenesis(VAULT, { rpcUrl: RPC_URL });
  assert.equal(v.verdict, "clean");
  assert.equal(v.independentId, false);
  assert.equal(v.independent.why, "rpc-error");
});

test("a non-WebSocket endpoint is reported as such", async () => {
  reset("covenant");
  const v = await auditTreasuryGenesis(VAULT, { rpcUrl: "https://not-a-wrpc-endpoint" });
  assert.equal(v.independentId, false);
  assert.equal(v.independent.why, "bad-endpoint");
});

test("SECURITY: a genesis reported without its funding outpoint is NOT clean", async () => {
  // Round 5. This used to assert verdict "clean" with cryptographic false, and the
  // deposit address turned on the verdict — so withholding one field the SOURCE
  // controls bought a clean verdict for a genesis nothing tied to this address.
  //
  // The honest reading of a partial source and the hostile one are byte-identical
  // here, so they get the same answer, and it is not the one callers may act on.
  reset("covenant");
  respond = () => chainOf(noOutpoint());
  const v = await auditTreasuryGenesis(VAULT, { rpcUrl: RPC_URL });
  assert.equal(v.verdict, "unverified", "an unanswered question must not be reported as a clean answer");
  assert.equal(v.code, "vault-binding-unestablished");
  assert.equal(v.cryptographic, false, "nothing ties this transaction to this address");
  assert.equal(v.vaultScriptHash, null);
});

test("SECURITY: a partial answer is NOT cached, so the proof can still complete", async () => {
  reset("covenant");
  respond = () => chainOf(noOutpoint());
  const first = await auditTreasuryGenesis(VAULT, { rpcUrl: RPC_URL });
  assert.equal(first.cryptographic, false);
  respond = () => chainOf(honest());
  const second = await auditTreasuryGenesis(VAULT, { rpcUrl: RPC_URL });
  assert.equal(second.cached, false, "a partial answer must never freeze as the final one");
  assert.equal(second.cryptographic, true);
});

test("a full verdict is cached — a genesis is immutable", async () => {
  reset("covenant");
  await auditTreasuryGenesis(VAULT, { rpcUrl: RPC_URL });
  const before = calls;
  const again = await auditTreasuryGenesis(VAULT, { rpcUrl: RPC_URL });
  assert.equal(again.cached, true);
  assert.equal(again.cryptographic, true);
  assert.equal(calls, before); // no second REST round-trip
});

test("SECURITY: a refusal is remembered, so it cannot be re-rolled by retrying", async () => {
  reset("covenant");
  respond = () => chainOf(secondMember());
  await auditTreasuryGenesis(VAULT, { rpcUrl: RPC_URL });
  respond = () => chainOf(honest()); // the attacker's indexer now tells the truth
  const v = await auditTreasuryGenesis(VAULT, { rpcUrl: RPC_URL });
  assert.equal(v.verdict, "refused");
  assert.equal(v.cached, true);
});

test("an unreachable chain is UNVERIFIED, and is never cached as an answer", async () => {
  reset("covenant");
  respond = () => new Error("network down");
  const v = await auditTreasuryGenesis(VAULT, { rpcUrl: RPC_URL });
  assert.equal(v.verdict, "unverified");
  assert.equal(v.ok, false);
  assert.equal(v.code, "fetch-failed");
  respond = () => chainOf(honest());
  const later = await auditTreasuryGenesis(VAULT, { rpcUrl: RPC_URL });
  assert.equal(later.verdict, "clean");
  assert.equal(later.cached, false); // the failure did not poison the cache
});

test("a vault with no KOSGN genesis is UNVERIFIED, not clean", async () => {
  reset("covenant");
  respond = () => ({});
  const v = await auditTreasuryGenesis(VAULT, { rpcUrl: RPC_URL });
  assert.equal(v.verdict, "unverified");
  assert.equal(v.code, "no-genesis");
});

test("an address that commits to no script is not a vault, and never reaches the network", async () => {
  reset("covenant");
  const wallet = await auditTreasuryGenesis(FUNDER, { rpcUrl: RPC_URL });
  assert.equal(wallet.code, "bad-address");
  const junk = await auditTreasuryGenesis("not-an-address", { rpcUrl: RPC_URL });
  assert.equal(junk.code, "bad-address");
  assert.equal(calls, 0);
});
