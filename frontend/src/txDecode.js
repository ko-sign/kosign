// A second, independent reading of the transaction an owner is about to authorise.
//
// The covenant enforces "no transfer without owner signatures". It cannot enforce
// "the owner meant this transfer". The wasm builder chooses the amount, the
// recipient and the covenant continuation; the sighash it returns is a hash of
// that choice, and @noble signs whatever it is handed. If the builder is wrong —
// an ordinary bug, or a blob that is not what tools/wasm-tx says it is — the
// signature is valid, the covenant is satisfied, and the money goes somewhere the
// owner never saw. Every guard in contracts/*.sil is upstream of that and none of
// them can help.
//
// So this module re-reads the finished transaction from its bytes and reports what
// it ACTUALLY does, sharing no code path with the thing that produced it: borsh is
// decoded here by hand against the rusty-kaspa layout, and addresses are rebuilt
// with this file's own cashaddr encoder. Asking the builder to describe its own
// output would not be a check — the whole value is that two independent readings
// have to agree.
//
// Borsh layout (rusty-kaspa 42b734f, consensus/core/src/tx.rs). Little-endian
// throughout; every Vec is a u32 length followed by its elements:
//
//   Transaction   u16 version | Vec<Input> | Vec<Output> | u64 lockTime
//                 | [u8;20] subnetworkId | u64 gas | Vec<u8> payload
//                 | u64 mass | [u8;32] id
//   Input         [u8;32] txid | u32 index | Vec<u8> signatureScript | u64 sequence
//                 | TxInputMass
//   TxInputMass   u8 tag; 0 => u8 SigopCount, 1 => u16 ComputeBudget
//   Output        u64 value | ScriptPublicKey | Option<CovenantBinding>
//   ScriptPubKey  u16 version | Vec<u8> script      (a manual impl, not derived)
//   Option<T>     u8; 0 => None, 1 => Some(T)
//   Covenant      u16 authorizingInput | [u8;32] covenantId

const HEX = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function reader(bytes) {
  let i = 0;
  const need = (n) => {
    if (i + n > bytes.length) throw new Error(`truncated transaction: wanted ${n} bytes at offset ${i}, ${bytes.length - i} left`);
  };
  const u8 = () => { need(1); return bytes[i++]; };
  const le = (n) => { need(n); let v = 0n; for (let k = n - 1; k >= 0; k--) v = (v << 8n) | BigInt(bytes[i + k]); i += n; return v; };
  return {
    u8,
    u16: () => Number(le(2)),
    u32: () => Number(le(4)),
    u64: () => le(8),                       // BigInt: sompi exceeds Number's exact range
    fixed: (n) => { need(n); const b = bytes.slice(i, i + n); i += n; return b; },
    vecBytes() { const n = this.u32(); return this.fixed(n); },
    vec(readOne) { const n = this.u32(); const out = []; for (let k = 0; k < n; k++) out.push(readOne()); return out; },
    get offset() { return i; },
    get remaining() { return bytes.length - i; },
  };
}

const unhex = (hex) => {
  const s = String(hex ?? "");
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error("borshHex must be an even-length hex string");
  const out = new Uint8Array(s.length / 2);
  for (let k = 0; k < out.length; k++) out[k] = parseInt(s.slice(k * 2, k * 2 + 2), 16);
  return out;
};

/**
 * Decode a borsh-serialised Kaspa transaction.
 *
 * Trailing bytes are an error rather than something to ignore: a decoder that
 * stops early would read a prefix of some other transaction as if it were the
 * whole of this one, which is exactly the confusion this module exists to prevent.
 *
 * @param {string} borshHex
 */
