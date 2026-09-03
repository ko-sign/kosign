// Genesis provenance audit — the one covenant attack the scripts provably cannot see.
//
// SHARED ESM. A byte-identical copy lives at `indexer/genesisAudit.mjs` (the indexer
// ships as a standalone Docker image with its own build context, so it vendors rather
// than imports). The copy is pinned by `indexer/test/genesisAudit.test.mjs`, which
// fails on any drift — and so are the two files this module imports:
// `./treasuryTemplates.js` (the covenant templates this build publishes) and
// `@noble/hashes/blake2b`. Both packages carry them under the SAME specifiers, which
// is what keeps the vendored copy byte-identical.
//
// ── THE ATTACK ──────────────────────────────────────────────────────────────
// A treasury's covenant id is minted by rusty-kaspa's `populate_genesis_covenants`,
// whose group is { authorizing_input, outputs: Vec<u32> }. The SPENDER chooses which
// outputs join the group. Ko-sign's honest builder binds exactly one — the KoRoot at
// index 0 (tools/wasm-tx/src/lib.rs `gen_build`). Nothing in consensus requires that.
//
// `KoVault.executeProposal` authenticates a proposal input by TEMPLATE SHAPE plus
// covenant id — never by provenance. There is no opcode that exposes how an input's
// covenant binding was created; the complete covenant set is OpInputCovenantId,
// OpOutputCovenantId, OpCovOutputCount, OpCovOutputIdx, OpOutputAuthorizingInput. So a
// KoProposal-shaped P2SH whose state its author wrote himself (status = 1 Approved,
// snapThreshold = 1, owner0 = his own key) drains a vault on demand the moment it
// shares that vault's lineage.
//
// The vault carries its lineage in STATE and refuses every other one, so nobody can
// bring a covenant of his own to somebody else's vault address. That shuts the attack
// out from the outside. What it cannot shut out is the inside: the author of a genesis
// decides what that treasury's lineage IS. Two ways to poison it —
//
//   (a) bind a SECOND output at genesis, so the lineage has a member besides the
//       KoRoot, or
//   (b) bind exactly one — a forged KoProposal in the KoRoot's place.
//
// (b) is the dangerous one: it is a genuine one-member group, so the group SIZE, the
// binding set, the authorizing input and the recomputed covenant id are all exactly
// what an honest genesis produces, and the vault address it derives is a real vault
// whose lineage really is that id. Only IDENTITY separates the two — is output 0 a
// KoRoot governed by the owners the inscription names, or a contract its author wrote
// for himself? Nothing on chain answers that. This audit is the only defence — for any
// treasury, current or future.
//
// ── THE DEFENCE ─────────────────────────────────────────────────────────────
// The genesis transaction is on chain and immutable. Anyone can read it BEFORE
// depositing. This module decides, from the genesis tx alone, whether the vault
// address a user is about to pay into is the consequence of a genesis whose covenant
// domain contains exactly THIS treasury's KoRoot and nothing else.
//
// Four layers, because they fail differently:
//
//   STRUCTURAL — the reported per-output covenant bindings. Both sources expose them
//     (REST: `covenant_id` + `covenant_authorizing_input`; JSON wRPC getBlock(s):
//     `output.covenant = {covenantId, authorizingInput}`). Requires exactly ONE bound
//     output, at index 0, one authorizing input — plus: at most two outputs, and a
//     second output that is ordinary change (never P2SH, never covenant-bound).
//     Catches (a) when the source is honest.
//
//   COVENANT-ID RECOMPUTE — `covenant_id` is
//         blake2b-256(key="CovenantID")( genesis_outpoint.txid ‖ index_le32 ‖
//             len_le64(n) ‖ for each: idx_le32 ‖ value_le64 ‖ spkVersion_le16 ‖
//             len_le64(spk) ‖ spk )
//     (consensus/core/src/hashing/covenant_id.rs). It commits to the NUMBER and the
//     exact content of the authorized outputs, so a two-member group cannot produce
//     the id a one-member group produces. Recomputing it over {output 0} catches (a)
//     even when the source hides the extra output.
//
//   MEMBER IDENTITY — the layer that catches (b), and the only one that can. The
//     genesis payload carries the KOSGN inscription: version, threshold, ownerCount,
//     the covenant lineage and the owner keys. From it, and from the covenant
//     templates THIS BUILD publishes (./treasuryTemplates.js), the member is
//     re-derived exactly as the honest builder minted it — the KoRoot at proposal
//     nonce 0 with the inscribed policy — and its P2SH script hash must EQUAL the
//     script hash genesis actually paid. A P2SH address IS blake2b-256(redeemScript),
//     so this is a cryptographic identity check, not a shape check: the creator writes
//     the inscription, but he cannot make a forged KoProposal hash to the KoRoot that
//     inscription derives. (Same derivation, same soundness argument as
//     scripts/treasury-version.mjs.)
//
//   VAULT DERIVATION — the layer that ties the other three to the money. The vault is
//     not an output of the genesis and cannot be: a covenant id hashes the
//     scriptPubKeys of its own genesis group, so a vault whose state IS that id would
//     have to contain a hash of itself. KoRoot.bootstrapVault mints it one transaction
//     later, as a continuation, stamping the id in. The vault address is therefore
//     P2SH(prefix ‖ push32 ‖ lineage ‖ suffix) — a pure FUNCTION of the genesis. The
//     audit derives it and requires it to BE the address being opened. So an auditor
//     never looks for the vault in the genesis, he computes it; and a transaction that
//     derives some other address was simply never this vault's genesis.
//
// What the audit CANNOT prove: that the creator did not hand the vault address to
// someone else, that the inscribed owner keys are who they claim to be, or anything at
// all about a genesis it cannot fetch. It proves one thing exactly — this vault address
// is the consequence of THIS genesis, and that genesis's covenant domain holds this
// treasury's KoRoot and no other member — and that is the property
// `KoVault.executeProposal` assumes and cannot check.
import { blake2b } from "@noble/hashes/blake2b";
import { TEMPLATES } from "./treasuryTemplates.js";

