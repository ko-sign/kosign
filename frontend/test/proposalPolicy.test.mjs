// What the UI is allowed to let a user ask for, and what it is allowed to tell
// them happened (run: node --test frontend/test/proposalPolicy.test.mjs).
//
// Two of these are the UI half of a rule the covenant enforces somewhere else, and
// both failure modes are silent:
//
//   * The transfer ceiling. ex_build spends the vault UTXO *and* the proposal's
//     bond, so an execute can pay out MORE than the vault holds. A UI that blocks
//     at the balance refuses a legitimate "send everything"; a UI that blocks
//     nothing lets a user pay a 0.5 KAS bond for a proposal the builder will
//     refuse at execute time. The boundary is checked here against the REAL wasm
//     builder rather than against a restatement of it.
//   * The ending. Only an execute pays anyone. A retirement frees the bond and
//     moves nothing, and reporting it as an execution tells a treasury's owners
//     their money left when it did not.
import test from "node:test";
import assert from "node:assert/strict";
import W from "./wasm-loader.mjs";
import { rebuildVault, proposalTemplateScript } from "../src/treasuryRebuild.js";
import {
  PROPOSAL_BOND, MAX_COVENANT_FEE, maxTransferSompi, checkTransfer,
  statusLabel, outcomeNote, retireState, canRetire, daaEta,
  expiryDaa, executeWindow, DAA_PER_SECOND, MIN_EXPIRY_SECS, MAX_EXPIRY_SECS, DEFAULT_EXPIRY_SECS,
} from "../src/proposalPolicy.js";

const ZERO_SIG = "00".repeat(64);
const TREASURY = "8b".repeat(32);
const txid = (c) => String(c).repeat(64);
const vaultRedeem = rebuildVault("ab".repeat(32));
const proposalRedeem = proposalTemplateScript();
const spkHex = JSON.parse(W.recipient_info(W.pubkey_address("c0".repeat(32), "testnet"))).spkHex;

// the covenant-funded execute: vault + bond in, recipient + vault change out
const execBuild = (vaultAmount, amount, fee) => JSON.parse(W.execute_build(JSON.stringify({
  treasuryId: TREASURY, vaultRedeem, vaultTxid: txid(2), vaultIndex: 0, vaultAmount,
  proposalRedeem, propTxid: txid(3), propIndex: 0, propAmount: PROPOSAL_BOND,
  recipientSpkHex: spkHex, amount, executorIndex: 0, fee,
}), ZERO_SIG));

// ---- the ceiling, against the builder that actually enforces it --------------

