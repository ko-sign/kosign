// Discover a treasury's OPEN proposals purely from chain — the browser-side covenant
// indexer (zero backend). For each KoRoot nonce we find the createProposal tx via
// api-tn10 (a public read indexer, holds no keys), read the proposal params from its
// input witness + a self-describing payload, reconstruct the proposal redeem, then
// follow the approve chain to the current open UTXO. So any co-owner sees the others'
// pending proposals with no backend. Runs entirely in the browser tab.
import { TEMPLATES } from "./treasuryTemplates.js";
import { rebuildRoot, rebuildVault } from "./treasuryRebuild.js";
import { blake2b256 } from "../../packages/descriptor/src/genesis.js";
import { getNetwork } from "./network.js";

const rest = async (p) => { const r = await fetch(`${getNetwork().rest}${p}`); if (!r.ok) throw new Error(`REST indexer ${r.status}`); return r.json(); };

const PAD = (h) => h.padStart(2, "0");
const encInt = (v) => { let n = BigInt(v) & ((1n << 64n) - 1n); let h = "08"; for (let i = 0; i < 8; i++) { h += PAD((Number(n & 0xffn)).toString(16)); n >>= 8n; } return h; };
const encB32 = (hex) => "20" + hex;
const bytesToHex = (a) => a.map((x) => PAD(x.toString(16))).join("");
const hexToBytes = (h) => { const b = []; for (let i = 0; i < h.length; i += 2) b.push(parseInt(h.slice(i, i + 2), 16)); return b; };

// Kaspa script push parser → list of { int } | { data:hex }.
function parsePushes(hex) {
  const b = hexToBytes(hex), out = []; let i = 0;
  while (i < b.length) {
    const op = b[i++];
    if (op === 0x00) out.push({ int: 0n });
    else if (op >= 0x01 && op <= 0x4b) { out.push({ data: bytesToHex(b.slice(i, i + op)) }); i += op; }
    else if (op === 0x4c) { const n = b[i++]; out.push({ data: bytesToHex(b.slice(i, i + n)) }); i += n; }
    else if (op === 0x4d) { const n = b[i] | (b[i + 1] << 8); i += 2; out.push({ data: bytesToHex(b.slice(i, i + n)) }); i += n; }
    else if (op === 0x4f) out.push({ int: -1n });
    else if (op >= 0x51 && op <= 0x60) out.push({ int: BigInt(op - 0x50) });
    else out.push({ op });
  }
  return out;
}
function dataToInt(hex) { const d = hexToBytes(hex); if (!d.length) return 0n; let v = 0n; for (let k = 0; k < d.length; k++) v |= BigInt(d[k]) << BigInt(8 * k); if ((d[d.length - 1] & 0x80) !== 0) { v &= ~(0x80n << BigInt(8 * (d.length - 1))); v = -v; } return v; }
const asInt = (p) => (p.int !== undefined ? p.int : dataToInt(p.data));
const bitFor = (i) => 1n << BigInt(i);

