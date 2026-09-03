// The guard that reads a transaction back before it is broadcast
// (run: node --test frontend/test/txGuard.test.mjs).
//
// Two things are being established here, and the second matters more than the
// first. One: the hand-written borsh decoder in frontend/src/txDecode.js reads
// the same transaction the builder wrote — checked against the builder's OWN
// reading, which is the only way to know an independent implementation is
// actually correct rather than merely different. Two: the guard refuses
// transactions that do not match what was asked for. A guard nobody has tried to
// defeat is a guard nobody should trust, so most of this file is attempts to
// slip something past it.
import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import W from "./wasm-loader.mjs";
import { decodeTx, addressFromSpk, spkPayload } from "../src/txDecode.js";
import { inspectSpend, inspectDecoded, assertSpend } from "../src/txGuard.js";
import { rebuildRoot, rebuildVault, proposalTemplateScript, ROOT_STATE_LAYOUT, PROPOSAL_STATE_LAYOUT } from "../src/treasuryRebuild.js";
import { TEMPLATES } from "../src/treasuryTemplates.js";
import { blake2b256 } from "../../packages/descriptor/src/genesis.js";

const NUMS = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
const ZERO_SIG = "00".repeat(64);
const txid = (c) => String(c).repeat(64);
const PREFIX = "kaspatest";
const LINEAGE = "8b".repeat(32);

const owners5 = [NUMS, NUMS, NUMS, NUMS, NUMS];
const rootScript = rebuildRoot(3, 2, 2, owners5);
const vaultRedeem = rebuildVault("ab".repeat(32));
const proposalRedeem = proposalTemplateScript();

const alice = W.pubkey_address("c0".repeat(32), "testnet");
const mallory = W.pubkey_address("d1".repeat(32), "testnet");
const spkOf = (addr) => JSON.parse(W.recipient_info(addr)).spkHex;

const VAULT_OUTPOINT = { txid: txid(2), index: 0 };
const executeTx = ({ to = alice, amount = 100_000_000, lineage = LINEAGE } = {}) =>
  JSON.parse(W.execute_build(JSON.stringify({
    treasuryId: lineage, vaultRedeem, vaultTxid: VAULT_OUTPOINT.txid, vaultIndex: VAULT_OUTPOINT.index, vaultAmount: 500_000_000,
    proposalRedeem, propTxid: txid(3), propIndex: 0, propAmount: 45_000_000,
    recipientSpkHex: spkOf(to), amount, executorIndex: 0, fee: 1_000_000,
  }), ZERO_SIG)).borshHex;

const approveTx = () => JSON.parse(W.approve_build(JSON.stringify({
  proposalRedeem, propTxid: txid(1), propIndex: 0, propAmount: 50_000_000,
  treasuryId: LINEAGE, pStart: PROPOSAL_STATE_LAYOUT.start, ownerIndex: 1, fee: 1_000_000,
}), ZERO_SIG)).borshHex;

const PROPOSE_BASE = {
  rootScript, rootTxid: txid(6), rootIndex: 0, rootAmount: 200_000_000,
  treasuryId: LINEAGE, pPrefix: TEMPLATES.proposal.prefix, pSuffix: TEMPLATES.proposal.suffix, vPrefix: TEMPLATES.vault.prefix, vSuffix: TEMPLATES.vault.suffix,
  rStart: ROOT_STATE_LAYOUT.start, operation: 1, recipientSpkHash: "11".repeat(32),
  amount: 1_000_000, maxFee: 10_000_000, expiresAt: 4_000_000_000, executionDelay: 0, proposerIndex: 0,
};

// The proposer funds the 0.5 KAS bond from their own wallet; the KoRoot is spent
// but returned whole. The treasury therefore ends this transaction AHEAD.
const ownerFundedProposeTx = () => JSON.parse(W.create_proposal_build(JSON.stringify({
  ...PROPOSE_BASE, ownerAddress: alice, fundingUtxos: [{ txid: txid(7), index: 0, amount: 100_000_000 }], fee: 1_000_000,
}), JSON.stringify([ZERO_SIG, ZERO_SIG]))).borshHex;

const proposeTx = () => JSON.parse(W.create_proposal_build(JSON.stringify({
  rootScript, rootTxid: txid(6), rootIndex: 0, rootAmount: 200_000_000,
  treasuryId: LINEAGE, pPrefix: TEMPLATES.proposal.prefix, pSuffix: TEMPLATES.proposal.suffix, vPrefix: TEMPLATES.vault.prefix, vSuffix: TEMPLATES.vault.suffix,
  rStart: ROOT_STATE_LAYOUT.start, operation: 1, recipientSpkHash: "11".repeat(32),
  amount: 1_000_000, maxFee: 10_000_000, expiresAt: 4_000_000_000, executionDelay: 0, proposerIndex: 0, fee: 1_000_000,
}), ZERO_SIG)).borshHex;

// A retirement returns the WHOLE bond to the vault's P2SH as an unbound output,
// carries a lock time, and funds its fee from the closer's own signed inputs
// (change home). Structurally unlike anything else the guard sees, which is
// precisely why borrowing another operation's transaction to test it proves nothing.
const closeExpiredTx = ({ redeem = vaultRedeem, bond = 50_000_000 } = {}) => JSON.parse(W.close_expired_build(JSON.stringify({
  proposalRedeem, propTxid: txid(1), propIndex: 0, propAmount: bond,
  vaultRedeem: redeem, lockTime: 4_000_000_000, fee: 1_000_000,
  ownerAddress: alice, fundingUtxos: [{ txid: txid(8), index: 0, amount: 20_000_000 }],
}), JSON.stringify([ZERO_SIG]))).borshHex;
// the spk the guard independently derives for the vault redeem (aa20 ‖ hash ‖ 87)
const vaultBondSpk = (redeem = vaultRedeem) => `aa20${Buffer.from(blake2b256(Buffer.from(redeem, "hex"))).toString("hex")}87`;