export function decodeTx(borshHex) {
  const r = reader(unhex(borshHex));
  const version = r.u16();
  const inputs = r.vec(() => {
    const txid = HEX(r.fixed(32));
    const index = r.u32();
    const signatureScript = HEX(r.vecBytes());
    const sequence = r.u64();
    const tag = r.u8();
    const mass = tag === 0 ? { kind: "sigOpCount", value: r.u8() }
      : tag === 1 ? { kind: "computeBudget", value: r.u16() }
        : (() => { throw new Error(`unknown TxInputMass tag ${tag}`); })();
    return { previousOutpoint: { transactionId: txid, index }, signatureScript, sequence, mass };
  });
  const outputs = r.vec(() => {
    const value = r.u64();
    const spkVersion = r.u16();
    const script = HEX(r.vecBytes());
    const has = r.u8();
    if (has !== 0 && has !== 1) throw new Error(`Option<CovenantBinding> tag must be 0 or 1, got ${has}`);
    const covenant = has === 1 ? { authorizingInput: r.u16(), covenantId: HEX(r.fixed(32)) } : null;
    return { value, scriptPublicKey: { version: spkVersion, script }, covenant };
  });
  const lockTime = r.u64();
  const subnetworkId = HEX(r.fixed(20));
  const gas = r.u64();
  const payload = HEX(r.vecBytes());
  const mass = r.u64();
  const id = HEX(r.fixed(32));
  if (r.remaining !== 0) throw new Error(`${r.remaining} trailing bytes after the transaction — this is not a single well-formed transaction`);
  return { version, inputs, outputs, lockTime, subnetworkId, gas, payload, mass, id };
}

// ---- scriptPubKey → address -------------------------------------------------
// Going this direction rather than address → script keeps the comparison in the
// units a person actually checked: the string they read on screen.
//
//   P2PK        OP_DATA_32 <32-byte schnorr key> OP_CHECKSIG    → version 0
//   P2PK-ECDSA  OP_DATA_33 <33-byte key> OP_CHECKSIG_ECDSA      → version 1
//   P2SH        OP_BLAKE2B OP_DATA_32 <32-byte hash> OP_EQUAL   → version 8
const OP_DATA_32 = 0x20, OP_DATA_33 = 0x21, OP_CHECKSIG = 0xac, OP_CHECKSIG_ECDSA = 0xab;
const OP_BLAKE2B = 0xaa, OP_EQUAL = 0x87;

/** @returns {{version: number, payload: Uint8Array}|null} */
export function spkPayload(scriptHex) {
  const s = unhex(scriptHex);
  if (s.length === 34 && s[0] === OP_DATA_32 && s[33] === OP_CHECKSIG) return { version: 0, payload: s.slice(1, 33) };
  if (s.length === 35 && s[0] === OP_DATA_33 && s[34] === OP_CHECKSIG_ECDSA) return { version: 1, payload: s.slice(1, 34) };
  if (s.length === 35 && s[0] === OP_BLAKE2B && s[1] === OP_DATA_32 && s[34] === OP_EQUAL) return { version: 8, payload: s.slice(2, 34) };
  return null;
}

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

const polymod = (values) => {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    if (c0 & 0x01n) c ^= 0x98f2bc8e61n;
    if (c0 & 0x02n) c ^= 0x79b76d99e2n;
    if (c0 & 0x04n) c ^= 0xf33e5fb3c4n;
    if (c0 & 0x08n) c ^= 0xae2eabe2a8n;
    if (c0 & 0x10n) c ^= 0x1e4f43e470n;
  }
  return c ^ 1n;
};

const to5bit = (bytes) => {
  const out = [];
  let acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 0x1f); }
  }
  if (bits) out.push((acc << (5 - bits)) & 0x1f);
  return out;
};

/**
 * The address an output pays to, or null for a script this app does not recognise.
 *
 * null is a refusal, not a detail to paper over: an output whose shape cannot be
 * named is an output whose destination cannot be shown to the person signing.
 *
 * @param {string} scriptHex
 * @param {string} prefix e.g. "kaspatest"
 */
export function addressFromSpk(scriptHex, prefix) {
  const p = spkPayload(scriptHex);
  if (!p) return null;
  const five = to5bit([p.version, ...p.payload]);
  const expanded = [...[...prefix].map((ch) => ch.charCodeAt(0) & 0x1f), 0, ...five, 0, 0, 0, 0, 0, 0, 0, 0];
  const checksum = polymod(expanded);
  const cs = [];
  for (let k = 0; k < 8; k++) cs.push(Number((checksum >> BigInt(5 * (7 - k))) & 0x1fn));
  return `${prefix}:${[...five, ...cs].map((v) => CHARSET[v]).join("")}`;
}