// proposal state region (mirrors cp_build / KoProposal.sil field order)
function encodeProposalState(s) {
  return encInt(s.proposalId) + encInt(s.operation) + encB32(s.recipientSpkHash) + encInt(s.amount)
    + encInt(s.maxFee) + encInt(s.expiresAt) + encInt(s.executionDelay) + encInt(s.bitmap) + encInt(s.count)
    + encInt(s.status) + encInt(s.snapThreshold) + encInt(s.ownerCount) + s.owners5.map(encB32).join("")
    + encInt(s.rejectBitmap) + encInt(s.rejectCount) + encB32(s.vaultSpkHash);
}
// The bond-return commitment KoRoot writes into every proposal it mints: the
// blake2b of this treasury's vault redeem — a pure function of the lineage, so
// the scan derives it rather than trusting anything it read.
const vaultSpkHashFor = (treasuryId) => {
  const redeem = rebuildVault(treasuryId);
  const bytes = Uint8Array.from(redeem.match(/../g).map((h) => parseInt(h, 16)));
  return Array.from(blake2b256(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
};
const proposalRedeem = (s) => TEMPLATES.proposal.prefix + encodeProposalState(s) + TEMPLATES.proposal.suffix;

// proposal payload inscription: "KSPR1" | operation(1) | amount(8 LE) | recipientAddr(utf8)
const PR_MAGIC = "4b53505231"; // "KSPR1"
export function proposalPayload(operation, amountSompi, recipient) {
  let a = BigInt(amountSompi), amt = "";
  for (let i = 0; i < 8; i++) { amt += PAD((Number(a & 0xffn)).toString(16)); a >>= 8n; }
  const addr = bytesToHex(Array.from(new TextEncoder().encode(recipient || "")));
  return PR_MAGIC + PAD((operation & 0xff).toString(16)) + amt + addr;
}
function decodeProposalPayload(hex) {
  if (!hex || !hex.toLowerCase().startsWith(PR_MAGIC)) return null;
  const b = hexToBytes(hex); let o = 5;
  const operation = b[o]; o += 1;
  let amount = 0n; for (let i = 0; i < 8; i++) amount |= BigInt(b[o + i]) << BigInt(8 * i); o += 8;
  const recipient = new TextDecoder().decode(Uint8Array.from(b.slice(o)));
  return { operation, amount, recipient };
}

// Walk the KoRoot's on-chain spend history from genesis. Each createProposal
// spend advances the nonce (same owners); each executeConfig spend installs new
// owners/threshold from ITS OWN witness (nonce preserved); bootstrapVault leaves
// both alone — so the walk always lands on the CURRENT config, no matter how many
// signer changes happened. Returns the LIVE root (redeem + outpoint + config) and
// every createProposal tx with the config that was active when it was created
// (proposal state embeds it). Outpoint-anchored, so root addresses shared across
// treasuries with the same policy can't confuse it.
export async function walkRoot({ treasuryId, genesisTxid, threshold, ownerCount, owners5, p2sh, getUtxos, log = () => {} }) {
  let cfg = { threshold: Number(threshold), ownerCount: Number(ownerCount), owners5: [...owners5] };
  let nonce = 0;
  let cur = { txid: genesisTxid, index: 0 };
  const creations = [];
  for (let hops = 0; hops < 128; hops++) {
    const redeem = rebuildRoot(nonce, cfg.threshold, cfg.ownerCount, cfg.owners5);
    const addr = p2sh(redeem);
    const utxos = await getUtxos(addr);
    const live = (utxos || []).find((e) => e.outpoint?.transactionId === cur.txid && Number(e.outpoint?.index) === cur.index
      && (!treasuryId || e.utxoEntry?.covenantId === treasuryId));
    if (live) return { live: { nonce, redeem, outpoint: cur, value: Number(live.utxoEntry.amount), ...cfg }, creations };
    // spent — find the spending tx via the address history (REST indexer)
    let txs; try { txs = await rest(`/addresses/${addr}/full-transactions?limit=50&resolve_previous_outpoints=light`); } catch { return { live: null, creations }; }
    const sp = (txs || []).find((t) => t.inputs?.some((i) => i.previous_outpoint_hash === cur.txid && Number(i.previous_outpoint_index) === cur.index));
    if (!sp) return { live: null, creations }; // not indexed yet
    const si = sp.inputs.find((i) => i.previous_outpoint_hash === cur.txid && Number(i.previous_outpoint_index) === cur.index);
    const ps = parsePushes(si.signature_script);
    const sel = ps.length >= 2 ? asInt(ps[ps.length - 2]) : null; // selector sits before the revealed rootScript
    if (sel === 0n) {
      // createProposal: [proposerIndex, sig, operation, recipientSpkHash, amount,
      // maxFee, expiresAt, executionDelay, vaultTemplatePrefix, vaultTemplateSuffix,
      // SELECTOR=0, rootScript]
      creations.push({ nonce, ct: sp, witness: ps, ...cfg, owners5: [...cfg.owners5] });
      nonce += 1;
    } else if (sel === 1n) {
      // bootstrapVault: [ownerIndex, sig, vaultTemplatePrefix, vaultTemplateSuffix,
      // SELECTOR=1, rootScript]. It mints the vault and continues the root UNCHANGED
      // — same nonce, same config — so the walk only follows the outpoint. Every
      // treasury has one of these as the first hop out of genesis.
    } else if (sel === 2n) {
      // executeConfig: [propIdx, thr8, cnt8, owner0..4, SELECTOR=2, rootScript]
      cfg = { threshold: Number(asInt(ps[1])), ownerCount: Number(asInt(ps[2])), owners5: ps.slice(3, 8).map((x) => x.data) };
      log(`chain: signer change found → now ${cfg.threshold}-of-${cfg.ownerCount}`);
    } else return { live: null, creations };
    cur = { txid: sp.transaction_id, index: 0 };
  }
  return { live: null, creations };
}

// Rebuild ALL of a treasury's proposals from the walked createProposal txs — open ones
// (with the redeem, for ops) AND closed ones (executed / expired → history), each
// with a full audit log (created/signed/rejected/executed events from the
// witnesses + block_time). Each proposal is reconstructed with the owner set that
// was active when it was created (its state embeds that snapshot).
export async function scanOpenProposals({ treasuryId, creations, p2sh, getUtxos, log = () => {} }) {
  const found = [];
  for (const cr of creations) {
    const ct = cr.ct, ps = cr.witness;
    if (ps.length < 10) continue;
    const proposerIndex = Number(asInt(ps[0]));
    const base = {
      proposalId: BigInt(cr.nonce + 1), operation: asInt(ps[2]), recipientSpkHash: ps[3].data, amount: asInt(ps[4]),
      maxFee: asInt(ps[5]), expiresAt: asInt(ps[6]), executionDelay: asInt(ps[7]),
      snapThreshold: BigInt(cr.threshold), ownerCount: BigInt(cr.ownerCount), owners5: cr.owners5,
      vaultSpkHash: vaultSpkHashFor(treasuryId),
    };
    const meta = decodeProposalPayload(ct.payload); // recipient address (self-describing)

    // follow the proposal's chain (create → approve/reject* → open|failed|executed),
    // accumulating the audit log from the on-chain witnesses + block times
    let bitmap = bitFor(proposerIndex), count = 1n, rejectBitmap = 0n, rejectCount = 0n;
    let cur = { txid: ct.transaction_id, index: 1 }; // P0 = createProposal output 1
    const events = [{ type: "created", owner: proposerIndex, at: Number(ct.block_time) || null }];
    const shape = () => ({
      proposalId: Number(base.proposalId), operation: Number(base.operation), amount: Number(base.amount),
      recipientAddress: meta?.recipient || null, recipientSpkHex: null, recipientSpkHash: base.recipientSpkHash,
      approvalBitmap: Number(bitmap), approvalCount: Number(count),
      rejectBitmap: Number(rejectBitmap), rejectCount: Number(rejectCount),
      maxFee: Number(base.maxFee), expiresAtDaa: Number(base.expiresAt), executionDelay: Number(base.executionDelay),
      createdAt: Number(ct.block_time) || null, events: [...events], discovered: true,
    });
    const thr = BigInt(cr.threshold), oc = BigInt(cr.ownerCount);
    const statusOf = () => (count >= thr ? 1n : (oc - rejectCount < thr ? 2n : 0n)); // Approved / Failed / Pending
    for (let hops = 0; hops < 24; hops++) {
      const status = statusOf();
      const redeem = proposalRedeem({ ...base, bitmap, count, status, rejectBitmap, rejectCount });
      const addr = p2sh(redeem);
      const utxos = await getUtxos(addr);
      const live = (utxos || []).find((e) => e.outpoint?.transactionId === cur.txid && Number(e.outpoint?.index) === cur.index);
      if (live) { // current on-chain UTXO (Pending / Approved / Failed-status-2)
        found.push({
          ...shape(), status: Number(status),
          proposalRedeemHex: redeem, proposalOutpoint: { txid: cur.txid, index: cur.index },
          proposalValue: Number(live.utxoEntry.amount),
        });
        break;
      }
      // spent — find the spending tx via the proposal address history
      let atxs; try { atxs = await rest(`/addresses/${addr}/full-transactions?limit=20&resolve_previous_outpoints=light`); } catch { break; }
      const sp = (atxs || []).find((t) => t.inputs?.some((i) => i.previous_outpoint_hash === cur.txid && Number(i.previous_outpoint_index) === cur.index));
      if (!sp) break;
      const si = sp.inputs.find((i) => i.previous_outpoint_hash === cur.txid && Number(i.previous_outpoint_index) === cur.index);
      const sps = parsePushes(si.signature_script);
      // Every KoProposal witness is [..entrypoint arguments.., SELECTOR, spentRedeem], and
      // each entrypoint takes a different number of arguments — so the selector only ever
      // sits at a fixed offset from the END (walkRoot reads KoRoot's the same way):
      //   approve(int ownerIndex, sig)              → [idx, sig, 0, redeem]
      //   execute(int paired, int ownerIndex, sig)  → [paired, idx, sig, 1, redeem]
      //   closeExpired()                            → [2, redeem]
      //   reject(int ownerIndex, sig)               → [idx, sig, 3, redeem]
      // closeExpired is PERMISSIONLESS: no owner index, no signature, so its whole witness
      // is the selector and the redeem reveal. Read from the front, its selector is off the
      // end of the witness and a retired proposal reads as an executed one — the user is
      // told a payout happened when the proposal was retired without moving a sompi.
      const selAt = sps.length - 2;
      const selector = selAt >= 0 ? asInt(sps[selAt]) : null;
      const args = sps.slice(0, selAt);
      const voted = selector === 0n || selector === 3n; // approve / reject continue the proposal
      const who = voted && args.length === 2 ? Number(asInt(args[0]))        // approve/reject: ownerIndex leads
        : selector === 1n && args.length === 3 ? Number(asInt(args[1]))      // execute: behind the paired input index
        : null;                                                              // closeExpired: nobody, anyone may retire it
      const continues = voted && args.length === 2 && sp.outputs?.[0]?.covenant_id;
      if (!continues) {
        // Closed on-chain. Only execute (1) moved treasury — a transfer paid out, a config
        // rotated the owners. closeExpired (2) retires the UTXO and touches nothing else, so
        // it reports Failed/closed, never executed. An unrecognised selector gets the same
        // non-committal close: a proposal whose ending we cannot read is not a payout.
        const executed = selector === 1n;
        events.push({ type: executed ? "executed" : "closed", owner: who, at: Number(sp.block_time) || null });
        found.push({
          ...shape(), status: executed ? 3 : 2,
          ...(executed ? {} : { closedReason: selector === 2n ? "expired" : "unknown" }),
          // the tx that consumed the proposal, whatever it did; `status` is what says
          // whether it paid out (the card labels this "Closing tx" below status 3).
          executedTxid: sp.transaction_id, executedAt: Number(sp.block_time) || null,
        });
        break;
      }
      if (selector === 0n) { bitmap |= bitFor(who); count += 1n; events.push({ type: "signed", owner: who, at: Number(sp.block_time) || null }); }
      else { rejectBitmap |= bitFor(who); rejectCount += 1n; events.push({ type: "rejected", owner: who, at: Number(sp.block_time) || null }); }
      cur = { txid: sp.transaction_id, index: 0 }; // continuation output 0 = new proposal
    }
  }
  const open = found.filter((p) => p.status < 2).length;
  log(`scanned chain: ${found.length} proposal(s) — ${open} open, ${found.length - open} in history`);
  return found;
}
