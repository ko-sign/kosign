// Genesis provenance gate — run BEFORE a treasury may be opened or shown a
// deposit address.
//
// Two things have to hold before an address is safe to pay into, and the covenant
// scripts can establish neither on their own.
//
//   WHICH GENESIS. A vault carries its covenant lineage in state, so its address is
//   a pure function of the id its genesis minted: one lineage, one vault address,
//   and no second lineage can ever transact there. That is what makes "is this
//   transaction this vault's genesis?" a question with an answer — and this gate
//   answers it by DERIVING the address from the genesis rather than accepting a
//   claim that the two belong together. Everything the app then believes about the
//   treasury (owners, threshold, what may spend it) is read out of that genesis, so
//   opening the wrong one means operating on somebody else's facts.
//
//   WHAT THAT GENESIS MINTED. The genesis spender chooses which outputs join the
//   covenant group; an honest Ko-sign genesis binds exactly one, the KoRoot. A
//   creator who smuggles a second member in — a KoProposal he wrote already-approved
//   — owns a contract the vault accepts as one of its own, and drains deposits with
//   it at will. No opcode reveals how an input's covenant binding was created (see
//   ../../packages/descriptor/src/genesis.js for the full attack), so no contract can
//   catch this; the genesis transaction, immutable and on chain, is the only place it
//   is visible. Nothing about the treasury looks wrong afterwards: the addresses, the
//   KOSGN inscription and the balances are all what an honest treasury shows.
//
// This module does the looking, before anyone can deposit:
//
//   1. locate the genesis via the KOSGN inscription (kaspaRest.fetchGenesisTx),
//   2. read the treasury's REAL covenant id from a LIVE vault UTXO over your own
//      wRPC node when one is configured — an independent source, so a hostile or
//      buggy REST indexer cannot supply both the evidence and the answer,
//   3. hand both to the shared auditor, along with the P2SH script hash of the
//      address being opened — the value it re-derives from the genesis, and the
//      only thing that ties the transaction it just read to the money.
//
// Step 2 is best-effort and fails for ordinary reasons all the time (no endpoint,
// the node errored, the vault has no UTXO there yet, the entries carry no
// covenantId). None of them is an attack, but none of them may pass for evidence
// either: the reason WHY travels with the verdict as `independent`, and the caller
// must show it.
//
// Verdicts are cached per network+vault in localStorage: a genesis is immutable,
// so "clean" and "refused" are permanent facts. "unverified" is never cached, and
// neither is a clean verdict that never got as far as deriving the vault address —
// that one is a partial answer, so it is re-run every time and completes as soon as
// the chain source supplies the whole genesis.
import { auditGenesis, normalizeRestGenesisTx, GENESIS_AUDIT_VERSION, blake2b256, computeCovenantId, ROOT_OUTPUT_INDEX, AUTHORIZING_INPUT_INDEX } from "../../packages/descriptor/src/genesis.js";
import { TEMPLATES } from "./treasuryTemplates.js";
import { fetchGenesisTx } from "./kaspaRest.js";
import { getNetworkId } from "./network.js";
import { connectWrpc } from "./wrpc.js";

// Fingerprint of the covenant templates this build derives members under. A
// verdict — above all a `not-this-build` refusal — is only valid for the
// templates that produced it, and those move independently of the audit version
// (the genesis-bounds change moved KoRoot while proposalTemplateHash stood
// still). Without this in the key, one build's refusal of an honest older
// treasury would outlive the build that made it.
const TPL_FP = (() => {
  const t = TEMPLATES;
  const canon = [t.proposalTemplateHash, t.vaultTemplateHash, t.vault?.prefix, t.vault?.suffix, t.root?.prefix, t.root?.suffix,
                 t.proposal?.prefix, t.proposal?.suffix].join("|");
  return Array.from(blake2b256(new TextEncoder().encode(canon)).slice(0, 4))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
})();

// ---- the address this gate is gating ---------------------------------------
// A Kaspa address is cashaddr-style bech32 (rusty-kaspa, crypto/addresses): a
// version byte — 8 for a script hash — followed by the payload the output commits
// to. For a vault that payload IS blake2b256(vaultRedeem), the exact value the
// auditor re-derives from the genesis, so the gate has to recover it from the
// address itself. Decoded here rather than through the wasm builder because the
// gate runs before the app is allowed to load anything.
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const ADDR_VERSION_SCRIPT_HASH = 8;

// 40-bit cashaddr checksum polymod (BigInt for the 64-bit math). A well-formed
// address polymods to zero over prefix ‖ 0 ‖ payload ‖ checksum.
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

