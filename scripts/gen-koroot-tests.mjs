#!/usr/bin/env node
// ===========================================================================
// gen-koroot-tests — regenerate contracts/KoRoot.test.json.
//
// WHY THIS EXISTS (i.e. why you cannot hand-edit the fixtures)
//   KoRoot's createProposal is signature-gated, so its tests are only worth
//   anything if they carry a REAL BIP340 signature over a REAL Kaspa sighash.
//   That sighash commits to the spent input's scriptPubKey — which, for a
//   covenant UTXO, is P2SH(compiled KoRoot script). So the signature is a
//   function of the COMPILED CONTRACT: change one line of KoRoot.sil (add a
//   require, reword a constant, anything that moves a byte) and every positive
//   fixture stops verifying at checkSig, with an error that looks like a
//   contract bug and is really a stale fixture.
//
//   Therefore: whenever contracts/KoRoot.sil changes, run
//       npm run gen:koroot-tests
//   and re-run `npm run test:contracts && npm run test:security`. Editing the
//   JSON by hand can only produce fixtures that fail for the wrong reason.
//
// THE COMPILATION CAVEAT (this bit is not optional)
//   silc and cli-debugger compile the SAME source to DIFFERENT bytes. The
//   debugger sets `record_debug_infos: true`, which skips the
//   `lower_local_aliases` pass, so it runs a longer script with a different
//   blake2b hash — and therefore a different P2SH address and a different
//   sighash. Fixtures must be built from the DEBUGGER's compilation, or every
//   signature is over an address the debugger never presents.
//   That is what .tooling/…/examples/silc_dbg is for (written and built by
//   scripts/build-compiler.sh). scripts/compile.sh's plain `silc` is the
//   PRODUCTION compilation and must NOT be used here.
//
// WHAT IT WRITES
//   contracts/KoRoot.test.json — createProposal (happy paths, argument and
//   continuation rejections, lineage/output-pinning controls, genesis-bounds
//   rejections) and executeConfig (owner-set rotation + its SECURITY lineage
//   tests). Test names are the documentation; keep them true to the guard the
//   test actually trips. To confirm which guard a rejection trips, flip its
//   `expect` to 'pass' and read the `--> line:col` the debugger reports.
//
// Usage:  node scripts/gen-koroot-tests.mjs        (or: npm run gen:koroot-tests)
// ===========================================================================
import { writeFileSync } from 'node:fs';
import * as L from './lib/covenant-fixtures.mjs';
const { B, I, hex, cat, rep, fromHex, compile, p2shScript, blake2b256, encInt, encB32,
        encodeProposalState, sighash, sign, ownerKey, fixtureArgs, i64: B8, REPO } = L;

// ---------------------------------------------------------------- template --
// The KoProposal template KoRoot mints into: derived from the REAL compiled
// KoProposal contract, exactly as packages/descriptor/deriveTemplate does.
const KP_CTOR = [
  B(rep(0xaa, 32)), I(1), I(1), B(rep(0x07, 32)), I(100000000), I(20000), I(9999999999), I(3600),
  B(new Uint8Array(8)), I(1), I(0), I(2), I(3),
  B(rep(0x01, 32)), B(rep(0x02, 32)), B(rep(0x03, 32)), B(rep(0x04, 32)), B(rep(0x05, 32)),
  B(new Uint8Array(8)), I(0), B(new Uint8Array(32)), // initVaultSpkHash (state-only placeholder)
];
const KP = compile(REPO + '/contracts/KoProposal.sil', KP_CTOR);
const TPL_PREFIX = KP.script.slice(0, KP.layout.start);
const TPL_SUFFIX = KP.script.slice(KP.layout.start + KP.layout.len);
const TPL_HASH   = blake2b256(cat(TPL_PREFIX, TPL_SUFFIX));
console.error(`KoProposal template: prefixLen=${TPL_PREFIX.length} suffixLen=${TPL_SUFFIX.length} stateLen=${KP.layout.len}`);

const OWN = [0, 1, 2, 3, 4, 5].map(ownerKey);
const PK = OWN.map((o) => o.pk);
// The NUMS point every real treasury pads its unused owner slots with
// (scripts/gen-templates.ts). One shared key across
// the whole tail, which is why distinctness may only be checked BELOW ownerCount.
const NUMS = fromHex('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');
const pad = (...live) => [...live, ...Array(5 - live.length).fill(NUMS)];
const TREASURY_ID = rep(0xaa, 32);
const CID  = rep(0xcc, 32);
const CID2 = rep(0xdd, 32);
const MAX_PROPOSAL_FEE = 50000;
const RECIPIENT = rep(0x07, 32);

// The vault template KoRoot is entitled to mint. Compiled with a PLACEHOLDER
// lineage — only the prefix/suffix around the state slot are hashed, and those are
// invariant, which is exactly why bootstrapVault can stamp the real id in later.
const VAULT_CTOR = [
  B(new Uint8Array(32)), I(TPL_PREFIX.length), I(TPL_SUFFIX.length), B(TPL_HASH),
  I(10000000), I(16), I(10000000),
];
const KV = compile(REPO + '/contracts/KoVault.sil', VAULT_CTOR);
const VAULT_PREFIX = KV.script.slice(0, KV.layout.start);
const VAULT_SUFFIX = KV.script.slice(KV.layout.start + KV.layout.len);
const VAULT_TPL_HASH = blake2b256(cat(VAULT_PREFIX, VAULT_SUFFIX));
console.error(`KoVault template: prefixLen=${VAULT_PREFIX.length} suffixLen=${VAULT_SUFFIX.length} stateLen=${KV.layout.len}`);

