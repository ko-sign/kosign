#!/usr/bin/env node
// ===========================================================================
// gen-kovault-tests — regenerate contracts/KoVault.test.json.
//
// WHY THIS EXISTS (i.e. why you cannot hand-edit the fixtures)
//   KoVault.executeProposal returns change to the vault's OWN address:
//       require(tx.outputs[vaultChangeOutputIndex].scriptPubKey == vaultSpk)
//   where vaultSpk is the active input's scriptPubKey — P2SH(compiled KoVault).
//   Every executeProposal fixture therefore carries the compiled script's hash
//   in two places (the change output's script_hex, and the pinned proposal
//   template baked into the constructor args). Change one line of KoVault.sil
//   and a stale fixture stops failing at the rule it was written for and starts
//   failing at the scriptPubKey compare — a FALSE GREEN for any test that
//   expects 'fail'. That is not hypothetical: it happened while the per-input
//   value rule was being replaced, and it is why these fixtures are generated.
//
//   Therefore: whenever contracts/KoVault.sil or contracts/KoProposal.sil
//   changes, run
//       npm run gen:kovault-tests
//   and re-run `npm run test:contracts && npm run test:security`.
//
// THE COMPILATION CAVEAT (this bit is not optional)
//   silc and cli-debugger compile the SAME source to DIFFERENT bytes: the
//   debugger sets `record_debug_infos: true`, which skips `lower_local_aliases`.
//   Fixtures must be built from the DEBUGGER's compilation (examples/silc_dbg,
//   built by scripts/build-compiler.sh) or the P2SH they bake in is one the
//   debugger never presents. See the header of scripts/gen-koroot-tests.mjs.
//
// WHAT IT WRITES
//   contracts/KoVault.test.json — the deposit/sweep suite, and the
//   executeProposal suite: the per-vault-input-SET value rule (positive,
//   boundary and evasion cases), the proposal-gating rules, and the covenant
//   lineage/output-pinning SECURITY controls.
//
//   executeProposal takes no signature, so its lineage tests ARE valid
//   differential controls: strip the guards and the transaction becomes valid,
//   which is exactly what scripts/test-security.sh checks. Every test named
//   SECURITY here must therefore pass ONLY because of its lineage guard —
//   every other rule in the entrypoint has to be satisfied.
//
// Usage:  node scripts/gen-kovault-tests.mjs      (or: npm run gen:kovault-tests)
// ===========================================================================
import { writeFileSync } from 'node:fs';
import * as L from './lib/covenant-fixtures.mjs';
const { B, I, hex, cat, rep, compile, p2shScript, blake2b256, encodeProposalState, ownerKey, fixtureArgs, REPO } = L;

// ---------------------------------------------------------------- template --
// The KoProposal template KoVault pins, derived from the REAL compiled contract
// exactly as packages/descriptor/deriveTemplate does. A proposal UTXO is only
// readable by the vault if its redeem script is prefix ‖ state ‖ suffix.
const KP_CTOR = [
  B(rep(0xaa, 32)), I(1), I(1), B(rep(0x07, 32)), I(100000000), I(20000), I(9999999999), I(3600),
  B(new Uint8Array(8)), I(1), I(0), I(2), I(3),
  B(rep(0x01, 32)), B(rep(0x02, 32)), B(rep(0x03, 32)), B(rep(0x04, 32)), B(rep(0x05, 32)),
  B(new Uint8Array(8)), I(0), B(new Uint8Array(32)), // initVaultSpkHash (state-only placeholder)
];
const KP = compile(REPO + '/contracts/KoProposal.sil', KP_CTOR);
const TPL_PREFIX = KP.script.slice(0, KP.layout.start);
const TPL_SUFFIX = KP.script.slice(KP.layout.start + KP.layout.len);
const TPL_HASH = blake2b256(cat(TPL_PREFIX, TPL_SUFFIX));

const TREASURY_ID = rep(0xaa, 32);
const CID = rep(0xcc, 32);
const CID2 = rep(0xdd, 32);
const MAX_EXECUTION_FEE = 50000;
const MAX_DEPOSIT_INPUTS = 16;