// A signer change spends the KoRoot AND the proposal, and continues both. It pays
// nobody at all — a shape no other operation produces.
const configExecuteTx = () => JSON.parse(W.execute_config_build(JSON.stringify({
  rootScript, rootTxid: txid(4), rootIndex: 0, rootAmount: 30_000_000,
  proposalRedeem, propTxid: txid(5), propIndex: 0, propAmount: 45_000_000,
  treasuryId: LINEAGE, rStart: ROOT_STATE_LAYOUT.start,
  newThreshold: 1, newOwnerCount: 1, newOwners: owners5, executorIndex: 0, fee: 1_000_000,
}), ZERO_SIG)).borshHex;

const rejectTx = () => JSON.parse(W.reject_build(JSON.stringify({
  proposalRedeem, propTxid: txid(1), propIndex: 0, propAmount: 50_000_000,
  treasuryId: LINEAGE, pStart: PROPOSAL_STATE_LAYOUT.start, ownerIndex: 1, fee: 1_000_000,
}), ZERO_SIG)).borshHex;

const guard = (extra = {}) => ({ lineage: LINEAGE, prefix: PREFIX, vaultOutpoint: VAULT_OUTPOINT, walletAddress: null, ...extra });

// ---- the decoder is independent AND correct ---------------------------------

test("the hand-written borsh decoder reads what the builder wrote", () => {
  for (const [name, hex] of [["execute", executeTx()], ["approve", approveTx()], ["propose", proposeTx()]]) {
    const mine = decodeTx(hex);
    const theirs = JSON.parse(W.borsh_to_rpc_json(hex));
    assert.equal(mine.version, theirs.version, `${name}: version`);
    assert.equal(mine.inputs.length, theirs.inputs.length, `${name}: input count`);
    assert.equal(mine.outputs.length, theirs.outputs.length, `${name}: output count`);
    mine.inputs.forEach((mi, i) => {
      const ti = theirs.inputs[i];
      assert.equal(mi.previousOutpoint.transactionId, ti.previousOutpoint.transactionId, `${name}: input ${i} txid`);
      assert.equal(mi.previousOutpoint.index, ti.previousOutpoint.index, `${name}: input ${i} index`);
      assert.equal(mi.signatureScript, ti.signatureScript, `${name}: input ${i} signature script`);
    });
    mine.outputs.forEach((mo, i) => {
      const to = theirs.outputs[i];
      assert.equal(String(mo.value), String(to.value), `${name}: output ${i} value`);
      // the RPC rendering flattens the scriptPublicKey to one hex string with the
      // 2-byte version in front; rebuild that shape rather than reaching past it
      const flat = mo.scriptPublicKey.version.toString(16).padStart(4, "0") + mo.scriptPublicKey.script;
      assert.equal(flat, to.scriptPublicKey, `${name}: output ${i} script`);
      assert.equal(mo.covenant?.covenantId ?? null, to.covenant?.covenantId ?? null, `${name}: output ${i} covenant`);
    });
    assert.equal(String(mine.lockTime), String(theirs.lockTime), `${name}: lockTime`);
    assert.equal(mine.payload, theirs.payload ?? "", `${name}: payload`);
  }
});

test("an output's address is rebuilt exactly as the wallet renders it", () => {
  for (const addr of [alice, mallory]) {
    // recipient_info hands back a scriptPubKey with its 2-byte version prefix;
    // an output carries the version separately, so drop it before comparing.
    const script = spkOf(addr).slice(4);
    assert.equal(addressFromSpk(script, PREFIX), addr);
  }
  // and the P2SH side: the vault continuation names an address too
  const vaultOut = decodeTx(executeTx()).outputs.find((o) => o.covenant);
  const p = spkPayload(vaultOut.scriptPublicKey.script);
  assert.equal(p.version, 8, "a covenant continuation pays a script hash");
  assert.ok(addressFromSpk(vaultOut.scriptPublicKey.script, PREFIX).startsWith("kaspatest:p"));
});

test("a transaction that cannot be read back is refused rather than guessed at", () => {
  assert.throws(() => decodeTx("abc"), /even-length hex/);
  assert.throws(() => decodeTx("zz00"), /even-length hex/);
  assert.throws(() => decodeTx(executeTx().slice(0, 40)), /truncated/);
  assert.throws(() => decodeTx(executeTx() + "00"), /trailing bytes/);
  // and the guard turns that into a refusal, not a crash
  assert.deepEqual(inspectSpend(executeTx() + "00", guard({ recipientSpkHex: spkOf(alice), amount: 100_000_000 })).length, 1);
});

// ---- the guard passes honest work -------------------------------------------

test("an honest transfer, approval and proposal all pass", () => {
  assert.deepEqual(inspectSpend(executeTx(), { ...guard({ recipientSpkHex: spkOf(alice), amount: 100_000_000 }), kind: "execute" }), []);
  assert.deepEqual(inspectSpend(approveTx(), { ...guard(), kind: "approve" }), []);
  assert.deepEqual(inspectSpend(proposeTx(), { ...guard(), kind: "propose" }), []);
});

// ---- and refuses everything else --------------------------------------------

test("a transfer to someone other than the address you named is refused", () => {
  const problems = inspectSpend(executeTx({ to: mallory }), { ...guard({ recipientSpkHex: spkOf(alice), amount: 100_000_000 }), kind: "execute" });
  assert.ok(problems.some((p) => p.includes("not the address you named")), problems.join(" | "));
  assert.ok(problems.some((p) => p.includes(mallory)), "the refusal names where the money would actually have gone");
});

test("the right address for the wrong amount is refused, and the message says both numbers", () => {
  const problems = inspectSpend(executeTx({ amount: 400_000_000 }), { ...guard({ recipientSpkHex: spkOf(alice), amount: 100_000_000 }), kind: "execute" });
  assert.equal(problems.length, 1, problems.join(" | "));
  assert.match(problems[0], /pays the right address but 4 KAS instead of the 1 KAS/);
});