const rootCtor = ({ nonce, threshold, ownerCount, owners = PK.slice(0, 5) }) => [
  B(TREASURY_ID), B(TPL_PREFIX), B(TPL_SUFFIX), B(TPL_HASH),
  I(TPL_PREFIX.length), I(TPL_SUFFIX.length), B(VAULT_TPL_HASH), I(MAX_PROPOSAL_FEE),
  I(nonce), I(threshold), I(ownerCount), ...owners.map(B),
];
const KOROOT = REPO + '/contracts/KoRoot.sil';
const compileRoot = (cfg) => compile(KOROOT, rootCtor(cfg));
const ROOT_LAYOUT = compileRoot({ nonce: 0, threshold: 2, ownerCount: 3 }).layout;
console.error(`KoRoot state layout: start=${ROOT_LAYOUT.start} len=${ROOT_LAYOUT.len}`);

const encodeRootState = (s) => cat(encInt(s.proposalNonce), encInt(s.threshold), encInt(s.ownerCount),
  encB32(s.owner0), encB32(s.owner1), encB32(s.owner2), encB32(s.owner3), encB32(s.owner4));
const rootStateJson = (s) => ({
  proposalNonce: s.proposalNonce, threshold: s.threshold, ownerCount: s.ownerCount,
  owner0: '0x' + hex(s.owner0), owner1: '0x' + hex(s.owner1), owner2: '0x' + hex(s.owner2),
  owner3: '0x' + hex(s.owner3), owner4: '0x' + hex(s.owner4),
});
const rootState = ({ nonce, threshold, ownerCount, owners = PK.slice(0, 5) }) => ({
  proposalNonce: nonce, threshold, ownerCount,
  owner0: owners[0], owner1: owners[1], owner2: owners[2], owner3: owners[3], owner4: owners[4],
});

const proposalRedeem = (st) => cat(TPL_PREFIX, encodeProposalState(st), TPL_SUFFIX);

const mask = (i) => { const m = new Uint8Array(8); m[0] = i >= 1 && i <= 4 ? 1 << i : 1; return m; };

// ------------------------------------------------------------------ builder --
const tests = [];
function build({ name, fn, cfg, args, expect, inputs, outputs, signWith = null, sigArgIndex = 1, active = 0 }) {
  const ctor = rootCtor(cfg);
  const rootScript = compile(KOROOT, ctor).script;

  const txInputs = inputs.map((inp, idx) => {
    let utxoScript, fx = { utxo_value: inp.value };
    if (inp.kind === 'root') {
      utxoScript = p2shScript(rootScript);
    } else {
      utxoScript = p2shScript(inp.redeem);
      fx.utxo_script_hex = hex(utxoScript);
      fx.signature_script_hex = hex(inp.sigScript ?? inp.redeem);
    }
    if (inp.cid) fx.covenant_id = '0x' + hex(inp.cid);
    return { fx, prevTxid: rep(idx, 32), prevIndex: 0, sequence: 0, utxoScript, value: inp.value };
  });

  const txOutputs = outputs.map((out) => {
    let script, fx = { value: out.value };
    if (out.kind === 'root') {
      const expected = cat(rootScript.slice(0, ROOT_LAYOUT.start), encodeRootState(out.state),
                           rootScript.slice(ROOT_LAYOUT.start + ROOT_LAYOUT.len));
      const viaCompile = compileRoot(out.cfg).script;
      if (hex(expected) !== hex(viaCompile)) throw new Error(`root output state splice mismatch in "${name}"`);
      script = p2shScript(expected);
      fx.state = rootStateJson(out.state);
    } else if (out.kind === 'proposal') {
      script = p2shScript(proposalRedeem(out.state));
      fx.script_hex = hex(script);
    } else {
      script = out.script;
      fx.script_hex = hex(script);
    }
    if (out.cid) { fx.covenant_id = '0x' + hex(out.cid); if (out.authorizingInput !== undefined) fx.authorizing_input = out.authorizingInput; }
    return { fx, script, value: out.value, covenantId: out.cid ?? null, authorizingInput: out.authorizingInput };
  });

  const finalArgs = args.slice();
  if (signWith !== null) {
    // The sighash commits to the ACTIVE input's outpoint, spk and value, so a
    // fixture that runs a second copy of the script (active > 0) must be signed
    // over THAT input or it fails at checkSig for a reason the test is not about.
    const h = sighash({ version: 1, lockTime: 0, inputs: txInputs, outputs: txOutputs }, active);
    finalArgs[sigArgIndex] = '0x' + hex(sign(h, OWN[signWith].sk));
  }

  tests.push({
    name, function: fn, constructor_args: fixtureArgs(ctor), args: finalArgs, expect,
    tx: { active_input_index: active, inputs: txInputs.map((i) => i.fx), outputs: txOutputs.map((o) => o.fx) },
  });
}

