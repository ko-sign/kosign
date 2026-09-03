// ===========================================================================
// covenant-fixtures — primitives for BUILDING signed contract test fixtures.
//
// Used by scripts/gen-koroot-tests.mjs. Everything here exists because the
// fixtures in contracts/*.test.json carry REAL BIP340 signatures over a REAL
// Kaspa sighash, so they can only be produced, never hand-edited. See the
// header of gen-koroot-tests.mjs for the full why.
//
// Three pieces:
//   compile()            — shells out to the DEBUGGER's compiler (silc_dbg),
//                          returning script bytes + state layout.
//   encode*/encodeProposalState — mirrors the compiler's state-region encoding
//                          so a continuation output's redeem script can be
//                          spliced together byte-for-byte.
//   sighash()/sign()     — reimplements consensus/core/src/hashing/sighash.rs
//                          (keyed blake2b, domain "TransactionSigningHash").
// ===========================================================================
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SILC_DBG = REPO + '/.tooling/silverscript/target/debug/examples/silc_dbg';

// ---- dependency resolution -------------------------------------------------
// @noble/* is not a root dependency (it lives in frontend/ and packages/
// descriptor/), and pnpm's strict node_modules layout means a bare import from
// scripts/ cannot see it. Resolve it by walking the workspaces that DO declare
// it, falling back to the pnpm store. No new root dependency, no hard-coded
// version in a path.
function pkgDirs(pkg) {
  const dirs = [];
  for (const base of ['', '/frontend', '/packages/descriptor', '/backend']) {
    const d = `${REPO}${base}/node_modules/${pkg}`;
    if (existsSync(d)) dirs.push(d);
  }
  const store = REPO + '/node_modules/.pnpm';
  if (existsSync(store)) {
    const flat = pkg.replace('/', '+');
    for (const e of readdirSync(store).filter((e) => e.startsWith(flat + '@')).sort().reverse()) {
      const d = `${store}/${e}/node_modules/${pkg}`;
      if (existsSync(d)) dirs.push(d);
    }
  }
  return dirs;
}

/** import a subpath of a package that the repo root cannot resolve directly. */
async function importFrom(pkg, file) {
  for (const dir of pkgDirs(pkg)) {
    for (const rel of [`esm/${file}`, file]) {           // v1 dual layout, then v2 ESM-only
      const p = join(dir, rel);
      if (existsSync(p)) return await import(pathToFileURL(p).href);
    }
  }
  throw new Error(`cannot locate ${pkg}/${file} — run \`pnpm install\` at the repo root`);
}

const { blake2b } = await importFrom('@noble/hashes', 'blake2.js');
const { sha256 } = await importFrom('@noble/hashes', 'sha2.js');
const { schnorr } = await importFrom('@noble/curves', 'secp256k1.js');

// ---- bytes -----------------------------------------------------------------
export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const fromHex = (h) => { const c = h.startsWith('0x') ? h.slice(2) : h; const o = new Uint8Array(c.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16); return o; };
export const cat = (...arrs) => { const n = arrs.reduce((a, b) => a + b.length, 0); const o = new Uint8Array(n); let k = 0; for (const a of arrs) { o.set(a, k); k += a.length; } return o; };
export const rep = (byte, n) => new Uint8Array(n).fill(byte);

export const blake2b256 = (d) => blake2b(d, { dkLen: 32 });
const DOMAIN = new TextEncoder().encode('TransactionSigningHash');
export const txSigHash = (d) => blake2b(d, { dkLen: 32, key: DOMAIN });
export const ZERO32 = new Uint8Array(32);

export const u8  = (n) => Uint8Array.from([n & 0xff]);
export const u16 = (n) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; };
export const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
export const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
export const i64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(n), true); return b; };
export const varBytes = (b) => cat(u64(b.length), b);

/** P2SH scriptPubKey SCRIPT bytes (script version 0 is carried separately). */
export const p2shScript = (redeem) => cat(Uint8Array.from([0xaa, 0x20]), blake2b256(redeem), Uint8Array.from([0x87]));

// ---- silc ctor-arg encoding ------------------------------------------------
export const B = (v) => ({ t: 'b', v });
export const I = (v) => ({ t: 'i', v });
const silcArg = (a) => a.t === 'b'
  ? { kind: 'array', data: Array.from(a.v, (x) => ({ kind: 'byte', data: x })) }
  : { kind: 'int', data: Number(a.v) };
