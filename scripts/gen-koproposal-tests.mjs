#!/usr/bin/env node
// ===========================================================================
// gen-koproposal-tests — regenerate contracts/KoProposal.test.json.
//
// WHY THIS EXISTS (i.e. why you cannot hand-edit the fixtures)
//   approve, reject and execute are signature-gated, so a fixture is only worth
//   something if it carries a REAL BIP340 signature over a REAL Kaspa sighash.
//   That sighash commits to the spent input's scriptPubKey — P2SH(compiled
//   KoProposal), and this contract bakes the whole proposal STATE into its
//   script, so the address is a function of both the source and the fixture's
//   own constructor args. The hand-written suite this replaces could not sign at
//   all: every approve test was a rejection that stopped at checkSig, and the
//   entrypoint had NO positive coverage whatsoever.
//
//   Therefore: whenever contracts/KoProposal.sil changes, run
//       npm run gen:koproposal-tests
//   and re-run `npm run test:contracts && npm run test:security`.
//
// THE COMPILATION CAVEAT (this bit is not optional)
//   silc and cli-debugger compile the SAME source to DIFFERENT bytes: the
//   debugger sets `record_debug_infos: true`, which skips `lower_local_aliases`.
//   Fixtures must be built from the DEBUGGER's compilation (examples/silc_dbg,
//   built by scripts/build-compiler.sh). See scripts/gen-koroot-tests.mjs.
//
// WHY SO FEW TESTS ARE NAMED "SECURITY"
//   scripts/test-security.sh strips the lineage guards and requires every
//   SECURITY-named test to flip to FAIL. A SIGNED fixture cannot do that
//   honestly: deleting any line moves the compiled script, hence the P2SH
//   address, hence the sighash — so the signature stops verifying and the test
//   "fails" for a reason that has nothing to do with the guard. Signed lineage
//   tests are therefore labelled [weak: …] and only closeExpired — the one
//   entrypoint that checks no signature — carries the SECURITY label.
//
// Usage:  node scripts/gen-koproposal-tests.mjs   (or: npm run gen:koproposal-tests)
// ===========================================================================
import { writeFileSync } from 'node:fs';
import * as L from './lib/covenant-fixtures.mjs';
const { B, I, hex, cat, rep, fromHex, compile, p2shScript, encodeProposalState,
        sighash, sign, ownerKey, fixtureArgs, blake2b256, REPO } = L;

const KOPROPOSAL = REPO + '/contracts/KoProposal.sil';
const OWN = [0, 1, 2, 3, 4, 5].map(ownerKey);
const PK = OWN.map((o) => o.pk);
const TREASURY_ID = rep(0xaa, 32);
const CID = rep(0xcc, 32);
const CID2 = rep(0xdd, 32);
const RECIPIENT = rep(0x07, 32);
// The debugger's synthetic tx carries lock_time 0, and `tx.time` reads that
// lock time — so `tx.time >= expiresAt` only holds for expiresAt 0 here. On the
// real network tx.time is a LOWER bound on the including block's time; see
// docs/RISKS.md for why >= is the only sound use of expiry on-chain.
const EXPIRED = 0;
const FUTURE = 9999999999;
// The bond-return commitment: closeExpired must pay P2SH(vaultSpkHash) the full
// bond. OP_TRUE stands in for the vault redeem — what matters is that the state
// commits to ITS hash, and output 0 pays exactly that P2SH.
const VAULT_REDEEM = fromHex('51');
const VAULT_SPK_HASH = blake2b256(VAULT_REDEEM);

const mask = (i) => { const m = new Uint8Array(8); m[0] = i >= 1 && i <= 4 ? 1 << i : 1; return m; };
const bits = (...idx) => { const m = new Uint8Array(8); for (const i of idx) m[0] |= i >= 1 && i <= 4 ? 1 << i : 1; return m; };

/** A pending 2-of-3 proposal carrying its proposer's approval — what KoRoot mints. */
const st = (over = {}) => ({
  proposalId: 1, operation: 1, recipientSpkHash: RECIPIENT, amount: 100000000, maxFee: 20000,
  expiresAt: FUTURE, executionDelay: 0, approvalBitmap: mask(0), approvalCount: 1, status: 0,
  snapThreshold: 2, ownerCount: 3,
  owner0: PK[0], owner1: PK[1], owner2: PK[2], owner3: PK[3], owner4: PK[4],
  rejectBitmap: new Uint8Array(8), rejectCount: 0, vaultSpkHash: VAULT_SPK_HASH, ...over,
});