// ============================================================ createProposal ==
const DUMMY_SIG = '0x' + '11'.repeat(65);
const cpArgs = (i, { operation = 1, amount = 100000000, maxFee = 20000, expiresAt = 9999999999, executionDelay = 3600,
                     vPrefix = VAULT_PREFIX, vSuffix = VAULT_SUFFIX } = {}) =>
  [i, DUMMY_SIG, operation, '0x' + hex(RECIPIENT), amount, maxFee, expiresAt, executionDelay,
   '0x' + hex(vPrefix), '0x' + hex(vSuffix)];

// The bond-return commitment createProposal writes into the minted state:
// blake2b(vaultPrefix ‖ 0x20 ‖ cid ‖ vaultSuffix) — the vault P2SH hash this
// lineage derives. Must match what the contract recomputes from the reveal.
const vaultSpkHashFor = (lineage = CID) =>
  blake2b256(cat(VAULT_PREFIX, Uint8Array.from([0x20]), lineage, VAULT_SUFFIX));

const propState = ({ id = 1, operation = 1, amount = 100000000, maxFee = 20000, expiresAt = 9999999999,
                     executionDelay = 3600, bitmap, approvalCount = 1, status = 0, snapThreshold,
                     ownerCount, owners = PK.slice(0, 5), rejectBitmap = new Uint8Array(8), rejectCount = 0,
                     vaultSpkHash = vaultSpkHashFor() }) => ({
  proposalId: id, operation, recipientSpkHash: RECIPIENT, amount, maxFee, expiresAt, executionDelay,
  approvalBitmap: bitmap, approvalCount, status, snapThreshold, ownerCount,
  owner0: owners[0], owner1: owners[1], owner2: owners[2], owner3: owners[3], owner4: owners[4],
  rejectBitmap, rejectCount, vaultSpkHash,
});

// standard 2-of-3 treasury, nonce 0 -> 1
const CFG3 = { nonce: 0, threshold: 2, ownerCount: 3 };
const rootIn = (cid = CID, value = 100000) => ({ kind: 'root', value, cid });
const rootOut = (cfg, value = 90000, cid = CID) => ({ kind: 'root', value, cid, cfg, state: rootState(cfg) });
const propOut = (st, value = 5000, cid = CID) => ({ kind: 'proposal', value, cid, state: st });

build({
  name: 'createProposal mints a proposal and bumps the nonce (owner 0 of a 2-of-3 treasury)',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'pass', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }))],
});

build({
  name: 'createProposal by owner 2 sets owner 2’s approval bit',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(2), expect: 'pass', signWith: 2,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }), propOut(propState({ bitmap: mask(2), snapThreshold: 2, ownerCount: 3 }))],
});

const CFG11 = { nonce: 7, threshold: 1, ownerCount: 1 };
build({
  name: 'createProposal on a 1-of-1 treasury mints an already-Approved proposal',
  fn: 'createProposal', cfg: CFG11, args: cpArgs(0), expect: 'pass', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG11, nonce: 8 }), propOut(propState({ id: 8, bitmap: mask(0), status: 1, snapThreshold: 1, ownerCount: 1 }))],
});

build({
  name: 'createProposal REJECTS proposerIndex == ownerCount (out of range)',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(3), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }))],
});

build({
  name: 'createProposal REJECTS a negative proposerIndex (which would alias owner 0)',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(-1), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }))],
});

build({
  name: 'createProposal REJECTS owner 0’s signature presented as owner 1',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(1), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }), propOut(propState({ bitmap: mask(1), snapThreshold: 2, ownerCount: 3 }))],
});

build({
  name: 'createProposal REJECTS a garbage signature',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'fail', signWith: null,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }))],
});

build({
  name: 'createProposal REJECTS amount 0',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0, { amount: 0 }), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }), propOut(propState({ amount: 0, bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }))],
});

build({
  name: 'createProposal REJECTS maxFee above maxProposalFee',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0, { maxFee: MAX_PROPOSAL_FEE + 1 }), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }), propOut(propState({ maxFee: MAX_PROPOSAL_FEE + 1, bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }))],
});

build({
  name: 'SECURITY createProposal REJECTS a vault template that does not hash to the pinned vaultTemplateHash — an attacker-chosen template would let the minted proposal commit its bond return to an attacker-chosen address',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0, { vSuffix: cat(VAULT_SUFFIX, Uint8Array.from([0x51])) }), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }))],
});

build({
  name: 'SECURITY createProposal REJECTS minting a proposal whose vaultSpkHash is not the one this lineage derives — the bond can be root-reserve-funded, so a proposer-chosen return address drains the reserve 0.5 KAS a proposal',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3, vaultSpkHash: rep(0xee, 32) }))],
});

build({
  name: 'createProposal REJECTS an unknown operation code',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0, { operation: 3 }), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }), propOut(propState({ operation: 3, bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }))],
});

build({
  name: 'createProposal REJECTS a root continuation that does not bump the nonce (proposal id replay)',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 0 }), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }))],
});

