// UTXO-based treasury state tracking. Reading state from chain needs RPC (blocked on
// a Toccata SDK), but the classification logic over decoded proposal state is
// pure and testable, so it lives here and is unit-tested.

import { ProposalStatus, type ProposalState } from "@kosign/descriptor";

export interface ProposalView {
  proposalId: bigint;
  status: ProposalStatus;
  approvalCount: bigint;
  approvalBitmap: bigint;
  amount: bigint;
  /** the UTXO currently holding this proposal's state, if unspent */
  utxo?: { txid: string; index: number };
  executedTxId?: string;
}

/** Which owner indices (0..4) have approved, from the bitmap. */
export function approvers(bitmap: bigint): number[] {
  const out: number[] = [];
  for (let i = 0; i < 5; i++) if ((bitmap >> BigInt(i)) & 1n) out.push(i);
  return out;
}

/**
 * Classify a proposal for the UI given its on-chain state and the current time.
 * `nowSeconds` is chain time (DAA-derived); `ageSeconds` is the proposal UTXO's
 * age. Mirrors the contract's own gating so the UI never offers an action the
 * covenant would reject.
 */
export function classify(
  s: Pick<ProposalState, "status" | "expiresAt" | "executionDelay" | "approvalCount">,
  ctx: { nowSeconds: bigint; ageSeconds: bigint; threshold: number },
): { label: "pending" | "approved" | "executable" | "expired"; executableNow: boolean } {
  if (s.status === ProposalStatus.ExecutedOrClosed || s.status === ProposalStatus.Cancelled) {
    return { label: "expired", executableNow: false };
  }
  const expired = ctx.nowSeconds >= s.expiresAt;
  if (s.status === ProposalStatus.Pending) {
    // expiry is only soundly enforceable on the close path; surface it anyway
    return { label: expired ? "expired" : "pending", executableNow: false };
  }
  // Approved
  const delayPassed = ctx.ageSeconds >= s.executionDelay;
  const enough = s.approvalCount >= BigInt(ctx.threshold);
  const executableNow = enough && delayPassed; // note: cannot block post-expiry execute on-chain
  return { label: executableNow ? "executable" : "approved", executableNow };
}

/**
 * Live tracking — subscribe to UTXO changes for the treasury's covenant id and
 * maintain current KoRoot / KoVault / proposal UTXOs.
 * BLOCKED on a Toccata RPC client (see docs/RISKS.md).
 */
export function trackTreasury(_treasuryId: Uint8Array): never {
  throw new Error("trackTreasury(): needs a Toccata RPC client + covenant-id UTXO index. See docs/RISKS.md.");
}