const ctorOf = (s) => [
  B(TREASURY_ID), I(s.proposalId), I(s.operation), B(s.recipientSpkHash), I(s.amount), I(s.maxFee),
  I(s.expiresAt), I(s.executionDelay), B(s.approvalBitmap), I(s.approvalCount), I(s.status),
  I(s.snapThreshold), I(s.ownerCount), B(s.owner0), B(s.owner1), B(s.owner2), B(s.owner3), B(s.owner4),
  B(s.rejectBitmap), I(s.rejectCount), B(s.vaultSpkHash),
];
const LAYOUT = compile(KOPROPOSAL, ctorOf(st())).layout;
console.error(`KoProposal state layout: start=${LAYOUT.start} len=${LAYOUT.len}`);

const IN_VALUE = 100000;
const tests = [];

/**
 * inputs:  { kind: 'self' }                     — the proposal being spent
 *          { kind: 'raw', redeem, cid, value }  — a paired covenant input
 * outputs: { kind: 'cont', state }              — the proposal continuation
 *          { kind: 'raw', script, value, cid }
 */
function build({ name, fn, state, args, expect, inputs, outputs, signWith = null, sigArgIndex = 1 }) {
  const ctor = ctorOf(state);
  const script = compile(KOPROPOSAL, ctor).script;

  const txInputs = inputs.map((inp, idx) => {
    const utxoScript = inp.kind === 'self' ? p2shScript(script) : p2shScript(inp.redeem);
    const fx = { utxo_value: inp.value ?? IN_VALUE };
    if (inp.kind !== 'self') { fx.utxo_script_hex = hex(utxoScript); fx.signature_script_hex = hex(inp.redeem); }
    if (inp.cid) fx.covenant_id = '0x' + hex(inp.cid);
    return { fx, prevTxid: rep(idx, 32), prevIndex: 0, sequence: 0, utxoScript, value: fx.utxo_value };
  });

  const txOutputs = outputs.map((out) => {
    let s;
    if (out.kind === 'cont') {
      // Splice the new state into the compiled script, then PROVE the splice by
      // recompiling with that state as constructor args — a mismatch here means
      // the fixture would be asserting something the contract cannot produce.
      const spliced = cat(script.slice(0, LAYOUT.start), encodeProposalState(out.state), script.slice(LAYOUT.start + LAYOUT.len));
      const viaCompile = compile(KOPROPOSAL, ctorOf(out.state)).script;
      if (hex(spliced) !== hex(viaCompile)) throw new Error(`continuation splice mismatch in "${name}"`);
      s = p2shScript(spliced);
    } else {
      s = out.script;
    }
    const fx = { value: out.value, script_hex: hex(s) };
    if (out.cid) { fx.covenant_id = '0x' + hex(out.cid); fx.authorizing_input = out.authorizingInput ?? 0; }
    return { fx, script: s, value: out.value, covenantId: out.cid ?? null, authorizingInput: out.authorizingInput };
  });

  const finalArgs = args.slice();
  if (signWith !== null) {
    const h = sighash({ version: 1, lockTime: 0, inputs: txInputs, outputs: txOutputs }, 0);
    finalArgs[sigArgIndex] = '0x' + hex(sign(h, OWN[signWith].sk));
  }

  tests.push({
    name, function: fn, constructor_args: fixtureArgs(ctor), args: finalArgs, expect,
    tx: { active_input_index: 0, inputs: txInputs.map((i) => i.fx), outputs: txOutputs.map((o) => o.fx) },
  });
}

const DUMMY_SIG = '0x' + '11'.repeat(65);
const selfIn = (cid = CID) => ({ kind: 'self', cid, value: IN_VALUE });
const cont = (s, value = IN_VALUE - 20000, cid = CID) => ({ kind: 'cont', state: s, value, cid });
const junk = (value = 1000, cid = CID) => ({ kind: 'raw', script: p2shScript(fromHex('51')), value, cid });

// Signed fixtures cannot serve as differential controls — see the header.
const WEAK = ' [weak control: it fails at the right guard on the real contract, but cannot flip on a stripped mutant — deleting any line changes KoProposal’s redeem script and therefore its P2SH address, so the real signature this fixture carries stops verifying]';

// ==================================================================== approve ==
// The suite's positive coverage: before this file was generated there was none,
// because the debugger cannot auto-sign and every approve fixture was a rejection
// that stopped at checkSig.
// CONTINUATION STATE. validateOutputState pins all nineteen fields of the output a
// vote continues into, and until these fixtures existed only two of them had a test
// that bit: strip the pin and the suite went on passing. Every field below is one an
// approver could otherwise rewrite while casting an otherwise valid vote — the terms
// of the payment itself among them. The mutation harness regenerates signatures
// against the mutant (REGEN_STATE), so these fail for the missing pin and not for
// signature rot.
const contTamper = (label, over) => build({
  name: `approve REJECTS a continuation that ${label}`,
  fn: 'approve', state: st(), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ approvalBitmap: bits(0, 1), approvalCount: 2, status: 1, ...over }))],
});

