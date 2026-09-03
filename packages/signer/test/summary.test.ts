import { describe, it, expect } from "vitest";
import { buildApprovalSummary } from "../src/index.js";
import { Operation, ProposalStatus, type ProposalState } from "@kosign/descriptor";

describe("buildApprovalSummary", () => {
  it("renders the fields a signer must see", () => {
    const state: ProposalState = {
      proposalId: 4n,
      operation: Operation.TRANSFER_KAS,
      recipientSpkHash: new Uint8Array(32).fill(0xab),
      amount: 250_000_000n,
      maxFee: 20000n,
      expiresAt: 1_900_000_000n,
      executionDelay: 3600n,
      approvalBitmap: 0b011n,
      approvalCount: 2n,
      status: ProposalStatus.Pending,
      // owner snapshot + reject tally (mutable owners — docs/OWNER-MANAGEMENT.md)
      snapThreshold: 3n,
      ownerCount: 3n,
      owner0: new Uint8Array(32).fill(0x11),
      owner1: new Uint8Array(32).fill(0x22),
      owner2: new Uint8Array(32).fill(0x33),
      owner3: new Uint8Array(32).fill(0x44),
      owner4: new Uint8Array(32).fill(0x55),
      rejectBitmap: 0n,
      rejectCount: 0n,
    };
    const s = buildApprovalSummary({ treasuryId: new Uint8Array(32).fill(1), threshold: 3, state });
    expect(s.operation).toBe("TRANSFER_KAS");
    expect(s.approvals).toBe("2 / 3");
    expect(s.amountSompi).toBe("250000000");
    expect(s.status).toBe("Pending");
    expect(s.recipientSpkHashHex.length).toBe(64);
  });
});
