// The last thing that looks at a transaction before it is broadcast.
//
// The covenant enforces "no transfer without owner signatures". It cannot enforce
// "the owner meant THIS transfer". By the time a transaction reaches the node the
// signature is already valid — the guard's whole job is to notice, before it goes
// out, that the transaction does something nobody asked for.
//
// It reads the transaction with frontend/src/txDecode.js, which decodes borsh by
// hand and rebuilds addresses with its own cashaddr encoder. Nothing here calls
// back into the wasm builder. Asking the builder to describe its own output would
// not be a check; two independent readings that have to agree is the only reason
// this is worth anything.
//
// The central rule is about DESTINATIONS, because that is what a defect actually
// costs. Every output must be one of three things:
//
//   * a continuation of this treasury's own covenant lineage,
//   * a payment the caller declared (a transfer's recipient, a retirement's payout),
//   * change back to the wallet that is funding the operation.
//
// Anything else is money leaving for a destination the person signing never saw,
// and there is no fourth legitimate category. Note the lineage half is a real
// check and not a formality: an output that continues a DIFFERENT covenant id is
// exactly the re-parenting shape that could once have been used to walk off with
// a treasury's deposits.
import { decodeTx, addressFromSpk } from "./txDecode.js";

/** Ops that must never spend the vault. Approving is an opinion, not a payment. */
const MUST_NOT_TOUCH_VAULT = new Set(["approve", "reject", "propose", "config-execute", "close-expired"]);

/** Ops that are allowed to pay exactly one declared external address. */
const MAY_PAY_OUT = new Set(["execute", "close-expired"]);

const strip = (spkHex) => {
  // recipient_info() hands back a scriptPubKey WITH its 2-byte version prefix;
  // a decoded output carries the version separately. Compare like with like.
  const s = String(spkHex ?? "").toLowerCase();
  return s.startsWith("0000") ? s.slice(4) : s;
};

/**
 * @typedef {object} Guard
 * @property {string} kind            propose | approve | reject | execute | config-execute | close-expired
 * @property {string} lineage         this treasury's covenant id (64-hex)
 * @property {string} prefix          address prefix for this network, e.g. "kaspatest"
 * @property {{txid: string, index: number}|null} [vaultOutpoint]
 * @property {string|null} [recipientSpkHex]  the declared payee, if this op pays one
 * @property {number|null} [amount]           the declared amount in sompi
 * @property {string|null} [payoutAddress]    where a retirement's bond is declared to go
 * @property {string|null} [walletAddress]    the funding wallet, which may receive change
 * @property {string|null} [vaultSpk]  this treasury's vault scriptPubKey, hex. Supplied
 *   only by `execute` — the one operation that spends the vault — so the guard can
 *   require the treasury's money to come home to that exact script rather than to
 *   anything merely wearing its covenant id.
 * @property {number|null} [treasuryIn]      total sompi this operation spends OUT of the
 *   treasury's own covenant UTXOs — the vault, the root, the proposal bond. Known
 *   exactly by every caller, because it is what they told the builder to spend.
 * @property {number|null} [treasuryFee]     the MOST the treasury may lose beyond what
 *   it pays out. Zero when the operator's wallet funds the operation. Note this is a
 *   ceiling, not an equality: an owner-funded proposal moves the 0.5 KAS bond from
 *   the wallet INTO the treasury, so the treasury ends up ahead, and a rule that
 *   demanded an exact match refused every one of them.
 */

/**
 * Re-read a finished transaction and report every way it disagrees with what was
 * asked for. An empty list means the bytes about to be broadcast do what the
 * caller said they would.
 *
 * @param {string} borshHex
 * @param {Guard} guard
 * @returns {string[]} problems, in the words a person can act on
 */
export function inspectSpend(borshHex, guard) {
  let tx;
  try {
    tx = decodeTx(borshHex);
  } catch (e) {
    // A transaction this app cannot read is a transaction it cannot vouch for.
    return [`this transaction could not be decoded (${e.message}) — refusing to broadcast something that cannot be read back`];
  }
  return inspectDecoded(tx, guard);
}

/**
 * The rules themselves, over an already-decoded transaction.
 *
 * Split out from inspectSpend so every rule can be exercised against a
 * transaction built to break it. Some of them — paying the declared address
 * twice, for instance — describe shapes the real builder will not produce, and a
 * rule that can only be reached through the builder is a rule the builder gets to
 * decide whether to test.
 *
 * @param {ReturnType<typeof decodeTx>} tx
 * @param {Guard} guard
 * @returns {string[]}
 */
