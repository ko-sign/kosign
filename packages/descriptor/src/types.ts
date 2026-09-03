// Shapes mirroring the Silverscript compiler's JSON artifact (silverscript-lang
// CompiledContract) and the Ko-sign descriptor.

/** A compiled Silverscript contract artifact (output of `silc contract.sil`). */
export interface CompiledArtifact {
  contract_name: string;
  compiler_version: string;
  /** Redeem-script bytecode (with the concrete initial state baked in). */
  script: number[];
  abi: { name: string; inputs: { name: string; type_name: string }[] }[];
  without_selector: boolean;
  /** Contiguous byte range of the mutable state region inside `script`. */
  state_layout: { start: number; len: number };
}

/**
 * Everything KoVault / KoRoot need in order to verify or mint a foreign
 * KoProposal, derived from a compiled KoProposal artifact. Invariant across
 * proposals of one treasury (depends only on owners + threshold, NOT on treasuryId or
 * per-proposal state — verified in tests).
 */
export interface TemplateInfo {
  /** length of the immutable script prefix before the state region */
  prefixLen: number;
  /** length of the immutable script suffix after the state region */
  suffixLen: number;
  /** fixed encoded length of the state region (constant for a given contract) */
  stateLen: number;
  /** blake2b256(prefix ‖ suffix) — the `expectedTemplateHash` argument */
  templateHash: Uint8Array;
  /** raw immutable prefix bytes (for validateOutputStateWithTemplate) */
  prefix: Uint8Array;
  /** raw immutable suffix bytes (for validateOutputStateWithTemplate) */
  suffix: Uint8Array;
}

/** A treasury's immutable configuration. */
export interface TreasuryConfig {
  /** sorted, deduplicated owner pubkeys (x-only Schnorr, 32 bytes), padded to 5 */
  owners: Uint8Array[];
  threshold: number;
  network: "testnet-10" | "testnet-12" | "mainnet";
}

export const MAX_OWNERS = 5;

export enum Operation {
  TRANSFER_KAS = 1,
  MIGRATE_TREASURY = 2,
}

export enum ProposalStatus {
  Pending = 0,
  Approved = 1,
  Cancelled = 2,
  ExecutedOrClosed = 3,
}

/** KoProposal state field order — MUST match KoProposal.sil / the struct
 *  mirrors in KoVault.sil and KoRoot.sil. The descriptor uses this list to
 *  encode/decode proposal state and to assert the artifact's state length. */
export const PROPOSAL_STATE_FIELDS = [
  { name: "proposalId", kind: "int" },
  { name: "operation", kind: "int" },
  { name: "recipientSpkHash", kind: "bytes32" },
  { name: "amount", kind: "int" },
  { name: "maxFee", kind: "int" },
  { name: "expiresAt", kind: "int" },
  { name: "executionDelay", kind: "int" },
  { name: "approvalBitmap", kind: "int" },
  { name: "approvalCount", kind: "int" },
  { name: "status", kind: "int" },
  // owner snapshot (mutable owners — taken from KoRoot at creation)
  { name: "snapThreshold", kind: "int" },
  { name: "ownerCount", kind: "int" },
  { name: "owner0", kind: "bytes32" },
  { name: "owner1", kind: "bytes32" },
  { name: "owner2", kind: "bytes32" },
  { name: "owner3", kind: "bytes32" },
  { name: "owner4", kind: "bytes32" },
  // rejection tally (mirrors approval) — owners vote approve XOR reject
  { name: "rejectBitmap", kind: "int" },
  { name: "rejectCount", kind: "int" },
  // blake2b of this treasury's vault redeem — closeExpired pays the bond back to
  // it. Written by KoRoot.createProposal from the hash-pinned vault template.
  { name: "vaultSpkHash", kind: "bytes32" },
] as const;

/** KoRoot state field order — owners + threshold now live here (mutable),
 *  MUST match KoRoot.sil. */
export const ROOT_STATE_FIELDS = [
  { name: "proposalNonce", kind: "int" },
  { name: "threshold", kind: "int" },
  { name: "ownerCount", kind: "int" },
  { name: "owner0", kind: "bytes32" },
  { name: "owner1", kind: "bytes32" },
  { name: "owner2", kind: "bytes32" },
  { name: "owner3", kind: "bytes32" },
  { name: "owner4", kind: "bytes32" },
] as const;