/**
 * The 32-byte P2SH script hash an address commits to, or null for anything that
 * is not a well-formed script-hash address — a typo, a bad checksum, a plain
 * wallet address. None of those can be a vault, so null is a refusal to proceed
 * rather than a detail to paper over.
 * @param {string} address
 * @returns {string|null} 64-hex
 */
export function p2shHashFromAddress(address) {
  const [prefix, body] = String(address ?? "").toLowerCase().split(":");
  if (!prefix || !body || body.length <= 8) return null;
  /** @type {number[]} */
  const five = [];
  for (const ch of body) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) return null;
    five.push(v);
  }
  const expanded = [...[...prefix].map((ch) => ch.charCodeAt(0) & 0x1f), 0, ...five];
  if (polymod(expanded) !== 0n) return null;
  let acc = 0, bits = 0;
  /** @type {number[]} */
  const bytes = [];
  for (const v of five.slice(0, -8)) {
    acc = ((acc << 5) | v) & 0x1fff;
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
  }
  // the 5-bit regrouping is left-aligned, so the tail is padding and must be zero
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0) return null;
  if (bytes.length !== 33 || bytes[0] !== ADDR_VERSION_SCRIPT_HASH) return null;
  return bytes.slice(1).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const CACHE = (net, vault) => `kosign.genesisAudit.v${GENESIS_AUDIT_VERSION}.${TPL_FP}.${net}.${vault}`;
const OVERRIDE = (net, vault) => `kosign.genesisOverride.${net}.${vault}`;

const readCache = (net, vault) => {
  try { return JSON.parse(localStorage.getItem(CACHE(net, vault)) || "null"); } catch { return null; }
};
const writeCache = (net, vault, v) => {
  try { localStorage.setItem(CACHE(net, vault), JSON.stringify(v)); } catch { /* private mode */ }
};

// An override is only ever offered for "unverified" (we could not reach the chain).
// A REFUSED genesis has no override — that is the whole point of the gate.
export const isOverridden = (vault, net = getNetworkId()) => {
  try { return sessionStorage.getItem(OVERRIDE(net, vault)) === "1"; } catch { return false; }
};
export const setOverride = (vault, net = getNetworkId()) => {
  try { sessionStorage.setItem(OVERRIDE(net, vault), "1"); } catch { /* ignore */ }
};

/**
 * The treasury id the vault ACTUALLY carries, straight from the node's UTXO set.
 * This is the value the covenant scripts compare against, and the only genesis
 * fact we can obtain without going through the REST indexer — which is what makes
 * the covenant-id recomputation an independent check rather than a restatement of
 * what the indexer already told us.
 *
 * Best-effort, but never silently: every way this can come back empty returns a
 * REASON, because "no independent id" and "independent id matched" are different
 * security outcomes and the old code reported them identically.
 *
 * @returns {Promise<{id: string|null, why: string, note: string}>}
 */
/**
 * The covenant id a genesis transaction mints, recomputed from the transaction
 * itself. This is what a vault address is derived from, so it is also the only
 * lineage a UTXO at that address can ever be spent under.
 */
function lineageOf(atx) {
  const funding = atx.inputs?.[AUTHORIZING_INPUT_INDEX];
  const root = atx.outputs?.[ROOT_OUTPUT_INDEX];
  if (!funding?.txid || funding.index == null || !root) return null;
  try {
    return computeCovenantId({ txid: funding.txid, index: funding.index }, [
      { index: ROOT_OUTPUT_INDEX, value: root.value, spkVersion: root.spkVersion, spkHex: root.spkHex },
    ]);
  } catch { return null; }
}

/**
 * Look for a live UTXO at the vault address carrying `expected` — the lineage the
 * genesis derives — and report it as the independent corroboration.
 *
 * Deliberately NOT "the first UTXO here that carries any covenant id". Consensus
 * lets anyone create an output at any address, so a stranger can park a covenant of
 * his own making at this one for the price of the dust. It is already dead (KoVault
 * refuses it on the way in and on the way out), but reporting its id as what the
 * treasury carries would contradict the genesis and get an HONEST treasury shown as
 * forged. The lineage is the filter.
 */
