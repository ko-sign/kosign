// Per-treasury operational state in localStorage, so the signed flows can run
// node-direct (zero backend): the frontend tracks the advancing state (root nonce,
// open proposals) itself — exactly like the backend relay does. Seeded once from
// the backend wasmctx (compiled scripts + current state), then updated after each op.
const KEY = (id) => `kosign.state.${id}`;

export const loadState = (id) => { try { return JSON.parse(localStorage.getItem(KEY(id)) || "null"); } catch { return null; } };
export const saveState = (id, st) => { try { localStorage.setItem(KEY(id), JSON.stringify(st)); } catch { /* ignore */ } };

// Find a tracked treasury by its vault address (the URL carries the vault address, the
// state is keyed by treasuryId) — lets /treasury/:vaultAddress resolve locally, no backend.
export const findByVault = (vaultAddress) => {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith("kosign.state.")) continue;
      const st = JSON.parse(localStorage.getItem(k) || "null");
      if (st?.vaultAddress === vaultAddress && st?.treasuryId) return st;
    }
  } catch { /* ignore */ }
  return null;
};

export const seedFromCtx = (ctx) => ({
  treasuryId: ctx.treasuryId, vaultRedeem: ctx.vaultRedeem, rootRedeem: ctx.rootRedeem, proposalRedeem: ctx.proposalRedeem,
  rootStateLayout: ctx.rootStateLayout, proposalStateLayout: ctx.proposalStateLayout,
  vaultAddress: ctx.vault?.address, root: ctx.root, proposals: ctx.proposals || [], history: ctx.history || [],
  threshold: ctx.threshold, owners: ctx.owners || [], fundingAddress: ctx.fundingAddress,
});

// Mirror the relay's state tracking after a node-direct submit. Returns a new state.
export function applyUpdate(st, kind, meta, txid) {
  const next = { ...st, proposals: [...(st.proposals || [])] };
  // an executed proposal moves to the tracked history (Transactions → History)
  const toHistory = (p, status) => { next.history = [...(st.history || []), { ...p, status, executedTxid: txid, executedAt: Date.now(), events: [...(p.events || []), { type: "executed", at: Date.now() }] }]; };
  if (kind === "propose") {
    next.proposals.push({
      proposalId: meta.proposalId, operation: meta.operation, amount: meta.amount,
      recipientAddress: meta.recipientAddress, recipientSpkHex: meta.recipientSpkHex,
      proposalRedeemHex: meta.proposalRedeemHex, proposalOutpoint: { txid, index: 1 },
      approvalBitmap: meta.approvalBitmap, approvalCount: 1, status: meta.status, proposalValue: 50_000_000, createdAt: Date.now(),
      events: [{ type: "created", owner: meta.proposerIndex, at: Date.now() }],
      ...(meta.config ? { config: meta.config, configOwners: meta.configOwners, configThreshold: meta.configThreshold } : {}),
    });
    // owner-funded proposals preserve the KoRoot value (the proposer paid the bond
    // from their own wallet); legacy root-funded proposals deduct bond + actual fee.
    // meta.fee = the mass-priced network fee actually paid (fallbacks = the old
    // fixed constants, for records written by pre-dynamic-fee builds). These
    // tracked values feed back into later builders as previous-output amounts,
    // so they must match the chain exactly (rescans re-read them from chain).
    next.root = { redeemHex: meta.rootContHex, outpoint: { txid, index: 0 }, value: (st.root?.value ?? 0) - (meta.ownerFunded ? 0 : 50_000_000 + (meta.fee ?? 10_000_000)) };
  } else if (kind === "approve") {
    const e = next.proposals.find((x) => String(x.proposalId) === String(meta.proposalId));
    if (e) { e.proposalRedeemHex = meta.newRedeemHex; e.proposalOutpoint = { txid, index: 0 }; e.approvalBitmap = meta.approvalBitmap; e.approvalCount = meta.approvalCount; e.status = meta.status; e.proposalValue = (e.proposalValue ?? 50_000_000) - (meta.ownerFunded ? 0 : (meta.fee ?? 5_000_000)); e.events = [...(e.events || []), { type: "signed", owner: meta.ownerIndex, at: Date.now() }]; }
  } else if (kind === "reject") {
    const e = next.proposals.find((x) => String(x.proposalId) === String(meta.proposalId));
    if (e) { e.proposalRedeemHex = meta.newRedeemHex; e.proposalOutpoint = { txid, index: 0 }; e.rejectBitmap = meta.rejectBitmap; e.rejectCount = meta.rejectCount; e.status = meta.status; e.proposalValue = (e.proposalValue ?? 50_000_000) - (meta.ownerFunded ? 0 : (meta.fee ?? 5_000_000)); e.events = [...(e.events || []), { type: "rejected", owner: meta.ownerIndex, at: Date.now() }]; }
  } else if (kind === "execute") {
    const done = next.proposals.find((x) => String(x.proposalId) === String(meta.proposalId));
    next.proposals = next.proposals.filter((x) => String(x.proposalId) !== String(meta.proposalId));
    if (done) toHistory(done, 3);
  } else if (kind === "config-execute") {
    const consumed = next.proposals.find((x) => String(x.proposalId) === String(meta.proposalId));
    next.proposals = next.proposals.filter((x) => String(x.proposalId) !== String(meta.proposalId));
    if (consumed) toHistory(consumed, 3);
    next.root = { redeemHex: meta.newRootHex, outpoint: { txid, index: 0 }, value: (st.root?.value ?? 0) + (consumed?.proposalValue ?? 45_000_000) - (meta.ownerFunded ? 0 : (meta.fee ?? 5_000_000)) };
    const owners = meta.configOwners || consumed?.configOwners;
    if (owners) { next.owners = owners; next.threshold = meta.configThreshold ?? consumed?.configThreshold ?? st.threshold; }
  }
  return next;
}

import { getNetworkId } from "./network.js";

// Build a TreasuryView-shaped status object from the tracked state (+ a vault balance).
export function statusFromState(st, vaultBalanceSompi, unsweptSompi = 0, strays = []) {
  return {
    network: getNetworkId(), treasuryId: st.treasuryId, threshold: st.threshold, direct: true,
    owners: (st.owners || []).filter((o) => !o.padding && o.xonly_pubkey).map((o) => ({ pubkey: o.xonly_pubkey, address: o.address })),
    vault: { address: st.vaultAddress, balanceSompi: vaultBalanceSompi, unsweptSompi, strays },
    root: st.root,
    proposals: st.proposals || [],
    // chain-scanned closed proposals (in st.proposals, status ≥ 2, with on-chain
    // audit logs) supersede the same locally-tracked history entry
    history: (st.history || []).filter((h) => !(st.proposals || []).some((p) => String(p.proposalId) === String(h.proposalId))),
    fundingAddress: st.fundingAddress,
  };
}
