// Transaction LAYOUTS for every Ko-sign phase. These encode the exact
// input/output shape each covenant entrypoint expects (validated against the
// compiled contracts). A TxPlan is SDK-agnostic: once a Toccata-capable Kaspa
// SDK exposes covenant-bound output construction, `realize(plan)` serializes it
// into a signable PSKT. Until then the plans are the source of truth for the
// transaction graph and for tests. See docs/RISKS.md "SDK gap".

import { Operation } from "@kosign/descriptor";

/** A UTXO this tx spends. `entrypoint`/`args` are filled for covenant inputs. */
export interface InputSpec {
  role: "koroot" | "kovault" | "koproposal" | "funding" | "fee";
  outpoint?: { txid: string; index: number };
  /** covenant entrypoint to invoke on this input, e.g. "approve" */
  entrypoint?: string;
  /** entrypoint call args (descriptor Expr or primitives), in ABI order */
  args?: unknown[];
}

/** An output this tx creates. Covenant outputs carry the next state. */
export interface OutputSpec {
  role: "koroot" | "kovault" | "koproposal" | "recipient" | "change" | "newvault";
  /** sompi */
  value?: bigint;
  /** for covenant continuations: the next state object (validateOutputState) */
  state?: Record<string, unknown>;
  /** for plain payments: destination scriptPubKey */
  scriptPubKey?: Uint8Array;
}

export interface TxPlan {
  phase: "genesis" | "createProposal" | "approve" | "execute" | "migrate" | "closeExpired";
  inputs: InputSpec[];
  outputs: OutputSpec[];
  /** absolute locktime if the phase needs one (e.g. closeExpired >= expiresAt) */
  locktime?: bigint;
  notes: string[];
}

// ---- Phase layouts (mirror plan.md, verified against the .sil entrypoints) ----

/** Phase 1 — genesis: a funding UTXO mints KoRoot + KoVault into one new
 *  covenant domain. The treasury's covenant id (== treasuryId) is derived here by the
 *  network from the genesis input; the builder must precompute it (see RISKS). */
export function genesisPlan(p: { rootValue: bigint; vaultValue: bigint }): TxPlan {
  return {
    phase: "genesis",
    inputs: [{ role: "funding" }],
    outputs: [
      { role: "koroot", value: p.rootValue, state: { proposalNonce: 0 } },
      { role: "kovault", value: p.vaultValue, state: { vaultNonce: 0 } },
    ],
    notes: [
      "output[0]=KoRoot, output[1]=KoVault, both bound into the same covenant id.",
      "Keep rootValue well above dust: storage mass penalizes tiny outputs (KIP-9).",
    ],
  };
}

/** Phase 2 — createProposal: spend KoRoot, continue it (nonce+1), mint a
 *  KoProposal. Calls KoRoot.createProposal. */
export function createProposalPlan(p: {
  proposerIndex: number;
  operation: Operation;
  recipientSpkHash: Uint8Array;
  amount: bigint;
  maxFee: bigint;
  expiresAt: number;
  executionDelay: number;
  nextProposalId: number;
  rootValue: bigint;
  proposalValue: bigint;
}): TxPlan {
  return {
    phase: "createProposal",
    inputs: [
      { role: "koroot", entrypoint: "createProposal", args: [p.proposerIndex, "<proposerSig>", p.operation, p.recipientSpkHash, p.amount, p.maxFee, p.expiresAt, p.executionDelay] },
      { role: "fee" },
    ],
    outputs: [
      { role: "koroot", value: p.rootValue, state: { proposalNonce: p.nextProposalId } },
      { role: "koproposal", value: p.proposalValue, state: { /* set by KoRoot covenant */ } },
    ],
    notes: ["KoRoot enforces output[1] is a KoProposal of the right template via validateOutputStateWithTemplate."],
  };
}

/** Phase 3 — approve: spend the KoProposal, continue it with the new approval. */
export function approvePlan(p: { ownerIndex: number; proposalValue: bigint }): TxPlan {
  return {
    phase: "approve",
    inputs: [
      { role: "koproposal", entrypoint: "approve", args: [p.ownerIndex, "<ownerSig>"] },
      { role: "fee" },
    ],
    outputs: [{ role: "koproposal", value: p.proposalValue, state: { /* bitmap|count|status bumped */ } }],
    notes: ["Continuation MUST be output[0]. Re-fetch the proposal UTXO before signing (approvals race)."],
  };
}

/** Phase 4 — execute: spend KoVault + approved KoProposal together; pay the
 *  recipient and return change to the vault. Calls KoVault.executeProposal and
 *  KoProposal.execute in the same tx (mutual validation). */
export function executePlan(p: {
  recipientSpk: Uint8Array;
  amount: bigint;
  maxFee: bigint;
  vaultInValue: bigint;
}): TxPlan {
  const change = p.vaultInValue - p.amount - p.maxFee;
  return {
    phase: "execute",
    inputs: [
      { role: "kovault", entrypoint: "executeProposal", args: [1 /*proposalInputIndex*/, 0 /*recipientOut*/, 1 /*changeOut*/, p.recipientSpk] },
      { role: "koproposal", entrypoint: "execute", args: [0 /*vaultInputIndex*/] },
      { role: "fee" },
    ],
    outputs: [
      { role: "recipient", value: p.amount, scriptPubKey: p.recipientSpk },
      { role: "change", value: change, state: { /* vaultNonce+1 */ } },
    ],
    notes: ["input[0]=vault, input[1]=proposal (indices referenced by the entrypoint args).", "this.age on the proposal must already exceed executionDelay."],
  };
}