test("the ceiling is what ex_build can fund, at the worst fee the covenant allows", () => {
  const bal = 500_000_000;
  const max = maxTransferSompi(bal);
  assert.equal(max, bal + PROPOSAL_BOND - MAX_COVENANT_FEE);
  // at the ceiling the builder funds it even if the fee prices out at the cap
  const ok = execBuild(bal, max, MAX_COVENANT_FEE);
  assert.equal(ok.vaultChange, 0 + (bal + PROPOSAL_BOND - max - MAX_COVENANT_FEE));
  // one sompi past it and the builder refuses — the exact failure a proposer would
  // otherwise meet only after paying the bond and collecting approvals
  assert.throws(() => execBuild(bal, max + 1, MAX_COVENANT_FEE), /can't cover/);
});

test("a transfer of the WHOLE vault balance is buildable — the bond covers the fee", () => {
  const bal = 500_000_000;
  assert.equal(checkTransfer("5", bal).ok, true); // 5 KAS == the whole balance
  const built = execBuild(bal, bal, MAX_COVENANT_FEE);
  assert.equal(built.vaultChange, PROPOSAL_BOND - MAX_COVENANT_FEE);
});

test("checkTransfer blocks more than the vault can pay and says what it holds", () => {
  const bal = 500_000_000; // 5 KAS
  const under = checkTransfer("5.4", bal); // still inside vault + bond - cap
  assert.equal(under.ok, true);
  assert.equal(under.error, null);
  assert.equal(under.sompi, 540_000_000);

  const over = checkTransfer("6", bal);
  assert.equal(over.ok, false);
  assert.match(over.error, /5 KAS/); // names the balance, at the point of the mistake
  assert.match(over.error, /5\.4 KAS/); // …and the most that could ever be paid
  assert.match(over.error, /0\.5 KAS bond/);

  // the boundary itself, to the sompi
  assert.equal(checkTransfer("5.4", bal).ok, true);
  assert.equal(checkTransfer("5.40000001", bal).ok, false);
});

test("checkTransfer stays silent on a half-typed amount and invents no limit without a balance", () => {
  for (const t of ["", "0", "-1", ".", "abc", null, undefined]) {
    const r = checkTransfer(t, 500_000_000);
    assert.equal(r.ok, false, `"${t}" must not submit`);
    assert.equal(r.error, null, `"${t}" is not a mistake worth shouting about`);
  }
  // backend down / balance not in yet: nothing to compare against, so don't block
  const blind = checkTransfer("1000000", null);
  assert.equal(blind.ok, true);
  assert.equal(blind.error, null);
  assert.equal(maxTransferSompi(null), null);
  assert.equal(maxTransferSompi(undefined), null);
});

test("an empty vault still reports the bond-funded remainder rather than a negative ceiling", () => {
  assert.equal(maxTransferSompi(0), PROPOSAL_BOND - MAX_COVENANT_FEE);
  assert.equal(checkTransfer("100", 0).ok, false);
  assert.match(checkTransfer("100", 0).error, /vault holds 0 KAS/);
});

// ---- what the UI says happened ----------------------------------------------

const proposal = (o = {}) => ({ proposalId: 7, status: 0, amount: 100_000_000, expiresAtDaa: 1000, proposalOutpoint: { txid: txid(9), index: 0 }, ...o });

test("only an execute reads as executed", () => {
  assert.equal(statusLabel(proposal({ status: 3, executedTxid: txid(1) })), "Executed");
  assert.match(outcomeNote(proposal({ status: 3, executedTxid: txid(1) })), /recipient was paid/);

  // the closeExpired spend the chain scan reports as status 2 + closedReason
  const retired = proposal({ status: 2, closedReason: "expired", executedTxid: txid(1) });
  assert.equal(statusLabel(retired), "Retired");
  assert.match(outcomeNote(retired), /nothing was paid out/);

  // a spend whose witness the scan could not read is a close, never a payout
  const unknown = proposal({ status: 2, closedReason: "unknown", executedTxid: txid(1) });
  assert.equal(statusLabel(unknown), "Closed");
  assert.match(outcomeNote(unknown), /not an execute/);

  // failed by rejections, still holding its bond on chain
  const rejected = proposal({ status: 2, rejectCount: 2 });
  assert.equal(statusLabel(rejected), "Rejected");
  assert.match(outcomeNote(rejected), /pays nobody/);

  assert.equal(statusLabel(proposal({ status: 0 })), "Pending");
  assert.equal(statusLabel(proposal({ status: 1 })), "Approved");
  assert.equal(outcomeNote(proposal({ status: 0 })), null);
  assert.equal(outcomeNote(proposal({ status: 1 })), null);
});

// ---- when retiring can actually succeed --------------------------------------

test("retire is offered only past the committed expiry, on a bond that still exists", () => {
  const p = proposal({ expiresAtDaa: 1000 });
  // the contract compares tx.time >= expiresAt and the node relays only a lock time
  // the DAA score has already PASSED, so the boundary is strict
  assert.equal(retireState(p, 999).state, "waiting");
  assert.equal(retireState(p, 1000).state, "waiting");
  assert.equal(retireState(p, 1001).state, "retirable");
  assert.equal(canRetire(p, 1001), true);
  assert.equal(canRetire(p, 1000), false);

  // no node → no clock → no claim that it would succeed
  assert.equal(retireState(p, null).state, "no-clock");
  assert.equal(canRetire(p, null), false);

  // already spent: an executed proposal has no bond left to free, and the contract
  // refuses status 3 outright
  assert.equal(retireState(proposal({ status: 3, executedTxid: txid(1) }), 9e9).state, "closed");
  assert.equal(retireState(proposal({ status: 2, closedReason: "expired", executedTxid: txid(1) }), 9e9).state, "closed");

  // a REJECTED proposal is exactly the case whose bond is stuck — it stays retirable
  assert.equal(retireState(proposal({ status: 2, rejectCount: 2 }), 1001).state, "retirable");

  // history rebuilt without a live outpoint has nothing to spend
  assert.equal(retireState(proposal({ proposalOutpoint: undefined }), 1001).state, "no-utxo");
  assert.equal(retireState(proposal({ expiresAtDaa: 0 }), 1001).state, "no-expiry");
});

test("the waiting card reports the real distance to the expiry", () => {
  const r = retireState(proposal({ expiresAtDaa: 1_000_000 }), 400_000);
  assert.equal(r.blocks, 600_000);
  assert.equal(daaEta(600_000), "~17 h"); // 10 blocks a second
  assert.equal(daaEta(600), "~60s");
  assert.equal(daaEta(6000), "~10 min");
  assert.equal(daaEta(0), "~0s");
  // the expiry the shipped proposal builders commit today, against a live TN10 score
  assert.match(daaEta(4_000_000_000 - 548_000_000), /years/);
});

// ── A proposal's lifetime is bounded, chosen, and anchored to the chain ─────────

test("expiryDaa commits to a bounded lifetime from the chain's own clock", () => {
  const now = 548_000_000;
  assert.equal(expiryDaa(now, 30 * 86400), now + 30 * 86400 * DAA_PER_SECOND);
  assert.equal(expiryDaa(now), now + DEFAULT_EXPIRY_SECS * DAA_PER_SECOND); // the default is real, not the 11-year constant
  assert.ok(expiryDaa(now) < 4_000_000_000, "the default expiry must never reproduce the old effectively-eternal value");
});

test("expiryDaa refuses a lifetime outside the floor and ceiling", () => {
  const now = 548_000_000;
  assert.throws(() => expiryDaa(now, MIN_EXPIRY_SECS - 1), /must live between/);
  assert.throws(() => expiryDaa(now, MAX_EXPIRY_SECS + 1), /must live between/);
  assert.equal(expiryDaa(now, MIN_EXPIRY_SECS), now + MIN_EXPIRY_SECS * DAA_PER_SECOND); // the bounds themselves are legal
  assert.equal(expiryDaa(now, MAX_EXPIRY_SECS), now + MAX_EXPIRY_SECS * DAA_PER_SECOND);
});

test("expiryDaa refuses to guess when there is no chain clock", () => {
  // currentDaaScore() returns null when no node answers — committing an expiry
  // anchored to nothing would silently recreate the eternal-proposal bug
  for (const bad of [null, undefined, 0, -5, NaN]) {
    assert.throws(() => expiryDaa(bad, 86400), /no DAA score/i, `must refuse daa=${bad}`);
  }
});

test("an expired proposal is for retiring, not executing", () => {
  // closeExpired is permissionless and pays the bond to whoever runs it, so a
  // post-expiry execute races bond snipers with the transfer as the stake —
  // legal on-chain (tx.time is a lower bound; RISKS #3), refused by this client
  const exp = 1_000_000;
  assert.equal(executeWindow(exp, exp).state, "expired");
  assert.equal(executeWindow(exp, exp + 1).state, "expired");
  const closing = executeWindow(exp, exp - 3600 * DAA_PER_SECOND);
  assert.equal(closing.state, "closing"); // final hour: warned, not blocked
  assert.equal(executeWindow(exp, exp - 2 * 3600 * DAA_PER_SECOND).state, "open");
  assert.equal(executeWindow(null, 5).state, "no-clock"); // no committed expiry readable → no verdict
  assert.equal(executeWindow(exp, null).state, "no-clock"); // no chain clock → no verdict
});
