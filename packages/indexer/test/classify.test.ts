import { describe, it, expect } from "vitest";
import { approvers, classify } from "../src/index.js";
import { ProposalStatus } from "@kosign/descriptor";

describe("approvers bitmap", () => {
  it("decodes set bits", () => {
    expect(approvers(0b00000n)).toEqual([]);
    expect(approvers(0b00101n)).toEqual([0, 2]);
    expect(approvers(0b11111n)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("classify", () => {
  const base = { expiresAt: 2_000_000_000n, executionDelay: 3600n, approvalCount: 3n };

  it("pending below threshold", () => {
    const r = classify({ ...base, status: ProposalStatus.Pending, approvalCount: 1n }, { nowSeconds: 1n, ageSeconds: 0n, threshold: 3 });
    expect(r.label).toBe("pending");
    expect(r.executableNow).toBe(false);
  });

  it("approved but timelock not elapsed", () => {
    const r = classify({ ...base, status: ProposalStatus.Approved }, { nowSeconds: 1n, ageSeconds: 100n, threshold: 3 });
    expect(r.label).toBe("approved");
    expect(r.executableNow).toBe(false);
  });

  it("executable once delay elapsed and threshold met", () => {
    const r = classify({ ...base, status: ProposalStatus.Approved }, { nowSeconds: 1n, ageSeconds: 4000n, threshold: 3 });
    expect(r.label).toBe("executable");
    expect(r.executableNow).toBe(true);
  });

  it("executed proposals are terminal", () => {
    const r = classify({ ...base, status: ProposalStatus.ExecutedOrClosed }, { nowSeconds: 1n, ageSeconds: 9999n, threshold: 3 });
    expect(r.executableNow).toBe(false);
  });
});