// The vault's lineage IS its state: every fixture below runs a vault that belongs
// to CID and to nothing else, which is what the deposit/execute paths now demand.
const VAULT_CTOR = [
  B(CID), I(TPL_PREFIX.length), I(TPL_SUFFIX.length), B(TPL_HASH),
  I(MAX_EXECUTION_FEE), I(MAX_DEPOSIT_INPUTS), I(10000000),
];
const VAULT_SCRIPT = compile(REPO + '/contracts/KoVault.sil', VAULT_CTOR).script;
const VAULT_SPK = p2shScript(VAULT_SCRIPT);
console.error(`KoProposal template: prefixLen=${TPL_PREFIX.length} suffixLen=${TPL_SUFFIX.length} stateLen=${KP.layout.len}`);
console.error(`KoVault script: ${VAULT_SCRIPT.length} bytes, P2SH ${hex(VAULT_SPK).slice(4, 20)}…`);

const PK = [0, 1, 2, 3, 4].map((i) => ownerKey(i).pk);
// A plain P2PK recipient: `<32-byte key> OP_CHECKSIG`. The contract hashes the
// full scriptPubKey (version ‖ script), which is what `recipientSpk` must be.
const RCP_SCRIPT = cat(Uint8Array.from([0x20]), ownerKey(9).pk, Uint8Array.from([0xac]));
const RCP_SPK = cat(Uint8Array.from([0, 0]), RCP_SCRIPT);

const tests = [];

// ================================================================= deposit ==
// Permissionless sweep: value may only flow INTO the vault, so the network fee
// has to come from the sweeper's own (non-vault) inputs.
const VAULT_UTXO = 100000000;
const STRAY = 30000000;
const depositTx = (outputs) => ({
  active_input_index: 0,
  inputs: [{ utxo_value: VAULT_UTXO, covenant_id: '0x' + hex(CID) }, { utxo_value: STRAY }],
  outputs,
});
const cid = (v, extra = {}) => ({ value: v, covenant_id: '0x' + hex(CID), ...extra });
const deposit = (name, expect, outputs) =>
  tests.push({ name, function: 'deposit', constructor_args: fixtureArgs(VAULT_CTOR), args: [], expect, tx: depositTx(outputs) });

deposit('deposit sweeps two vault-address inputs into one vault output (value fully preserved)', 'pass',
  [cid(VAULT_UTXO + STRAY)]);
deposit('deposit REJECTS a sweep that pays the fee from vault funds (one sompi short)', 'fail',
  [cid(VAULT_UTXO + STRAY - 1)]);
deposit('SECURITY deposit REJECTS dropping the covenant binding (vault would fall back to the unbound, stealable state)', 'fail',
  [{ value: VAULT_UTXO + STRAY }]);
deposit("SECURITY deposit REJECTS minting a second output under the treasury's own lineage (forged sibling)", 'fail',
  [cid(VAULT_UTXO + STRAY), cid(1000000)]);

// LINEAGE IDENTITY. `boundVaultIns >= 1` proves a covenant vault UTXO of cid0 is
// PRESENT; it does not prove cid0 is THIS treasury's lineage. Anyone may mint a
// dust UTXO at the vault address under a covenant id he authored — consensus lets
// a genesis binding name any scriptPubKey and any outpoint the spender owns — so
// without `alienVaultIns == 0` he could spend that dust next to the real treasury
// and have output 0 continue HIS id. Value is fully preserved, so every other rule
// is satisfied; the treasury is simply re-parented onto a lineage whose sibling
// proposals only he can mint, and it drains from there. Both input orderings are
// pinned, and both a foreign continuation and a foreign passenger are rejected.
const ALIEN = '0x' + hex(rep(0xee, 32));
const alienDeposit = (name, expect, activeIdx, inputs, outputs) =>
  tests.push({
    name, function: 'deposit', constructor_args: fixtureArgs(VAULT_CTOR), args: [], expect,
    tx: { active_input_index: activeIdx, inputs, outputs },
  });