contTamper('rewrites the payment amount (the vote would approve one sum and the vault release another)', { amount: 900000000 });
contTamper('rewrites the recipient the proposal committed to', { recipientSpkHash: rep(0x5a, 32) });
contTamper('raises the fee cap the proposal was approved under', { maxFee: 9000000 });
contTamper('changes the operation from TRANSFER to CONFIG', { operation: 2 });
contTamper('renumbers the proposal (a vote replayed onto another id)', { proposalId: 7 });
contTamper('pushes the expiry out', { expiresAt: FUTURE + 100000 });
contTamper('adds an execution delay the approvers never agreed to', { executionDelay: 86400 });
contTamper('lowers the snapshot threshold so fewer votes suffice', { snapThreshold: 1 });
contTamper('inflates the approval count past the bits actually set', { approvalCount: 3 });
// The input must actually CARRY the rejection this one erases, or the "tampered"
// continuation is simply the correct one and the fixture proves nothing.
build({
  name: 'approve REJECTS a continuation that erases a rejection already on the record',
  fn: 'approve', state: st({ rejectBitmap: mask(2), rejectCount: 1 }), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ approvalBitmap: bits(0, 1), approvalCount: 2, status: 1, rejectBitmap: new Uint8Array(8), rejectCount: 0 }))],
});

build({
  name: 'reject REJECTS a continuation that rewrites the payment amount',
  fn: 'reject', state: st(), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ rejectBitmap: mask(1), rejectCount: 1, amount: 900000000 }))],
});

build({
  name: 'reject REJECTS a continuation that rewrites the owner snapshot',
  fn: 'reject', state: st(), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ rejectBitmap: mask(1), rejectCount: 1, owner2: rep(0x5b, 32) }))],
});

build({
  name: 'reject REJECTS a continuation that quietly drops the approvals already cast',
  fn: 'reject', state: st(), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ rejectBitmap: mask(1), rejectCount: 1, approvalBitmap: new Uint8Array(8), approvalCount: 0 }))],
});

build({
  name: 'approve records owner 1’s approval and turns a 2-of-3 proposal Approved',
  fn: 'approve', state: st(), args: [1, DUMMY_SIG], expect: 'pass', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ approvalBitmap: bits(0, 1), approvalCount: 2, status: 1 }))],
});

build({
  name: 'approve leaves a 3-of-5 proposal Pending until the threshold is actually met',
  fn: 'approve', state: st({ snapThreshold: 3, ownerCount: 5 }), args: [1, DUMMY_SIG], expect: 'pass', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ snapThreshold: 3, ownerCount: 5, approvalBitmap: bits(0, 1), approvalCount: 2, status: 0 }))],
});

build({
  name: 'approve accepts spending exactly the proposal’s maxFee from its reserve',
  fn: 'approve', state: st(), args: [1, DUMMY_SIG], expect: 'pass', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ approvalBitmap: bits(0, 1), approvalCount: 2, status: 1 }), IN_VALUE - 20000)],
});

build({
  name: 'approve REJECTS draining the proposal reserve beyond its maxFee',
  fn: 'approve', state: st(), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ approvalBitmap: bits(0, 1), approvalCount: 2, status: 1 }), IN_VALUE - 20001)],
});

build({
  name: 'approve REJECTS ownerIndex out of range',
  fn: 'approve', state: st(), args: [3, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ approvalBitmap: bits(0, 1), approvalCount: 2, status: 1 }))],
});

build({
  name: 'approve REJECTS a negative ownerIndex (which would alias owner 0)',
  fn: 'approve', state: st(), args: [-1, DUMMY_SIG], expect: 'fail', signWith: 0,
  inputs: [selfIn()],
  outputs: [cont(st({ approvalBitmap: bits(0), approvalCount: 2, status: 1 }))],
});

build({
  name: 'approve REJECTS when not Pending',
  fn: 'approve', state: st({ status: 1 }), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ status: 1, approvalBitmap: bits(0, 1), approvalCount: 2 }))],
});

build({
  name: 'approve REJECTS duplicate approval (bit already set)',
  fn: 'approve', state: st(), args: [0, DUMMY_SIG], expect: 'fail', signWith: 0,
  inputs: [selfIn()],
  outputs: [cont(st({ approvalCount: 2, status: 1 }))],
});

build({
  name: 'approve REJECTS approving after rejecting (owners vote approve XOR reject)',
  fn: 'approve', state: st({ rejectBitmap: mask(1), rejectCount: 1 }), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ rejectBitmap: mask(1), rejectCount: 1, approvalBitmap: bits(0, 1), approvalCount: 2, status: 1 }))],
});