test("a transfer that pays nobody is refused — silence is not success", () => {
  // built for alice, but the caller declared mallory: nothing in the transaction
  // pays the declared address, and the guard must say so rather than shrug.
  const problems = inspectSpend(executeTx({ to: alice }), { ...guard({ recipientSpkHex: spkOf(mallory), amount: 100_000_000 }), kind: "execute" });
  assert.ok(problems.some((p) => p.includes("pays nobody")), problems.join(" | "));
});

test("an output continuing someone else's covenant is refused", () => {
  // the re-parenting shape: same structure, different lineage.
  const foreign = "cc".repeat(32);
  const problems = inspectSpend(executeTx({ lineage: foreign }), { ...guard({ recipientSpkHex: spkOf(alice), amount: 100_000_000 }), kind: "execute" });
  assert.ok(problems.some((p) => p.includes("is not this treasury's lineage")), problems.join(" | "));
});

test("an approval that would spend the vault is refused", () => {
  // Approving is an opinion, not a payment. Point the guard's vault at the UTXO
  // this approval actually spends and it must refuse on that ground alone.
  const problems = inspectSpend(approveTx(), { ...guard({ vaultOutpoint: { txid: txid(1), index: 0 } }), kind: "approve" });
  assert.ok(problems.some((p) => p.includes("must not spend the vault")), problems.join(" | "));
});

test("a proposal is not allowed to pay anyone at all", () => {
  // A proposal only moves value between this treasury's own covenant outputs.
  // Declaring a payee for it does not make one appear, and if the builder ever
  // produced one it would be an output nobody agreed to.
  assert.deepEqual(inspectSpend(proposeTx(), { ...guard(), kind: "propose" }), []);
  const tx = decodeTx(proposeTx());
  assert.ok(tx.outputs.every((o) => o.covenant), "every proposal output stays inside the treasury's covenant");
});

test("without a lineage to check against, nothing is broadcast", () => {
  for (const bad of [undefined, null, "", "not-hex", "ab".repeat(31)]) {
    const problems = inspectSpend(executeTx(), { ...guard({ lineage: bad, recipientSpkHex: spkOf(alice), amount: 100_000_000 }), kind: "execute" });
    assert.ok(problems.some((p) => p.includes("refusing to broadcast")), `lineage ${JSON.stringify(bad)}: ${problems.join(" | ")}`);
  }
});

test("assertSpend throws with every problem named, and stays silent when there are none", () => {
  assert.doesNotThrow(() => assertSpend(executeTx(), { ...guard({ recipientSpkHex: spkOf(alice), amount: 100_000_000 }), kind: "execute" }));
  let e;
  try {
    assertSpend(executeTx({ to: mallory, amount: 400_000_000 }), { ...guard({ recipientSpkHex: spkOf(alice), amount: 100_000_000 }), kind: "execute" });
  } catch (err) { e = err; }
  assert.ok(e, "a transfer to the wrong address for the wrong amount must throw");
  assert.equal(e.name, "SpendGuardRefusal");
  assert.ok(Array.isArray(e.problems) && e.problems.length >= 1);
  assert.match(e.message, /was NOT sent/);
  assert.match(e.message, /Nothing has moved/);
});

test("paying the declared address twice is refused", () => {
  // The builder will not produce this, which is exactly why the rule is reached
  // through inspectDecoded: a rule only testable via the builder is a rule the
  // builder decides whether to test. Two outputs of the right amount to the right
  // address still means the vault paid twice for one approval.
  const tx = decodeTx(executeTx());
  const payment = tx.outputs.find((o) => !o.covenant);
  tx.outputs.push({ ...payment });
  const problems = inspectDecoded(tx, { ...guard({ recipientSpkHex: spkOf(alice), amount: 100_000_000 }), kind: "execute" });
  assert.ok(problems.some((p) => p.includes("pays the declared address 2 times")), problems.join(" | "));
});

test("a retirement's bond must reach the vault spk the guard derived, not whatever the tx pays", () => {
  // close-expired frees the 0.5 KAS bond into an UNBOUND output, so the
  // destination rule is the only thing standing between the bond and a stranger
  // — the guard names the vault's own P2SH and everything else is refused.
  const tx = decodeTx(executeTx({ to: mallory }));
  const problems = inspectDecoded(tx, { ...guard({ recipientSpkHex: vaultBondSpk() }), kind: "close-expired" });
  assert.ok(problems.some((p) => p.includes("not the address you named") || p.includes("not this treasury")), problems.join(" | "));
  assert.ok(problems.some((p) => p.includes("pays nobody")), "and the bond never reached the vault");
});