alienDeposit('SECURITY deposit REJECTS re-parenting the treasury onto a sweeper-minted covenant id (dust first)', 'fail',
  1,
  [{ utxo_value: 1000, covenant_id: ALIEN }, { utxo_value: VAULT_UTXO, covenant_id: '0x' + hex(CID) }],
  [{ value: VAULT_UTXO + 1000, covenant_id: ALIEN, authorizing_input: 0 }]);

alienDeposit('SECURITY deposit REJECTS re-parenting the treasury onto a sweeper-minted covenant id (treasury first)', 'fail',
  0,
  [{ utxo_value: VAULT_UTXO, covenant_id: '0x' + hex(CID) }, { utxo_value: 1000, covenant_id: ALIEN }],
  [{ value: VAULT_UTXO + 1000, covenant_id: ALIEN, authorizing_input: 1 }]);

alienDeposit("SECURITY deposit REJECTS a foreign-lineage vault input even when the treasury's own id continues", 'fail',
  0,
  [{ utxo_value: VAULT_UTXO, covenant_id: '0x' + hex(CID) }, { utxo_value: 1000, covenant_id: ALIEN }],
  [{ value: VAULT_UTXO + 1000, covenant_id: '0x' + hex(CID), authorizing_input: 0 }]);

// LINEAGE IDENTITY, the second half. Everything above pins the treasury's EXISTING
// balance. An incoming payment is a different problem: it lands UNBOUND, so nothing
// about the payment says which covenant may claim it, and a vault address can host
// as many lineages as strangers care to plant there. Whoever swept first would
// decide — and a stranger who planted one can always sweep first. The vault carries
// its lineage in state and refuses every other, so an arriving sompi joins THIS
// treasury or stays where it is.
const RIVAL = '0x' + hex(rep(0xee, 32));

alienDeposit('SECURITY deposit REJECTS a rival lineage at the same address absorbing an incoming payment', 'fail',
  1,
  [{ utxo_value: 1000, covenant_id: RIVAL }, { utxo_value: VAULT_UTXO }],
  [{ value: VAULT_UTXO + 1000, covenant_id: RIVAL, authorizing_input: 0 }]);

alienDeposit('SECURITY deposit REJECTS a wholly self-consistent FOREIGN treasury sweeping at this address', 'fail',
  0,
  [{ utxo_value: VAULT_UTXO, covenant_id: RIVAL }, { utxo_value: STRAY }],
  [{ value: VAULT_UTXO + STRAY, covenant_id: RIVAL, authorizing_input: 0 }]);

alienDeposit('deposit still sweeps an UNBOUND stray beside the treasury (zero id is neither bound nor alien)', 'pass',
  0,
  [{ utxo_value: VAULT_UTXO, covenant_id: '0x' + hex(CID) }, { utxo_value: STRAY }],
  [{ value: VAULT_UTXO + STRAY, covenant_id: '0x' + hex(CID), authorizing_input: 0 }]);

// ========================================================= executeProposal ==
// An HONEST, fully approved 3-of-5 TRANSFER. Everything below varies the
// TRANSACTION around this proposal, never the proposal itself, so each rejection
// isolates one rule of the vault.
const approvedTransfer = (over = {}) => ({
  proposalId: 1, operation: 1, recipientSpkHash: blake2b256(RCP_SPK), amount: 1000000000, maxFee: 20000,
  expiresAt: 9999999999, executionDelay: 0, approvalBitmap: Uint8Array.from([7, 0, 0, 0, 0, 0, 0, 0]),
  approvalCount: 3, status: 1, snapThreshold: 3, ownerCount: 5,
  owner0: PK[0], owner1: PK[1], owner2: PK[2], owner3: PK[3], owner4: PK[4],
  rejectBitmap: new Uint8Array(8), rejectCount: 0, vaultSpkHash: rep(0x0b, 32), ...over,
});
const P = approvedTransfer();
const V = 5000000000; // 50 KAS per bound vault UTXO

