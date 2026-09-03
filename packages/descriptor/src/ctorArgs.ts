// Builders for the Silverscript compiler's constructor-arg JSON (the `Expr`
// format: {kind, data}). These produce the exact ctor files scripts/compile.sh
// feeds to `silc` when instantiating a treasury's contracts.

import type { TemplateInfo } from "./types.js";

export type Expr =
  | { kind: "int"; data: number }
  | { kind: "bool"; data: boolean }
  | { kind: "byte"; data: number }
  | { kind: "array"; data: Expr[] };

export const eInt = (n: number | bigint): Expr => ({ kind: "int", data: Number(n) });
export const eBool = (b: boolean): Expr => ({ kind: "bool", data: b });
export const eBytes = (b: Uint8Array): Expr => ({
  kind: "array",
  data: Array.from(b, (x) => ({ kind: "byte", data: x }) as Expr),
});

/** Constructor args for KoProposal, in declaration order. Owners + threshold
 *  are NOT baked — they are snapshotted into the proposal's state (initSnapThreshold,
 *  initOwnerCount, initOwner0..4), so the script stays owner-agnostic (stable
 *  template/address). treasuryId is unused by the body (kept for indexer clarity). */
export function koProposalArgs(p: {
  owners: Uint8Array[]; // exactly 5 (the snapshot)
  threshold: number; // snapshot threshold
  ownerCount: number;
  treasuryId: Uint8Array; // 32 bytes
  initProposalId: number;
  initOperation: number;
  initRecipientSpkHash: Uint8Array; // 32
  initAmount: number | bigint;
  initMaxFee: number | bigint;
  initExpiresAt: number;
  initExecutionDelay: number;
  initApprovalBitmap: Uint8Array; // byte[8] (see KoProposal.sil)
  initApprovalCount: number;
  initStatus: number;
  initRejectBitmap?: Uint8Array; // byte[8]
  initRejectCount?: number;
  initVaultSpkHash?: Uint8Array; // 32 — blake2b of the treasury's vault redeem
}): Expr[] {
  requireOwners(p.owners);
  requirePolicy(p.threshold, p.ownerCount); // the snapshot inherits the treasury's policy
  requireDistinctOwners(p.owners, p.ownerCount);
  if (p.initApprovalBitmap.length !== 8) throw new Error("initApprovalBitmap must be byte[8]");
  return [
    eBytes(p.treasuryId),
    eInt(p.initProposalId),
    eInt(p.initOperation),
    eBytes(p.initRecipientSpkHash),
    eInt(p.initAmount),
    eInt(p.initMaxFee),
    eInt(p.initExpiresAt),
    eInt(p.initExecutionDelay),
    eBytes(p.initApprovalBitmap),
    eInt(p.initApprovalCount),
    eInt(p.initStatus),
    eInt(p.threshold), // initSnapThreshold
    eInt(p.ownerCount), // initOwnerCount
    ...p.owners.map(eBytes), // initOwner0..4
    eBytes(p.initRejectBitmap ?? new Uint8Array(8)), // initRejectBitmap
    eInt(p.initRejectCount ?? 0), // initRejectCount
    eBytes(p.initVaultSpkHash ?? new Uint8Array(32)), // initVaultSpkHash (bond-return commit)
  ];
}

/** Constructor args for KoVault. proposalTemplate comes from deriveTemplate()
 *  of the KoProposal artifact compiled for THIS treasury.
 *
 *  `lineage` is the treasury's covenant id and is the vault's STATE, not a label:
 *  the vault refuses to release or absorb funds under any other lineage, which is
 *  what stops a stranger who plants a covenant of his own at this address from
 *  capturing incoming payments. It is not known until the genesis transaction that
 *  mints KoRoot exists, so a vault is built with a placeholder to derive the
 *  template and stamped for real by KoRoot.bootstrapVault. */
export function koVaultArgs(p: {
  lineage: Uint8Array;
  proposalTemplate: TemplateInfo;
  maxExecutionFee: number | bigint;
  maxDepositInputs: number; // loop bound for the deposit/sweep path
  depositMaxFee: number | bigint;
}): Expr[] {
  // No threshold baked: the proposal gates on its snapshot threshold (status==1),
  // so the vault stays owner/threshold-agnostic → its address never changes.
  if (p.lineage.length !== 32) throw new Error("lineage must be a 32-byte covenant id");
  return [
    eBytes(p.lineage),
    eInt(p.proposalTemplate.prefixLen),
    eInt(p.proposalTemplate.suffixLen),
    eBytes(p.proposalTemplate.templateHash),
    eInt(p.maxExecutionFee),
    eInt(p.maxDepositInputs),
    eInt(p.depositMaxFee),
  ];
}