build({
  name: 'approve REJECTS owner 0’s signature presented as owner 1',
  fn: 'approve', state: st(), args: [1, DUMMY_SIG], expect: 'fail', signWith: 0,
  inputs: [selfIn()],
  outputs: [cont(st({ approvalBitmap: bits(0, 1), approvalCount: 2, status: 1 }))],
});

build({
  name: 'approve REJECTS a garbage signature',
  fn: 'approve', state: st(), args: [1, DUMMY_SIG], expect: 'fail', signWith: null,
  inputs: [selfIn()],
  outputs: [cont(st({ approvalBitmap: bits(0, 1), approvalCount: 2, status: 1 }))],
});

build({
  name: 'approve REJECTS a continuation that records the vote but leaves the proposal Pending (below-threshold status is not the signer’s to choose)',
  fn: 'approve', state: st(), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ approvalBitmap: bits(0, 1), approvalCount: 2, status: 0 }))],
});

build({
  name: 'approve REJECTS a continuation that rewrites the owner snapshot',
  fn: 'approve', state: st(), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ approvalBitmap: bits(0, 1), approvalCount: 2, status: 1, owner2: PK[5] }))],
});

// ------------------------------------------------- snapshot bounds (approve) --
// A covenant id does not prove KoRoot minted this UTXO: the genesis covenant
// group may bind an arbitrary number of outputs, so a treasury's creator can
// plant a template-shaped proposal carrying any snapThreshold/ownerCount. These
// bounds are what stop a snapshot naming the REAL owners from being SHAPED so
// their votes cannot work. Each fixture is signed by a genuine owner, so the
// bound — not checkSig — is what rejects it.
build({
  name: 'approve REJECTS a snapshot claiming ownerCount 99 (ownerAt/maskFor fall through to owner 0 past the last slot, and an inflated count makes `ownerCount - rejectCount < snapThreshold` unreachable — the proposal could never be Failed)',
  fn: 'approve', state: st({ ownerCount: 99 }), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ ownerCount: 99, approvalBitmap: bits(0, 1), approvalCount: 2, status: 1 }))],
});

build({
  name: 'approve REJECTS a snapshot with ownerCount 6 (one past the five slots the state carries)',
  fn: 'approve', state: st({ ownerCount: 6 }), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ ownerCount: 6, approvalBitmap: bits(0, 1), approvalCount: 2, status: 1 }))],
});

build({
  name: 'approve REJECTS a snapshot with ownerCount 0',
  fn: 'approve', state: st({ ownerCount: 0, snapThreshold: 1 }), args: [0, DUMMY_SIG], expect: 'fail', signWith: 0,
  inputs: [selfIn()],
  outputs: [cont(st({ ownerCount: 0, snapThreshold: 1, approvalBitmap: bits(0), approvalCount: 2, status: 1 }))],
});

build({
  name: 'approve REJECTS a snapshot with snapThreshold 0 — the first single vote would satisfy `newCount >= snapThreshold` no matter how many owners it names',
  fn: 'approve', state: st({ snapThreshold: 0 }), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ snapThreshold: 0, approvalBitmap: bits(0, 1), approvalCount: 2, status: 1 }))],
});

build({
  name: 'approve REJECTS a snapshot whose threshold exceeds its owner count (no complete owner set could reach it, and the reject arithmetic starts out of range)',
  fn: 'approve', state: st({ snapThreshold: 4 }), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ snapThreshold: 4, approvalBitmap: bits(0, 1), approvalCount: 2, status: 0 }))],
});

build({
  name: 'approve accepts the boundary snapshot 5-of-5 (the bounds are a range, not a narrowing — a full five-owner treasury still works)',
  fn: 'approve', state: st({ snapThreshold: 5, ownerCount: 5 }), args: [1, DUMMY_SIG], expect: 'pass', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ snapThreshold: 5, ownerCount: 5, approvalBitmap: bits(0, 1), approvalCount: 2, status: 0 }))],
});

build({
  name: 'approve accepts the boundary snapshot 1-of-1',
  fn: 'approve', state: st({ snapThreshold: 1, ownerCount: 1, approvalBitmap: new Uint8Array(8), approvalCount: 0 }),
  args: [0, DUMMY_SIG], expect: 'pass', signWith: 0,
  inputs: [selfIn()],
  outputs: [cont(st({ snapThreshold: 1, ownerCount: 1, approvalBitmap: mask(0), approvalCount: 1, status: 1 }))],
});