const propInput = (st = P, c = CID) => {
  const redeem = cat(TPL_PREFIX, encodeProposalState(st), TPL_SUFFIX);
  return {
    utxo_value: 1000000, ...(c ? { covenant_id: '0x' + hex(c) } : {}),
    utxo_script_hex: hex(p2shScript(redeem)), signature_script_hex: hex(redeem),
  };
};
const vaultInput = (value = V, c = CID) => ({ utxo_value: value, ...(c ? { covenant_id: '0x' + hex(c) } : {}) });
// A non-vault input: a different scriptPubKey, so the vault-set sum skips it.
const filler = (n) => ({ utxo_value: 1000, utxo_script_hex: hex(cat(Uint8Array.from([0x20]), ownerKey(50 + n).pk, Uint8Array.from([0xac]))) });

const recipientOut = (value = P.amount, script = RCP_SCRIPT) => ({ value, script_hex: hex(script) });
// The vault change output deliberately carries NO script_hex: the debugger then
// derives it from the contract under test, so it follows a MUTATED contract too.
// Baking P2SH(current KoVault) in here would make every lineage fixture reject on
// the stripped mutant for the wrong reason — the spk compare rather than the
// guard — and scripts/test-security.sh would certify a vacuous control as green.
// Pass an explicit `script` only when the point of the test is a WRONG address.
const changeOut = (value, c = CID, script = null) => ({
  value, ...(script ? { script_hex: hex(script) } : {}),
  ...(c ? { covenant_id: '0x' + hex(c), authorizing_input: 0 } : {}),
});

/** args: proposalInputIndex, recipientOutputIndex, vaultChangeOutputIndex, recipientSpk */
const exec = ({ name, expect, active = 0, inputs, outputs, args = [1, 0, 1, '0x' + hex(RCP_SPK)] }) =>
  tests.push({
    name, function: 'executeProposal', constructor_args: fixtureArgs(VAULT_CTOR), args, expect,
    tx: { active_input_index: active, inputs, outputs },
  });

const ONE = [vaultInput(), propInput()];
const CHANGE_1 = V - P.amount - P.maxFee; // the floor for a single vault UTXO

// F5 (round 7): a proposal may commit the vault's OWN scriptPubKey as its recipient
// (a net-zero self-send). If the recipient and the vault-change output indices are
// then aliased onto one output, that single output satisfies BOTH the recipient check
// (value == amount, spk == vaultSpk) and the change floor, so up to amount+maxFee of
// the vault walks out while owners believed they approved a net-zero move. VAULT_SPK
// is COMPUTED from the compiled contract here (line 75), so it tracks a mutant and this
// stays a valid isolation: strip `require(recipientOutputIndex != vaultChangeOutputIndex)`
// and the aliased spend passes. amount is chosen so 2*amount + maxFee >= V (the floor
// would otherwise reject it and mask the guard).
const VAULT_SPK_V = cat(Uint8Array.from([0, 0]), VAULT_SPK); // version-prefixed, as recipient_info hands back
const SELF_SEND = approvedTransfer({ recipientSpkHash: blake2b256(VAULT_SPK_V), amount: 3000000000 });
exec({
  name: 'SECURITY executeProposal REJECTS aliasing the recipient and vault-change onto ONE output (net-zero self-send that would otherwise leak amount+maxFee)',
  expect: 'fail', inputs: [vaultInput(), propInput(SELF_SEND)], outputs: [changeOut(3000000000)],
  args: [1, 0, 0, '0x' + hex(VAULT_SPK_V)],
});

exec({
  name: 'executeProposal pays the recipient and returns the change to the vault (single vault UTXO, change exactly at the floor)',
  expect: 'pass', inputs: ONE, outputs: [recipientOut(), changeOut(CHANGE_1)],
});
// The release path needs the same identity rule as the sweep path, and for the same
// reason: a lineage planted at this address is INTERNALLY consistent — its vault
// input, its proposal and its change output all agree — so every relational rule
// here is satisfied by it. Only a comparison against the treasury's own baked
// lineage tells the two apart.
exec({
  name: 'SECURITY executeProposal REJECTS a self-consistent FOREIGN lineage (vault input, proposal and change all agree — they simply are not this treasury)',
  expect: 'fail',
  inputs: [vaultInput(V, rep(0xee, 32)), propInput(undefined, rep(0xee, 32))],
  outputs: [recipientOut(), changeOut(CHANGE_1, rep(0xee, 32))],
});

