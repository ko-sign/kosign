import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { importKey, connectKasware } from "./signer.js";
import { kaswareAvailable, kaswareConnect, kosignNetworkOf } from "./kasware.js";

// Connect Wallet — a two-pane picker (wallet list left, connection pane right).
// KasWare connects as OWNER IDENTITY + DEPOSITS (its API can't sign covenant
// P2SH inputs yet); the manual raw key is the full covenant signer.
const KAS = (s) => (s == null ? "—" : (Number(s) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 }));

export default function WalletModal({ open, onClose }) {
  const [sel, setSel] = useState(null); // "kasware" | "manual"
  const [phase, setPhase] = useState("idle"); // idle | connecting | connected
  const [err, setErr] = useState("");
  const [kw, setKw] = useState(null); // { address, pubkey, network, balance }
  const [val, setVal] = useState("");
  const detected = kaswareAvailable();

  useEffect(() => { if (open) { setSel(null); setPhase("idle"); setErr(""); setKw(null); setVal(""); } }, [open]);
  if (!open) return null;

  const pick = (id) => { setSel(id); setPhase("idle"); setErr(""); };

  const doKasware = async () => {
    setPhase("connecting"); setErr("");
    try {
      const info = await kaswareConnect();
      connectKasware(info);
      setKw(info); setPhase("connected");
      setTimeout(onClose, 1400); // let the ✓ land, then close
    } catch (e) { setPhase("idle"); setErr(e.message || String(e)); }
  };
  const doImport = () => {
    try { importKey(val); setVal(""); onClose(); }
    catch (e) { setErr(e.message || String(e)); }
  };

  const Cap = ({ ok, children }) => (
    <div className={`wm-cap ${ok ? "ok" : "no"}`}><span>{ok ? "✓" : "✗"}</span>{children}</div>
  );

  // portal to <body>: the KeyBar lives in a sticky topbar whose backdrop-filter
  // turns position:fixed descendants into topbar-relative boxes
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal wmodal" onClick={(e) => e.stopPropagation()}>
        <aside className="wm-list">
          <div className="wm-h">⟨ full access ⟩</div>
          <button className={`wm-item ${sel === "manual" ? "on" : ""}`} onClick={() => pick("manual")}>
            <span className="wm-ico key">⌘</span>
            <span className="wm-name">Manual key<small>full covenant signing</small></span>
            <span className="wm-tag ok">full</span>
          </button>

          <div className="wm-h">⟨ third-party · limited ⟩</div>
          <button className={`wm-item ${sel === "kasware" ? "on" : ""}`} onClick={() => pick("kasware")}>
            <span className="wm-ico kw">K</span>
            <span className="wm-name">KasWare<small>identity + deposits only</small></span>
            <span className={`wm-tag ${detected ? "ok" : ""}`}>{detected ? "detected" : "not installed"}</span>
          </button>
        </aside>

        <section className="wm-pane">
          <div className="cm-head" style={{ marginBottom: 0 }}>
            <h3 style={{ fontSize: 15 }}>
              {sel === "kasware" ? "KasWare" : sel === "manual" ? "Manual key import" : "Connect a wallet"}
            </h3>
            <button className="x" onClick={onClose}>✕</button>
          </div>

          {!sel && (
            <div className="wm-wait">
              <div className="orbit"><i /><i /><i /><span className="core" /></div>
              <div className="load-title" style={{ animation: "none" }}>Waiting for connection</div>
              <p className="muted" style={{ textAlign: "center", margin: 0 }}>Select a wallet on the left to start connecting.</p>
            </div>
          )}

          {sel === "kasware" && (
            <div className="wm-body">
              {!detected ? (
                <>
                  <p className="muted">KasWare isn't installed in this browser.</p>
                  <a className="btn btn-primary btn-block" href="https://kasware.xyz" target="_blank" rel="noreferrer">Get KasWare ↗</a>
                </>
              ) : phase === "connected" && kw ? (
                <>
                  <div className="cm-effect ok" style={{ marginTop: 0 }}>✓ connected — {kosignNetworkOf(kw.network) || kw.network || "network unknown"}</div>
                  <div className="drow"><span className="dk">Address</span><span className="dv"><code className="mono" style={{ fontSize: 11 }}>{kw.address}</code></span></div>
                  <div className="drow"><span className="dk">Pubkey (x-only)</span><span className="dv"><code className="mono" style={{ fontSize: 11 }}>{kw.pubkey}</code></span></div>
                  <div className="drow"><span className="dk">Balance</span><b className="mono ok">{KAS(kw.balance)} KAS</b></div>
                </>
              ) : (
                <>
                  <p className="muted">Connects your KasWare account as a treasury owner identity — a <b>limited</b> connection.</p>
                  <div className="wm-limit">
                    <div className="wm-limit-h ok">✓ works with KasWare</div>
                    <Cap ok>owner identity — your Treasuries recognise you as a signer</Cap>
                    <Cap ok>deposit into the vault straight from the wallet (sendKaspa)</Cap>
                    <Cap ok>balance display</Cap>
                    <div className="wm-limit-h no" style={{ marginTop: 8 }}>✗ not possible with KasWare</div>
                    <Cap ok={false}>propose a transfer</Cap>
                    <Cap ok={false}>approve / reject a proposal</Cap>
                    <Cap ok={false}>execute / apply a signer change</Cap>
                    <div className="wm-limit-why">KasWare's signPskt only signs inputs of its own addresses — it cannot sign covenant P2SH (KoRoot / KoProposal) inputs.</div>
                  </div>
                  <div className="wm-fullnote">Need the full feature set? Use <b>Manual key</b> — it signs covenant sighashes locally.</div>
                  <button className="btn btn-primary btn-block" style={{ marginTop: 12 }} disabled={phase === "connecting"} onClick={doKasware}>
                    {phase === "connecting" ? "waiting for KasWare…" : "⛓ Connect KasWare (limited)"}
                  </button>
                  <button className="btn btn-ghost btn-block" style={{ marginTop: 8 }} onClick={() => pick("manual")}>⌘ Use Manual key instead — full signing</button>
                </>
              )}
              {err && <div className="warn" style={{ fontSize: 12, marginTop: 10 }}>{err}</div>}
            </div>
          )}

          {sel === "manual" && (
            <div className="wm-body">
              <p className="muted">The raw owner key signs covenant sighashes locally (BIP340 Schnorr). It stays in this browser — never sent anywhere.</p>
              <Cap ok>full covenant signing — propose / approve / reject / execute</Cap>
              <input className="input mono" type="password" autoFocus spellCheck={false} autoComplete="off"
                placeholder="private key (64 hex)" value={val} style={{ marginTop: 12 }}
                onChange={(e) => { setVal(e.target.value); setErr(""); }}
                onPaste={(e) => { const t = (e.clipboardData.getData("text") || "").trim(); if (t) { e.preventDefault(); setVal(t); setErr(""); } }}
                onKeyDown={(e) => e.key === "Enter" && doImport()} />
              <button className="btn btn-primary btn-block" style={{ marginTop: 10 }} disabled={!val.trim()} onClick={doImport}>Import key</button>
              {err && <div className="warn" style={{ fontSize: 12, marginTop: 10 }}>{err}</div>}
              <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>Persisted in this browser only — use ✕ on the wallet chip to forget it on shared machines.</div>
            </div>
          )}
        </section>
      </div>
    </div>,
    document.body,
  );
}
