// Signing UX. The actual Schnorr signing over a Kaspa sighash needs the SDK
// (blocked), but the anti-blind-signing SUMMARY — what a wallet must show an
// owner before they approve — is pure and lives here.

import { Operation, ProposalStatus, toHex, type ProposalState } from "@kosign/descriptor";

export interface ApprovalSummary {
  treasuryIdHex: string;
  proposalId: string;
  operation: string;
  recipientSpkHashHex: string;
  amountSompi: string;
  maxFeeSompi: string;
  approvals: string; // "2 / 3"
  status: string;
  expiresAt: string;
  executionDelaySeconds: string;
}

/**
 * Build the human-readable summary a signer UI must display. Never let an owner
 * approve from a raw tx hash alone (plan.md "Signer UI must display ...").
 */
export function buildApprovalSummary(p: {
  treasuryId: Uint8Array;
  threshold: number;
  state: ProposalState;
}): ApprovalSummary {
  const s = p.state;
  return {
    treasuryIdHex: toHex(p.treasuryId),
    proposalId: s.proposalId.toString(),
    operation: Operation[s.operation] ?? `unknown(${s.operation})`,
    recipientSpkHashHex: toHex(s.recipientSpkHash),
    amountSompi: s.amount.toString(),
    maxFeeSompi: s.maxFee.toString(),
    approvals: `${s.approvalCount} / ${p.threshold}`,
    status: ProposalStatus[s.status] ?? `unknown(${s.status})`,
    expiresAt: s.expiresAt.toString(),
    executionDelaySeconds: s.executionDelay.toString(),
  };
}

/** Sign one covenant input's sighash with an owner's Schnorr key.
 *  BLOCKED on a Toccata SDK that can compute the input sighash. See RISKS.md. */
export function signInput(_args: { privateKey: Uint8Array; sighash: Uint8Array }): never {
  throw new Error("signInput(): needs SDK sighash computation for covenant inputs. See docs/RISKS.md.");
}
