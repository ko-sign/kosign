import { blake2b256 } from "./hash.js";
import type { CompiledArtifact, TemplateInfo } from "./types.js";

const OP_BLAKE2B = 0xaa;
const OP_EQUAL = 0x87;

/**
 * Split a compiled artifact into the covenant template (immutable prefix+suffix
 * with the mutable state region removed) and derive the values needed to read
 * or mint this template from another contract.
 *
 * Mirrors silverscript-lang compile.rs exactly:
 *   prefix = script[0 .. state_layout.start]
 *   suffix = script[state_layout.start + state_layout.len ..]
 *   templateHash = blake2b256(prefix ‖ suffix)
 *
 * Because Silverscript encodes state with fixed-width fields, the prefix/suffix
 * (and therefore templateHash) are invariant across all instances that share
 * the same immutable constructor config — see test/template.test.ts.
 */
export function deriveTemplate(artifact: CompiledArtifact): TemplateInfo {
  const script = Uint8Array.from(artifact.script);
  const { start, len } = artifact.state_layout;
  if (start < 0 || len < 0 || start + len > script.length) {
    throw new Error(`invalid state_layout {start:${start}, len:${len}} for script of ${script.length} bytes`);
  }
  const prefix = script.slice(0, start);
  const suffix = script.slice(start + len);
  const template = concat(prefix, suffix);
  return {
    prefixLen: prefix.length,
    suffixLen: suffix.length,
    stateLen: len,
    templateHash: blake2b256(template),
    prefix,
    suffix,
  };
}

/** blake2b256 of the full redeem script (with concrete state) — the P2SH commit. */
export function redeemScriptHash(artifact: CompiledArtifact): Uint8Array {
  return blake2b256(Uint8Array.from(artifact.script));
}

/**
 * The version-prefixed scriptPubKey introspection returns for a P2SH output,
 * matching the compiler's `ScriptPubKeyP2SHFromRedeemScript` codegen:
 *   00 00            (ScriptPublicKey version 0, big-endian u16)
 *   aa               (OpBlake2b)
 *   20               (push 32)
 *   <32-byte hash>
 *   87               (OpEqual)
 *
 * NOTE: the version prefix is included because tx introspection compares the
 * full version-prefixed spk. Confirm the version bytes on TN10. See RISKS.md.
 */
export function p2shScriptPubKey(artifact: CompiledArtifact): Uint8Array {
  const h = redeemScriptHash(artifact);
  const out = new Uint8Array(2 + 1 + 1 + 32 + 1);
  out[0] = 0x00;
  out[1] = 0x00;
  out[2] = OP_BLAKE2B;
  out[3] = 0x20;
  out.set(h, 4);
  out[4 + 32] = OP_EQUAL;
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