// ------------------------------------------------------ the tally invariant --
// The five numbers (ownerCount, snapThreshold, approvalCount, rejectCount,
// status) are this contract's whole decision surface, and a planted proposal
// carries whatever the planter wrote in all five. Bounding the first two left
// the tallies exactly as minted, so these fixtures pin the rest of the range an
// honest history can reach:
//     status 0 (Pending):   0 <= approvalCount < snapThreshold
//                           0 <= rejectCount  <= ownerCount - snapThreshold
//     status 1 (Approved):  snapThreshold <= approvalCount <= ownerCount
// Every rejection here is signed by a GENUINE owner, so the rule — not checkSig
// — is what rejects it, and every rule also gets the boundary case it must still
// ACCEPT, because a bound that strands an honest proposal is its own denial of
// service. (The names carry the word "tally": scripts/test-security.sh selects
// this family by name.)
build({
  name: 'approve accepts a zero tally (approvalCount 0 with no bits set — the lower bound is a bound, not a narrowing)',
  fn: 'approve', state: st({ snapThreshold: 3, ownerCount: 5, approvalBitmap: new Uint8Array(8), approvalCount: 0 }),
  args: [1, DUMMY_SIG], expect: 'pass', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ snapThreshold: 3, ownerCount: 5, approvalBitmap: mask(1), approvalCount: 1, status: 0 }))],
});

build({
  name: 'approve REJECTS a tally with approvalCount below zero (the threshold then needs more approvals than the snapshot names owners, so the proposal could never be Approved by them)',
  fn: 'approve', state: st({ approvalCount: -1 }), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ approvalBitmap: bits(0, 1), approvalCount: 0, status: 0 }))],
});

build({
  name: 'reject REJECTS a tally with rejectCount below zero — `ownerCount - rejectCount < snapThreshold` could then never trip, so a proposal naming the real owners could never be Failed by them',
  fn: 'reject', state: st({ rejectCount: -1 }), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ rejectBitmap: mask(1), rejectCount: 0, status: 0 }))],
});

build({
  name: 'approve accepts the last vote of a fully-voted 2-of-3, where the tallies together reach ownerCount exactly',
  fn: 'approve', state: st({ rejectBitmap: mask(2), rejectCount: 1 }), args: [1, DUMMY_SIG], expect: 'pass', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ rejectBitmap: mask(2), rejectCount: 1, approvalBitmap: bits(0, 1), approvalCount: 2, status: 1 }))],
});

build({
  name: 'approve REJECTS a Pending proposal whose tally has already reached the threshold (Approved is a state this contract writes, not a label the minter may withhold)',
  fn: 'approve', state: st({ approvalBitmap: bits(0, 2), approvalCount: 2, status: 0 }),
  args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ approvalBitmap: bits(0, 1, 2), approvalCount: 3, status: 1 }))],
});

build({
  name: 'reject REJECTS the same over-threshold Pending tally (both voting paths re-derive it)',
  fn: 'reject', state: st({ approvalBitmap: bits(0, 2), approvalCount: 2, status: 0 }),
  args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ approvalBitmap: bits(0, 2), approvalCount: 2, rejectBitmap: mask(1), rejectCount: 1, status: 0 }))],
});

build({
  name: 'reject accepts the last rejection a 3-of-5 can still take (its tally leaves ownerCount - rejectCount exactly on the threshold)',
  fn: 'reject', state: st({ snapThreshold: 3, ownerCount: 5, rejectBitmap: bits(3, 4), rejectCount: 2 }),
  args: [1, DUMMY_SIG], expect: 'pass', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ snapThreshold: 3, ownerCount: 5, rejectBitmap: bits(1, 3, 4), rejectCount: 3, status: 2 }))],
});

build({
  name: 'reject REJECTS a Pending tally with more rejections than a 3-of-5 could survive — the proposal it describes is one this contract would already have Failed',
  fn: 'reject', state: st({ snapThreshold: 3, ownerCount: 5, rejectBitmap: bits(2, 3, 4), rejectCount: 3 }),
  args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ snapThreshold: 3, ownerCount: 5, rejectBitmap: bits(1, 2, 3, 4), rejectCount: 4, status: 2 }))],
});

// ------------------------------------------------ lineage + pinning (approve) --
build({
  name: 'approve REJECTS an UNBOUND proposal input (ZERO covenant id would pair with a forged sibling)' + WEAK,
  fn: 'approve', state: st(), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [{ kind: 'self', value: IN_VALUE }],
  outputs: [cont(st({ approvalBitmap: bits(0, 1), approvalCount: 2, status: 1 }), IN_VALUE - 20000, null)],
});

build({
  name: 'approve REJECTS minting a second output under the same lineage' + WEAK,
  fn: 'approve', state: st(), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ approvalBitmap: bits(0, 1), approvalCount: 2, status: 1 })), junk()],
});