build({
  name: 'createProposal REJECTS a root continuation that rewrites the owner set',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [
    rootOut({ ...CFG3, nonce: 1, owners: [PK[0], PK[5], PK[2], PK[3], PK[4]] }),
    propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 })),
  ],
});

build({
  name: 'createProposal REJECTS a minted proposal whose snapshot threshold is lowered',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }), propOut(propState({ bitmap: mask(0), snapThreshold: 1, ownerCount: 3 }))],
});

build({
  name: 'createProposal REJECTS a minted proposal that starts with two approvals',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }), propOut(propState({ bitmap: fromHex('0300000000000000'), approvalCount: 2, snapThreshold: 2, ownerCount: 3 }))],
});

build({
  name: 'createProposal REJECTS a minted proposal that starts Approved on a 2-of-3 treasury',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }), propOut(propState({ bitmap: mask(0), status: 1, snapThreshold: 2, ownerCount: 3 }))],
});

build({
  name: 'createProposal REJECTS a minted proposal that pre-loads a rejection bit',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3, rejectBitmap: mask(1), rejectCount: 1 }))],
});

const WEAK = ' [weak control: it fails at the right guard on the real contract, but cannot flip on a stripped mutant — deleting any line changes KoRoot’s redeem script and therefore its P2SH address, so the real signature this fixture carries stops verifying]';

build({
  name: 'createProposal REJECTS an UNBOUND root input (zero covenant id)' + WEAK,
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [{ kind: 'root', value: 100000 }],
  outputs: [rootOut({ ...CFG3, nonce: 1 }, 90000, null), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }), 5000, null)],
});

build({
  name: 'createProposal REJECTS minting a THIRD output under the treasury lineage (forged sibling)' + WEAK,
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [
    rootOut({ ...CFG3, nonce: 1 }),
    propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 })),
    { kind: 'raw', value: 1000, cid: CID, script: p2shScript(fromHex('51')) },
  ],
});

build({
  name: 'createProposal REJECTS letting a forged sibling — not the minted proposal — inherit the lineage' + WEAK,
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [
    rootOut({ ...CFG3, nonce: 1 }),
    propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }), 5000, null),
    { kind: 'raw', value: 1000, cid: CID, script: p2shScript(fromHex('51')) },
  ],
});

build({
  name: 'createProposal REJECTS dropping the covenant binding from the root continuation' + WEAK,
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }, 90000, null), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }))],
});

// ================================================== genesis-bounds rejections ==
// A treasury minted outside the UI can carry ANY threshold/ownerCount: they are
// constructor arguments and the constructor checks nothing. createProposal is
// the only path that can create a proposal, so the 1..5 / 1..ownerCount bounds
// are enforced there — a malformed genesis is unusable rather than dangerous.
// These four tests pin that. Each one previously documented the hole (the first
// two were `expect: 'pass'` probes); they now pin the fix.
const CFG6 = { nonce: 0, threshold: 2, ownerCount: 6 };

build({
  name: 'createProposal REJECTS a genesis treasury with ownerCount 6 (the constructor’s bounds are enforced here — index 5 would otherwise fall through to owner 0’s key AND owner 0’s bitmap bit)',
  fn: 'createProposal', cfg: CFG6, args: cpArgs(5), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG6, nonce: 1 }), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 6 }))],
});

build({
  name: 'createProposal REJECTS an ownerCount-6 genesis treasury before it authenticates anyone (owner 1’s signature at index 5 trips the same bound, not checkSig)',
  fn: 'createProposal', cfg: CFG6, args: cpArgs(5), expect: 'fail', signWith: 1,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG6, nonce: 1 }), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 6 }))],
});

build({
  name: 'createProposal REJECTS an ownerCount-6 genesis treasury even when the mint claims a sixth bitmap bit (there is no sixth bit; the bound trips first)',
  fn: 'createProposal', cfg: CFG6, args: cpArgs(5), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG6, nonce: 1 }), propOut(propState({ bitmap: fromHex('2000000000000000'), snapThreshold: 2, ownerCount: 6 }))],
});

build({
  name: 'createProposal REJECTS proposerIndex 5 on a well-formed 5-owner treasury (proposerIndex < ownerCount; the ownerCount-6 genesis that used to reach ownerAt’s fall-through is now rejected outright)',
  fn: 'createProposal', cfg: { nonce: 0, threshold: 2, ownerCount: 5 }, args: cpArgs(5), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ nonce: 1, threshold: 2, ownerCount: 5 }), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 5 }))],
});

const CFG_T0 = { nonce: 0, threshold: 0, ownerCount: 3 };
build({
  name: 'createProposal REJECTS a genesis treasury with threshold 0 (the constructor’s bounds are enforced here — `threshold <= 1` would otherwise mint every proposal already Approved, one key moving funds under a nominal M-of-N)',
  fn: 'createProposal', cfg: CFG_T0, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG_T0, nonce: 1 }), propOut(propState({ bitmap: mask(0), status: 1, snapThreshold: 0, ownerCount: 3 }))],
});

