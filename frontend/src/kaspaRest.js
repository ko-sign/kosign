// Backend-free treasury recovery straight from the chain via the public TN10 REST
// indexer (api-tn10.kaspa.org). Given a vault address we fetch its transactions,
// find the genesis tx carrying the KOSGN recovery inscription in its payload, and
// decode the treasury's config (owners, threshold, covenant lineage) — no backend
// / .secrets needed. CORS is open on the API, so the browser calls it directly.
// See docs/RECOVERY.md for the inscription format this decodes.
import { getNetwork } from "./network.js";
import { decodeInscription, ROOT_OUTPUT_INDEX, NUMS_OWNER, OWNER_SLOTS } from "../../packages/descriptor/src/genesis.js";
const KOSGN_MAGIC = "4b4f53474e"; // "KOSGN"

export const restJson = async (path) => {
  // the indexer can HANG on addresses it is still indexing (fresh treasuries) — time out
  // so callers can retry instead of spinning forever
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(`${getNetwork().rest}${path}`, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
};
const getJson = restJson;

// Locate a vault's GENESIS transaction — the tx whose payload carries the KOSGN
// inscription. Everything that reasons about a treasury's origin (recovery AND the
// genesis provenance audit in genesisAudit.js) starts here.
//
// The genesis does not pay this address, and cannot: a covenant id hashes the
// scriptPubKeys of its own genesis group, so a vault whose state IS that id can
// never sit inside the group that mints it. KoRoot.bootstrapVault mints it one
// transaction later, as a continuation. Reaching the genesis therefore means
// walking backwards through the two transactions that create a treasury:
//
//   the vault's history → the OLDEST covenant payment to it, which is the
//   bootstrapVault transaction that minted it → the KoRoot that transaction spent
//   at input 0, whose outpoint NAMES the genesis and whose address is where that
//   genesis is → the genesis itself.
//
// Every hop is a hint and nothing more. What settles it is the audit: it recomputes
// the covenant id the returned transaction mints, derives the vault address that id
// (and only it) produces, and refuses anything that does not derive the address
// being opened. So a wrong hop cannot be certified as a genesis — it can only fail.
// Returns the raw REST transaction (inputs/outputs incl. covenant bindings) or null.
const historyPage = (address, before, limit) =>
  getJson(`/addresses/${address}/full-transactions?limit=${limit}&resolve_previous_outpoints=no${before ? `&before=${before}` : ""}`);

// The bootstrapVault transaction that minted `vaultAddress`: the OLDEST covenant
// payment to it. Deposits arrive unbound, and every later covenant payment (a
// sweep, a proposal execution) is younger, so the oldest bound one is the mint.
// Only a walk that reaches the END of the history can name the oldest, so a walk
// that runs out of pages returns null rather than a guess — a later covenant
// payment would send the second hop looking for a genesis behind the wrong root.
async function fetchVaultMint(vaultAddress, pages, limit) {
  let before = null, mint = null, mintAt = Infinity, walkedAll = false;
  for (let page = 0; page < pages; page++) {
    const txs = await historyPage(vaultAddress, before, limit);
    if (!Array.isArray(txs) || !txs.length) { walkedAll = true; break; }
    for (const t of txs) {
      const bound = (t.outputs || []).some((o) => o.script_public_key_address === vaultAddress && o.covenant_id);
      const at = Number(t.block_time || 0);
      if (bound && at && at <= mintAt) { mint = t; mintAt = at; }
    }
    if (txs.length < limit) { walkedAll = true; break; } // walked the whole history
    before = Math.min(...txs.map((t) => t.block_time || Infinity));
    if (!Number.isFinite(before)) { walkedAll = true; break; }
  }
  return walkedAll ? mint : null;
}

export async function fetchGenesisTx(vaultAddress, { pages = 4, limit = 500 } = {}) {
  const mint = await fetchVaultMint(vaultAddress, pages, limit);
  if (!mint) return null;
  // bootstrapVault continues the KoRoot UNCHANGED at output 0, so the mint repays
  // the very address the genesis paid, and the outpoint it spent at input 0 names
  // the genesis transaction. Match that txid rather than "the first KOSGN payload
  // in that history": anyone may pay the root address and any payment may carry any
  // payload, and a candidate picked by payload alone is a stranger's to choose.
  const genesisTxid = String(mint.inputs?.[0]?.previous_outpoint_hash ?? "").toLowerCase();
  const rootAddress = (mint.outputs || [])
    .find((o, n) => (o.index == null ? n : Number(o.index)) === ROOT_OUTPUT_INDEX)?.script_public_key_address;
  if (!/^[0-9a-f]{64}$/.test(genesisTxid) || !rootAddress) return null;
  let before = null;
  for (let page = 0; page < pages; page++) {
    const txs = await historyPage(rootAddress, before, limit);
    if (!Array.isArray(txs) || !txs.length) return null;
    const hit = txs.find((t) => String(t.transaction_id ?? "").toLowerCase() === genesisTxid);
    if (hit) return typeof hit.payload === "string" && hit.payload.toLowerCase().startsWith(KOSGN_MAGIC) ? hit : null;
    if (txs.length < limit) return null; // walked the whole history
    before = Math.min(...txs.map((t) => t.block_time || Infinity));
    if (!Number.isFinite(before)) return null;
  }
  return null;
}

// The KOSGN v1 inscription decoder is the genesis auditor's own:
//   "KOSGN"(5) | ver(1) | threshold(1) | ownerCount(1) | lineage[32] | owners[32*n]
// The audit REBUILDS a treasury's covenant scripts from these exact fields and
// refuses the genesis unless the rebuilt scripts ARE the ones it paid — so a second
// decoder here that disagreed by one byte would mean the app recovers a treasury the
// audit did not certify. One implementation, no drift.
//
// The 32-byte slot is the treasury's covenant LINEAGE — the id its genesis minted,
// which the vault holds in state and which its address is derived from. It is
// therefore a claim an auditor can check against the chain, not a number only its
// creator knows.
export { decodeInscription };

// On-chain activity of an address straight from the REST indexer — powers the
// Assets → "On-chain activity" feed. Each entry carries the signed net movement
// for `address` (negative = out of the wallet) plus everything the detail modal
// shows (fee, mass, blue score, accepting block, full inputs/outputs).
export async function fetchAddressActivity(address, limit = 25) {
  const txs = await getJson(`/addresses/${address}/full-transactions?limit=${limit}&resolve_previous_outpoints=light`);
  return (txs || []).map((t) => {
    const ins = t.inputs || [], outs = t.outputs || [];
    const inSelf = outs.filter((o) => o.script_public_key_address === address).reduce((a, o) => a + Number(o.amount), 0);
    const outSelf = ins.filter((i) => i.previous_outpoint_address === address).reduce((a, i) => a + Number(i.previous_outpoint_amount), 0);
    const inTotal = ins.reduce((a, i) => a + Number(i.previous_outpoint_amount || 0), 0);
    const outTotal = outs.reduce((a, o) => a + Number(o.amount), 0);
    // classify the tx from the vault's perspective so the UI can say "sweep"
    // instead of a meaningless "+0": vault-input spends that keep (almost) all
    // value at the address are consolidations, not transfers.
    const net = inSelf - outSelf;
    const vaultIns = ins.filter((i) => i.previous_outpoint_address === address);
    const covenantOutHere = outs.some((o) => o.script_public_key_address === address && o.covenant_id);
    const absorbed = vaultIns.filter((i) => !i.covenant_id).reduce((a, i) => a + Number(i.previous_outpoint_amount), 0);
    const kind = !vaultIns.length
      ? (covenantOutHere ? "genesis" : "in") // funds arrived: covenant mint vs plain deposit
      : (covenantOutHere && net <= 0 && net >= -10_000_000 ? "sweep" : net < 0 ? "out" : "in");
    return {
      txid: t.transaction_id, hash: t.hash,
      net, // sompi; < 0 = funds left this address
      kind, absorbed, // "genesis" | "in" | "sweep" | "out"; absorbed = strays folded in by a sweep
      fee: ins.length && inTotal >= outTotal ? inTotal - outTotal : null, // coinbase / unresolved → null
      mass: t.mass != null ? Number(t.mass) : null,
      accepted: !!t.is_accepted,
      time: t.block_time ?? null,
      subnetworkId: t.subnetwork_id,
      blueScore: t.accepting_block_blue_score ?? null,
      acceptingBlockHash: t.accepting_block_hash || null,
      acceptingBlockTime: t.accepting_block_time ?? null,
      blockHashes: t.block_hash || [],
      covenant: ins.some((i) => i.covenant_id) || outs.some((o) => o.covenant_id),
      inputs: ins.map((i) => ({ address: i.previous_outpoint_address || null, amount: i.previous_outpoint_amount != null ? Number(i.previous_outpoint_amount) : null, covenant: !!i.covenant_id })),
      outputs: outs.map((o) => ({ address: o.script_public_key_address || null, amount: Number(o.amount), covenant: !!o.covenant_id })),
    };
  }).sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
}

// Just the vault balance (sompi) from the indexer — used to keep the read-only
// (backend-free) view live without re-pulling the whole transaction list.
export async function fetchBalance(vaultAddress) {
  try {
    const b = await getJson(`/addresses/${vaultAddress}/balance`);
    return Number(b.balance);
  } catch { return null; }
}

// Recover a read-only treasury view for `vaultAddress` from the chain. Returns
// { ok:true, status } shaped like the backend's status, or { ok:false, reason }.
//
// THE POLICY THIS RETURNS IS THE GENESIS POLICY. The inscription is the anchor a
// treasury is rebuilt from, so it is written once and never rewritten — while the
// owner set it names is not: KoRoot.executeConfig installs a new one at every
// signer change, in a continuation the genesis cannot know about. Read the
// inscription alone and you get the owners a treasury was BORN with, for the rest
// of its life; a treasury that added D and removed C still reports [A, B, C].
//
// So the shape below says which one it is, and carries what a caller needs to go
// find the current one: `policySource` names the source, `genesisPolicy` holds the
// walk's anchor — the txid to start from, the NUMS-padded owner slots the KoRoot
// state is rebuilt from, and the lineage that pins the continuation to THIS
// treasury. proposalScan.walkRoot takes exactly those and follows the KoRoot
// forward through every executeConfig to the live owner set (that is what the
// node-direct path does via seedFromChain, and it is chain-proven). A caller with
// no node cannot make that walk — it must then present this as the genesis policy
// and say so, never as the current signer set.
//
// `threshold` / `owners` stay at the top level with the same values, for callers
// that already read the anchor under those names.
export async function recoverTreasuryFromChain(vaultAddress) {
  if (!vaultAddress || !vaultAddress.startsWith("kaspa")) return { ok: false, reason: "bad-address" };
  let genesis;
  try {
    genesis = await fetchGenesisTx(vaultAddress);
  } catch (e) {
    return { ok: false, reason: "fetch-failed", error: String(e?.message ?? e) };
  }
  if (!genesis) return { ok: false, reason: "no-inscription" };
  const rec = decodeInscription(genesis.payload);
  if (!rec) return { ok: false, reason: "bad-inscription" };

  let balanceSompi = null;
  try {
    const b = await getJson(`/addresses/${vaultAddress}/balance`);
    balanceSompi = Number(b.balance);
  } catch { /* balance is best-effort */ }

  const genesisTxId = genesis.transaction_id || genesis.hash || null;
  const owners5 = rec.owners.slice(0, OWNER_SLOTS);
  while (owners5.length < OWNER_SLOTS) owners5.push(NUMS_OWNER);

  return {
    ok: true,
    status: {
      recovered: true,
      network: "testnet-10",
      treasuryId: null,
      // where the owner set and threshold below come from. The inscription is the
      // only thing this function reads, so "genesis" is the only value it can
      // return — a status carrying it has NOT been walked forward to the current
      // KoRoot and must not be rendered as the treasury's current signers.
      policySource: "genesis",
      // the policy the treasury was born with, plus the anchor for the walk to the
      // current one (proposalScan.walkRoot: genesisTxid + owners5 + lineage)
      genesisPolicy: {
        threshold: rec.threshold,
        ownerCount: rec.ownerCount,
        owners: rec.owners,
        owners5, // the 5 KoRoot state slots, NUMS-padded — what rebuildRoot takes
        genesisTxid: genesisTxId,
        lineage: rec.lineage,
      },
      threshold: rec.threshold,
      owners: rec.owners.map((pk) => ({ pubkey: pk })),
      vault: { address: vaultAddress, balanceSompi, unsweptSompi: 0 },
      root: null,
      proposals: [],
      history: [],
      fundingAddress: null,
      genesisTxId,
      // the covenant id this treasury transacts under, and the only value its vault
      // address can be derived from — see deriveVaultFromLineage
      lineage: rec.lineage,
    },
  };
}