export const fixtureArg = (a) => (a.t === 'b' ? '0x' + hex(a.v) : Number(a.v));
export const fixtureArgs = (args) => args.map(fixtureArg);

const TMP = mkdtempSync(join(tmpdir(), 'covenant-fixtures-'));
const scriptCache = new Map();

/**
 * Compile a contract THE WAY THE DEBUGGER DOES (record_debug_infos: true).
 * Not interchangeable with scripts/compile.sh's silc — see gen-koroot-tests.mjs.
 */
export function compile(silPath, args) {
  if (!existsSync(SILC_DBG)) {
    throw new Error(`missing ${SILC_DBG}\n  build it with: pnpm build:compiler`);
  }
  const key = silPath + '|' + JSON.stringify(args.map(fixtureArg));
  if (scriptCache.has(key)) return scriptCache.get(key);
  const argPath = join(TMP, 'ctor.json');
  writeFileSync(argPath, JSON.stringify(args.map(silcArg)));
  const out = execFileSync(SILC_DBG, [silPath, argPath], { maxBuffer: 64 * 1024 * 1024 }).toString();
  let parsed;
  try { parsed = JSON.parse(out); } catch { throw new Error('silc_dbg failed: ' + out.slice(0, 400)); }
  const res = { script: Uint8Array.from(parsed.script), layout: parsed.state_layout };
  scriptCache.set(key, res);
  return res;
}

// ---- state encoding (mirrors compile_encoded_object_with_layout) -----------
export const encInt = (v) => { const b = new Uint8Array(9); b[0] = 0x08; new DataView(b.buffer).setBigInt64(1, BigInt(v), true); return b; };
export const encB8  = (v) => { if (v.length !== 8) throw new Error('byte[8]'); return cat(Uint8Array.from([0x08]), v); };
export const encB32 = (v) => { if (v.length !== 32) throw new Error('byte[32]'); return cat(Uint8Array.from([0x20]), v); };

/** KoProposal state region — field order is contractually fixed. */
export function encodeProposalState(s) {
  return cat(
    encInt(s.proposalId), encInt(s.operation), encB32(s.recipientSpkHash), encInt(s.amount),
    encInt(s.maxFee), encInt(s.expiresAt), encInt(s.executionDelay), encB8(s.approvalBitmap),
    encInt(s.approvalCount), encInt(s.status), encInt(s.snapThreshold), encInt(s.ownerCount),
    encB32(s.owner0), encB32(s.owner1), encB32(s.owner2), encB32(s.owner3), encB32(s.owner4),
    encB8(s.rejectBitmap), encInt(s.rejectCount), encB32(s.vaultSpkHash),
  );
}

// ---- kaspa schnorr sighash (consensus/core/src/hashing/sighash.rs) ---------
// The debugger's synthetic transactions are version 1, so sig_op_counts are NOT
// hashed and outputs DO carry their covenant binding.
export function sighash(tx, inputIndex) {
  const prevOuts = txSigHash(cat(...tx.inputs.map((i) => cat(i.prevTxid, u32(i.prevIndex)))));
  const seqs = txSigHash(cat(...tx.inputs.map((i) => u64(i.sequence))));
  const outs = txSigHash(cat(...tx.outputs.map((o) => cat(
    u64(o.value), u16(0), varBytes(o.script),
    ...(tx.version >= 1
      ? [Uint8Array.from([o.covenantId ? 1 : 0]),
         ...(o.covenantId ? [u16(o.authorizingInput ?? inputIndex), o.covenantId] : [])]
      : []),
  ))));
  const inp = tx.inputs[inputIndex];
  return txSigHash(cat(
    u16(tx.version), prevOuts, seqs,
    inp.prevTxid, u32(inp.prevIndex),
    u16(0), varBytes(inp.utxoScript),
    u64(inp.value), u64(inp.sequence),
    outs, u64(tx.lockTime ?? 0),
    new Uint8Array(20), u64(0), ZERO32, u8(1),
  ));
}

/** BIP340 signature + the trailing sighash-type byte the VM expects. */
export function sign(msgHash, sk) {
  return cat(schnorr.sign(msgHash, sk, new Uint8Array(32)), Uint8Array.from([0x01]));
}

/** Deterministic throwaway test keys — never used on any network. */
export function ownerKey(i) {
  const sk = sha256(new TextEncoder().encode('kosafe-koroot-test-owner-' + i));
  return { sk, pk: schnorr.getPublicKey(sk) };
}