async function liveTreasuryId(vaultAddress, rpcUrl, expected) {
  if (!rpcUrl) return { id: null, why: "no-endpoint", note: "no node endpoint is configured — set one with ⚙ to complete the proof." };
  if (!/^wss?:\/\//i.test(rpcUrl)) return { id: null, why: "bad-endpoint", note: `the configured endpoint (${rpcUrl}) is not a wRPC WebSocket URL.` };
  const c = connectWrpc(rpcUrl);
  try {
    await c.ready;
    const { entries } = await c.getUtxos([vaultAddress]);
    const ids = (entries || []).map((e) => String(e?.utxoEntry?.covenantId ?? "").toLowerCase()).filter(Boolean);
    if (expected && ids.includes(expected)) {
      return { id: expected, why: "ok", note: "read from your node's UTXO set." };
    }
    if (ids.length) {
      return { id: null, why: "foreign-covenant-only", note: `your node shows ${ids.length} covenant UTXO(s) at this address, none carrying this genesis's lineage — a stranger may park one here and it can never be spent, so it proves nothing either way.` };
    }
    return (entries || []).length
      ? { id: null, why: "no-covenant-field", note: "your node returned the vault's UTXOs but none carried a covenantId — this build of the node does not report covenant bindings." }
      : { id: null, why: "no-utxo", note: "the vault has no UTXO at your node yet (a treasury minted moments ago, or a node still syncing)." };
  } catch (e) {
    return { id: null, why: "rpc-error", note: `your node could not be queried (${String(e?.message ?? e)}).` };
  } finally { c.close(); }
}

/**
 * Audit `vaultAddress`'s genesis. Returns the shared auditor's verdict, extended
 * with `{ cached, checkedAt }`. Callers MUST treat anything but verdict==="clean"
 * as "do not open, do not show a deposit address".
 *
 * @param {string} vaultAddress
 * @param {{ rpcUrl?: string, force?: boolean, log?: (t: string, k?: string) => void }} [opts]
 */
export async function auditTreasuryGenesis(vaultAddress, opts = {}) {
  const { rpcUrl = "", force = false, log = () => {} } = opts;
  const net = getNetworkId();
  const unverified = (code, reason) => ({
    ok: false, verdict: "unverified", code, reason, checks: [], treasuryId: null,
    rootAddress: null, vaultAddress, vaultScriptHash: null, changeAddress: null, genesisTxid: null,
    identified: false, independentId: false, cryptographic: false,
    independent: { why: "not-reached", note: "the genesis itself could not be read, so no cross-check was attempted." },
    version: GENESIS_AUDIT_VERSION, cached: false, checkedAt: Date.now(),
  });

  if (!vaultAddress || !/^kaspa(test)?:/.test(vaultAddress)) return unverified("bad-address", "not a Kaspa address.");
  // The audit's closing step compares a script hash it derives from the genesis
  // against the one this address commits to, so the address has to yield one at
  // all. A wallet address or a mistyped one never can, and is not a vault.
  const vaultScriptHash = p2shHashFromAddress(vaultAddress);
  if (!vaultScriptHash) return unverified("bad-address", "not a Kaspa script-hash address — every Ko-sign vault is one.");

  // Only fully-established verdicts are ever cached (see writeCache below), so a hit
  // is always a final answer.
  const cached = force ? null : readCache(net, vaultAddress);
  if (cached && cached.version === GENESIS_AUDIT_VERSION) return { ...cached, cached: true };

  let genesis;
  try {
    genesis = await fetchGenesisTx(vaultAddress);
  } catch (e) {
    return unverified("fetch-failed", `could not reach the chain indexer (${String(e?.message ?? e)}).`);
  }
  if (!genesis) return unverified("no-genesis", "no KOSGN genesis transaction found for this address yet.");

  const atx = normalizeRestGenesisTx(genesis);
  const independent = await liveTreasuryId(vaultAddress, rpcUrl, lineageOf(atx));
  log(
    independent.id
      ? `genesis audit: vault covenant id ${independent.id.slice(0, 16)}… read from your node — independent cross-check available`
      : `genesis audit: NO independent covenant id — ${independent.note}`,
    independent.id ? "ok" : "warn",
  );

  const verdict = auditGenesis(atx, {
    vaultAddress,
    vaultScriptHash,
    treasuryId: independent.id || undefined,
  });
  const out = { ...verdict, independent, cached: false, checkedAt: Date.now() };
  // Immutable facts only. A REFUSED genesis is permanent. A CLEAN one is permanent
  // too — but a clean verdict that never got as far as deriving this vault's address
  // from the genesis says nothing about whether the two belong together, so it is not
  // frozen into the cache: re-running it is cheap, and a source that reports the
  // genesis in full finishes the proof.
  if (out.verdict === "refused" || (out.verdict === "clean" && out.cryptographic)) writeCache(net, vaultAddress, out);
  log(
    out.verdict === "clean"
      ? `genesis audit: ${out.reason}`
      : `genesis audit: ${out.verdict.toUpperCase()} — ${out.reason}`,
    out.verdict === "clean" ? (out.cryptographic ? "ok" : "warn") : "err",
  );
  return out;
}