build({
  name: 'createProposal REJECTS an ownerCount-0 genesis treasury (bricked at require(ownerCount >= 1), before proposerIndex is even range-checked)',
  fn: 'createProposal', cfg: { nonce: 0, threshold: 1, ownerCount: 0 }, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ nonce: 1, threshold: 1, ownerCount: 0 }), propOut(propState({ bitmap: mask(0), status: 1, snapThreshold: 1, ownerCount: 0 }))],
});

// ============================================ genesis owner distinctness ==
// Identity is the SLOT, not the key: ownerAt(i) reads slot i and maskFor(i)
// returns bit i, and the duplicate-approval guard compares BITS. A key holding
// several live slots therefore votes once per slot — [A, A, C] at threshold 2 is
// a 1-of-2 treasury wearing a 2-of-3 label. Enforced on the only path that can
// create a proposal, so such a genesis is unusable rather than dangerous.
// Slots at or above ownerCount hold the shared NUMS pad and are NOT compared;
// the two positive fixtures below are what stop that rule from being tightened
// into one that rejects every treasury of fewer than five owners.
const CFG_DUP01 = { nonce: 0, threshold: 2, ownerCount: 3, owners: [PK[0], PK[0], PK[2], PK[3], PK[4]] };
build({
  name: 'createProposal REJECTS a genesis treasury whose owner slots 0 and 1 hold the SAME key (one key, two approval bits — a 1-of-2 treasury labelled 2-of-3)',
  fn: 'createProposal', cfg: CFG_DUP01, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG_DUP01, nonce: 1 }),
            propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3, owners: CFG_DUP01.owners }))],
});

const CFG_DUP02 = { nonce: 0, threshold: 2, ownerCount: 3, owners: [PK[0], PK[1], PK[0], PK[3], PK[4]] };
build({
  name: 'createProposal REJECTS a duplicate in a NON-ADJACENT live pair (slots 0 and 2 — every pair below ownerCount is compared, not just neighbours)',
  fn: 'createProposal', cfg: CFG_DUP02, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG_DUP02, nonce: 1 }),
            propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3, owners: CFG_DUP02.owners }))],
});

const CFG_DUP34 = { nonce: 0, threshold: 3, ownerCount: 5, owners: [PK[0], PK[1], PK[2], PK[3], PK[3]] };
build({
  name: 'createProposal REJECTS a duplicate in the LAST live pair of a full 5-owner treasury (slots 3 and 4)',
  fn: 'createProposal', cfg: CFG_DUP34, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG_DUP34, nonce: 1 }),
            propOut(propState({ bitmap: mask(0), snapThreshold: 3, ownerCount: 5, owners: CFG_DUP34.owners }))],
});

const CFG_PAD2 = { nonce: 0, threshold: 2, ownerCount: 2, owners: pad(PK[0], PK[1]) };
build({
  name: 'createProposal ACCEPTS the NUMS-padded tail of a 2-of-2 treasury (slots 2..4 share one key by construction, and are never compared)',
  fn: 'createProposal', cfg: CFG_PAD2, args: cpArgs(0), expect: 'pass', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG_PAD2, nonce: 1 }),
            propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 2, owners: CFG_PAD2.owners }))],
});

const CFG_DUPDEAD = { nonce: 0, threshold: 2, ownerCount: 2, owners: [PK[0], PK[1], PK[0], PK[0], PK[0]] };
build({
  name: 'createProposal ACCEPTS a duplicate BEYOND ownerCount (slots 2..4 repeat owner 0’s key, but proposerIndex < ownerCount can never select them, so they carry no bit and no vote)',
  fn: 'createProposal', cfg: CFG_DUPDEAD, args: cpArgs(0), expect: 'pass', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG_DUPDEAD, nonce: 1 }),
            propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 2, owners: CFG_DUPDEAD.owners }))],
});

// =============================================== createProposal value floor ==
// Output PINNING fixes WHICH outputs inherit the treasury id; it says nothing
// about what they are worth, and constrains nothing outside the lineage. So the
// root continuation and the minted proposal must together retain the input value
// less the fee cap. Nothing is stolen without it — but KIP-9 storage mass grows
// as output values shrink, so a dust root plus a dust proposal is one owner
// pricing the treasury out of being used.
build({
  name: 'createProposal REJECTS shrinking the root continuation and the minted proposal to dust and paying the reserve elsewhere (KIP-9 storage mass makes every later covenant op expensive — a single owner could price the treasury out of use)',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }, 1000), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }), 1000)],
});

build({
  name: 'createProposal REJECTS a dust root continuation even when the minted proposal keeps its value (the floor is over the PAIR, so neither can be starved alone)',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }, 1000), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }), 40000)],
});

build({
  name: 'createProposal accepts spending exactly maxProposalFee across the two id-bearing outputs (the floor is a cap on leakage, not a demand that value be preserved)',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'pass', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }, 45000), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }), 5000)],
});

build({
  name: 'createProposal REJECTS spending one sompi more than maxProposalFee across the two id-bearing outputs',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }, 44999), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }), 5000)],
});