/** Bump when the RULES change: consumers use it in their verdict-cache key. */
export const GENESIS_AUDIT_VERSION = 4;

/** Honest genesis layout (`gen_build` in tools/wasm-tx/src/lib.rs). */
export const ROOT_OUTPUT_INDEX = 0;
// The vault is NOT a genesis output. A covenant id hashes the scriptPubKeys of its
// own genesis group, so a vault built around the id cannot be inside that group.
// Genesis binds the ROOT alone; KoRoot.bootstrapVault mints the vault afterwards as
// a continuation. That inversion is what lets an auditor DERIVE the vault address
// from the genesis instead of merely observing it there.
export const CHANGE_OUTPUT_INDEX = 1;
export const AUTHORIZING_INPUT_INDEX = 0;
/** the KoRoot + (optional) one ordinary change output back to the funder. */
export const MAX_GENESIS_OUTPUTS = 2;
/** The genesis KoRoot is minted at proposal nonce 0 — every later root is a spend of it. */
export const GENESIS_ROOT_NONCE = 0;

const ZERO_ID = "0".repeat(64);
/** "KOSGN" — the recovery-inscription magic (tools/wasm-tx/src/lib.rs `inscription`). */
export const KOSGN_MAGIC = "4b4f53474e";
/** NUMS point: the dead key every unused owner slot is padded with (wasmTx.js). */
export const NUMS_OWNER = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
/** KoRoot/KoProposal carry five owner slots regardless of ownerCount. */
export const OWNER_SLOTS = 5;

/**
 * @typedef {Object} AuditOutput
 * @property {number} index
 * @property {number} value              sompi
 * @property {number} spkVersion         ScriptPublicKey version (0 in practice)
 * @property {string} spkHex             script bytes, WITHOUT the version prefix
 * @property {string|null} address
 * @property {string|null} covenantId    64-hex, or null when unbound
 * @property {number|null} authorizingInput
 */

/**
 * @typedef {Object} AuditTx
 * @property {string|null} txid
 * @property {string|null} payload
 * @property {{txid: string|null, index: number|null, address: string|null}[]} inputs
 * @property {AuditOutput[]} outputs
 * @property {boolean} covenantFieldsPresent  does the SOURCE report per-output bindings?
 * @property {"rest"|"rpc"} source
 */

/**
 * @typedef {Object} AuditCheck
 * @property {string} id
 * @property {"pass"|"fail"|"skip"} state
 * @property {string} note
 */

/**
 * @typedef {Object} Inscription
 * @property {number} version
 * @property {number} threshold
 * @property {number} ownerCount
 * @property {string} lineage     64-hex covenant id the treasury transacts under
 * @property {string[]} owners    x-only pubkeys, 64-hex each
 */

/**
 * @typedef {Object} AuditVerdict
 * @property {boolean} ok                     true only for verdict === "clean"
 * @property {"clean"|"refused"|"unverified"} verdict
 * @property {string|null} code               machine-readable failure code
 * @property {string} reason                  one sentence, safe to show a user
 * @property {AuditCheck[]} checks
 * @property {string|null} treasuryId
 * @property {string|null} rootAddress
 * @property {string|null} vaultAddress
 * @property {string|null} vaultScriptHash   the 32-byte P2SH script hash the genesis DERIVES
 * @property {string|null} changeAddress
 * @property {string|null} genesisTxid
 * @property {boolean} identified             were BOTH members re-derived and matched?
 * @property {boolean} independentId          was the covenant id supplied by a source
 *                                            independent of the genesis transaction?
 * @property {boolean} cryptographic          identified AND recomputed against an
 *                                            independent covenant id — full assurance
 * @property {number} version
 */

// ---------------------------------------------------------------- byte helpers

const HEX_RE = /^[0-9a-f]*$/;

