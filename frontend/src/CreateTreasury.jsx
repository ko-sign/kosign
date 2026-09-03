import React, { useEffect, useState } from "react";
import { go } from "./App.jsx";
import { useWallet } from "./signer.js";
import { createTreasuryClientSide, resumeBootstrap, pendingBootstraps, loadWasm, pubkeyAddress } from "./wasmTx.js";
import { fetchBalance } from "./kaspaRest.js";
import { getNetwork, useNetworkId } from "./network.js";
import { termPush, termClear, termBusy } from "./Terminal.jsx";

const KAS = (s) => (s == null ? "—" : (Number(s) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 }));

// Dedicated Create-treasury page. Creating a treasury takes TWO transactions:
// genesis mints the KoRoot and, with it, the covenant id; a second transaction
// (bootstrapVault) mints the KoVault built around that id. The vault address is a
// function of the id, so it does not exist until the second one lands — which is
// why this page navigates to the dashboard only after both are accepted, and why a
// genesis whose bootstrap failed is offered back as something to FINISH rather than
// left as a treasury with no address.
// The covenant stores owners as fixed state fields (owner0..owner4 in KoRoot and
// in every proposal's owner snapshot), so the owner set is capped by the script
// itself — not by policy. packages/descriptor rejects any other slot count.
const MAX_OWNERS = 5;