// ------------------------------------------- the floor is over the input SET --
// Each root UTXO spent here runs its OWN copy of this script, and every copy is
// satisfied by the SAME two id-bearing outputs — so a floor written against
// `this` input's value alone protects one root while the rest walk out to an
// ordinary output. These fixtures are that rule: with two bound roots in, the
// pair of outputs must cover BOTH, no matter which copy is running, and the
// scan window is a hard transaction-width requirement rather than a truncation.
// (An honest treasury has one root UTXO; two can only arise from a forked
// lineage, which the output pinning above is what prevents. The floor is what
// makes such a fork harmless if one ever exists.)
const TWO_ROOTS = [rootIn(), rootIn()];
const FILLER = { kind: 'raw', value: 1000, redeem: fromHex('51') };
const fillers = (n) => Array.from({ length: n }, () => FILLER);

build({
  name: 'createProposal accepts TWO bound root UTXOs when the id-bearing outputs cover the whole set (the rule permits a legitimate multi-UTXO spend rather than banning it)',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'pass', signWith: 0,
  inputs: TWO_ROOTS,
  outputs: [rootOut({ ...CFG3, nonce: 1 }, 145000), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }), 5000)],
});

build({
  name: 'createProposal REJECTS outputs that cover only ONE of two bound root UTXOs — a per-input floor would have let the second root’s whole reserve walk out on one honest proposal',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: TWO_ROOTS,
  outputs: [rootOut({ ...CFG3, nonce: 1 }, 45000), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }), 5000)],
});

build({
  name: 'createProposal REJECTS the same one-of-two spend from the SECOND root input’s point of view too (every copy of the script must agree)',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'fail', signWith: 0, active: 1,
  inputs: TWO_ROOTS,
  outputs: [rootOut({ ...CFG3, nonce: 1 }, 45000), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }), 5000)],
});

build({
  name: 'createProposal REJECTS a 17-input spend that parks a second root UTXO past the scan window (the loop’s own bound rejects the transaction outright, so the sum can never be incomplete)',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn(), ...fillers(15), rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }, 45000), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }), 5000)],
});

build({
  name: 'createProposal accepts a 16-input spend (one under the scan window — the ceiling the proposer’s own fee UTXOs now share with the root)',
  fn: 'createProposal', cfg: CFG3, args: cpArgs(0), expect: 'pass', signWith: 0,
  inputs: [rootIn(), ...fillers(15)],
  outputs: [rootOut({ ...CFG3, nonce: 1 }, 45000), propOut(propState({ bitmap: mask(0), snapThreshold: 2, ownerCount: 3 }), 5000)],
});

// ============================================================ bootstrapVault ==
// The vault cannot exist at genesis: a covenant id hashes the scriptPubKeys of its
// own genesis group, so a vault carrying the id would have to contain a hash of
// itself. Genesis binds the ROOT alone; this entrypoint then mints the vault as a
// CONTINUATION of the root's id, stamping that id into the vault's state. The
// address the vault lands on is therefore one only this treasury can spend from,
// which is what makes paying into it safe.
const vaultRedeem = (lineage) => cat(VAULT_PREFIX, Uint8Array.from([0x20]), lineage, VAULT_SUFFIX);
const vaultOut = (lineage = CID, value = 50000, cid = CID, authorizingInput = 0) =>
  ({ kind: 'raw', script: p2shScript(vaultRedeem(lineage)), value, cid, authorizingInput });
const bvArgs = (i) => [i, DUMMY_SIG, '0x' + hex(VAULT_PREFIX), '0x' + hex(VAULT_SUFFIX)];
// the root continues UNCHANGED — bootstrapping is not a config change
const CFG_SAME = CFG3;

build({
  name: 'bootstrapVault mints the vault stamped with the root’s own lineage, leaving the root state untouched',
  fn: 'bootstrapVault', cfg: CFG3, args: bvArgs(0), expect: 'pass', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut(CFG_SAME), vaultOut()],
});

build({
  name: 'SECURITY bootstrapVault REJECTS stamping the vault with a lineage that is not this root’s (the stamp IS the treasury; a vault built around any other id belongs to whoever chose it)',
  fn: 'bootstrapVault', cfg: CFG3, args: bvArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut(CFG_SAME), vaultOut(CID2)],
});

build({
  name: 'SECURITY bootstrapVault REJECTS a template that is not the vault (the spender supplies the bytes, so only the baked hash keeps them honest — otherwise the root mints an arbitrary script into its own lineage)',
  fn: 'bootstrapVault', cfg: CFG3, args: [0, DUMMY_SIG, '0x' + hex(VAULT_PREFIX), '0x' + hex(VAULT_SUFFIX.slice(0, -1))],
  expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut(CFG_SAME), vaultOut()],
});

build({
  name: 'bootstrapVault REJECTS a non-owner’s signature',
  fn: 'bootstrapVault', cfg: CFG3, args: bvArgs(0), expect: 'fail', signWith: 5,
  inputs: [rootIn()],
  outputs: [rootOut(CFG_SAME), vaultOut()],
});

build({
  name: 'bootstrapVault REJECTS owner 0’s signature presented as owner 1',
  fn: 'bootstrapVault', cfg: CFG3, args: bvArgs(1), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut(CFG_SAME), vaultOut()],
});

build({
  name: 'bootstrapVault REJECTS ownerIndex == ownerCount (out of range)',
  fn: 'bootstrapVault', cfg: CFG3, args: bvArgs(3), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut(CFG_SAME), vaultOut()],
});

