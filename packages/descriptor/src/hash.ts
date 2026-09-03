// Kaspa's `OpBlake2b` computes blake2b with a 256-bit (32-byte) digest and no key.
// The compiler uses the same hash for P2SH redeem-script commitments and for
// `readInputStateWithTemplate`'s expectedTemplateHash. Keyed blake2b-256 is the
// construction behind every `kaspa_hashes` domain hasher
// (`blake2b_simd::Params::new().hash_length(32).key(domain)`, crypto/hashes/src/
// hashers.rs) — that is what mints a covenant id.
//
// Both live in genesis.js and are re-exported here, so there is exactly ONE
// implementation in the workspace. genesis.js owns them because the genesis audit
// must never depend on a caller remembering to inject a hasher: an audit whose
// assurance silently drops to "structural only" when a call site forgets an option
// is the bug class that module exists to close (see its header, and SECURITY.md →
// "Genesis provenance").
//
// VERIFIED on TN10: the node's OpBlake2b is plain blake2b-256 with no domain key or
// personalization — every P2SH address this repo derives matches the chain. See
// docs/RISKS.md "hashing assumptions".
export { blake2b256, blake2b256Keyed } from "./genesis.js";

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