exec({
  name: 'executeProposal accepts change ABOVE the floor (the rule caps leakage; it does not demand the fee be spent)',
  expect: 'pass', inputs: ONE, outputs: [recipientOut(), changeOut(CHANGE_1 + P.maxFee)],
});
exec({
  name: 'executeProposal REJECTS change one sompi below the floor (more than the proposal’s own maxFee would leave the vault)',
  expect: 'fail', inputs: ONE, outputs: [recipientOut(), changeOut(CHANGE_1 - 1)],
});

// ---- the per-vault-input-SET value rule ------------------------------------
// Each vault UTXO spent here runs its OWN copy of this script, and every copy is
// satisfied by the SAME change output. A bound written against `this` input's
// value alone therefore protects one UTXO while the rest walk out to whoever the
// transaction pays. These four fixtures are the rule: the change must cover the
// whole vault-input set, and it must do so no matter which copy is running.
const TWO = [vaultInput(), propInput(), vaultInput()];
const CHANGE_2 = 2 * V - P.amount - P.maxFee;

exec({
  name: 'executeProposal accepts TWO bound vault UTXOs when the change covers the whole set (the rule permits legitimate multi-UTXO spends rather than banning them)',
  expect: 'pass', active: 0, inputs: TWO, outputs: [recipientOut(), changeOut(CHANGE_2)],
});
exec({
  name: 'executeProposal accepts a multi-UTXO spend from the SECOND vault input’s point of view too (every copy of the script must agree)',
  expect: 'pass', active: 2, inputs: TWO, outputs: [recipientOut(), changeOut(CHANGE_2)],
});
exec({
  name: 'executeProposal REJECTS a change output that covers only ONE of two bound vault UTXOs — a per-input bound would have let the second walk out on one honest approved transfer',
  expect: 'fail', active: 0, inputs: TWO, outputs: [recipientOut(), changeOut(CHANGE_1)],
});
exec({
  name: 'executeProposal REJECTS the same one-of-two change from the second vault input as well (the leak is not an artefact of which input is active)',
  expect: 'fail', active: 2, inputs: TWO, outputs: [recipientOut(), changeOut(CHANGE_1)],
});
exec({
  name: 'executeProposal REJECTS an UNBOUND stray at the vault address whose value is not returned (the sum walks by scriptPubKey, so a plain payment to the vault cannot be pocketed by executing a proposal)',
  expect: 'fail', inputs: [vaultInput(), propInput(), vaultInput(V, null)],
  outputs: [recipientOut(), changeOut(CHANGE_1)],
});
exec({
  name: 'executeProposal REJECTS a 17-input spend that parks a second vault UTXO past the scan window (the loop’s own bound rejects the transaction outright, so the sum can never be incomplete)',
  expect: 'fail',
  inputs: [vaultInput(), propInput(), ...Array.from({ length: 14 }, (_, i) => filler(i)), vaultInput()],
  outputs: [recipientOut(), changeOut(CHANGE_1)],
});
exec({
  name: 'executeProposal accepts a 16-input spend (one under the scan window, the same ceiling deposit imposes on the vault address)',
  expect: 'pass',
  inputs: [vaultInput(), propInput(), ...Array.from({ length: 14 }, (_, i) => filler(i))],
  outputs: [recipientOut(), changeOut(CHANGE_1)],
});