build({
  name: 'SECURITY bootstrapVault REJECTS altering the root while bootstrapping (a bump here would desynchronise the nonce from the proposals it names)',
  fn: 'bootstrapVault', cfg: CFG3, args: bvArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, nonce: 1 }), vaultOut()],
});

build({
  name: 'SECURITY bootstrapVault REJECTS rotating the owner set while bootstrapping',
  fn: 'bootstrapVault', cfg: CFG3, args: bvArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut({ ...CFG3, threshold: 1 }), vaultOut()],
});

build({
  name: 'bootstrapVault REJECTS draining the root reserve below the fee cap',
  fn: 'bootstrapVault', cfg: CFG3, args: bvArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn(CID, 100000)],
  outputs: [rootOut(CFG_SAME, 1000), vaultOut(CID, 1000)],
});

build({
  name: 'SECURITY bootstrapVault REJECTS minting a third output under the treasury lineage',
  fn: 'bootstrapVault', cfg: CFG3, args: bvArgs(0), expect: 'fail', signWith: 0,
  inputs: [rootIn()],
  outputs: [rootOut(CFG_SAME), vaultOut(), { kind: 'raw', script: p2shScript(vaultRedeem(CID)), value: 1000, cid: CID, authorizingInput: 0 }],
});

build({
  name: 'SECURITY bootstrapVault REJECTS an UNBOUND root (a plain payment to the root address is exactly that, and it carries no lineage to stamp)',
  fn: 'bootstrapVault', cfg: CFG3, args: bvArgs(0), expect: 'fail', signWith: 0,
  inputs: [{ kind: 'root', value: 100000 }],
  outputs: [rootOut(CFG_SAME, 90000, null), vaultOut(CID, 50000, null)],
});

// ============================================================== executeConfig ==
const cfgHash = (thr, cnt, owners) => blake2b256(cat(B8(thr), B8(cnt), ...owners));
const ecArgs = (idx, thr, cnt, owners) => [idx, '0x' + hex(B8(thr)), '0x' + hex(B8(cnt)), ...owners.map((o) => '0x' + hex(o))];

const NEW_OWNERS = [PK[5], PK[1], PK[2], PK[3], PK[4]];
const approvedConfigProposal = (over = {}) => propState({
  id: 4, operation: 2, bitmap: fromHex('0300000000000000'), approvalCount: 2, status: 1,
  snapThreshold: 2, ownerCount: 3, ...over,
});
const withRecipient = (st, h) => ({ ...st, recipientSpkHash: h });

function ecTest({ name, expect, thr = 3, cnt = 4, owners = NEW_OWNERS, proposalOver = {}, recipientOverride = null,
                  rootCfg = { nonce: 4, threshold: 2, ownerCount: 3 }, outCfg = null, outValue = 90000,
                  rootInCid = CID, propInCid = CID, outCids = null, extraOutputs = [], extraInputs = [],
                  badSigScript = false }) {
  const committed = recipientOverride ?? cfgHash(thr, cnt, owners);
  const pst = withRecipient(approvedConfigProposal(proposalOver), committed);
  const redeem = proposalRedeem(pst);
  const outputs = [{
    kind: 'root', value: outValue, cid: outCids === null ? CID : outCids[0],
    cfg: outCfg ?? { nonce: rootCfg.nonce, threshold: thr, ownerCount: cnt, owners },
    state: rootState(outCfg ?? { nonce: rootCfg.nonce, threshold: thr, ownerCount: cnt, owners }),
  }, ...extraOutputs];
  build({
    name, fn: 'executeConfig', cfg: rootCfg, args: ecArgs(1, thr, cnt, owners), expect, signWith: null,
    inputs: [rootIn(rootInCid, 100000), { kind: 'raw', value: 20000, cid: propInCid, redeem,
                                          sigScript: badSigScript ? cat(redeem.slice(0, redeem.length - 1), fromHex('00')) : undefined },
             ...extraInputs],
    outputs,
  });
}

ecTest({ name: 'executeConfig installs the approved new owner set and threshold, keeping the nonce', expect: 'pass' });
ecTest({ name: 'executeConfig REJECTS a proposal that is not Approved', expect: 'fail', proposalOver: { status: 0 } });
ecTest({ name: 'executeConfig REJECTS a TRANSFER proposal (operation 1) as a config change', expect: 'fail', proposalOver: { operation: 1 } });
ecTest({ name: 'executeConfig REJECTS a revealed config that does not match the committed hash', expect: 'fail', recipientOverride: rep(0x07, 32) });
ecTest({ name: 'executeConfig REJECTS newOwnerCount 6 (above the five owner slots the state carries)', expect: 'fail', thr: 2, cnt: 6 });
ecTest({ name: 'executeConfig REJECTS newOwnerCount 0', expect: 'fail', thr: 1, cnt: 0 });
ecTest({ name: 'executeConfig REJECTS newThreshold 0', expect: 'fail', thr: 0, cnt: 3 });
ecTest({ name: 'executeConfig REJECTS newThreshold greater than newOwnerCount', expect: 'fail', thr: 4, cnt: 3 });
ecTest({ name: 'executeConfig REJECTS a continuation that installs a different owner set than the one revealed', expect: 'fail',
         outCfg: { nonce: 4, threshold: 3, ownerCount: 4, owners: [PK[5], PK[5], PK[2], PK[3], PK[4]] } });