/** Constructor args for KoRoot. Owners + threshold now live in KoRoot STATE
 *  (the config registry: proposalNonce, threshold, ownerCount, owner0..4), so the
 *  script is owner-agnostic and the root address is stable across owner changes. */
export function koRootArgs(p: {
  owners: Uint8Array[];
  threshold: number;
  ownerCount: number;
  treasuryId: Uint8Array;
  proposalTemplate: TemplateInfo;
  vaultTemplateHash: Uint8Array; // pins what bootstrapVault is allowed to mint
  maxProposalFee: number | bigint;
  initProposalNonce: number;
}): Expr[] {
  requireOwners(p.owners);
  requirePolicy(p.threshold, p.ownerCount);
  requireDistinctOwners(p.owners, p.ownerCount);
  return [
    eBytes(p.treasuryId),
    eBytes(p.proposalTemplate.prefix),
    eBytes(p.proposalTemplate.suffix),
    eBytes(p.proposalTemplate.templateHash),
    eInt(p.proposalTemplate.prefixLen), // for readInputStateWithTemplate (executeConfig)
    eInt(p.proposalTemplate.suffixLen),
    eBytes(p.vaultTemplateHash),
    eInt(p.maxProposalFee),
    eInt(p.initProposalNonce),
    eInt(p.threshold), // initThreshold (state)
    eInt(p.ownerCount), // initOwnerCount (state)
    ...p.owners.map(eBytes), // initOwner0..4 (state)
  ];
}

function requireOwners(owners: Uint8Array[]): void {
  if (owners.length !== 5) throw new Error(`MVP requires exactly 5 owner slots, got ${owners.length}`);
  for (const o of owners) if (o.length !== 32) throw new Error("owner pubkeys must be 32-byte x-only Schnorr keys");
}

// The M-of-N policy is baked into the genesis script, and until KoRoot enforced
// these bounds itself nothing on-chain did: a treasury could claim five owners
// while carrying threshold 0, which mints proposals already Approved. KoRoot now
// rejects such a treasury on its only proposal-creating path, so this check is
// the SDK-side half — it stops a wallet integrating @kosign/descriptor from
// minting a treasury that is dead on arrival.
function requirePolicy(threshold: number, ownerCount: number): void {
  if (!Number.isInteger(ownerCount) || ownerCount < 1 || ownerCount > 5) {
    throw new Error(`ownerCount must be an integer in 1..5, got ${ownerCount}`);
  }
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > ownerCount) {
    throw new Error(`threshold must be an integer in 1..${ownerCount} (ownerCount), got ${threshold}`);
  }
}

// Identity in this design is the SLOT, not the key: KoRoot/KoProposal select an
// owner with ownerAt(i) and its approval bit with maskFor(i), and the duplicate-vote
// guard compares BITMAP BITS, never keys. So one key sitting in several live slots
// is several owners to every later check, and it can approve once per slot it
// occupies: owners [A, A, A, B, C] at threshold 3 is a 1-of-3 treasury presenting
// itself as 3-of-5. KoRoot.createProposal now rejects such a genesis (and
// KoRoot.executeConfig rejects installing one), which bricks the treasury rather
// than leaking from it — so catching it here, before anything is minted, is the
// difference between an error message and an unusable Safe.
//
// Only slots BELOW ownerCount are compared. The unused tail is padded with one
// shared NUMS point (see scripts/gen-templates.ts), so comparing all five would
// reject every treasury of fewer than five owners — the same rule, and the same
// reason, as the guarded `if (ownerCount >= n)` blocks in KoRoot.sil.
function requireDistinctOwners(owners: Uint8Array[], ownerCount: number): void {
  const live = owners.slice(0, ownerCount);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (a && b && sameKey(a, b)) {
        throw new Error(
          `owner slots ${i} and ${j} hold the same key (${hex8(a)}…) — ` +
            "each live slot carries its own approval bit, so a duplicate key votes once per slot it occupies",
        );
      }
    }
  }
}

const sameKey = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const hex8 = (b: Uint8Array): string => Array.from(b.slice(0, 8), (x) => x.toString(16).padStart(2, "0")).join("");