test("every operation that submits a transaction is guarded", () => {
  // The guard is only worth anything if it is on the path. A new entrypoint that
  // forgets to pass one would submit unchecked and no other test would notice,
  // so the wiring itself is pinned here rather than left to review.
  const src = readFileSync(new URL("../src/wasmTx.js", import.meta.url), "utf8");
  // the declaration matches the same name, so exclude it explicitly
  const calls = [...src.matchAll(/(?<!function )submitAndTrack\(([\s\S]*?)\);\n/g)].map((m) => m[1]);
  assert.ok(calls.length >= 7, `expected every covenant op to submit through submitAndTrack, found ${calls.length}`);
  // every op builds its guard through guardFor(), directly or via a local gd()
  const unguarded = calls.filter((c) => !/\b(gd|guardFor)\(/.test(c));
  assert.deepEqual(unguarded, [], `these submitAndTrack call sites pass no guard:\n${unguarded.join("\n---\n")}`);

  // and the guard has to be applied per attempt, not once: a node that demands a
  // higher fee sends the flow back through rebuild(), which re-signs new bytes.
  const loop = src.slice(src.indexOf("for (let attempt = 0"), src.indexOf("const st0 = loadState"));
  assert.match(loop, /assertSpend\(borshHex/, "the guard must run inside the fee-retry loop, not once before it");
});

test("with no vault outpoint to compare against, theft is still caught by destination", () => {
  // The vault's outpoint comes from the node, so an unreachable node leaves that
  // rule with nothing to check. It must not be the only thing standing between a
  // treasury and a thief: an approval that drained the vault still has to send the
  // money somewhere, and every destination has to be declared.
  const problems = inspectSpend(executeTx({ to: mallory }), {
    ...guard({ vaultOutpoint: null, recipientSpkHex: spkOf(alice), amount: 100_000_000 }), kind: "approve",
  });
  assert.ok(problems.some((p) => p.includes(mallory)), problems.join(" | "));
  assert.ok(problems.some((p) => p.includes("not your own wallet")), problems.join(" | "));
});

// ---- conservation: how MUCH leaves, not just where it goes -------------------

test("an honest transfer's arithmetic balances", () => {
  // 5 KAS vault + 0.45 KAS bond in; 1 KAS paid out; 4.44 KAS back to the vault;
  // 0.01 KAS fee. The guard is told what went in and what the treasury pays.
  assert.deepEqual(inspectSpend(executeTx(), {
    ...guard({ recipientSpkHex: spkOf(alice), amount: 100_000_000, treasuryIn: 545_000_000, treasuryFee: 1_000_000 }),
    kind: "execute",
  }), []);
});

test("a fee the treasury pays but the app does not show is caught, with the exact shortfall", () => {
  // The destination rules cannot see this: nothing goes anywhere suspicious, the
  // vault just gets less back. Miners take the remainder whatever it is called.
  const problems = inspectSpend(executeTx(), {
    ...guard({ recipientSpkHex: spkOf(alice), amount: 100_000_000, treasuryIn: 545_000_000, treasuryFee: 100_000 }),
    kind: "execute",
  });
  assert.equal(problems.length, 1, problems.join(" | "));
  assert.match(problems[0], /0\.009 KAS more than accounted for/);
});

test("an owner-funded operation is fully conserved, and saying otherwise would refuse honest work", () => {
  // When the wallet pays the fee the treasury loses nothing, so treasuryFee is 0.
  // Passing the real fee here instead is the mistake that would refuse every
  // honest owner-funded operation, so it is pinned as a failure on purpose.
  const ap = approveTx();
  assert.deepEqual(inspectSpend(ap, { ...guard({ treasuryIn: 50_000_000, treasuryFee: 1_000_000 }), kind: "approve" }), []);
  const wrong = inspectSpend(ap, { ...guard({ treasuryIn: 50_000_000, treasuryFee: 0 }), kind: "approve" });
  assert.equal(wrong.length, 1, "claiming the treasury pays nothing when it paid the fee must not pass silently");
});

test("conservation is skipped, not guessed, when the caller cannot state the numbers", () => {
  // Not every path knows what it spent — a backend-served context, say. Inventing
  // a number there would refuse honest transactions, which is worse than the gap.
  assert.deepEqual(inspectSpend(executeTx(), {
    ...guard({ recipientSpkHex: spkOf(alice), amount: 100_000_000, treasuryIn: null, treasuryFee: null }),
    kind: "execute",
  }), []);
});

test("a treasury too large to represent exactly is refused, not mis-accounted (round 6)", () => {
  // Money amounts are held as JS Number, exact only to 2^53-1 sompi (~90M KAS).
  // treasuryIn reaches the guard as a Number SUM (vault + bond); once it crosses
  // the limit it no longer equals the true u64 sum, while the outputs are decoded
  // as exact BigInt. The guard then either refuses an honest payout or waves a
  // real over-loss through — so above the limit it must refuse, clearly, rather
  // than compare an exact figure against a rounded one.
  //
  // Number(9007199254740991) + 50000000 rounds to 9007199304740992 (not a safe
  // integer), which is the value executeClientSide would hand the guard.
  const bigTreasuryIn = 9_007_199_254_740_991 + 50_000_000;
  assert.equal(Number.isSafeInteger(bigTreasuryIn), false, "the sum must actually be unrepresentable, or this proves nothing");
  const problems = inspectSpend(executeTx(), {
    ...guard({ recipientSpkHex: spkOf(alice), amount: 100_000_000, treasuryIn: bigTreasuryIn, treasuryFee: 0 }),
    kind: "execute",
  });
  assert.equal(problems.length, 1, problems.join(" | "));
  assert.match(problems[0], /too large for this build to check exactly/);

  // and an ordinary treasury one sompi under the boundary is NOT refused —
  // the check must not cost honest users anything.
  assert.deepEqual(inspectSpend(executeTx(), {
    ...guard({ recipientSpkHex: spkOf(alice), amount: 100_000_000, treasuryIn: 545_000_000, treasuryFee: 1_000_000 }),
    kind: "execute",
  }), []);
});

test("an owner-funded proposal leaves the treasury AHEAD, and that is not a shortfall", () => {
  // Regression. The first version of the conservation rule demanded that what left
  // the treasury EQUAL the stated fee. An owner-funded proposal spends the KoRoot,
  // returns it whole, and mints the 0.5 KAS bond out of the proposer's wallet — so
  // the treasury gains. The rule read that gain as "0.5 KAS less than accounted
  // for" and refused every one of them, in the product, to a real user.
  //
  // Losing money the owner was not told about is the danger. Gaining it never is.
  const problems = inspectSpend(ownerFundedProposeTx(), {
    ...guard({ treasuryIn: 200_000_000, treasuryFee: 0, walletAddress: alice }), kind: "propose",
  });
  assert.deepEqual(problems, []);

  // and the treasury really is ahead, so this test cannot pass for the wrong reason
  const tx = decodeTx(ownerFundedProposeTx());
  const back = tx.outputs.reduce((n, o) => (o.covenant ? n + o.value : n), 0n);
  assert.ok(back > 200_000_000n, `the covenant outputs (${back}) must exceed what the treasury put in`);
});

test("the ceiling still catches the treasury losing more than it was said to cost", () => {
  // The rule is one-sided, not absent: a covenant-funded transfer that takes more
  // out than the app admitted is still refused, and the message carries the gap.
  const problems = inspectSpend(executeTx(), {
    ...guard({ recipientSpkHex: spkOf(alice), amount: 100_000_000, treasuryIn: 545_000_000, treasuryFee: 100_000 }),
    kind: "execute",
  });
  assert.equal(problems.length, 1, problems.join(" | "));
  assert.match(problems[0], /0\.009 KAS more than accounted for/);
});

// ---- the shapes the guard had never actually seen ---------------------------
//
// Until a user hit it, the conservation rule had a test for the owner-funded case
// that ran through `approve` — a path where the treasury's value cannot grow, so
// the case it was written for could not arise. These three operations produce
// shapes no other operation does, and the guard had never been run over any of
// them. Borrowing another operation's transaction and relabelling its `kind` is
// not a test of that operation.

test("a retirement returns the WHOLE bond to the vault, unbound, and the treasury loses nothing", () => {
  // Structurally unlike everything else: output 0 pays the vault's P2SH with NO
  // covenant binding (the bond arrives as a stray the next sweep folds in), the
  // closer's change comes home, and the transaction is time-locked. The treasury
  // ends the operation down ZERO — the closer pays the fee — so treasuryFee: 0
  // is the honest declaration and the conservation rule holds it there.
  const tx = decodeTx(closeExpiredTx());
  assert.equal(tx.outputs[0].covenant, null, "the bond output must not inherit the lineage");
  assert.equal(tx.outputs[0].value, 50_000_000n, "the WHOLE bond, not bond-minus-fee");
  assert.ok(tx.lockTime > 0n, "a retirement is time-locked to the committed expiry");

  assert.deepEqual(inspectSpend(closeExpiredTx(), {
    ...guard({ recipientSpkHex: vaultBondSpk(), amount: 50_000_000, walletAddress: alice, treasuryIn: 50_000_000, treasuryFee: 0 }), kind: "close-expired",
  }), []);
});

test("a retirement routing the bond anywhere but the vault is refused", () => {
  // the closer bounty this covenant change removes: the tx pays SOME P2SH, but
  // not the vault the guard independently derives from the redeem it holds
  const problems = inspectSpend(closeExpiredTx({ redeem: rebuildVault("cd".repeat(32)) }), {
    ...guard({ recipientSpkHex: vaultBondSpk(), amount: 50_000_000, walletAddress: alice, treasuryIn: 50_000_000, treasuryFee: 0 }), kind: "close-expired",
  });
  assert.ok(problems.some((p) => p.includes("not this treasury")), problems.join(" | "));
  assert.ok(problems.some((p) => p.includes("pays nobody")), "and the bond never reached the vault");
});

test("a retirement returning the bond short is refused", () => {
  // right address, wrong value: the guard was told the whole 0.5 KAS bond comes
  // home and must refuse a transaction that returns less
  const problems = inspectSpend(closeExpiredTx({ bond: 49_000_000 }), {
    ...guard({ recipientSpkHex: vaultBondSpk(), amount: 50_000_000, walletAddress: alice, treasuryIn: 50_000_000, treasuryFee: 0 }), kind: "close-expired",
  });
  assert.ok(problems.some((p) => /instead of the .* you asked for|more than accounted for/.test(p)), problems.join(" | "));
});

test("a signer change merges the root and the proposal into one continuation, and pays nobody", () => {
  // Two covenant inputs, ONE covenant output carrying their combined value. No
  // other operation produces this shape, and an off-by-one in the arithmetic here
  // would have refused every signer change in the product.
  const tx = decodeTx(configExecuteTx());
  assert.equal(tx.outputs.length, 1);
  assert.ok(tx.outputs[0].covenant, "the whole value stays inside the treasury");

  assert.deepEqual(inspectSpend(configExecuteTx(), {
    ...guard({ treasuryIn: 75_000_000, treasuryFee: 1_000_000 }), kind: "config-execute",
  }), []);
});

test("a signer change may not spend the vault", () => {
  // Changing who signs is not a payment. It touches the root and the proposal.
  const problems = inspectSpend(configExecuteTx(), {
    ...guard({ vaultOutpoint: { txid: txid(4), index: 0 }, treasuryIn: 75_000_000, treasuryFee: 1_000_000 }),
    kind: "config-execute",
  });
  assert.ok(problems.some((p) => p.includes("must not spend the vault")), problems.join(" | "));
});

test("a rejection continues the proposal and takes only the fee", () => {
  assert.deepEqual(inspectSpend(rejectTx(), {
    ...guard({ treasuryIn: 50_000_000, treasuryFee: 1_000_000 }), kind: "reject",
  }), []);
  const problems = inspectSpend(rejectTx(), {
    ...guard({ treasuryIn: 50_000_000, treasuryFee: 0 }), kind: "reject",
  });
  assert.equal(problems.length, 1, "a rejection that costs the treasury more than claimed is still caught");
});

test("every operation the app can submit has been through the guard here", () => {
  // The gap this file closes was not a missing assertion, it was a missing SHAPE.
  // Pin the inventory so a new entrypoint cannot be guarded in wasmTx.js and left
  // untested here — which is exactly how close-expired and config-execute got in.
  const covered = new Set(["propose", "approve", "reject", "execute", "config-execute", "close-expired"]);
  const src = readFileSync(new URL("../src/wasmTx.js", import.meta.url), "utf8");
  const submitted = new Set(
    [...src.matchAll(/submitAndTrack\(base, treasuryId, [^,]+, "([a-z-]+)"/g)].map((m) => m[1]),
  );
  const untested = [...submitted].filter((k) => !covered.has(k));
  assert.deepEqual(untested, [], `these operations submit transactions no test in this file has ever built: ${untested.join(", ")}`);
});

test("every node-demanded fee passes the sanity ceiling before it is re-signed", () => {
  // The "required amount of N" retry re-signs at the N the node names, and on the
  // owner-funded paths nothing else caps it — the guard conserves TREASURY value
  // and is never told the wallet input total, so a lying node's N would come
  // straight out of the wallet. Pin the shape: every parse of that error must
  // hand its number to saneFeeDemand (sweepPlan.js) before anything is rebuilt.
  const src = readFileSync(new URL("../src/wasmTx.js", import.meta.url), "utf8");
  const retries = src.split("required amount of (\\d+)").length - 1;
  const clamped = src.split("saneFeeDemand(").length - 1;
  assert.ok(retries >= 4, `expected the four submit-retry sites, found ${retries}`);
  assert.equal(clamped, retries,
    `${retries} retry sites parse the node's demanded fee but only ${clamped} pass it through saneFeeDemand — an unclamped site re-signs whatever a hostile node names`);
});

// ---- a lineage tag is not an address ----------------------------------------

test("a vault continuation repointed at a stranger is refused, though it wears this treasury's id", () => {
  // Round 5. The destination rule accepts a covenant output the moment its id
  // matches — and an id is a TAG the builder writes beside the script, not a
  // property of the script. So repointing the vault continuation's 32-byte hash
  // at an attacker, with the binding left untouched, satisfied every rule: the
  // output read as a continuation of this lineage, and its value counted as
  // "came back" in the conservation sum, closing the arithmetic too.
  //
  // Consensus does reject this transaction — KoVault.executeProposal requires the
  // change output's scriptPubKey to be the vault's own. Which is the point: being
  // right because the node catches it is not the same as being right, and this
  // module exists precisely so the browser does not have to find out at the node.
  const tx = decodeTx(executeTx());
  const cont = tx.outputs.find((o) => o.covenant);
  const honestSpk = cont.scriptPublicKey.script;
  cont.scriptPublicKey = { ...cont.scriptPublicKey, script: `aa20${"99".repeat(32)}87` };

  const g = { ...guard({ recipientSpkHex: spkOf(alice), amount: 100_000_000, vaultSpk: honestSpk, treasuryIn: 545_000_000, treasuryFee: 1_000_000 }), kind: "execute" };
  const problems = inspectDecoded(tx, g);
  assert.ok(problems.some((p) => p.includes("without being its vault")), problems.join(" | "));

  // and it must be THIS rule that fires: the id still matches, and the money still
  // "balances", so nothing else in the guard has any reason to object.
  assert.ok(!problems.some((p) => p.includes("more than accounted for")), `conservation alone cannot see this: ${problems.join(" | ")}`);
});

test("the honest transfer still returns the vault's money to the vault", () => {
  // The other half of the rule above, and the half that matters more: a rule that
  // refuses honest work has shipped in this product before. The real builder's
  // own output must satisfy it untouched.
  const vaultSpk = decodeTx(executeTx()).outputs.find((o) => o.covenant).scriptPublicKey.script;
  assert.deepEqual(inspectSpend(executeTx(), {
    ...guard({ recipientSpkHex: spkOf(alice), amount: 100_000_000, vaultSpk, treasuryIn: 545_000_000, treasuryFee: 1_000_000 }),
    kind: "execute",
  }), []);
});

test("the vault's own script is derived without asking the builder for it", () => {
  // wasmTx.js hands the guard a vaultSpk it hashes itself, from the redeem script
  // the app already holds. Asking the wasm builder for the address would be the
  // builder vouching for its own output — the one thing this module refuses to do.
  const derived = `aa20${Buffer.from(blake2b256(Buffer.from(vaultRedeem, "hex"))).toString("hex")}87`;
  const fromBuilder = decodeTx(executeTx()).outputs.find((o) => o.covenant).scriptPublicKey.script;
  assert.equal(derived, fromBuilder, "the independently hashed vault script must be the one the vault continuation pays");
});

test("a vault address must follow from the lineage, not from what the builder says it minted", () => {
  // Round 5, creation path. Both callers of submitBootstrap publish
  // p2sh(vaultRedeemHex) as the treasury's deposit address — and that hex is the
  // BUILDER's account of what it just minted, not a reading of the transaction.
  //
  // The covenant pins what reaches the chain, so a wrong vault cannot be minted.
  // It cannot pin a return value. A builder that puts the correct vault on chain
  // and hands back a different redeem script tells a lie the node never sees, and
  // the treasury is then correct with an attacker's address printed under it.
  //
  // A vault address is a pure function of its lineage, so the app can derive it.
  // This is that derivation, and the assertion wasmTx.js makes before publishing.
  const lineage = "ab".repeat(32);
  assert.equal(rebuildVault(lineage), vaultRedeem, "the vault of a lineage is exactly one script");

  // and a different lineage is a different vault — otherwise the check above
  // would hold for every treasury at once and prove nothing.
  assert.notEqual(rebuildVault("cd".repeat(32)), vaultRedeem);
});

test("wasmTx refuses to publish a vault address it did not derive", () => {
  // The guard above lives in submitBootstrap, which needs a node and a funded
  // wallet to reach. Pin the check itself so it cannot be quietly dropped: without
  // it, a builder's vaultRedeemHex is published unexamined.
  const src = readFileSync(new URL("../src/wasmTx.js", import.meta.url), "utf8");
  assert.match(src, /const derivedRedeem = rebuildVault\(lineage\);/,
    "submitBootstrap must derive the vault redeem from the lineage");
  assert.match(src, /out\.vaultRedeemHex\.toLowerCase\(\) !== derivedRedeem\.toLowerCase\(\)/,
    "submitBootstrap must compare the builder's vault against the derived one before publishing");
});

// ---- round 6: wiring the sweep and creation paths cannot silently regress ----

test("the sweep funds its fee through the session-spend filter, not a raw read", () => {
  // Every wallet-funded flow reads its UTXOs through freshUtxos so it does not
  // re-pick one already spent (in the mempool) by a preceding op this session. The
  // sweep was the one exception, which made a proposal-then-sweep deterministically
  // fail as a double-spend. Pin the fix: the sweep's fee read goes through
  // freshUtxos, and each batch records its inputs as spent.
  const src = readFileSync(new URL("../src/wasmTx.js", import.meta.url), "utf8");
  assert.match(src, /let fents = freshUtxos\(\(await c\.getUtxos\(\[sweeperAddress\]\)\)\.entries\);/,
    "the sweep must read fee UTXOs through freshUtxos");
  const batch = src.slice(src.indexOf("async function submitSweepBatch"), src.indexOf("async function sweepClientSide"));
  assert.match(batch, /markSpentOutpoints\(rpcTx\);/,
    "submitSweepBatch must record its spent inputs so the next op/batch does not re-pick them");
});

test("the sweep does nothing (and charges nothing) when there is nothing to sweep", () => {
  // No strays and a single vault UTXO: there is nothing to consolidate, so the
  // sweep must return before building a tx rather than pay a wallet fee to re-mint
  // the vault to itself. Compaction is real only when a second vault UTXO exists.
  const src = readFileSync(new URL("../src/wasmTx.js", import.meta.url), "utf8");
  assert.match(src, /if \(!keep\.length && !covExtra\.length\) \{/,
    "sweepClientSide must early-return when there is neither a stray nor a second vault UTXO");
});

test("the money path validates amounts through safeSompi before signing or checking", () => {
  // A UTXO amount above 2^53 sompi cannot be represented, so signing or checking a
  // rounded one is wrong. Pin that the source conversions go through safeSompi
  // rather than a bare Number(), on the vault balance, deposits, and the batch sum.
  const src = readFileSync(new URL("../src/wasmTx.js", import.meta.url), "utf8");
  assert.match(src, /value: safeSompi\(pick\.utxoEntry\.amount/, "the vault balance must be range-checked");
  assert.match(src, /amount: safeSompi\(e\.utxoEntry\.amount/, "deposit/wallet amounts must be range-checked");
  assert.match(src, /safeSompi\(vaultUtxos\.reduce/, "the chained-batch vault sum must be range-checked");
});

// ---- guard COVERAGE: the wallet-signing flows that used to skip the guard -----
// Round 7 found that sweep, genesis and bootstrap sign the operator's OWN wallet
// inputs (SIGHASH_ALL) and broadcast with no second reading. The covenant floor
// keeps the treasury safe, but nothing stopped a wrong/hostile builder from
// routing the wallet CHANGE to an attacker. These pin that (a) the guard passes
// an honest build of each shape, and (b) a diverted change/vault output is caught.

const p2shSpkLocal = (redeemHex) => {
  const bytes = new Uint8Array(String(redeemHex).match(/../g).map((b) => parseInt(b, 16)));
  return `aa20${Array.from(blake2b256(bytes), (b) => b.toString(16).padStart(2, "0")).join("")}87`;
};

// -- sweep --
const SWEEP_SID = "cd".repeat(32);
const sweepVaultRedeem = rebuildVault(SWEEP_SID);
const sweepInputs = (fee = 100_000) => JSON.stringify({
  vaultRedeem: sweepVaultRedeem, treasuryId: SWEEP_SID,
  vaultUtxos: [
    { txid: txid(1), index: 0, amount: 500_000_000, covenant: true },
    { txid: txid(2), index: 0, amount: 50_000_000, covenant: false },
  ],
  ownerAddress: alice, fundingUtxos: [{ txid: txid(3), index: 0, amount: 100_000_000 }], fee,
});
const sweepTx = () => {
  const inp = sweepInputs();
  const shs = JSON.parse(W.sweep_funded_sighashes(inp));
  return JSON.parse(W.sweep_funded_tx(inp, JSON.stringify(shs.map(() => ZERO_SIG)))).borshHex;
};
const sweepGuard = { kind: "sweep", lineage: SWEEP_SID, prefix: PREFIX, walletAddress: alice, vaultSpk: p2shSpkLocal(sweepVaultRedeem), treasuryIn: 550_000_000, treasuryFee: 0 };

test("an honest sweep passes the guard (vault kept whole, change home to the sweeper)", () => {
  assert.deepEqual(inspectSpend(sweepTx(), sweepGuard), []);
});

test("a sweep that reroutes the wallet change to an attacker is refused", () => {
  const tx = decodeTx(sweepTx());
  const changeIdx = tx.outputs.findIndex((o) => !o.covenant);
  assert.ok(changeIdx >= 0, "the honest sweep must have a change output to divert");
  tx.outputs[changeIdx].scriptPublicKey.script = spkOf(mallory).slice(4);
  const problems = inspectDecoded(tx, sweepGuard);
  assert.ok(problems.some((p) => /not your own wallet|unrecognised/.test(p)), problems.join("; "));
});

test("a sweep that reparents the vault output off this lineage is refused", () => {
  const tx = decodeTx(sweepTx());
  const vaultIdx = tx.outputs.findIndex((o) => o.covenant);
  tx.outputs[vaultIdx].scriptPublicKey.script = spkOf(mallory).slice(4);
  tx.outputs[vaultIdx].covenant = null; // now a plain P2PK to the attacker
  const problems = inspectDecoded(tx, sweepGuard);
  assert.ok(problems.length > 0, "a vault output paid to a stranger must be refused");
});

// -- genesis --
const gAnchor = { fundingAddress: alice, rootRedeem: rootScript, rootValue: 30_000_000, fundingUtxos: [{ txid: txid(8), index: 0, amount: 100_000_000 }] };
const gLineage = W.genesis_covenant_id(JSON.stringify(gAnchor));
const gPayload = W.inscription(BigInt(2), JSON.stringify([NUMS, NUMS]), gLineage);
const genesisTx = (change = 60_000_000) => {
  const ginp = JSON.stringify({ ...gAnchor, change, payloadHex: gPayload });
  const ga = JSON.parse(W.genesis_sighashes(ginp));
  return JSON.parse(W.genesis_build(ginp, JSON.stringify(ga.sighashes.map(() => ZERO_SIG)))).borshHex;
};
const genesisGuard = { kind: "genesis", lineage: gLineage, prefix: PREFIX, walletAddress: alice };

test("an honest genesis passes the guard (root minted, change home to the funder)", () => {
  assert.deepEqual(inspectSpend(genesisTx(), genesisGuard), []);
});

test("a genesis that reroutes the change (the vault's opening balance) to an attacker is refused", () => {
  const tx = decodeTx(genesisTx());
  const changeIdx = tx.outputs.findIndex((o) => !o.covenant);
  assert.ok(changeIdx >= 0, "the honest genesis must have a change output to divert");
  tx.outputs[changeIdx].scriptPublicKey.script = spkOf(mallory).slice(4);
  const problems = inspectDecoded(tx, genesisGuard);
  assert.ok(problems.some((p) => /not your own wallet|unrecognised/.test(p)), problems.join("; "));
});

// -- bootstrap --
const bBase = {
  rootScript, rootTxid: txid(9), rootIndex: 0, rootAmount: 30_000_000, treasuryId: gLineage,
  vaultPrefix: TEMPLATES.vault.prefix, vaultSuffix: TEMPLATES.vault.suffix, vaultValue: 30_000_000,
  ownerIndex: 0, ownerAddress: alice, fundingUtxos: [{ txid: txid(10), index: 0, amount: 60_000_000 }],
};
const bootstrapTx = (fee = 100_000) => {
  const inp = JSON.stringify({ ...bBase, fee });
  const shs = JSON.parse(W.bootstrap_sighashes(inp));
  return JSON.parse(W.bootstrap_build(inp, JSON.stringify(shs.map(() => ZERO_SIG)))).borshHex;
};
const bootstrapGuard = { kind: "bootstrap", lineage: gLineage, prefix: PREFIX, walletAddress: alice };

test("an honest bootstrap passes the guard (root+vault continued, change home)", () => {
  assert.deepEqual(inspectSpend(bootstrapTx(), bootstrapGuard), []);
});

test("a bootstrap that reroutes the funder's change to an attacker is refused", () => {
  const tx = decodeTx(bootstrapTx());
  const changeIdx = tx.outputs.findIndex((o) => !o.covenant);
  assert.ok(changeIdx >= 0, "the honest bootstrap must have a change output to divert");
  tx.outputs[changeIdx].scriptPublicKey.script = spkOf(mallory).slice(4);
  const problems = inspectDecoded(tx, bootstrapGuard);
  assert.ok(problems.some((p) => /not your own wallet|unrecognised/.test(p)), problems.join("; "));
});

// -- wiring: the three flows must actually CALL the guard before broadcasting ---
test("sweep, genesis and bootstrap all route through assertSpend before submit", () => {
  const src = readFileSync(new URL("../src/wasmTx.js", import.meta.url), "utf8");
  assert.match(src, /assertSpend\(out\.borshHex,\s*\{\s*\n?\s*kind:\s*"sweep"/, "sweep must assertSpend the built bytes");
  assert.match(src, /assertSpend\(gout\.borshHex,\s*\{\s*kind:\s*"genesis"/, "genesis must assertSpend the built bytes");
  assert.match(src, /assertSpend\(out\.borshHex,\s*\{\s*kind:\s*"bootstrap"/, "bootstrap must assertSpend the built bytes");
});

// ---- a non-standard (version != 0) output is anyone-can-spend, not a payment ---
// Round 7 (txDecode re-attack): decodeTx captured scriptPublicKey.version but the
// guard only ever compared .script, so a version-1 output — which does not run its
// script on chain and pays nobody — rendered via addressFromSpk as an honest
// address and passed as the declared recipient/change. Pin that the guard now
// refuses any non-zero script version, and that honest (version-0) work still passes.
test("an output with a non-zero script version is refused (anyone-can-spend, not a payment)", () => {
  const tx = decodeTx(executeTx());
  const payIdx = tx.outputs.findIndex((o) => !o.covenant);
  assert.ok(payIdx >= 0, "the transfer must have a recipient output");
  tx.outputs[payIdx].scriptPublicKey.version = 1; // same bytes, non-standard version
  const problems = inspectDecoded(tx, { ...guard({ recipientSpkHex: spkOf(alice), amount: 100_000_000 }), kind: "execute" });
  assert.ok(problems.some((p) => /version 1, not 0|non-standard/.test(p)), problems.join("; "));
});

test("version-0 outputs (all honest work) are unaffected by the version check", () => {
  // the honest transfer/approve/propose already assert []; this names the reason
  const tx = decodeTx(executeTx());
  assert.ok(tx.outputs.every((o) => o.scriptPublicKey.version === 0), "honest builder outputs are all script version 0");
});

// ---- the destination rule is the backstop, not the (self-vouched) fee math -----
// Round 7 critic (G1): treasuryFee reaches the guard from the builder's own output
// (treasurySpend sources it from r.fee), the "builder vouching for itself" seam. Even
// if a hostile builder inflated it so the conservation ceiling is trivially satisfied,
// an output to anywhere but the declared payee or the funding wallet must still be
// refused — by the destination rule, which reads the bytes and owes the builder nothing.
test("an inflated treasuryFee cannot buy a wrong destination past the guard", () => {
  const problems = inspectSpend(executeTx({ to: mallory }), {
    ...guard({ recipientSpkHex: spkOf(alice), amount: 100_000_000, treasuryIn: 500_000_000, treasuryFee: 500_000_000 }),
    kind: "execute",
  });
  assert.ok(problems.some((p) => /not this treasury, not the address you named, and not your own wallet/.test(p)),
    `the destination rule must refuse a wrong payee regardless of the fee ceiling: ${problems.join("; ")}`);
});
