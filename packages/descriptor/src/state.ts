// Encode/decode KoProposal state exactly as Silverscript lays it out in the
// script (used by the indexer to read proposal UTXOs, and by tests to assert
// the artifact's state length). Each field is pushed with its minimal-but-fixed
// width: ints are OP_PUSHBYTES_8 + 8 little-endian bytes (9 bytes), bytes32 is
// OP_PUSHBYTES_32 + 32 bytes (33 bytes).
//
// NOTE: int sign/endianness was confirmed against real on-chain proposal state
// long ago; the length itself is computed from PROPOSAL_STATE_FIELDS (see
// proposalStateEncodedLen) and asserted against the compiled artifact in tests,
// so a field added to KoProposal.sil moves both together or fails loudly.
// Currently 348 = 12 ints * 9 + 8 bytes32 * 33.

import { PROPOSAL_STATE_FIELDS, ProposalStatus, type Operation } from "./types.js";

const PUSH8 = 0x08;
const PUSH32 = 0x20;

export interface ProposalState {
  proposalId: bigint;
  operation: Operation;
  recipientSpkHash: Uint8Array;
  amount: bigint;
  maxFee: bigint;
  expiresAt: bigint;
  executionDelay: bigint;
  approvalBitmap: bigint;
  approvalCount: bigint;
  status: ProposalStatus;
  // owner snapshot (mutable owners)
  snapThreshold: bigint;
  ownerCount: bigint;
  owner0: Uint8Array;
  owner1: Uint8Array;
  owner2: Uint8Array;
  owner3: Uint8Array;
  owner4: Uint8Array;
  // rejection tally (mirrors approval)
  rejectBitmap: bigint;
  rejectCount: bigint;
}

/** Fixed encoded length of the proposal state region (must equal artifact
 *  state_layout.len). Computed from the field list — 348 as of vaultSpkHash. */
export function proposalStateEncodedLen(): number {
  let n = 0;
  for (const f of PROPOSAL_STATE_FIELDS) n += f.kind === "int" ? 9 : 33;
  return n;
}

export function encodeProposalState(s: ProposalState): Uint8Array {
  const parts: number[] = [];
  pushInt(parts, s.proposalId);
  pushInt(parts, BigInt(s.operation));
  pushBytes32(parts, s.recipientSpkHash);
  pushInt(parts, s.amount);
  pushInt(parts, s.maxFee);
  pushInt(parts, s.expiresAt);
  pushInt(parts, s.executionDelay);
  pushInt(parts, s.approvalBitmap);
  pushInt(parts, s.approvalCount);
  pushInt(parts, BigInt(s.status));
  pushInt(parts, s.snapThreshold);
  pushInt(parts, s.ownerCount);
  pushBytes32(parts, s.owner0);
  pushBytes32(parts, s.owner1);
  pushBytes32(parts, s.owner2);
  pushBytes32(parts, s.owner3);
  pushBytes32(parts, s.owner4);
  pushInt(parts, s.rejectBitmap);
  pushInt(parts, s.rejectCount);
  return Uint8Array.from(parts);
}

export function decodeProposalState(region: Uint8Array): ProposalState {
  let o = 0;
  const readInt = (): bigint => {
    if (region[o] !== PUSH8) throw new Error(`expected PUSH8 at ${o}, got ${region[o]}`);
    o += 1;
    const v = leToBigInt(region.subarray(o, o + 8));
    o += 8;
    return v;
  };
  const readBytes32 = (): Uint8Array => {
    if (region[o] !== PUSH32) throw new Error(`expected PUSH32 at ${o}, got ${region[o]}`);
    o += 1;
    const b = region.slice(o, o + 32);
    o += 32;
    return b;
  };
  const proposalId = readInt();
  const operation = Number(readInt()) as Operation;
  const recipientSpkHash = readBytes32();
  const amount = readInt();
  const maxFee = readInt();
  const expiresAt = readInt();
  const executionDelay = readInt();
  const approvalBitmap = readInt();
  const approvalCount = readInt();
  const status = Number(readInt()) as ProposalStatus;
  const snapThreshold = readInt();
  const ownerCount = readInt();
  const owner0 = readBytes32();
  const owner1 = readBytes32();
  const owner2 = readBytes32();
  const owner3 = readBytes32();
  const owner4 = readBytes32();
  const rejectBitmap = readInt();
  const rejectCount = readInt();
  return { proposalId, operation, recipientSpkHash, amount, maxFee, expiresAt, executionDelay, approvalBitmap, approvalCount, status, snapThreshold, ownerCount, owner0, owner1, owner2, owner3, owner4, rejectBitmap, rejectCount };
}

// `operation` and `status` are numeric enums in ProposalState, the rest are
// bigints — accept both so every declared field can actually be encoded.
function pushInt(out: number[], v: bigint | number): void {
  out.push(PUSH8);
  let x = BigInt(v);
  for (let i = 0; i < 8; i++) {
    out.push(Number(x & 0xffn));
    x >>= 8n;
  }
}
function pushBytes32(out: number[], b: Uint8Array): void {
  if (b.length !== 32) throw new Error("bytes32 must be 32 bytes");
  out.push(PUSH32, ...b);
}
function leToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i] ?? 0);
  return v;
}