build({
  name: 'approve REJECTS continuing the lineage onto an output other than the proposal continuation' + WEAK,
  fn: 'approve', state: st(), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ approvalBitmap: bits(0, 1), approvalCount: 2, status: 1 }), IN_VALUE - 20000, null), junk()],
});

// ===================================================================== reject ==
build({
  name: 'reject records owner 1’s rejection; a 2-of-3 stays Pending while approval is still arithmetically possible',
  fn: 'reject', state: st(), args: [1, DUMMY_SIG], expect: 'pass', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ rejectBitmap: mask(1), rejectCount: 1, status: 0 }))],
});

build({
  name: 'reject Fails the proposal once rejections make the threshold unreachable',
  fn: 'reject', state: st({ rejectBitmap: mask(2), rejectCount: 1 }), args: [1, DUMMY_SIG], expect: 'pass', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ rejectBitmap: bits(1, 2), rejectCount: 2, status: 2 }))],
});

build({
  name: 'reject REJECTS duplicate rejection (bit already set)',
  fn: 'reject', state: st({ rejectBitmap: mask(1), rejectCount: 1 }), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ rejectBitmap: mask(1), rejectCount: 2, status: 2 }))],
});

build({
  name: 'reject REJECTS rejecting after approving (owner 0 already holds an approval bit)',
  fn: 'reject', state: st(), args: [0, DUMMY_SIG], expect: 'fail', signWith: 0,
  inputs: [selfIn()],
  outputs: [cont(st({ rejectBitmap: mask(0), rejectCount: 1, status: 0 }))],
});

build({
  name: 'reject REJECTS a snapshot claiming ownerCount 99 — the inflated count is exactly what would keep `ownerCount - rejectCount < snapThreshold` from ever tripping, so the bound is checked before any vote is counted',
  fn: 'reject', state: st({ ownerCount: 99 }), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ ownerCount: 99, rejectBitmap: mask(1), rejectCount: 1, status: 0 }))],
});

build({
  name: 'reject REJECTS a snapshot with snapThreshold 0',
  fn: 'reject', state: st({ snapThreshold: 0 }), args: [1, DUMMY_SIG], expect: 'fail', signWith: 1,
  inputs: [selfIn()],
  outputs: [cont(st({ snapThreshold: 0, rejectBitmap: mask(1), rejectCount: 1, status: 0 }))],
});

// ==================================================================== execute ==
// The proposal is consumed alongside its paired covenant input (the vault for a
// TRANSFER, the root for a CONFIG); the paired contract enforces the effect.
const PAIRED = { kind: 'raw', redeem: fromHex('51'), cid: CID, value: 5000000000 };

build({
  name: 'execute accepts an Approved proposal spent with its paired covenant input, authorised by a snapshot owner',
  fn: 'execute', state: st({ status: 1, approvalBitmap: bits(0, 1), approvalCount: 2 }),
  args: [1, 1, DUMMY_SIG], expect: 'pass', signWith: 1, sigArgIndex: 2,
  inputs: [selfIn(), PAIRED],
  outputs: [{ kind: 'raw', script: p2shScript(fromHex('51')), value: 4000000000, cid: CID, authorizingInput: 1 }],
});

// COVENANT MINTING. `pairedInputIndex` names the input this proposal is executed
// against, but nothing forced it to be a DIFFERENT input, and nothing said which
// output the one permitted continuation may be. Point it at the proposal itself,
// spend the proposal alone, and the single cid-bearing output is parented by this
// very input — so a lone owner mints an output of ANY shape under the treasury's
// lineage, including a forged Approved proposal naming himself for the whole
// balance. The vault then honours it: same lineage, matching template, status 1.
// Two rules close it, and both are needed. The proposal must parent nothing
// (OpAuthOutputCount == 0), so only the paired contract can carry the lineage
// forward under rules of its own; and the paired input must be a different input,
// so "mutual validation" names a second script that actually runs.
build({
  name: 'SECURITY execute REJECTS pairing a proposal with ITSELF to mint a lineage-bearing output (one owner would forge an Approved proposal for the whole treasury)',
  fn: 'execute', state: st({ status: 1, approvalBitmap: bits(0, 1), approvalCount: 2 }),
  args: [0, 1, DUMMY_SIG], expect: 'fail', signWith: 1, sigArgIndex: 2,
  inputs: [selfIn()],
  outputs: [{ kind: 'raw', script: p2shScript(fromHex('51')), value: 1000, cid: CID, authorizingInput: 0 }],
});