/** @param {string} hex @returns {Uint8Array} */
export function hexToBytes(hex) {
  const clean = String(hex ?? "").toLowerCase().replace(/^0x/, "");
  if (clean.length % 2 !== 0 || !HEX_RE.test(clean)) throw new Error(`not hex: ${String(hex).slice(0, 24)}…`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** @param {Uint8Array} b @returns {string} */
export function bytesToHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** @param {string|null|undefined} h @returns {string|null} */
const norm64 = (h) => {
  const s = String(h ?? "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
};

// ------------------------------------------------------------------- hashing
// Kaspa's P2SH commitment and `OpBlake2b` are plain blake2b-256 (crypto/txscript/
// src/standard.rs: `Params::new().hash_length(32)`); every `kaspa_hashes` domain
// hasher is the same construction KEYED with the domain string. Both live here so
// no caller can accidentally run the audit with a weaker set of checks — an audit
// whose assurance depends on what the caller remembered to inject is exactly the
// hole this module exists to close.

/** blake2b-256, unkeyed — the P2SH redeem-script commitment. @param {Uint8Array} data */
export const blake2b256 = (data) => blake2b(data, { dkLen: 32 });
/** blake2b-256 keyed with a `kaspa_hashes` domain. @param {Uint8Array} data @param {Uint8Array} key */
export const blake2b256Keyed = (data, key) => blake2b(data, { dkLen: 32, key });

/** blake2b-256 of a hex-encoded script. @param {string} hex @returns {string} 64-hex */
export const hashScriptHex = (hex) => bytesToHex(blake2b256(hexToBytes(hex)));

// ------------------------------------------------------------- script shapes

/**
 * Classify a scriptPublicKey by its BYTES, never by the source's own label — the
 * label is exactly the thing a hostile indexer would get wrong.
 *   P2SH        aa 20 <32-byte blake2b> 87                (35 bytes)
 *   P2PK        20 <32-byte x-only>     ac                (34 bytes)
 *   P2PK-ECDSA  21 <33-byte compressed> ab                (35 bytes)
 * @param {string} spkHex script bytes WITHOUT the version prefix
 * @returns {"p2sh"|"p2pk"|"p2pk-ecdsa"|"other"}
 */
export function scriptKind(spkHex) {
  const s = String(spkHex ?? "").toLowerCase();
  if (s.length === 70 && s.startsWith("aa20") && s.endsWith("87")) return "p2sh";
  if (s.length === 68 && s.startsWith("20") && s.endsWith("ac")) return "p2pk";
  if (s.length === 70 && s.startsWith("21") && s.endsWith("ab")) return "p2pk-ecdsa";
  return "other";
}

/**
 * The 32-byte redeem-script hash a P2SH output commits to, or null when the script
 * is not P2SH. This IS the script's identity: two P2SH outputs pay the same contract
 * iff this value matches.
 * @param {string} spkHex @returns {string|null}
 */
export function p2shScriptHash(spkHex) {
  if (scriptKind(spkHex) !== "p2sh") return null;
  return String(spkHex).toLowerCase().slice(4, 68);
}

// -------------------------------------------------------------- the inscription

/**
 * Decode a KOSGN recovery inscription from a genesis payload. Mirrors
 * tools/wasm-tx/src/lib.rs `encode_recovery` and frontend/src/kaspaRest.js:
 *   "KOSGN"(5) | ver(1) | threshold(1) | ownerCount(1) | lineage[32] | owners[32*n]
 * The 32-byte slot is the covenant id the genesis mints, so it is a claim an auditor
 * can recompute from the chain rather than a number only its author knows.
 * @param {string|null|undefined} payloadHex
 * @returns {Inscription|null}
 */
export function decodeInscription(payloadHex) {
  if (!payloadHex || typeof payloadHex !== "string") return null;
  const hex = payloadHex.toLowerCase();
  if (!hex.startsWith(KOSGN_MAGIC) || !HEX_RE.test(hex) || hex.length % 2 !== 0) return null;
  const byteLen = hex.length / 2;
  if (byteLen < 40) return null;
  const version = parseInt(hex.slice(10, 12), 16);
  const threshold = parseInt(hex.slice(12, 14), 16);
  const ownerCount = parseInt(hex.slice(14, 16), 16);
  if (ownerCount < 1 || ownerCount > OWNER_SLOTS) return null;
  if (threshold < 1 || threshold > ownerCount) return null;
  if (byteLen !== 40 + ownerCount * 32) return null;
  const lineage = hex.slice(16, 80);
  /** @type {string[]} */
  const owners = [];
  for (let i = 0; i < ownerCount; i++) {
    const off = (40 + i * 32) * 2;
    owners.push(hex.slice(off, off + 64));
  }
  return { version, threshold, ownerCount, lineage, owners };
}

// ------------------------------------------------------- member re-derivation
// Byte-for-byte the same reconstruction frontend/src/treasuryRebuild.js does (and
// scripts/treasury-version.mjs through it); `packages/descriptor/test/genesis.test.ts`
// pins the two against each other and against a real on-chain treasury.

/** @param {string} h */
const pad2 = (h) => h.padStart(2, "0");
/** Silverscript int in state: OP_PUSHBYTES_8 ‖ 8 LE bytes. @param {number|bigint} v */
const encInt = (v) => {
  let n = BigInt(v), h = "08";
  for (let i = 0; i < 8; i++) { h += pad2((Number(n & 0xffn)).toString(16)); n >>= 8n; }
  return h;
};
/** Silverscript bytes32 in state: OP_PUSHBYTES_32 ‖ 32 bytes. @param {string} hex */
const encB32 = (hex) => {
  if (hex.length !== 64) throw new Error(`bytes32 must be 32 bytes, got ${hex.length / 2}`);
  return "20" + hex;
};

/**
 * KoRoot redeem script for a given policy at a given proposal nonce.
 * @param {number} nonce
 * @param {number} threshold
 * @param {number} ownerCount
 * @param {string[]} owners5   exactly OWNER_SLOTS x-only keys, NUMS-padded
 * @param {typeof TEMPLATES} [templates]
 * @returns {string} redeem script hex
 */
export function rebuildRootRedeem(nonce, threshold, ownerCount, owners5, templates = TEMPLATES) {
  if (owners5.length !== OWNER_SLOTS) throw new Error(`rootState needs ${OWNER_SLOTS} owner slots`);
  const state = encInt(nonce) + encInt(threshold) + encInt(ownerCount) + owners5.map(encB32).join("");
  return templates.root.prefix + state + templates.root.suffix;
}

/**
 * KoVault redeem script for a covenant lineage — prefix ‖ push32 ‖ id ‖ suffix.
 *
 * The lineage is the vault's STATE and the vault refuses to work under any other,
 * so this is a bijection: one covenant id, one vault address, and no second lineage
 * can ever transact at it. That is the property the whole audit rests on — an
 * auditor does not look for the vault in the genesis, he DERIVES it, and a forged
 * genesis simply yields a different address than the one being opened.
 *
 * @param {string} lineageHex 64-hex covenant id
 * @param {typeof TEMPLATES} [templates]
 * @returns {string} redeem script hex
 */
export function rebuildVaultRedeem(lineageHex, templates = TEMPLATES) {
  const id = norm64(lineageHex);
  if (!id) throw new Error("lineage is not a 32-byte hex covenant id");
  return templates.vault.prefix + encB32(id) + templates.vault.suffix;
}

/**
 * The vault address a covenant lineage derives, as a P2SH script hash + spk.
 * @param {string} lineageHex
 * @param {typeof TEMPLATES} [templates]
 */
export function deriveVaultFromLineage(lineageHex, templates = TEMPLATES) {
  const vaultRedeem = rebuildVaultRedeem(lineageHex, templates);
  const vaultHash = hashScriptHex(vaultRedeem);
  return { vaultRedeem, vaultHash, vaultSpkHex: `aa20${vaultHash}87` };
}

/**
 * The single covenant member an honest genesis pays: this treasury's KoRoot, at
 * nonce 0, for the policy the genesis itself inscribes. Derived from that
 * inscription plus the templates this build publishes.
 *
 * The vault is deliberately absent — see rebuildVaultRedeem. It is derived from
 * the covenant id the genesis MINTS, which makes the vault address a consequence
 * of the genesis rather than a claim about it.
 *
 * @param {Inscription} ins
 * @param {typeof TEMPLATES} [templates]
 */
export function deriveGenesisMembers(ins, templates = TEMPLATES) {
  const owners5 = ins.owners.slice(0, OWNER_SLOTS);
  while (owners5.length < OWNER_SLOTS) owners5.push(NUMS_OWNER);
  const rootRedeem = rebuildRootRedeem(GENESIS_ROOT_NONCE, ins.threshold, ins.ownerCount, owners5, templates);
  const rootHash = hashScriptHex(rootRedeem);
  return { rootRedeem, rootHash, rootSpkHex: `aa20${rootHash}87` };
}

// ------------------------------------------------------------- normalization

/**
 * REST indexer (api[-tn10].kaspa.org) `full-transactions` / `transactions/{id}`.
 * NOTE the REST `script_public_key` carries NO version prefix and the API exposes
 * no version field, so version 0 is assumed — true for every script Kaspa mints
 * today, and a wrong assumption can only cause a covenant-id MISMATCH (a refusal
 * to open), never a missed forgery.
 * @param {any} tx
 * @returns {AuditTx}
 */
export function normalizeRestGenesisTx(tx) {
  const outs = Array.isArray(tx?.outputs) ? tx.outputs : [];
  const ins = Array.isArray(tx?.inputs) ? tx.inputs : [];
  return {
    txid: tx?.transaction_id ?? null,
    payload: typeof tx?.payload === "string" ? tx.payload : null,
    source: "rest",
    // "covenant_authorizing_input" is present-and-null on unbound outputs, absent
    // entirely on an API too old to report bindings — those are NOT the same thing.
    covenantFieldsPresent: outs.some((/** @type {any} */ o) => "covenant_id" in (o ?? {}) && "covenant_authorizing_input" in (o ?? {})),
    inputs: ins.map((/** @type {any} */ i) => ({
      txid: norm64(i?.previous_outpoint_hash),
      index: i?.previous_outpoint_index == null ? null : Number(i.previous_outpoint_index),
      address: i?.previous_outpoint_address ?? null,
    })),
    outputs: outs.map((/** @type {any} */ o, /** @type {number} */ n) => ({
      index: o?.index == null ? n : Number(o.index),
      value: Number(o?.amount ?? 0),
      spkVersion: 0,
      spkHex: String(o?.script_public_key ?? "").toLowerCase(),
      address: o?.script_public_key_address ?? null,
      covenantId: norm64(o?.covenant_id),
      authorizingInput: o?.covenant_authorizing_input == null ? null : Number(o.covenant_authorizing_input),
    })),
  };
}

/**
 * JSON wRPC `getBlock`/`getBlocks` transaction (RpcTransaction). Here the
 * scriptPublicKey hex DOES carry the u16 version prefix (big-endian, matching
 * rusty-kaspa's ScriptPublicKey serde) and the binding is a nested object.
 * @param {any} tx
 * @returns {AuditTx}
 */
export function normalizeRpcGenesisTx(tx) {
  const outs = Array.isArray(tx?.outputs) ? tx.outputs : [];
  const ins = Array.isArray(tx?.inputs) ? tx.inputs : [];
  return {
    txid: tx?.verboseData?.transactionId ?? tx?.transactionId ?? null,
    payload: typeof tx?.payload === "string" ? tx.payload : null,
    source: "rpc",
    covenantFieldsPresent: outs.some((/** @type {any} */ o) => "covenant" in (o ?? {})),
    inputs: ins.map((/** @type {any} */ i) => ({
      txid: norm64(i?.previousOutpoint?.transactionId),
      index: i?.previousOutpoint?.index == null ? null : Number(i.previousOutpoint.index),
      address: i?.verboseData?.scriptPublicKeyAddress ?? null,
    })),
    outputs: outs.map((/** @type {any} */ o, /** @type {number} */ n) => {
      const raw = String(o?.scriptPublicKey ?? "").toLowerCase();
      return {
        index: n,
        value: Number(o?.value ?? 0),
        spkVersion: raw.length >= 4 ? parseInt(raw.slice(0, 4), 16) : 0,
        spkHex: raw.length >= 4 ? raw.slice(4) : "",
        address: o?.verboseData?.scriptPublicKeyAddress ?? null,
        covenantId: norm64(o?.covenant?.covenantId),
        authorizingInput: o?.covenant?.authorizingInput == null ? null : Number(o.covenant.authorizingInput),
      };
    }),
  };
}

// ------------------------------------------------------- covenant id recompute

/**
 * Recompute a covenant id exactly as consensus does
 * (consensus/core/src/hashing/covenant_id.rs + hashing/mod.rs HasherExtensions:
 * every integer little-endian, `write_var_bytes` = u64 length then bytes,
 * `kaspa_hashes::CovenantID` = blake2b-256 keyed with the ASCII "CovenantID").
 *
 * Validated against live TN10 genesis 38d06bdc…ff72 → 8ff0e529…48e0.
 *
 * @param {{txid: string, index: number}} outpoint  the AUTHORIZING input's outpoint
 * @param {{index: number, value: number, spkVersion: number, spkHex: string}[]} authOutputs
 * @param {(message: Uint8Array, key: Uint8Array) => Uint8Array} [keyedHasher]
 * @returns {string} 64-hex covenant id
 */
export function computeCovenantId(outpoint, authOutputs, keyedHasher = blake2b256Keyed) {
  /** @type {Uint8Array[]} */
  const parts = [];
  const le = (/** @type {bigint|number} */ v, /** @type {number} */ bytes) => {
    const b = new Uint8Array(bytes);
    let n = BigInt(v);
    for (let i = 0; i < bytes; i++) { b[i] = Number(n & 0xffn); n >>= 8n; }
    return b;
  };
  parts.push(hexToBytes(outpoint.txid));
  parts.push(le(outpoint.index, 4));
  parts.push(le(authOutputs.length, 8)); // write_len
  for (const o of authOutputs) {
    const script = hexToBytes(o.spkHex);
    parts.push(le(o.index, 4), le(o.value, 8), le(o.spkVersion, 2), le(script.length, 8), script);
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const msg = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { msg.set(p, off); off += p.length; }
  const key = new Uint8Array([0x43, 0x6f, 0x76, 0x65, 0x6e, 0x61, 0x6e, 0x74, 0x49, 0x44]); // "CovenantID"
  return bytesToHex(keyedHasher(msg, key));
}

// ------------------------------------------------------------------- the audit

/**
 * Decide whether a genesis transaction minted an honest, single-member covenant
 * domain whose member is THIS treasury's KoRoot — and whether the covenant id it
 * minted is the one the vault being opened is built around. REFUSE means "do not
 * open this treasury and never show a deposit address"; UNVERIFIED means "we could
 * not establish either way" — also not safe to deposit into, but not evidence of an
 * attack, and the only verdict a caller may let a user acknowledge and continue past.
 *
 * @param {AuditTx} tx  normalized genesis transaction
 * @param {Object} [opts]
 * @param {string} [opts.vaultAddress]   the address the user is trying to open (for messages)
 * @param {string} [opts.vaultScriptHash] that address's 32-byte P2SH script hash, hex —
 *                                        the value the audit DERIVES from the genesis
 *                                        and compares. This is what ties the
 *                                        transaction to the money; without it the
 *                                        verdict cannot be cryptographic.
 * @param {string} [opts.treasuryId]     covenant id observed INDEPENDENTLY of `tx` —
 *                                        a live vault UTXO read from your own node.
 *                                        Handing back the id the same source that
 *                                        supplied `tx` reported is not independent and
 *                                        must not be passed here: it would upgrade the
 *                                        verdict to "cryptographic" on no new evidence.
 * @returns {AuditVerdict}
 */
export function auditGenesis(tx, opts = {}) {
  /** @type {AuditCheck[]} */
  const checks = [];
  const pass = (/** @type {string} */ id, /** @type {string} */ note) => { checks.push({ id, state: "pass", note }); };
  const skip = (/** @type {string} */ id, /** @type {string} */ note) => { checks.push({ id, state: "skip", note }); };
  const outs = tx.outputs || [];
  const root = outs[ROOT_OUTPUT_INDEX];
  const independent = opts.treasuryId ? norm64(opts.treasuryId) : null;
  /** @type {{vaultRedeem: string, vaultHash: string, vaultSpkHex: string}|null} */
  let derivedVault = null;

  /** @type {(code: string, reason: string, verdict?: "refused"|"unverified") => AuditVerdict} */
  const stop = (code, reason, verdict = "refused") => {
    checks.push({ id: code, state: "fail", note: reason });
    return {
      ok: false, verdict, code, reason, checks,
      treasuryId: root?.covenantId ?? independent ?? null,
      rootAddress: root?.address ?? null,
      vaultAddress: opts.vaultAddress ?? null,
      vaultScriptHash: null,
      changeAddress: outs[CHANGE_OUTPUT_INDEX]?.address ?? null,
      genesisTxid: tx.txid ?? null,
      identified: false,
      independentId: !!independent,
      cryptographic: false,
      version: GENESIS_AUDIT_VERSION,
    };
  };

  // ---- 1. output count -----------------------------------------------------
  // An honest genesis pays the KoRoot and (unless the change was folded into the
  // fee) the funder. There is no vault output: the vault cannot exist until the id
  // this transaction mints exists.
  if (outs.length < 1) return stop("too-few-outputs", `genesis has ${outs.length} output(s); an honest Ko-sign genesis pays the KoRoot.`);
  if (outs.length > MAX_GENESIS_OUTPUTS) {
    return stop("extra-outputs", `genesis has ${outs.length} outputs; an honest one has at most ${MAX_GENESIS_OUTPUTS} (KoRoot, change back to the funder).`);
  }
  pass("output-count", `${outs.length} output(s) (max ${MAX_GENESIS_OUTPUTS}).`);

  // ---- 2. output 0 is a P2SH script ----------------------------------------
  // Shape only — WHICH contract it is, is layer 5.
  if (!root || scriptKind(root.spkHex) !== "p2sh") return stop("root-not-p2sh", "genesis output 0 is not a P2SH script — it cannot be this treasury's KoRoot.");
  pass("layout", "output 0 is a covenant P2SH script.");

  // ---- 3. the reported binding set is exactly {root} ------------------------
  let reportedId = null;
  if (tx.covenantFieldsPresent) {
    const bound = outs.filter((o) => !!o.covenantId).map((o) => o.index);
    if (bound.length !== 1 || bound[0] !== ROOT_OUTPUT_INDEX) {
      return stop("bad-covenant-group", `genesis bound ${bound.length} output(s) [${bound.join(", ")}] into the covenant; an honest genesis binds exactly output 0. Any other member is a contract the creator smuggled into this treasury's covenant domain — and KoVault cannot tell a smuggled proposal from a real one.`);
    }
    if (!root.covenantId || root.covenantId === ZERO_ID) {
      return stop("covenant-id-split", "genesis output 0 carries no covenant id — nothing was minted here.");
    }
    if (root.authorizingInput !== AUTHORIZING_INPUT_INDEX) {
      return stop("bad-authorizing-input", `the covenant was authorized by input ${root.authorizingInput}; an honest genesis authorizes from input ${AUTHORIZING_INPUT_INDEX}.`);
    }
    reportedId = root.covenantId;
    pass("covenant-group", `exactly 1 covenant member (output 0), id ${reportedId.slice(0, 16)}…, authorized by input ${AUTHORIZING_INPUT_INDEX}.`);
  } else {
    skip("covenant-group", "this source does not report per-output covenant bindings.");
  }

  // ---- 4. the second output is ordinary change -----------------------------
  const change = outs[CHANGE_OUTPUT_INDEX];
  if (change) {
    const kind = scriptKind(change.spkHex);
    if (kind === "p2sh") {
      return stop("extra-p2sh-output", "genesis output 1 is a SECOND P2SH script. An honest genesis pays change to an ordinary wallet address; a script output here is how a forged proposal is smuggled into the treasury's covenant.");
    }
    if (kind === "other") return stop("change-not-wallet", "genesis output 1 is neither a wallet payment nor recognisable change — an honest genesis returns change to the funder's address.");
    if (change.covenantId) return stop("change-covenant-bound", "genesis output 1 carries a covenant binding; change must be plain, unbound value.");
    pass("change-output", `output 1 is ordinary ${kind} change${change.address ? ` to ${change.address}` : ""}.`);
  } else {
    pass("change-output", "no change output (folded into the fee).");
  }

  // ---- 5. member identity: output 0 IS this build's KoRoot -----------------
  // Everything above is satisfied by a genuine one-member group. It says nothing
  // about WHICH contract that member is, and a group of one forged KoProposal
  // satisfies every check so far. Re-derive the KoRoot from the inscription this
  // genesis carries plus the templates this build publishes, and require the P2SH
  // script hashes to be EQUAL. The creator writes the inscription, but no proposal
  // can hash to the KoRoot that inscription derives.
  const ins = decodeInscription(tx.payload);
  if (!ins) {
    return stop(
      "genesis-not-inscribed",
      "this genesis carries no decodable KOSGN inscription, so its covenant member cannot be re-derived and identified. Without it there is nothing to prove output 0 is this treasury's KoRoot rather than a contract its creator wrote for himself.",
    );
  }
  let members;
  try {
    members = deriveGenesisMembers(ins);
  } catch (e) {
    return stop("members-underivable", `the KOSGN inscription decoded but its covenant member could not be re-derived (${String(e && /** @type {any} */ (e).message || e)}).`, "unverified");
  }
  const rootHash = p2shScriptHash(root.spkHex);
  if (rootHash !== members.rootHash) {
    return stop(
      "not-this-build",
      `genesis output 0 does not reconstruct under the covenant templates this build publishes: expected the KoRoot for the inscribed ${ins.threshold}-of-${ins.ownerCount} policy (script hash ${members.rootHash.slice(0, 16)}…), found ${String(rootHash).slice(0, 16)}…. Either a different build of the contracts minted this treasury — run scripts/treasury-version.mjs to tell — or output 0 is not a KoRoot at all. Either way this build cannot identify what governs the money, so it will not certify the genesis.`,
    );
  }
  pass("member-identity", `output 0 is the KoRoot the inscription derives (${ins.threshold}-of-${ins.ownerCount}, nonce ${GENESIS_ROOT_NONCE}), re-derived from this build's templates and matched by P2SH script hash.`);

  // ---- 6. covenant id recompute --------------------------------------------
  // covenant_id commits to the COUNT and the exact content of the authorized
  // outputs, so recomputing it over {output 0} and getting the id the treasury
  // carries proves the group had no second member.
  let computed = null;
  const funding = tx.inputs?.[AUTHORIZING_INPUT_INDEX];
  if (!funding?.txid || funding.index == null) {
    skip("covenant-id-recompute", "the genesis funding outpoint is not available from this source.");
  } else {
    try {
      computed = computeCovenantId(
        { txid: funding.txid, index: funding.index },
        [{ index: ROOT_OUTPUT_INDEX, value: root.value, spkVersion: root.spkVersion, spkHex: root.spkHex }],
      );
    } catch (e) {
      return stop("covenant-id-uncomputable", `could not recompute the covenant id from the genesis (${String(e && /** @type {any} */ (e).message || e)}).`, "unverified");
    }
    // Compare against what THIS source reported for output 0, and nothing else. An
    // id a caller observed elsewhere is weighed below, after the address has settled
    // which lineage governs the money — feeding it in here would let a stranger's
    // parked covenant refuse an honest genesis before that ever runs.
    const claimed = reportedId;
    if (claimed && computed !== claimed) {
      return stop(
        "covenant-id-mismatch",
        `the covenant id recomputed from {output 0} is ${computed.slice(0, 16)}… but this treasury carries ${claimed.slice(0, 16)}…. The genesis therefore bound something BEYOND output 0 into this covenant — a second member KoVault would accept as a genuine proposal.`,
      );
    }
    pass("covenant-id-recompute", `covenant id recomputed from {output 0} is ${computed.slice(0, 16)}… — the covenant domain provably has exactly this one member.`);
  }

  // ---- 7. the vault address IS this genesis's consequence ------------------
  // The layer that removes the last piece of trust. Every check above establishes
  // facts about a transaction someone handed us; none of them, on its own, ties that
  // transaction to the address the user is about to pay into. A stateless vault could
  // not be tied to one at all: its address would commit to nothing but itself, any
  // number of covenants could transact at it, and "this genesis is honest" would never
  // have implied "and it governs your money".
  //
  // The vault carries its lineage in state, so its address is a pure function of the
  // id THIS genesis mints. Derive it and require equality. A forged genesis does not
  // fail this check by being detectably forged — it fails by deriving a different
  // address, which is to say it was never this treasury's genesis at all. There is
  // exactly one genesis per vault address, and this establishes which.
  const wantHash = norm64(opts.vaultScriptHash);
  if (!computed) {
    skip("vault-derivation", "the covenant id could not be recomputed, so the vault address it derives could not be checked.");
  } else if (!wantHash) {
    skip("vault-derivation", "the caller did not say which vault address it is opening, so the derived address could not be compared against it.");
  } else {
    let derived;
    try {
      derived = deriveVaultFromLineage(computed);
    } catch (e) {
      return stop("vault-underivable", `the vault address could not be derived from the covenant id (${String(e && /** @type {any} */ (e).message || e)}).`, "unverified");
    }
    if (derived.vaultHash !== wantHash) {
      return stop(
        "vault-not-from-this-genesis",
        `this genesis mints covenant id ${computed.slice(0, 16)}…, whose vault address has script hash ${derived.vaultHash.slice(0, 16)}… — but the vault being opened is ${wantHash.slice(0, 16)}…. A vault address is derived from its lineage and accepts no other, so this transaction is not that vault's genesis.`,
      );
    }
    derivedVault = derived;
    pass("vault-derivation", `the vault being opened is exactly the address covenant id ${computed.slice(0, 16)}… derives — so this transaction, and no other, is its genesis.`);
  }

  // ---- 8. an independently observed id, weighed AFTER the derivation --------
  // A caller may hand us the covenant id it saw on a live UTXO at this address. That
  // used to be the strongest evidence available and a contradiction was fatal. It is
  // no longer either.
  //
  // A vault address is derived from ONE lineage, but consensus lets anyone create an
  // output at any address, so a stranger can park a covenant of his own making at
  // this one. Such a UTXO is already dead — KoVault refuses it on the way in
  // (`cid0 == lineage`) and on the way out (`cid == lineage`), which is proven on
  // chain — but a caller that scans the address and reports the first covenant id it
  // finds can hand us his instead of the treasury's. Refusing on that would let
  // anyone brand an HONEST treasury as forged for the price of the dust, permanently
  // and in public. So once the address itself has established the lineage, a foreign
  // id observed there is noise and is reported as such.
  //
  // Where the derivation could NOT run, the contradiction is still the only evidence
  // there is, and it still counts.
  const anchorId = computed ?? reportedId;
  if (independent && anchorId) {
    if (independent === anchorId) {
      pass("independent-covenant-id", `a source independent of this genesis reports the live treasury carries ${independent.slice(0, 16)}… — the same id this genesis mints.`);
    } else if (derivedVault) {
      pass("independent-covenant-id", `a UTXO carrying ${independent.slice(0, 16)}… sits at this address, which is NOT this treasury's lineage. Anyone may park one there and nobody can ever spend it, so it says nothing about the genesis — the address itself already proves which covenant governs the money.`);
    } else {
      return stop("treasury-id-mismatch", `the live treasury carries covenant id ${independent.slice(0, 16)}… but this genesis mints ${anchorId.slice(0, 16)}…, and the vault address could not be derived to settle which is this vault's. Not safe to open.`);
    }
  } else if (!independent) {
    skip("independent-covenant-id", "no covenant id from a source independent of this one — not needed once the vault address derives from the genesis, but it would corroborate that the treasury is live.");
  }

  // ---- verdict -------------------------------------------------------------
  if (!tx.covenantFieldsPresent && !computed) {
    return stop("unverifiable", "neither the covenant bindings nor the funding outpoint were available, so the genesis covenant group could not be established.", "unverified");
  }
  // A caller that handed over a vault script hash asked one question above every
  // other: is this transaction THAT address's genesis? Layer 7 answers it by
  // deriving the vault address from the id the genesis mints. When the funding
  // outpoint never arrived the id could never be recomputed, layer 7 was skipped,
  // and the question went unanswered — but "clean" answers it anyway, and callers
  // are told that clean is the verdict they may act on.
  //
  // The two cases are indistinguishable from here. An honest source reporting the
  // genesis in part, and a hostile one withholding the single field that would
  // REFUSE it, produce byte-identical input — so they must receive the same
  // verdict, and it must not be the one that unlocks a deposit address. Withheld,
  // that one field disables all three of the checks that tie this transaction to
  // this address: the id recompute, the vault derivation, and the independent
  // node reading (liveTreasuryId filters the node's ids by the lineage this
  // genesis derives, which is now null, so it corroborates nothing).
  //
  // This costs an honest user nothing, which is what makes it safe to demand:
  // locating the genesis at all already required previous_outpoint_hash on the
  // mint transaction, from the same endpoint and the same response shape. A
  // source that supplies it once supplies it twice. Supplying it for the mint and
  // withholding it for the genesis is an asymmetry no honest indexer produces.
  if (wantHash && !derivedVault) {
    return stop(
      "vault-binding-unestablished",
      "this genesis could not be tied to the address being opened: the source did not report the outpoint the genesis spends, so the covenant id it mints could not be recomputed — and a vault address is derived from exactly that id. Everything else about the transaction checks out, which is precisely why this is not enough: an unrelated genesis that checks out equally well would look identical here.",
      "unverified",
    );
  }
  // "cryptographic" no longer needs a second opinion about the treasury's id: the
  // address the user typed IS the second opinion, because only one lineage derives it.
  const cryptographic = !!computed && !!derivedVault;
  return {
    ok: true, verdict: "clean", code: null,
    reason: cryptographic
      ? "genesis verified: output 0 is this treasury's KoRoot, it is the covenant's only member, and the id it mints derives exactly the vault address being opened — so this transaction is provably that vault's genesis."
      : "genesis structurally verified: output 0 was re-derived from the on-chain inscription and matched as this treasury's KoRoot, but the vault address it derives could not be checked here — so nothing yet ties this transaction to the money.",
    checks,
    treasuryId: computed ?? independent ?? reportedId,
    rootAddress: root.address ?? null,
    vaultAddress: opts.vaultAddress ?? null,
    vaultScriptHash: derivedVault?.vaultHash ?? null,
    changeAddress: change?.address ?? null,
    genesisTxid: tx.txid ?? null,
    identified: true,
    independentId: !!independent,
    cryptographic,
    version: GENESIS_AUDIT_VERSION,
  };
}