export function inspectDecoded(tx, guard) {
  const { kind, lineage, prefix } = guard;
  /** @type {string[]} */
  const problems = [];

  const lin = String(lineage ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(lin)) return ["no treasury lineage to check this transaction against — refusing to broadcast"];

  // Defence in depth, and knowingly best-effort: the vault's outpoint comes from
  // the node, so when the node is unreachable this rule has nothing to compare
  // against and does nothing. That is survivable because it is not the thing
  // standing between a treasury and a thief — the destination rule below is. A
  // rogue "approve" that drained the vault would still have to send the money
  // somewhere, and every destination has to be this treasury, a declared payee, or
  // the signer's own wallet. What this rule adds is naming the abuse precisely
  // when we can, instead of reporting it as a stray output.
  if (MUST_NOT_TOUCH_VAULT.has(kind) && guard.vaultOutpoint) {
    const v = guard.vaultOutpoint;
    const touches = tx.inputs.some((i) => i.previousOutpoint.transactionId === String(v.txid).toLowerCase() && i.previousOutpoint.index === v.index);
    if (touches) problems.push(`a "${kind}" must not spend the vault, and this transaction does — it would move treasury funds under cover of an operation that is not a payment`);
  }

  const wantSpk = MAY_PAY_OUT.has(kind) ? strip(guard.recipientSpkHex) : null;
  const payout = guard.payoutAddress ? String(guard.payoutAddress).toLowerCase() : null;
  const wallet = guard.walletAddress ? String(guard.walletAddress).toLowerCase() : null;

  let declaredPayments = 0;
  let paidOut = 0n;
  for (const [i, o] of tx.outputs.entries()) {
    const script = o.scriptPublicKey.script.toLowerCase();

    // A scriptPubKey version is not the address version. Every standard Kaspa
    // output is script version 0; at spend time a version > 0 output does not run
    // its script at all (it is anyone-can-spend), so it will NOT pay whoever its
    // bytes appear to name. addressFromSpk reads only the script shape and would
    // render such an output as an ordinary address — the destination rule below
    // would then wave it through as the declared recipient or as change, while
    // on chain the money goes to whoever spends it first. Refuse any non-zero
    // version outright: the app has no honest use for one.
    if (o.scriptPublicKey.version !== 0) {
      problems.push(`output ${i} (${fmt(o.value)} KAS) has script version ${o.scriptPublicKey.version}, not 0 — a non-standard output whose script never runs (anyone-can-spend), so it would not pay the address it appears to`);
      continue;
    }
    const addr = addressFromSpk(script, prefix);

    if (o.covenant) {
      // A covenant output is only ours if it continues OUR id. Anything else is
      // this treasury's money being re-parented onto someone else's lineage.
      if (o.covenant.covenantId.toLowerCase() !== lin) {
        problems.push(`output ${i} (${fmt(o.value)} KAS) continues covenant ${o.covenant.covenantId.slice(0, 16)}… which is not this treasury's lineage ${lin.slice(0, 16)}…`);
      }
      continue;
    }

    // Not a covenant continuation, so it is a payment and must have been declared.
    if (wantSpk && script === wantSpk) {
      declaredPayments++; paidOut += o.value;
      if (guard.amount != null && o.value !== BigInt(guard.amount)) {
        problems.push(`output ${i} pays the right address but ${fmt(o.value)} KAS instead of the ${fmt(BigInt(guard.amount))} KAS you asked for`);
      }
      continue;
    }
    if (payout && addr && addr.toLowerCase() === payout) { declaredPayments++; paidOut += o.value; continue; }
    if (wallet && addr && addr.toLowerCase() === wallet) continue;   // change home, any amount

    problems.push(`output ${i} sends ${fmt(o.value)} KAS to ${addr ?? `an unrecognised script (${script.slice(0, 24)}…)`}, which is not this treasury, not the address you named, and not your own wallet`);
  }

  // Conservation. Everything above is about WHERE money goes; this is about how
  // much of it leaves. The guard takes the builder's arithmetic entirely on trust
  // otherwise — and a builder that quietly overstates the fee does not send money
  // anywhere suspicious, it just leaves less behind, which no destination rule can
  // see. The treasury's own inputs are known exactly by every caller, because they
  // are what it told the builder to spend, so the difference is checkable:
  //
  //   what left the treasury  −  what came back to it  −  what was paid out
  //     must not EXCEED the fee the app displayed.
  //
  // A ceiling rather than an equality, and the difference is not pedantry. An
  // owner-funded proposal spends the KoRoot but returns it whole, and mints the
  // 0.5 KAS bond out of the proposer's WALLET — so the treasury ends the
  // transaction 0.5 KAS ahead. The first version of this rule demanded an exact
  // match, read that gain as a shortfall, and refused every owner-funded proposal
  // with "0.5 KAS less than accounted for". Losing money the owner was not told
  // about is the danger; gaining it never is.
  if (guard.treasuryIn != null && guard.treasuryFee != null) {
    // treasuryIn and treasuryFee reach the guard as JS Numbers, and the caller
    // computes treasuryIn as a SUM of UTXO amounts (vault + bond). The outputs
    // below are decoded from the bytes as exact BigInt, so the moment the Number
    // side has lost a sompi — any true value at or above 2^53 — this comparison is
    // between an exact figure and a rounded one, and it will either refuse an
    // honest payout or wave a real over-loss through. The guard cannot un-round a
    // value it was handed already rounded, so it refuses to pretend it can: a
    // treasuryIn that is not a safe integer means the app cannot represent this
    // treasury's own balance, and no conservation verdict over it is trustworthy.
    if (!Number.isSafeInteger(guard.treasuryIn) || !Number.isSafeInteger(guard.treasuryFee)) {
      problems.push(`this treasury's own value (${guard.treasuryIn} sompi) is too large for this build to check exactly — above ${Number.MAX_SAFE_INTEGER} sompi (~90,071,992 KAS) amounts round, so the guard cannot verify what leaves. Refusing rather than approve a spend it cannot account for.`);
      return problems;
    }
    const back = tx.outputs.reduce((sum, o) => (o.covenant ? sum + o.value : sum), 0n);
    const lost = BigInt(guard.treasuryIn) - back - BigInt(paidOut);
    const cap = BigInt(guard.treasuryFee);
    if (lost > cap) {
      problems.push(`this operation takes ${fmt(lost)} KAS out of the treasury beyond what it pays out, but the app says it should cost the treasury ${fmt(cap)} KAS — ${fmt(lost - cap)} KAS more than accounted for`);
    }
  }

  // WHERE the treasury's money comes home to — not merely that something wearing
  // its lineage received it.
  //
  // The destination rule above accepts a covenant output once its id matches, and
  // an id is a TAG the builder writes into the output beside the script, not a
  // property of the script. So a builder that repointed the vault continuation's
  // 32-byte script hash at an attacker, and left the binding untouched, satisfied
  // every rule here: the output looked like a continuation of this lineage, and
  // its value counted as "came back" in the conservation sum above, closing the
  // arithmetic too. Authenticating a continuation by the tag it carries is the
  // shape-not-identity mistake this codebase keeps making, and asking the builder
  // to describe its own output is the one thing this module exists not to do.
  //
  // Consensus does reject that transaction — KoVault.executeProposal requires the
  // change output's scriptPubKey to equal the vault's own. That is exactly why it
  // is worth checking here anyway: this guard's whole premise is that being right
  // because the node happens to catch it is not the same as being right.
  //
  // Only the vault is checked, and only where it is spent. The vault's script is
  // known exactly and never changes — it is the address the app has been showing
  // the owner all along. The root's and the proposal's do change on every
  // operation (nonce, bitmap, status live in the redeem script, so the P2SH moves
  // with them), and pre-computing those would mean re-implementing the covenants'
  // state transitions in JavaScript — a second implementation to keep in step,
  // which is a bigger liability than the gap it closes. The vault is also where
  // the money is: the root holds a small reserve and the proposal a 0.5 KAS bond,
  // while the vault holds the treasury.
  if (guard.vaultSpk && guard.treasuryIn != null && guard.treasuryFee != null) {
    const want = String(guard.vaultSpk).toLowerCase();
    const home = tx.outputs.reduce((sum, o) => (o.covenant && o.scriptPublicKey.script.toLowerCase() === want ? sum + o.value : sum), 0n);
    const owed = BigInt(guard.treasuryIn) - BigInt(paidOut) - BigInt(guard.treasuryFee);
    if (home < owed) {
      problems.push(`only ${fmt(home)} KAS returns to this treasury's own vault address, but ${fmt(owed)} KAS should — the rest is going to an address that carries this treasury's covenant id without being its vault`);
    }
  }

  if (MAY_PAY_OUT.has(kind) && (wantSpk || payout) && declaredPayments === 0) {
    problems.push(`this "${kind}" pays nobody — the payment you asked for is not in the transaction at all`);
  }
  if (declaredPayments > 1) {
    problems.push(`this transaction pays the declared address ${declaredPayments} times; exactly one payment was asked for`);
  }
  return problems;
}

const fmt = (sompi) => (Number(sompi) / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");

/**
 * Throw unless the transaction does what was asked. Called with the bytes that
 * are about to go to a node — including after a fee retry has rebuilt and
 * re-signed them, because a guard that only inspects the first attempt guards
 * nothing once the node asks for a higher fee.
 *
 * @param {string} borshHex
 * @param {Guard} guard
 */
export function assertSpend(borshHex, guard) {
  const problems = inspectSpend(borshHex, guard);
  if (!problems.length) return;
  const e = new Error(
    `This transaction does not do what the app said it would, so it was NOT sent:\n  - ${problems.join("\n  - ")}\n` +
    `Nothing has moved. Please report this — it means the transaction builder and the screen disagree.`);
  e.name = "SpendGuardRefusal";
  e.problems = problems;
  throw e;
}
