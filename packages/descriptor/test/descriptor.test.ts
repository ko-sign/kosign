import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { deriveTemplate, p2shScriptPubKey } from "../src/template.js";
import { blake2b256, toHex } from "../src/hash.js";
import { decodeProposalState, encodeProposalState, proposalStateEncodedLen, type ProposalState } from "../src/state.js";
import { Operation, ProposalStatus, type CompiledArtifact } from "../src/types.js";
import { koProposalArgs, koRootArgs, koVaultArgs, type Expr } from "../src/ctorArgs.js";

const here = dirname(fileURLToPath(import.meta.url));
const artifactsDir = resolve(here, "../../../artifacts");
// Artifacts are local build output (not committed), so absent means "skip".
// An interrupted `pnpm compile:contracts` can leave a truncated file behind —
// treat that the same way instead of failing the whole suite on JSON.parse.
const load = (name: string): CompiledArtifact | null => {
  const p = resolve(artifactsDir, `${name}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as CompiledArtifact;
  } catch {
    return null;
  }
};

describe("template derivation (pure)", () => {
  it("splits prefix/state/suffix and hashes prefix‖suffix", () => {
    // synthetic: script = [P0 P1 | S0 S1 S2 | F0 F1], state region [2,5)
    const script = [0xaa, 0xbb, 0x11, 0x22, 0x33, 0xcc, 0xdd];
    const artifact = { script, state_layout: { start: 2, len: 3 } } as CompiledArtifact;
    const t = deriveTemplate(artifact);
    expect(t.prefixLen).toBe(2);
    expect(t.suffixLen).toBe(2);
    expect(t.stateLen).toBe(3);
    expect([...t.prefix]).toEqual([0xaa, 0xbb]);
    expect([...t.suffix]).toEqual([0xcc, 0xdd]);
    expect(toHex(t.templateHash)).toBe(toHex(blake2b256(Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd]))));
  });

  it("p2sh spk has the 00 00 aa 20 <hash> 87 shape", () => {
    const artifact = { script: [1, 2, 3], state_layout: { start: 0, len: 0 } } as CompiledArtifact;
    const spk = p2shScriptPubKey(artifact);
    expect(spk.length).toBe(37);
    expect([spk[0], spk[1], spk[2], spk[3]]).toEqual([0x00, 0x00, 0xaa, 0x20]);
    expect(spk[36]).toBe(0x87);
  });
});

describe("proposal state encode/decode (pure)", () => {
  // 13 ints x 9B + 6 bytes32 x 33B = 315 — the mutable-owners layout (the owner
  // snapshot + reject tally live in the state; see docs/OWNER-MANAGEMENT.md).
  // Matches the compiled artifact and frontend/src/treasuryTemplates.js stateLen.
  it("encoded length matches the contract's fixed layout (348)", () => {
    expect(proposalStateEncodedLen()).toBe(348); // 19 fields + the vaultSpkHash bond-return commit (RISKS #17)
  });

  it("round-trips", () => {
    const s: ProposalState = {
      proposalId: 7n,
      operation: Operation.TRANSFER_KAS,
      recipientSpkHash: new Uint8Array(32).fill(0x5a),
      amount: 12_3456_7890n,
      maxFee: 20000n,
      expiresAt: 1_900_000_000n,
      executionDelay: 3600n,
      approvalBitmap: 0b101n,
      approvalCount: 2n,
      status: ProposalStatus.Approved,
      snapThreshold: 2n,
      ownerCount: 3n,
      owner0: new Uint8Array(32).fill(0x11),
      owner1: new Uint8Array(32).fill(0x22),
      owner2: new Uint8Array(32).fill(0x33),
      owner3: new Uint8Array(32).fill(0x44),
      owner4: new Uint8Array(32).fill(0x55),
      rejectBitmap: 0b010n,
      rejectCount: 1n,
    };
    const dec = decodeProposalState(encodeProposalState(s));
    expect(dec.proposalId).toBe(s.proposalId);
    expect(dec.amount).toBe(s.amount);
    expect(dec.approvalBitmap).toBe(s.approvalBitmap);
    expect(dec.status).toBe(ProposalStatus.Approved);
    expect(dec.operation).toBe(Operation.TRANSFER_KAS);
    expect(dec.snapThreshold).toBe(s.snapThreshold);
    expect(dec.ownerCount).toBe(s.ownerCount);
    expect(dec.owner2).toEqual(s.owner2);
    expect(dec.rejectCount).toBe(s.rejectCount);
    expect(toHex(dec.recipientSpkHash)).toBe(toHex(s.recipientSpkHash));
  });
});

// These run only when contracts have been compiled (pnpm compile:contracts).
describe("against real compiled artifacts", () => {
  const proposal = load("KoProposal");

  it.runIf(proposal)("KoProposal state region length == proposalStateEncodedLen()", () => {
    expect(proposal!.state_layout.len).toBe(proposalStateEncodedLen());
  });

  it.runIf(proposal)("deriveTemplate produces a 32-byte hash and consistent lengths", () => {
    const t = deriveTemplate(proposal!);
    expect(t.templateHash.length).toBe(32);
    expect(t.prefixLen + t.stateLen + t.suffixLen).toBe(proposal!.script.length);
  });
});

// The M-of-N policy is baked into the genesis script and, until KoRoot enforced
// these bounds itself, nothing on-chain did: a treasury could claim five owners
// while carrying threshold 0, and `threshold <= 1` mints proposals already
// Approved — one key moving funds a co-signer believed were under M-of-N.
// KoRoot now rejects such a treasury on its only proposal-creating path; this is
// the SDK-side half, so a wallet integrating @kosign/descriptor cannot mint one.
// One distinct 32-byte key per slot, and the NUMS point every real treasury
// pads its unused tail with (scripts/gen-templates.ts). Slot identity is what
// these suites are about, so the keys must actually differ — five copies of the
// same buffer would now be rejected by the distinctness rule below.
const key = (n: number) => Uint8Array.from({ length: 32 }, () => n);
const NUMS = key(0x50);
const FIVE_DISTINCT = [key(1), key(2), key(3), key(4), key(5)];
// KoRoot.bootstrapVault mints whatever vault script the SPENDER hands it and pins
// the choice with blake2b(prefix‖suffix) == vaultTemplateHash, so this constructor
// argument is the whole of what stops a treasury being bootstrapped with a vault
// somebody else wrote. Its VALUE is irrelevant to the policy suites below; its
// presence is not, because the ctor list is positional.
const VAULT_TEMPLATE_HASH = key(0x9c);

describe("genesis policy bounds", () => {
  const owners = FIVE_DISTINCT;
  const root = (threshold: number, ownerCount: number, os: Uint8Array[] = owners) =>
    koRootArgs({
      owners: os, threshold, ownerCount,
      treasuryId: new Uint8Array(32),
      proposalTemplate: {
        prefix: new Uint8Array(1), suffix: new Uint8Array(1),
        templateHash: new Uint8Array(32), prefixLen: 1, suffixLen: 1, stateLen: 315,
      },
      vaultTemplateHash: VAULT_TEMPLATE_HASH,
      maxProposalFee: 10_000_000,
      initProposalNonce: 0,
    });

  it("accepts a well-formed policy", () => {
    expect(() => root(2, 3)).not.toThrow();
    expect(() => root(1, 1)).not.toThrow();
    expect(() => root(5, 5)).not.toThrow();
  });

  it("rejects threshold 0 — it would mint proposals already Approved", () => {
    expect(() => root(0, 3)).toThrow(/threshold must be an integer in 1\.\.3/);
  });

  it("rejects a threshold above the owner count — unreachable, the treasury would be bricked", () => {
    expect(() => root(4, 3)).toThrow(/threshold must be an integer in 1\.\.3/);
  });

  it("rejects ownerCount past the last slot — ownerAt/maskFor fall through to owner 0", () => {
    expect(() => root(2, 6)).toThrow(/ownerCount must be an integer in 1\.\.5/);
    expect(() => root(1, 0)).toThrow(/ownerCount must be an integer in 1\.\.5/);
  });

  it("rejects non-integers rather than coercing them", () => {
    expect(() => root(1.5, 3)).toThrow(/threshold must be an integer/);
    expect(() => root(2, 3.5)).toThrow(/ownerCount must be an integer/);
  });
});

// Slot, not key, is the unit of identity: ownerAt(i) picks the key in slot i and
// maskFor(i) picks bit i, and the duplicate-vote guard compares BITS. One key in
// several live slots therefore votes once per slot — [A, A, A, B, C] at threshold
// 3 is a 1-of-3 treasury wearing a 3-of-5 label. KoRoot.createProposal rejects
// such a genesis on-chain (and executeConfig refuses to install one), which
// BRICKS the treasury; refusing to build the ctor args is how a wallet finds out
// before it funds anything.
describe("genesis owner distinctness", () => {
  const root = (owners: Uint8Array[], threshold: number, ownerCount: number) =>
    koRootArgs({
      owners, threshold, ownerCount,
      treasuryId: new Uint8Array(32),
      proposalTemplate: {
        prefix: new Uint8Array(1), suffix: new Uint8Array(1),
        templateHash: new Uint8Array(32), prefixLen: 1, suffixLen: 1, stateLen: 315,
      },
      vaultTemplateHash: VAULT_TEMPLATE_HASH,
      maxProposalFee: 10_000_000,
      initProposalNonce: 0,
    });

  it("rejects a key repeated INSIDE the live range — it would vote once per slot", () => {
    // [A, A, C, D, E] at ownerCount 3, threshold 3: A alone reaches the threshold.
    expect(() => root([key(1), key(1), key(3), key(4), key(5)], 3, 3)).toThrow(/owner slots 0 and 1 hold the same key/);
    // a non-adjacent pair is caught too (slots 0 and 2)
    expect(() => root([key(1), key(2), key(1), key(4), key(5)], 2, 3)).toThrow(/owner slots 0 and 2 hold the same key/);
    // and the last live pair of a full 5-owner set
    expect(() => root([key(1), key(2), key(3), key(4), key(4)], 3, 5)).toThrow(/owner slots 3 and 4 hold the same key/);
  });

  it("accepts the NUMS-padded tail every sub-5-owner treasury carries", () => {
    // 2-of-2: slots 2..4 all hold the SAME NUMS point. Comparing all five slots
    // would reject every treasury with fewer than five owners.
    expect(() => root([key(1), key(2), NUMS, NUMS, NUMS], 2, 2)).not.toThrow();
    expect(() => root([key(1), NUMS, NUMS, NUMS, NUMS], 1, 1)).not.toThrow();
    expect(() => root([key(1), key(2), key(3), NUMS, NUMS], 2, 3)).not.toThrow();
  });

  it("accepts a duplicate that sits BEYOND ownerCount — dead slots are unreachable", () => {
    // slots 3 and 4 repeat live keys, but ownerIndex < ownerCount can never
    // select them, so they carry no bit and no vote.
    expect(() => root([key(1), key(2), key(3), key(1), key(1)], 2, 3)).not.toThrow();
    // the padding may even equal a live owner's key without changing anything
    expect(() => root([key(1), key(2), key(1), key(1), key(1)], 2, 2)).not.toThrow();
  });

  it("applies to the proposal SNAPSHOT as well as the root registry", () => {
    const proposal = (owners: Uint8Array[], ownerCount: number) =>
      koProposalArgs({
        owners, threshold: 2, ownerCount,
        treasuryId: new Uint8Array(32),
        initProposalId: 1, initOperation: 1, initRecipientSpkHash: new Uint8Array(32),
        initAmount: 1, initMaxFee: 0, initExpiresAt: 0, initExecutionDelay: 0,
        initApprovalBitmap: new Uint8Array(8), initApprovalCount: 0, initStatus: 0,
      });
    expect(() => proposal([key(1), key(1), key(3), NUMS, NUMS], 3)).toThrow(/owner slots 0 and 1 hold the same key/);
    expect(() => proposal([key(1), key(2), key(3), NUMS, NUMS], 3)).not.toThrow();
  });
});

// `silc` takes constructor arguments as a positional JSON list, so a value in the
// wrong slot is not a type error — it is a different contract. Two arguments carry
// the new protocol and both are load-bearing: KoRoot's vaultTemplateHash decides
// which script bootstrapVault may mint, and KoVault's lineage is the covenant id
// the vault refuses to work outside of. Pin where they sit and what they hold.
describe("constructor argument layout", () => {
  const proposalTemplate = {
    prefix: Uint8Array.from([0xa1]), suffix: Uint8Array.from([0xa2]),
    templateHash: key(0x11), prefixLen: 1, suffixLen: 1, stateLen: 315,
  };
  const bytesOf = (e: Expr | undefined): Uint8Array => {
    if (e?.kind !== "array") throw new Error(`expected a byte array, got ${e?.kind}`);
    return Uint8Array.from(e.data, (d) => (d.kind === "byte" ? d.data : Number.NaN));
  };
  const intOf = (e: Expr | undefined): number => {
    if (e?.kind !== "int") throw new Error(`expected an int, got ${e?.kind}`);
    return e.data;
  };

  it("KoRoot: vaultTemplateHash sits between the template lengths and the fee cap", () => {
    const args = koRootArgs({
      owners: FIVE_DISTINCT, threshold: 2, ownerCount: 3,
      treasuryId: key(0x77), proposalTemplate,
      vaultTemplateHash: VAULT_TEMPLATE_HASH,
      maxProposalFee: 10_000_000, initProposalNonce: 0,
    });
    expect(intOf(args[4])).toBe(proposalTemplate.prefixLen);
    expect(intOf(args[5])).toBe(proposalTemplate.suffixLen);
    expect(bytesOf(args[6])).toEqual(VAULT_TEMPLATE_HASH);
    expect(intOf(args[7])).toBe(10_000_000); // maxProposalFee, still after it
    expect(intOf(args[8])).toBe(0); // initProposalNonce
    expect(args.length).toBe(11 + 5); // …and nothing else shifted
  });

  it("KoVault: the lineage is argument 0 — the state the vault is stamped with", () => {
    const lineage = key(0x5e);
    const args = koVaultArgs({
      lineage, proposalTemplate, maxExecutionFee: 10_000_000,
      maxDepositInputs: 16, depositMaxFee: 10_000_000,
    });
    expect(bytesOf(args[0])).toEqual(lineage);
    expect(intOf(args[1])).toBe(proposalTemplate.prefixLen);
  });

  it("KoVault: refuses a lineage that is not a 32-byte covenant id", () => {
    // A vault built around a truncated id would carry a state region of the wrong
    // length, so its address would not be the one the genesis derives — and nothing
    // downstream would ever be able to spend it.
    const args = (lineage: Uint8Array) =>
      koVaultArgs({ lineage, proposalTemplate, maxExecutionFee: 1, maxDepositInputs: 16, depositMaxFee: 1 });
    expect(() => args(new Uint8Array(31))).toThrow(/32-byte covenant id/);
    expect(() => args(new Uint8Array(0))).toThrow(/32-byte covenant id/);
    expect(() => args(new Uint8Array(32))).not.toThrow();
  });
});