// ---- what the proposal must say --------------------------------------------
exec({
  name: 'executeProposal REJECTS a proposal that is not Approved',
  expect: 'fail', inputs: [vaultInput(), propInput(approvedTransfer({ status: 0 }))],
  outputs: [recipientOut(), changeOut(CHANGE_1)],
});
exec({
  name: 'executeProposal REJECTS a CONFIG proposal (operation 2) — that one rotates owners KoRoot-side and must never move funds',
  expect: 'fail', inputs: [vaultInput(), propInput(approvedTransfer({ operation: 2 }))],
  outputs: [recipientOut(), changeOut(CHANGE_1)],
});
exec({
  name: 'executeProposal REJECTS a proposal whose maxFee exceeds the vault’s maxExecutionFee cap',
  expect: 'fail', inputs: [vaultInput(), propInput(approvedTransfer({ maxFee: MAX_EXECUTION_FEE + 1 }))],
  outputs: [recipientOut(), changeOut(V - P.amount - MAX_EXECUTION_FEE - 1)],
});
exec({
  name: 'executeProposal REJECTS a recipient script that is not the one the proposal committed to',
  expect: 'fail', inputs: ONE,
  outputs: [recipientOut(P.amount, cat(Uint8Array.from([0x20]), ownerKey(11).pk, Uint8Array.from([0xac]))), changeOut(CHANGE_1)],
  args: [1, 0, 1, '0x' + hex(cat(Uint8Array.from([0, 0]), Uint8Array.from([0x20]), ownerKey(11).pk, Uint8Array.from([0xac])))],
});
exec({
  name: 'executeProposal REJECTS paying the recipient more than the approved amount',
  expect: 'fail', inputs: ONE, outputs: [recipientOut(P.amount + 1), changeOut(CHANGE_1 - 1)],
});
exec({
  name: 'executeProposal REJECTS returning the change to an address other than the vault (the vault address is permanent)',
  expect: 'fail', inputs: ONE, outputs: [recipientOut(), changeOut(CHANGE_1, CID, p2shScript(Uint8Array.from([0x51])))],
});
exec({
  name: 'executeProposal REJECTS a proposal input whose revealed script is not the pinned template',
  expect: 'fail',
  inputs: [vaultInput(), { ...propInput(), signature_script_hex: hex(cat(TPL_PREFIX, encodeProposalState(P), TPL_SUFFIX.slice(0, TPL_SUFFIX.length - 1), Uint8Array.from([0x00]))) }],
  outputs: [recipientOut(), changeOut(CHANGE_1)],
});

// ---- lineage + output pinning (differential controls) -----------------------
// executeProposal checks no signature, so these fixtures fail for exactly one
// reason: the guard named in the test. Strip the guards and every one of them
// becomes a VALID transaction — which is what scripts/test-security.sh proves.
exec({
  name: 'SECURITY executeProposal REJECTS an UNBOUND vault input paired with an UNBOUND proposal (both ZERO ids compare equal, and a plain payment to the vault address is exactly that)',
  expect: 'fail', inputs: [vaultInput(V, null), propInput(P, null)],
  outputs: [recipientOut(), changeOut(CHANGE_1, null)],
});
exec({
  name: 'SECURITY executeProposal REJECTS a proposal from a FOREIGN covenant lineage',
  expect: 'fail', inputs: [vaultInput(), propInput(P, CID2)],
  outputs: [recipientOut(), changeOut(CHANGE_1)],
});
exec({
  name: 'SECURITY executeProposal REJECTS minting a second output under the treasury lineage (e.g. a forged proposal to drain the change with next)',
  expect: 'fail', inputs: ONE,
  outputs: [recipientOut(), changeOut(CHANGE_1), { value: 1000, covenant_id: '0x' + hex(CID), authorizing_input: 0, script_hex: hex(p2shScript(Uint8Array.from([0x51]))) }],
});
exec({
  name: 'SECURITY executeProposal REJECTS dropping the covenant binding from the vault change (the vault would fall back to the unbound, stealable state)',
  expect: 'fail', inputs: ONE, outputs: [recipientOut(), changeOut(CHANGE_1, null)],
});

writeFileSync(REPO + '/contracts/KoVault.test.json', JSON.stringify({ tests }, null, 2) + '\n');
console.error(`wrote ${tests.length} tests -> contracts/KoVault.test.json`);
