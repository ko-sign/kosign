import React, { useState, useEffect } from "react";
import { useWallet, useWalletSource, forgetKey, walletAddress, connectKasware } from "./signer.js";
import { kaswareDisconnect, kaswareOn, kaswareConnect } from "./kasware.js";
import WalletModal from "./WalletModal.jsx";
import { loadWasm, pubkeyAddress } from "./wasmTx.js";
import { NETWORKS, getNetworkId, setNetworkId, getRpcChoice, setRpcChoice, getResolvedRpc, resolvePublicNode } from "./network.js";

const short = (s, n = 8) => (s ? `${s.slice(0, n)}…${s.slice(-6)}` : "—");
const KAS = (s) => (s == null ? "—" : (Number(s) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 }));

// Global key bar: import a Kaspa private key (kept in-tab only) used to sign treasury
// operations client-side, plus the network / node endpoint settings (⚙).
// `gearOnly` renders just the ⚙ — used on the landing where a wallet isn't needed yet.
export default function KeyBar({ gearOnly = false }) {
  const pubkey = useWallet();
  const source = useWalletSource(); // "manual" | "kasware" | null
  const [open, setOpen] = useState(false); // Connect Wallet modal
  const [info, setInfo] = useState(null);
  const [rpcOpen, setRpcOpen] = useState(false);
  const [netId, setNetId] = useState(getNetworkId());
  const [mode, setMode] = useState(getRpcChoice().mode);
  const [rpc, setRpc] = useState(getRpcChoice().url || "");
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState(getResolvedRpc());

  // official mode: make sure a public node is resolved for the active network
  // (on app load and whenever the network / mode changes)
  useEffect(() => {
    if (getRpcChoice().mode !== "public") return;
    if (getResolvedRpc()) { setResolved(getResolvedRpc()); return; }
    let alive = true;
    setResolving(true);
    resolvePublicNode(getNetworkId()).then((url) => { if (alive) { setResolved(url || ""); setResolving(false); } });
    return () => { alive = false; };
  }, [netId, mode]);

  // Derive the owner address from the imported pubkey client-side (wasm) — no
  // backend. KasWare hands us the address directly. Falls back to
  // /api/owner-address only if wasm derivation fails.
  useEffect(() => {
    setInfo(null);
    if (!pubkey) return;
    const kwAddr = walletAddress();
    if (kwAddr) { setInfo({ address: kwAddr }); return; }
    let alive = true;
    loadWasm().then(() => {
      const address = pubkeyAddress(pubkey);
      if (alive && address) { setInfo({ address }); return; }
      fetch("/api/owner-address", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pubkey }) })
        .then((r) => r.json()).then((d) => alive && d.ok && setInfo(d)).catch(() => {});
    });
    return () => { alive = false; };
  }, [pubkey, netId]);

  // Anywhere in the app that tells a user "this needs a node" can OPEN the place
  // that sets one, instead of naming a gear icon and leaving them to find it.
  useEffect(() => {
    const on = () => { const c = getRpcChoice(); setNetId(getNetworkId()); setMode(c.mode); setRpc(c.url || ""); setResolved(getResolvedRpc()); setOpen(false); setRpcOpen(true); };
    window.addEventListener("kosign-open-rpc", on);
    return () => window.removeEventListener("kosign-open-rpc", on);
  }, []);

  // KasWare account switches follow into the store; empty accounts = disconnect.
  useEffect(() => {
    if (source !== "kasware") return;
    return kaswareOn("accountsChanged", (accounts) => {
      if (!accounts?.length) { forgetKey(); return; }
      kaswareConnect().then(connectKasware).catch(() => forgetKey());
    });
  }, [source]);

  const disconnect = () => { if (source === "kasware") kaswareDisconnect(); forgetKey(); };
  const pickNetwork = (id) => { setNetworkId(id); setNetId(id); const c = getRpcChoice(id); setMode(c.mode); setRpc(c.url || ""); setResolved(getResolvedRpc(id)); };
  const pickMode = (m) => { setMode(m); setRpcChoice({ mode: m, url: rpc }); };
  const saveRpc = () => { setRpcChoice({ mode, url: rpc }); setRpcOpen(false); };
  const resetRpc = () => { const n = NETWORKS[netId]; setMode(n.defaultMode); setRpc(n.defaultRpc); setRpcChoice({ mode: n.defaultMode, url: n.defaultRpc }); };
  const reResolve = () => { setResolving(true); setResolved(""); try { localStorage.removeItem(`kosign.rpcResolved.${netId}`); } catch { /* ignore */ } resolvePublicNode(netId).then((u) => { setResolved(u || ""); setResolving(false); }); };

  const rpcButton = (
    <button className="btn btn-ghost" title="Network & RPC endpoint" onClick={() => { const c = getRpcChoice(); setNetId(getNetworkId()); setMode(c.mode); setRpc(c.url || ""); setResolved(getResolvedRpc()); setRpcOpen((v) => !v); setOpen(false); }} style={{ padding: "8px 10px" }}>⚙</button>
  );
  const rpcPopover = rpcOpen && (
    <div className="keypop wide">
      <label className="lbl" style={{ marginTop: 0 }}>Network</label>
      <select className="input" value={netId} onChange={(e) => pickNetwork(e.target.value)}>
        {Object.values(NETWORKS).map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
      </select>

      <label className="lbl">Node endpoint <span className="muted">(JSON wRPC)</span></label>
      <select className="input" value={mode} onChange={(e) => pickMode(e.target.value)}>
        <option value="public">Official — Kaspa public nodes (auto-picked)</option>
        <option value="custom">Custom — my own node URL</option>
      </select>
      {mode === "custom" ? (
        <>
          <input className="input mono" spellCheck={false} placeholder="ws(s)://… (JSON wRPC)" value={rpc}
            onChange={(e) => setRpc(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveRpc()} />
          {location.protocol === "https:" && /^ws:\/\//i.test(rpc.trim()) && (
            <div className="warn" style={{ fontSize: 11.5 }}>This page is served over HTTPS, so a plain <code>ws://</code> node is blocked by the browser (mixed content). Use a <code>wss://</code> endpoint or the Official option.</div>
          )}
        </>
      ) : (
        <div className="muted mono" style={{ fontSize: 11.5, wordBreak: "break-all", margin: "2px 0 8px" }}>
          {resolving ? "resolving a public node (kaspa-resolver)…" : resolved ? `→ ${resolved}` : "no public node resolved yet"}
          {!resolving && <button className="btn btn-ghost" style={{ marginLeft: 8, padding: "2px 8px" }} onClick={reResolve}>↻</button>}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn btn-ghost" onClick={resetRpc}>Reset</button>
        <button className="btn btn-primary" style={{ flex: 1 }} onClick={saveRpc}>Save</button>
      </div>
      <div className="muted" style={{ fontSize: 11.5 }}>Your browser talks straight to this node — create, propose, approve, execute, no backend. Official = the Kaspa Public Node Network via kaspa-resolver.</div>
    </div>
  );

  if (gearOnly) {
    return (
      <span className="keybar">
        {rpcButton}
        {rpcPopover}
      </span>
    );
  }
  if (pubkey) {
    return (
      <span className="keybar">
        <span className="chip" title={info?.address || pubkey}>
          <span className="dot" /> {info ? short(info.address, 10) : short(pubkey, 8)}
          {source === "kasware" && <span className="src-tag">kasware</span>}
          {info && <span className="muted" style={{ margin: 0 }}>· {KAS(info.balanceSompi)} KAS</span>}
          <button className="x" title={source === "kasware" ? "Disconnect KasWare" : "Forget key"} onClick={disconnect}>✕</button>
        </span>
        {rpcButton}
        {rpcPopover}
        {/* stays mounted through the connect transition so the ✓ pane can land */}
        <WalletModal open={open} onClose={() => setOpen(false)} />
      </span>
    );
  }
  return (
    <span className="keybar">
      <button className="btn btn-ghost" onClick={() => { setOpen(true); setRpcOpen(false); }}>⛓ Connect Wallet</button>
      {rpcButton}
      {rpcPopover}
      <WalletModal open={open} onClose={() => setOpen(false)} />
    </span>
  );
}