build({
  name: 'SECURITY execute REJECTS a continuation parented by the PROPOSAL rather than by the paired contract (same mint, with the paired input present as cover)',
  fn: 'execute', state: st({ status: 1, approvalBitmap: bits(0, 1), approvalCount: 2 }),
  args: [1, 1, DUMMY_SIG], expect: 'fail', signWith: 1, sigArgIndex: 2,
  inputs: [selfIn(), PAIRED],
  outputs: [{ kind: 'raw', script: p2shScript(fromHex('51')), value: 4000000000, cid: CID, authorizingInput: 0 }],
});

build({
  name: 'execute REJECTS a proposal that is not Approved',
  fn: 'execute', state: st({ status: 0 }), args: [1, 1, DUMMY_SIG], expect: 'fail', signWith: 1, sigArgIndex: 2,
  inputs: [selfIn(), PAIRED],
  outputs: [{ kind: 'raw', script: p2shScript(fromHex('51')), value: 4000000000, cid: CID, authorizingInput: 1 }],
});

build({
  name: 'execute REJECTS a paired input from a FOREIGN covenant lineage' + WEAK,
  fn: 'execute', state: st({ status: 1, approvalBitmap: bits(0, 1), approvalCount: 2 }),
  args: [1, 1, DUMMY_SIG], expect: 'fail', signWith: 1, sigArgIndex: 2,
  inputs: [selfIn(), { ...PAIRED, cid: CID2 }],
  outputs: [{ kind: 'raw', script: p2shScript(fromHex('51')), value: 4000000000, cid: CID, authorizingInput: 0 }],
});

build({
  name: 'execute REJECTS a snapshot claiming ownerCount 99 (checked before the owner index is resolved, so index 5+ never reaches owner 0’s key)',
  fn: 'execute', state: st({ status: 1, ownerCount: 99, approvalBitmap: bits(0, 1), approvalCount: 2 }),
  args: [1, 1, DUMMY_SIG], expect: 'fail', signWith: 1, sigArgIndex: 2,
  inputs: [selfIn(), PAIRED],
  outputs: [{ kind: 'raw', script: p2shScript(fromHex('51')), value: 4000000000, cid: CID, authorizingInput: 1 }],
});

build({
  name: 'execute REJECTS a snapshot with snapThreshold 0 (a status the proposal could have reached on one vote is not one the vault may act on)',
  fn: 'execute', state: st({ status: 1, snapThreshold: 0, approvalBitmap: bits(0, 1), approvalCount: 2 }),
  args: [1, 1, DUMMY_SIG], expect: 'fail', signWith: 1, sigArgIndex: 2,
  inputs: [selfIn(), PAIRED],
  outputs: [{ kind: 'raw', script: p2shScript(fromHex('51')), value: 4000000000, cid: CID, authorizingInput: 1 }],
});

build({
  name: 'execute accepts an Approved proposal whose tallies reach ownerCount exactly (2 approvals + 1 rejection of 3 owners)',
  fn: 'execute', state: st({ status: 1, approvalBitmap: bits(0, 1), approvalCount: 2, rejectBitmap: mask(2), rejectCount: 1 }),
  args: [1, 1, DUMMY_SIG], expect: 'pass', signWith: 1, sigArgIndex: 2,
  inputs: [selfIn(), PAIRED],
  outputs: [{ kind: 'raw', script: p2shScript(fromHex('51')), value: 4000000000, cid: CID, authorizingInput: 1 }],
});

build({
  name: 'execute REJECTS a tally larger than the owner count (approvalCount 1000 behind an empty bitmap — one owner, one vote, so the two tallies together can never exceed ownerCount)',
  fn: 'execute', state: st({ status: 1, approvalBitmap: new Uint8Array(8), approvalCount: 1000 }),
  args: [1, 1, DUMMY_SIG], expect: 'fail', signWith: 1, sigArgIndex: 2,
  inputs: [selfIn(), PAIRED],
  outputs: [{ kind: 'raw', script: p2shScript(fromHex('51')), value: 4000000000, cid: CID, authorizingInput: 1 }],
});

build({
  name: 'execute REJECTS tallies that together exceed the owner count (2 approvals + 2 rejections of 3 owners) even though each is individually plausible',
  fn: 'execute', state: st({ status: 1, approvalBitmap: bits(0, 1), approvalCount: 2, rejectBitmap: bits(2, 3), rejectCount: 2 }),
  args: [1, 1, DUMMY_SIG], expect: 'fail', signWith: 1, sigArgIndex: 2,
  inputs: [selfIn(), PAIRED],
  outputs: [{ kind: 'raw', script: p2shScript(fromHex('51')), value: 4000000000, cid: CID, authorizingInput: 1 }],
});