ecTest({ name: 'executeConfig REJECTS a continuation that resets the proposal nonce', expect: 'fail',
         outCfg: { nonce: 0, threshold: 3, ownerCount: 4, owners: NEW_OWNERS } });
ecTest({ name: 'executeConfig REJECTS draining the root reserve beyond maxProposalFee', expect: 'fail', outValue: 100000 - MAX_PROPOSAL_FEE - 1 });
ecTest({ name: 'executeConfig accepts spending exactly maxProposalFee from the root reserve', expect: 'pass', outValue: 100000 - MAX_PROPOSAL_FEE });

// The same input-SET floor on the config side: one copy of the script per root
// UTXO, all of them satisfied by the same output 0. The proposal input is NOT in
// the sum — it pays a different address, and its reserve is released by execute.
ecTest({
  name: 'executeConfig accepts merging TWO bound root UTXOs into one continuation that covers the whole set',
  expect: 'pass', extraInputs: [rootIn(CID, 100000)], outValue: 2 * 100000 - MAX_PROPOSAL_FEE,
});
ecTest({
  name: 'executeConfig REJECTS a continuation that covers only ONE of two bound root UTXOs (the second root’s reserve would walk out on one honest config change)',
  expect: 'fail', extraInputs: [rootIn(CID, 100000)], outValue: 90000,
});
ecTest({ name: 'executeConfig REJECTS a proposal input whose revealed script is not the pinned template', expect: 'fail', badSigScript: true });
ecTest({ name: 'SECURITY executeConfig REJECTS an UNBOUND root input paired with an UNBOUND proposal (both ZERO ids compare equal)',
         expect: 'fail', rootInCid: null, propInCid: null, outCids: [null] });
ecTest({ name: 'SECURITY executeConfig REJECTS a proposal from a FOREIGN covenant lineage', expect: 'fail', propInCid: CID2 });
// F4 (round 7): a CONFIG proposal snapshots the owner set in force when it was created.
// executeConfig must admit only a proposal whose snapshot still equals the config
// installed NOW — else a config approved under an earlier set survives a later rotation
// and is replayed to overwrite the current set. The default rootCfg is threshold 2,
// owners PK0..4; these give the proposal a snapshot that DIFFERS from that, so only the
// generation gate rejects them (strip it and the stale config installs).
ecTest({ name: 'SECURITY executeConfig REJECTS a STALE config whose snapshot THRESHOLD differs from the current root config (rotation replay)',
         expect: 'fail', proposalOver: { snapThreshold: 1 } });
ecTest({ name: 'SECURITY executeConfig REJECTS a STALE config whose snapshot OWNER differs from the current root config (a removed owner reinstating themselves)',
         expect: 'fail', proposalOver: { owners: [PK[5], PK[1], PK[2], PK[3], PK[4]] } });
ecTest({ name: 'SECURITY executeConfig REJECTS minting a second output under the treasury lineage',
         expect: 'fail', extraOutputs: [{ kind: 'raw', value: 1000, cid: CID, script: p2shScript(fromHex('51')) }] });
ecTest({ name: 'SECURITY executeConfig REJECTS continuing the lineage onto an output other than the root continuation',
         expect: 'fail', outCids: [null], extraOutputs: [{ kind: 'raw', value: 1000, cid: CID, script: p2shScript(fromHex('51')) }] });


// ------------------------------------------- executeConfig owner distinctness --
// The same rule, on the set an APPROVED config proposal installs. Bounding
// newOwnerCount/newThreshold is not enough on its own: without this, the honest
// path could write exactly the registry state the genesis check rejects.
ecTest({ name: 'executeConfig REJECTS installing a set whose slots 0 and 1 hold the same key (the honest path would otherwise reach exactly the state the genesis check rejects)',
         expect: 'fail', thr: 3, cnt: 4, owners: [PK[5], PK[5], PK[2], PK[3], PK[4]] });
ecTest({ name: 'executeConfig REJECTS a duplicate in a non-adjacent live pair of the installed set (slots 1 and 3)',
         expect: 'fail', thr: 3, cnt: 4, owners: [PK[5], PK[1], PK[2], PK[1], PK[4]] });
ecTest({ name: 'executeConfig installs a 2-of-2 whose slots 2..4 are the shared NUMS pad (unused slots are not compared — otherwise no treasury could shrink below five owners)',
         expect: 'pass', thr: 2, cnt: 2, owners: pad(PK[5], PK[1]) });
ecTest({ name: 'executeConfig installs a set whose duplicates all sit BEYOND newOwnerCount (dead slots carry no bit and no vote)',
         expect: 'pass', thr: 2, cnt: 2, owners: [PK[5], PK[1], PK[5], PK[5], PK[5]] });

writeFileSync(REPO + '/contracts/KoRoot.test.json', JSON.stringify({ tests }, null, 2) + '\n');
console.error(`wrote ${tests.length} tests -> contracts/KoRoot.test.json`);