export default function CreateTreasury() {
  const pubkey = useWallet(); // imported owner-0 key (x-only) or null
  const [busy, setBusy] = useState(false);
  const push = termPush, clear = termClear; // logs go to the global bottom console
  useEffect(() => { termBusy(busy ? "create treasury" : ""); }, [busy]);
  const [threshold, setThreshold] = useState(2);
  // Fixed minimal genesis amounts — no need to bother the user: the KoRoot is just
  // a dust anchor (proposals are owner-funded, so it never depletes) and the vault is
  // topped up later via its deposit address.
  const rootKas = 0.3;
  const vaultKas = 0.3;
  // both transactions are funded up front: the genesis pays the root, its change
  // carries the vault's opening balance, and the bootstrap pays that in
  const feeCeilKas = 0.2;
  const [coOwners, setCoOwners] = useState([""]);
  const [me, setMe] = useState(null); // owner-0 address + balance
  const [pending, setPending] = useState([]); // genesis landed, vault never minted
  const netId = useNetworkId(); // re-derive on ⚙ network switch

  useEffect(() => { setPending(pendingBootstraps()); }, [netId, busy]);

  // resolve owner-0 address (client-side, wasm) + balance (REST indexer) — no backend
  useEffect(() => {
    setMe(null);
    if (!pubkey) return;
    let alive = true;
    loadWasm().then(async () => {
      const address = pubkeyAddress(pubkey);
      if (!alive || !address) return;
      setMe({ address, balanceSompi: null });
      const balanceSompi = await fetchBalance(address);
      if (alive) setMe({ address, balanceSompi });
    });
    return () => { alive = false; };
  }, [pubkey, netId]);

  const cos = coOwners.map((a) => a.trim()).filter(Boolean);
  const ownerCount = 1 + cos.length;
  const total = Number(rootKas) + Number(vaultKas) + feeCeilKas; // root + vault + both fees
  const funded = (me?.balanceSompi ?? 0) / 1e8 >= total;

  // keep the threshold valid as co-signers are added/removed (no confusing error)
  useEffect(() => { setThreshold((t) => Math.min(Math.max(1, t), ownerCount)); }, [ownerCount]);

  // Owners must be distinct: a repeated address bakes the same pubkey into two
  // slots, which would let one key approve twice (as two indices) and collapse
  // the M-of-N. Flag duplicates across owner 0 + the co-signers.
  const owner0Addr = me?.address || "";
  const addrCounts = {};
  for (const a of [owner0Addr, ...cos].filter(Boolean)) addrCounts[a] = (addrCounts[a] || 0) + 1;
  const dupAddrs = new Set(Object.keys(addrCounts).filter((a) => addrCounts[a] > 1));
  const hasDup = dupAddrs.size > 0;

  const create = async () => {
    setBusy(true); clear();
    try {
      if (!pubkey) { push("Import your key (top-right) first.", "err"); setBusy(false); return; }
      push(`create & sign (${threshold}-of-${ownerCount})`, "cmd");
      push("building covenant scripts in your browser (no backend) — this takes two transactions…");
      const { treasuryId, vaultAddress } = await createTreasuryClientSide(
        { ownerPubkey: pubkey, coSignerAddresses: cos, threshold, rootSompi: Math.round(rootKas * 1e8), vaultSompi: Math.round(vaultKas * 1e8) },
        (t, k) => push(t, k),
      );
      push(`treasury ${treasuryId.slice(0, 16)}… minted`, "ok");
      return go(`/treasury/${vaultAddress}`);
    } catch (e) { push(`${e.message || e}`, "err"); setPending(pendingBootstraps()); }
    setBusy(false);
  };

  // Finish a treasury whose genesis landed but whose vault never did. The root is
  // on chain under the treasury's own lineage, so this is a retry of the same
  // transaction — the vault lands at the address it always would have.
  const resume = async (treasuryId) => {
    setBusy(true); clear();
    try {
      push(`finish treasury ${treasuryId.slice(0, 16)}…`, "cmd");
      const { vaultAddress } = await resumeBootstrap(treasuryId, (t, k) => push(t, k));
      return go(`/treasury/${vaultAddress}`);
    } catch (e) { push(`${e.message || e}`, "err"); setPending(pendingBootstraps()); }
    setBusy(false);
  };

  const setCo = (i, v) => setCoOwners((a) => a.map((x, j) => (j === i ? v : x)));
  const thrOk = threshold >= 1 && threshold <= ownerCount;
  const countOk = ownerCount <= MAX_OWNERS;
  const ok = thrOk && countOk && !hasDup && pubkey && funded;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: "4px 0", fontSize: 26, letterSpacing: "-0.02em" }}>Create treasury</h2>
          <p className="muted" style={{ margin: 0 }}>Set an M-of-N policy — genesis mints the KoRoot and the covenant id it binds; a second transaction mints the vault around that id.</p>
        </div>
        <button className="btn btn-ghost" onClick={() => go("/")}>← Home</button>
      </div>

      {pending.length > 0 && (
        <div className="panel" style={{ marginTop: 14, background: "rgba(244,199,97,.06)", borderColor: "rgba(244,199,97,.3)" }}>
          <p className="warn" style={{ margin: "0 0 8px" }}>
            {pending.length === 1 ? "A treasury is half-created" : `${pending.length} treasuries are half-created`} — the genesis landed but the vault was never minted, so there is no deposit address yet. Finish it: the KoRoot is on chain under the treasury's own covenant id, and the vault will land at the address it always would have.
          </p>
          {pending.map((r) => (
            <div key={r.treasuryId} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
              <code style={{ fontSize: 12 }}>{r.treasuryId.slice(0, 20)}…</code>
              <span className="muted" style={{ fontSize: 12 }}>{r.threshold}-of-{r.ownerCount} · vault {(r.vaultSompi / 1e8).toFixed(2)} KAS</span>
              <button className="btn btn-ghost" disabled={busy || !pubkey} onClick={() => resume(r.treasuryId)}>
                {pubkey ? "Finish it" : "Import your key first"}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="panel" style={{ marginTop: 14 }}>
        <>
            {!pubkey && (
              <div className="panel" style={{ background: "rgba(244,199,97,.06)", borderColor: "rgba(244,199,97,.3)", marginBottom: 12 }}>
                <span className="warn" style={{ margin: 0 }}>Import your private key (top-right) — it becomes owner 0, funds the genesis, and signs it.</span>
              </div>
            )}
            <label className="lbl">Owner 0 — you (imported key)</label>
            <input className="input" value={me?.address || (pubkey ? "deriving…" : "— import a key —")} readOnly style={{ opacity: pubkey ? 1 : 0.5 }} />
            {pubkey && (
              <p className={funded ? "muted" : "warn"} style={{ fontSize: 12, marginTop: 5 }}>
                Balance {KAS(me?.balanceSompi)} KAS · needs ≥ {total.toFixed(2)} KAS{!funded && " — send testnet KAS to this address first"}
              </p>
            )}
            <label className="lbl" style={{ marginTop: 8 }}>Co-signers ({cos.length}) — their Kaspa addresses</label>
            {coOwners.map((a, i) => {
              const dup = !!a.trim() && dupAddrs.has(a.trim());
              return (
                <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                  <input className="input" placeholder={`co-signer ${i + 1} address (${getNetwork().prefix}:q…)`} value={a} onChange={(e) => setCo(i, e.target.value)}
                    style={dup ? { borderColor: "rgba(240,120,120,.7)" } : undefined} />
                  {coOwners.length > 1 && <button className="btn btn-ghost" onClick={() => setCoOwners((x) => x.filter((_, j) => j !== i))}>✕</button>}
                </div>
              );
            })}
            {hasDup && <p className="warn" style={{ fontSize: 12, marginTop: 2, marginBottom: 6 }}>Each owner must be a different address — remove the duplicate (owner 0 is you).</p>}
            {coOwners.length < MAX_OWNERS - 1 && <button className="btn btn-ghost" onClick={() => setCoOwners((x) => [...x, ""])}>+ Add co-signer</button>}
            <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
              Everything runs in your browser — the covenant scripts, both transactions and the signing are all local, submitted straight to your node (⚙). <b>No backend.</b> Each owner signs by importing their key in their own tab.
            </p>
        </>

        <label className="lbl" style={{ marginTop: 4 }}>Threshold — required approvals (M of {ownerCount})</label>
        <input className="input" type="number" min="1" max={ownerCount} value={threshold} onChange={(e) => setThreshold(+e.target.value)} />
        <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
          Creating costs ≈ <b>{total.toFixed(2)} KAS</b> from your imported wallet, across two transactions: genesis mints the KoRoot ({rootKas} KAS anchor), then bootstrapVault mints the vault ({vaultKas} KAS opening balance). <b>The deposit address only exists once the second one lands</b> — it is derived from the covenant id the genesis creates. Proposals are paid by whoever proposes.
        </p>

        <button className="btn btn-primary btn-block" disabled={busy || !ok} onClick={create} style={{ marginTop: 6 }}>
          {busy ? "Working… (two transactions, signed locally)"
            : hasDup ? "Owners must be unique"
            : !countOk ? `At most ${MAX_OWNERS} owners`
            : !thrOk ? "Threshold must be ≤ owners"
            : !pubkey ? "Import your key first"
            : !funded ? "Fund owner 0 first"
            : `Create & sign (${threshold}-of-${ownerCount})`}
        </button>
      </div>

    </div>
  );
}