build({
  name: 'execute REJECTS an Approved proposal whose tally is below its own threshold (KoVault and KoRoot act on `status == 1` and re-derive nothing, so it must mean what it says here)',
  fn: 'execute', state: st({ status: 1, approvalBitmap: mask(0), approvalCount: 1 }),
  args: [1, 1, DUMMY_SIG], expect: 'fail', signWith: 1, sigArgIndex: 2,
  inputs: [selfIn(), PAIRED],
  outputs: [{ kind: 'raw', script: p2shScript(fromHex('51')), value: 4000000000, cid: CID, authorizingInput: 1 }],
});

build({
  name: 'execute REJECTS a non-owner’s signature',
  fn: 'execute', state: st({ status: 1, approvalBitmap: bits(0, 1), approvalCount: 2 }),
  args: [1, 1, DUMMY_SIG], expect: 'fail', signWith: 5, sigArgIndex: 2,
  inputs: [selfIn(), PAIRED],
  outputs: [{ kind: 'raw', script: p2shScript(fromHex('51')), value: 4000000000, cid: CID, authorizingInput: 1 }],
});

// =============================================================== closeExpired ==
// The only unsigned entrypoint, and therefore the only one whose tests are real
// differential controls. The bond returns to the VAULT now (RISKS #17): output 0
// must pay P2SH(state.vaultSpkHash) at least the full bond over the input SET —
// the closer gets nothing, and funds their fee from their own inputs. Every
// output below pays p2shScript(VAULT_REDEEM), whose hash IS the committed one.
const vaultOut = (value = IN_VALUE, cid = null) =>
  (cid ? { kind: 'raw', script: p2shScript(VAULT_REDEEM), value, cid } : { kind: 'raw', script: p2shScript(VAULT_REDEEM), value });

build({
  name: 'closeExpired retires an expired proposal — the WHOLE bond returns to the committed vault P2SH, unbound',
  fn: 'closeExpired', state: st({ expiresAt: EXPIRED }), args: [], expect: 'pass',
  inputs: [selfIn()],
  outputs: [vaultOut()],
});

build({
  name: 'closeExpired retires a proposal whose SNAPSHOT is malformed (ownerCount 99) — deliberately NOT bounds-checked here, because retiring the UTXO is the one thing still possible once the voting paths reject it',
  fn: 'closeExpired', state: st({ expiresAt: EXPIRED, ownerCount: 99, snapThreshold: 0 }), args: [], expect: 'pass',
  inputs: [selfIn()],
  outputs: [vaultOut()],
});

build({
  name: 'closeExpired REJECTS a proposal that has not expired yet',
  fn: 'closeExpired', state: st({ expiresAt: FUTURE }), args: [], expect: 'fail',
  inputs: [selfIn()],
  outputs: [vaultOut()],
});

build({
  name: 'closeExpired REJECTS an already-closed proposal (status 3)',
  fn: 'closeExpired', state: st({ expiresAt: EXPIRED, status: 3 }), args: [], expect: 'fail',
  inputs: [selfIn()],
  outputs: [vaultOut()],
});

build({
  name: 'SECURITY closeExpired REJECTS continuing the lineage onto the bond output (minting oracle) — destination and value are otherwise honest, so only the zero-continuation pin refuses this',
  fn: 'closeExpired', state: st({ expiresAt: EXPIRED }), args: [], expect: 'fail',
  inputs: [selfIn()],
  outputs: [vaultOut(IN_VALUE, CID)],
});

build({
  name: 'SECURITY closeExpired REJECTS retiring the proposal while ANY output inherits the id, even alongside an honest unbound bond return',
  fn: 'closeExpired', state: st({ expiresAt: EXPIRED }), args: [], expect: 'fail',
  inputs: [selfIn()],
  outputs: [vaultOut(), junk(1000)],
});

build({
  name: 'SECURITY closeExpired REJECTS paying the bond anywhere but the committed vault P2SH — the closer bounty this replaces (expiry honest, value whole, lineage retired: only the destination rule refuses it)',
  fn: 'closeExpired', state: st({ expiresAt: EXPIRED }), args: [], expect: 'fail',
  inputs: [selfIn()],
  outputs: [{ kind: 'raw', script: p2shScript(fromHex('52')), value: IN_VALUE }],
});

build({
  name: 'closeExpired REJECTS returning the bond a thousand sompi short of the input set — the skim the closer bounty would become (right address, wrong value: only the value floor refuses it)',
  fn: 'closeExpired', state: st({ expiresAt: EXPIRED }), args: [], expect: 'fail',
  inputs: [selfIn()],
  outputs: [vaultOut(IN_VALUE - 1000)],
});

writeFileSync(REPO + '/contracts/KoProposal.test.json', JSON.stringify({ tests }, null, 2) + '\n');
console.error(`wrote ${tests.length} tests -> contracts/KoProposal.test.json`);
