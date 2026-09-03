import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { go } from "./App.jsx";
import { useWallet, useWalletSource, sign, walletAddress } from "./signer.js";
import { kaswareSend } from "./kasware.js";
import { fetchKasUsd, usdFmt, priceFmt } from "./price.js";
import { recoverTreasuryFromChain, fetchBalance, fetchAddressActivity } from "./kaspaRest.js";
import { subscribeUtxos, getRpcUrl } from "./kaspaLive.js";
import { ensureRpcUrl, reResolvePublicNode, getNetwork, useNetworkId } from "./network.js";
import { findByVault, loadState } from "./treasuryState.js";
import { auditTreasuryGenesis, isOverridden, setOverride } from "./genesisAudit.js";
import { sweepClientSide, quoteSweep, proposeClientSide, approveClientSide, rejectClientSide, executeClientSide, configProposeClientSide, closeExpiredClientSide, currentDaaScore, statusDirect, seedFromChain, rescanFromChain, loadWasm, pubkeyAddress, p2shAddressSafe } from "./wasmTx.js";
import { PROPOSAL_BOND, checkTransfer, statusLabel, outcomeNote, retireState, canRetire, daaEta } from "./proposalPolicy.js";
import { termPush, termClear, termBusy } from "./Terminal.jsx";
import KeyBar from "./KeyBar.jsx";

const KAS = (s) => (s == null ? "—" : (Number(s) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 }));
const short = (s, n = 10) => (s ? `${s.slice(0, n)}…${s.slice(-6)}` : "—");
const api = async (path, body) => {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const text = await r.text();
  if (!text) return { ok: false, stderr: r.status === 404 ? "endpoint not found — restart the backend (it predates this route)" : `empty response (HTTP ${r.status})` };
  try { return JSON.parse(text); } catch { return { ok: false, stderr: `bad response (HTTP ${r.status}): ${text.slice(0, 160)}` }; }
};
const copy = (t) => navigator.clipboard?.writeText(t).catch(() => {});
// deterministic avatar gradient from an address
const hueOf = (a) => { let h = 0; for (const c of a || "") h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const Avatar = ({ seed, size = 34 }) => {
  const h = hueOf(seed);
  return <span className="avatar" style={{ width: size, height: size, background: `linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 48) % 360} 70% 45%))` }} />;
};

// Safe{Wallet}-style per-treasury view: a fixed left sidebar (Assets / Transactions /
// Settings) + content. Reorganizes the basic multisig functions into pages.
export default function TreasuryView({ param, page = "assets" }) {
  // The URL carries the treasury's wallet (vault) address; resolve it to the internal
  // treasuryId (covenant id) the backend keys on. A legacy 64-hex treasuryId is used as-is.
  const isHex64 = /^[0-9a-fA-F]{64}$/.test(param);
  const [treasuryId, setTreasuryId] = useState(isHex64 ? param : null);
  const [notFound, setNotFound] = useState(false);
  const [s, setS] = useState(null);
  // the active page lives in the URL (#/treasury/:addr/:page) so links land on the same tab
  const setPage = (id) => go(`/treasury/${param}${id === "assets" ? "" : `/${id}`}`);
  const [proposeOpen, setProposeOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const push = termPush, clear = termClear; // ops log to the global bottom console
  useEffect(() => { termBusy(busy); }, [busy]); // mirror the running op into the dock
  const [recoverMsg, setRecoverMsg] = useState("");
  const [chainTick, setChainTick] = useState(0); // bumps when a chain re-scan lands
  const [rpcNonce, setRpcNonce] = useState(0); // bumps on ⚙ endpoint/network changes
  useEffect(() => {
    const on = () => setRpcNonce((n) => n + 1);
    window.addEventListener("kosign-rpc", on);
    return () => window.removeEventListener("kosign-rpc", on);
  }, []);
  const myPubkey = useWallet();

  // ── GENESIS PROVENANCE GATE ───────────────────────────────────────────────
  // Two facts have to be established from the chain before this page may show
  // anything. First, WHICH genesis: a vault holds its covenant lineage in state, so
  // its address is a pure function of the id one genesis minted — derive it and you
  // know, rather than assume, that this transaction governs this money. Second, what
  // that genesis minted: its spender chooses which outputs join the covenant group,
  // and a creator who binds a second member (a pre-approved KoProposal) can drain the
  // vault whenever he likes. No opcode exposes an input's genesis provenance, so no
  // contract can catch that; only reading the (immutable) genesis tx can.
  // See genesisAudit.js and SECURITY.md → "Genesis provenance".
  //
  // Nothing below this gate may render for a refused treasury — above all not a
  // deposit address. The audit runs on the vault ADDRESS, so it also covers legacy
  // /treasury/<treasuryId> URLs once the address is known.
  const [gate, setGate] = useState(null); // null = still checking
  const [overridden, setOverridden] = useState(false);
  const stateVaultAddr = s?.vault?.address;
  const gateAddress = useMemo(
    () => (isHex64 ? (loadState(param)?.vaultAddress || stateVaultAddr || null) : param),
    [isHex64, param, stateVaultAddr],
  );
  useEffect(() => {
    if (!gateAddress) return;
    let alive = true;
    setOverridden(isOverridden(gateAddress));
    (async () => {
      // prefer having a node: it supplies the treasury's real covenant id from the
      // UTXO set, which turns the audit into a cryptographic proof rather than a
      // restatement of what the REST indexer said
      await ensureRpcUrl();
      for (let attempt = 0; alive && attempt < 20; attempt++) {
        let v = null;
        try { v = await auditTreasuryGenesis(gateAddress, { rpcUrl: getRpcUrl(), log: (t, k) => termPush(t, k) }); }
        catch (e) { push(`genesis audit error: ${e.message || e}`, "err"); }
        if (!alive) return;
        if (v) setGate(v);
        if (v && v.verdict !== "unverified") return; // clean or refused — both final
        if (v?.code === "bad-address") return;
        await new Promise((r) => setTimeout(r, 8000)); // fresh treasury / indexer lag
      }
    })();
    return () => { alive = false; };
  }, [gateAddress, rpcNonce]);
  const gateOk = gate?.verdict === "clean" || (gate?.verdict === "unverified" && overridden);

  // "The check has not run yet" is not "the check could not run", and only one of the
  // two deserves a warning. A treasury this browser minted minutes ago is missing from
  // the chain indexer because the indexer trails the node, which is the expected order
  // of events — showing an alarm there teaches people to click past the alarm that
  // matters. Narrow on purpose: this browser must hold the mint record, the window is
  // short, and only the indexer-lag code qualifies. Anything else — a treasury opened
  // from a link, an unreachable indexer, a stale record — keeps the warning.
  const FRESH_MINT_GRACE_MS = 15 * 60 * 1000;
  const freshlyMinted = useMemo(() => {
    if (gate?.code !== "no-genesis" || !gateAddress) return false;
    const st = findByVault(gateAddress);
    return !!st?.genesis?.txid && Date.now() - Number(st.mintedAt ?? 0) < FRESH_MINT_GRACE_MS;
  }, [gate?.code, gateAddress]);

  // Node-direct: rebuild the proposal queue + history (with audit logs) from CHAIN.
  // Runs on page load AND whenever a watched covenant address changes on-chain
  // (a co-owner approving in another browser spends the proposal UTXO — see the
  // subscription below). `scanning` drives "syncing from chain…" states so
  // cached/empty views never read as final while the walk is still in flight.
  const [scanning, setScanning] = useState(true);
  const scanBusy = useRef(false);
  const doRescan = useCallback(async () => {
    if (!treasuryId || !getRpcUrl()) { setScanning(false); return; } // no endpoint yet — retried via rpcNonce
    if (scanBusy.current) return; // one walk at a time
    scanBusy.current = true;
    setScanning(true);
    try {
      const ok = await rescanFromChain(treasuryId, (t, k) => termPush(t, k));
      if (ok) setChainTick((t) => t + 1);
    } catch { /* indexer hiccup — the next trigger retries */ }
    scanBusy.current = false;
    setScanning(false);
  }, [treasuryId]);
  useEffect(() => { doRescan(); }, [doRescan, rpcNonce]);

  useEffect(() => {
    // never seed or resolve a treasury the genesis gate has not cleared — a refused
    // one must leave no trace in this browser. (When the URL carries a legacy
    // treasuryId and no address is known yet there is nothing to gate on, so
    // resolution proceeds and the RENDER gate below still blocks it.)
    if (gateAddress && !gateOk) return;
    if (isHex64) { setTreasuryId(param); return; }
    let alive = true;
    const resolve = async () => {
    // In Official mode a fresh browser has no endpoint until the resolver has
    // picked a public node — wait for that first, or the whole node-direct path
    // below is silently skipped and the view is stuck read-only.
    await ensureRpcUrl();
    if (!alive) return;
    // Node-direct first: a treasury this browser created/seeded is tracked in
    // localStorage — resolve the vault address locally, zero backend.
    if (getRpcUrl()) {
      const st = findByVault(param);
      if (st) { setTreasuryId(st.treasuryId); return; }
    }
    // Resolve the URL's vault address to a backend treasury. If the backend doesn't
    // have it (fresh machine / lost .secrets / backend down), recover a READ-ONLY
    // view straight from the chain via the REST indexer — no backend dependency.
    // The indexer lags behind fresh treasuries (seconds to minutes), so retry instead
    // of declaring not-found on the first miss.
    const recoverFromChain = async () => {
      let r = { ok: false };
      for (let attempt = 0; alive && attempt < 20; attempt++) {
        try { r = await recoverTreasuryFromChain(param); } catch { r = { ok: false, reason: "fetch-failed" }; }
        if (!alive || r.ok || r.reason === "bad-address") break;
        setRecoverMsg("indexing"); // show "chain indexer catching up" in the loader
        await new Promise((res) => setTimeout(res, 8000));
      }
      if (!alive) return;
      if (r.ok) {
        // Derive owner addresses client-side (wasm) so the UI shows kaspatest:q…
        // not raw pubkeys — the inscription only stores pubkeys.
        await loadWasm();
        if (!alive) return;
        setS({ ...r.status, owners: (r.status.owners || []).map((o) => ({ ...o, address: o.address || pubkeyAddress(o.pubkey) })) });
        // Node-direct (⚙ JSON wRPC set): rebuild the covenant scripts from the
        // recovered owners/threshold/lineage and locate the live KoRoot on chain,
        // so this chain-only treasury can be OPERATED with zero backend. Pool nodes
        // can be flaky — retry, and after a second failure ask the resolver for
        // a different node (which bumps rpcNonce and restarts this resolution).
        if (getRpcUrl()) {
          for (let attempt = 0; alive && attempt < 3; attempt++) {
            try {
              const seeded = await seedFromChain(param, r.status, (t) => push(t));
              if (seeded && alive) { setTreasuryId(seeded.treasuryId); return; } // hand off to the node-direct path
              if (alive) push("node-direct seed found no covenant UTXO yet — retrying…");
            } catch (e) { if (alive) push(`node-direct seed failed: ${e.message || e} — retrying…`, "err"); }
            if (!alive) return;
            if (attempt === 1) { reResolvePublicNode(); return; } // fresh node → rpcNonce re-runs us
            await new Promise((res) => setTimeout(res, 6000));
          }
        }
      } else { setRecoverMsg(r.reason || "not-found"); setNotFound(true); }
    };
    api("/api/treasuries").then((d) => {
      if (!alive) return;
      const up = Array.isArray(d?.treasuries); // backend reachable + responded
      const m = up ? d.treasuries.find((x) => x.address === param || x.treasuryId === param) : null;
      if (m) { setTreasuryId(m.treasuryId); return; }
      return recoverFromChain();
    }).catch(() => { if (alive) recoverFromChain(); });
    };
    resolve();
    return () => { alive = false; };
  }, [param, isHex64, rpcNonce, gateAddress, gateOk]); // re-resolve when the ⚙ endpoint/network changes

  const base = treasuryId ? `/api/treasury/${treasuryId}` : null;
  // refreshes overlap (polls + subscription events + post-op bursts) and read state
  // BEFORE awaiting the node — a stale in-flight result landing after an op's setS
  // would flicker the fresh proposal (and its nav badge) away. Sequence-guard:
  // only the newest refresh writes, and ops invalidate everything in flight.
  const refreshSeq = useRef(0);
  const setStatus = useCallback((next) => { refreshSeq.current++; setS(next); }, []);
  const refresh = useCallback(async () => {
    if (!base) return;
    const seq = ++refreshSeq.current;
    try {
      const direct = await statusDirect(treasuryId); // node-direct (⚙ JSON wRPC) → local state + live balance
      const next = direct || (await api(base));
      if (seq === refreshSeq.current) setS(next);
    } catch (e) { push(`status error: ${e}`, "err"); }
  }, [base, treasuryId]);
  useEffect(() => { refresh(); }, [refresh, chainTick]);

  // After an op lands, the swept/moved balance only reflects once the tx confirms
  // (a few seconds). Re-pull status a few times so the UI updates on its own — no
  // manual refresh needed.
  const scheduleRefresh = useCallback(() => {
    [3500, 8000, 14000].forEach((ms) => setTimeout(() => refresh(), ms));
  }, [refresh]);

  // Polling fallback: re-pull status on a timer so incoming deposits / state
  // changes appear without a manual refresh. Paused while an op runs (don't
  // clobber the terminal) and while the tab is hidden.
  useEffect(() => {
    if (!base) return;
    const id = setInterval(() => {
      if (!busy && document.visibilityState === "visible") refresh();
    }, 8000);
    return () => clearInterval(id);
  }, [base, busy, refresh]);

  // Real-time: direct browser→Kaspa wRPC subscription. Watch not just the vault
  // but the KoRoot and every OPEN proposal's current P2SH address — a co-owner
  // approving/rejecting in another browser spends the proposal UTXO (the vault is
  // untouched until execute), and that spend is our signal to re-walk the chain.
  // Proposal addresses change with every state transition, so the watch set
  // re-binds whenever a rescan lands new state.
  const [live, setLive] = useState("off");
  const vaultAddr = s?.vault?.address;
  const [wasmReady, setWasmReady] = useState(false);
  useEffect(() => { loadWasm().then(() => setWasmReady(true)).catch(() => {}); }, []);
  const watchKey = [
    vaultAddr,
    wasmReady ? p2shAddressSafe(s?.root?.redeemHex) : null,
    ...(wasmReady ? (s?.proposals || []).filter((p) => (p.status ?? 0) < 2).map((p) => p2shAddressSafe(p.proposalRedeemHex)) : []),
  ].filter(Boolean).join(",");
  const watchAddrs = useMemo(() => watchKey.split(",").filter(Boolean), [watchKey]);
  useEffect(() => {
    if (!watchAddrs.length) return;
    const timers = [];
    const onChange = () => {
      refresh(); scheduleRefresh();
      // the indexer we re-walk from lags the node by seconds-to-a-minute — chase
      // the event with staggered rescans until the new state lands
      [0, 10000, 25000, 45000].forEach((ms) => timers.push(setTimeout(doRescan, ms)));
    };
    const stop = subscribeUtxos(watchAddrs, onChange, setLive);
    return () => { stop(); timers.forEach(clearTimeout); };
  }, [watchAddrs, rpcNonce, refresh, scheduleRefresh, doRescan]);

  // KoProposal.closeExpired compares the proposal's committed expiry against the
  // chain's DAA SCORE, so the score is the only thing that says whether retiring a
  // proposal would succeed. Read it while any proposal still holds an unspent bond,
  // and only then: without a node there is no score, and an action we cannot show
  // would succeed is never offered.
  const [daaScore, setDaaScore] = useState(null);
  const bondsOutstanding = (s?.proposals || []).some((p) => !p.executedTxid && p.proposalOutpoint?.txid);
  useEffect(() => {
    if (!bondsOutstanding || !getRpcUrl()) { setDaaScore(null); return; }
    let alive = true;
    const pull = () => currentDaaScore().then((d) => { if (alive) setDaaScore(d); }).catch(() => {});
    pull();
    const id = setInterval(() => { if (document.visibilityState === "visible") pull(); }, 60000);
    return () => { alive = false; clearInterval(id); };
  }, [bondsOutstanding, rpcNonce, chainTick]);

  // No live subscription (borsh-only node / ws blocked)? Re-walk the chain every
  // 30s so co-owner signatures still show up without a manual reload.
  useEffect(() => {
    if (!treasuryId || live === "live") return;
    const id = setInterval(() => {
      if (!busy && document.visibilityState === "visible") doRescan();
    }, 30000);
    return () => clearInterval(id);
  }, [treasuryId, live, busy, doRescan]);

  // Backend-free (chain-recovered) view: keep the vault balance live straight from
  // api-tn10 — no backend in the path. Pausing while the tab is hidden.
  useEffect(() => {
    if (!s?.recovered || !vaultAddr) return;
    const id = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      const bal = await fetchBalance(vaultAddr);
      if (bal != null) setS((cur) => (cur?.recovered ? { ...cur, vault: { ...cur.vault, balanceSompi: bal } } : cur));
    }, 8000);
    return () => clearInterval(id);
  }, [s?.recovered, vaultAddr]);

  // append the result of an op to the terminal log (txid + tail of tool output)
  const logResult = (label, r) => {
    const tx = (r.stdout || "").match(/txid\s*:?\s*([0-9a-f]{64})/i);
    if (r.ok) { push(`${label} ok`, "ok"); if (tx) push(`txid ${tx[1]}`, "info"); }
    else {
      push(`${label} failed`, "err");
      (r.stderr || r.stdout || JSON.stringify(r)).trim().split("\n").slice(-4).forEach((m) => m && push(m, "err"));
    }
    if (r.status) setStatus(r.status);
    return r;
  };
  // backend-only ops (no owner signature): sweep
  const act = async (label, action, body) => {
    setBusy(label); clear(); push(label, "cmd"); push("submitting to TN10 — on-chain confirm takes a few seconds…");
    let r = { ok: false };
    try { r = logResult(label, await api(`${base}/${action}`, body ?? {})); }
    catch (e) { push(`${label}: ${e}`, "err"); }
    setBusy("");
    if (r.ok) { push("auto-refreshing as it confirms — no need to reload…"); scheduleRefresh(); }
    return r;
  };
  // owner-signed ops: prepare (sighash) -> sign in this tab -> submit
  const signedAct = async (label, action, body) => {
    if (!myPubkey) { clear(); push("Import your owner key (top-right) to sign.", "err"); return { ok: false }; }
    setBusy(label); clear(); push(label, "cmd");
    let r = { ok: false };
    try {
      push("building covenant tx (prepare)…");
      const prep = await api(`${base}/${action}/prepare`, body ?? {});
      if (!prep.ok || !prep.sighash) {
        push(`${label} prepare failed`, "err");
        (prep.stderr || "").trim().split("\n").slice(-4).forEach((m) => m && push(m, "err"));
        setBusy(""); return { ok: false };
      }
      push(`sighash ${prep.sighash.slice(0, 28)}…`);
      push("signing locally (BIP340 Schnorr)…");
      const sig = sign(prep.sighash);
      push("submitting to TN10 — confirm takes a few seconds…");
      r = logResult(label, await api(`${base}/${action}/submit`, { ...(body ?? {}), sig }));
    } catch (e) { push(`${label}: ${e.message || e}`, "err"); }
    setBusy("");
    if (r.ok) { push("auto-refreshing as it confirms — no need to reload…"); scheduleRefresh(); }
    return r;
  };

  // Route B: ops built entirely in the browser (wasm) → relay. The backend only
  // serves public data + forwards the finished tx; it never builds or signs.
  const wasmAct = async (label, fn, { needKey = true } = {}) => {
    if (needKey && !myPubkey) { clear(); push("Import your owner key (top-right) to sign.", "err"); return; }
    setBusy(label); clear(); push(label, "cmd");
    let r = { ok: false };
    try {
      r = await fn(base, (t, k) => push(t, k));
      push(`${label} ok`, "ok");
      if (r.txid) push(`txid ${r.txid}`, "info");
      if (r.status) setStatus(r.status);
      push("auto-refreshing as it confirms…"); scheduleRefresh();
    } catch (e) { push(`${label} failed: ${e.message || e}`, "err"); }
    setBusy(""); return r;
  };
  // the sweeper funds the sweep fee from their own wallet now → needs a key;
  // opts carry the batching hooks (dust filter, progress, cancel) from Assets
  const sweepWasm = (opts) => wasmAct("sweep (wasm)", (b, log) => sweepClientSide(b, treasuryId, log, opts), { needKey: true });
  const doPropose = (amountSompi, recipient, expirySecs) => wasmAct(`propose (owner ${myIndex})`, (b, log) => proposeClientSide(b, treasuryId, { amountSompi, recipient, proposerIndex: myIndex, expirySecs }, log));
  const doApprove = (proposalId, ownerIndex) => wasmAct(`approve #${proposalId} (owner ${ownerIndex})`, (b, log) => approveClientSide(b, treasuryId, { proposalId, ownerIndex }, log));
  const doReject = (proposalId, ownerIndex) => wasmAct(`reject #${proposalId} (owner ${ownerIndex})`, (b, log) => rejectClientSide(b, treasuryId, { proposalId, ownerIndex }, log));
  const doExecute = (proposalId, ownerIndex) => {
    const p = (s?.proposals || []).find((x) => String(x.proposalId) === String(proposalId));
    let recipientAddress = p?.recipientAddress;
    if (p && p.operation !== 2 && !p.recipientSpkHex && !recipientAddress) {
      recipientAddress = window.prompt("This proposal's recipient wasn't published on-chain (created before recipient publishing). Enter the recipient address to execute:") || "";
      if (!recipientAddress) return; // cancelled
    }
    return wasmAct(`execute #${proposalId} (owner ${ownerIndex})`, (b, log) => executeClientSide(b, treasuryId, { proposalId, ownerIndex, recipientAddress }, log));
  };
  const doConfigPropose = (args) => wasmAct(`propose signer change (owner ${myIndex})`, (b, log) => configProposeClientSide(b, treasuryId, { ...args, proposerIndex: myIndex }, log));
  // Retiring an expired proposal is PERMISSIONLESS — no owner index, no signature —
  // so it needs no key, only somewhere to send the freed bond. KasWare reports its
  // address directly; a manual key is turned into one client-side.
  const payoutAddress = walletAddress() || (myPubkey ? pubkeyAddress(myPubkey) : null);
  // needKey: the key signs the FEE inputs only (the bond itself returns to the
  // vault, so retiring is no longer self-funding); the entrypoint stays permissionless.
  const doRetire = (proposalId) => wasmAct(`retire #${proposalId} (expired)`, (b, log) => closeExpiredClientSide(b, treasuryId, { proposalId }, log), { needKey: true });

  // REFUSE: a treasury whose genesis bound anything beyond its own root and vault
  // is not openable and never gets a deposit address.
  if (gate?.verdict === "refused") return <GenesisRefused param={param} gate={gate} />;
  // Not yet established either way — also not safe to deposit into. Keeps retrying
  // (fresh treasuries lag the indexer by seconds to minutes).
  if (gateAddress && !gateOk) {
    return (
      <GenesisChecking
        param={param}
        gate={gate}
        freshlyMinted={freshlyMinted}
        onOverride={() => { setOverride(gateAddress); setOverridden(true); }}
      />
    );
  }

  if (notFound || (s && !s.treasuryId && !s.recovered)) return (
    <div className="app"><div className="content"><div className="page-in">
      <div className="panel">
        {recoverMsg === "no-inscription" ? (
          <p className="muted">No on-chain recovery record for <code className="mono">{short(param, 14)}</code>. This treasury predates the recovery inscription, or isn't a Ko-sign vault.</p>
        ) : (
          <p className="muted">No treasury found for <code className="mono">{short(param, 14)}</code> — nothing stored in this browser, and no recovery inscription on-chain.</p>
        )}
        <button className="btn btn-ghost" onClick={() => go("/create")}>← Create a treasury</button>
      </div>
    </div></div></div>
  );
  if (!s) return (
    <div className="app"><div className="content"><div className="loadwrap">
      <div className="loader">
        <div className="orbit"><i /><i /><i /><span className="core" /></div>
        <div className="load-title">Syncing treasury from chain</div>
        <div className="load-bar"><i /></div>
        <code className="mono load-addr">{param}</code>
        {recoverMsg === "indexing" && <div className="load-note">The chain indexer is still catching up on this treasury (fresh treasuries take seconds to a few minutes) — retrying automatically…</div>}
      </div>
    </div></div></div>
  );

  const myIndex = s.owners?.findIndex((o) => o.pubkey === myPubkey) ?? -1;
  const recovered = !!s.recovered;
  // nav badges derive from the same chain-synced state the pages render, so any
  // action that setS()es (config propose from Settings, approve, sweep, live
  // rescans) moves the counts without extra wiring
  const queueCount = (s.proposals || []).filter((p) => (p.status ?? 0) < 2).length;
  const unsweptSompi = s.vault?.unsweptSompi || 0;
  const strayCount = unsweptSompi > 0 ? (s.vault?.strays?.length || 1) : 0;
  const NAV = [
    { id: "assets", label: "Assets", icon: "◈", badge: strayCount, tone: "warn", hint: `${strayCount} unswept deposit${strayCount === 1 ? "" : "s"} waiting to be swept into the covenant` },
    { id: "transactions", label: "Transactions", icon: "⇄", badge: queueCount, tone: "teal", hint: `${queueCount} proposal${queueCount === 1 ? "" : "s"} in the queue awaiting signatures` },
    { id: "settings", label: "Settings", icon: "⚙" },
  ];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand-mini" onClick={() => go("/")}>
          <span className="dot" /><span>Ko-<span className="grad">sign</span></span>
        </div>
        <nav className="sidenav">
          {NAV.map((n) => (
            <button key={n.id} className={`sideitem ${page === n.id ? "on" : ""}`} onClick={() => setPage(n.id)} title={n.badge ? n.hint : undefined}>
              <span className="sideicon">{n.icon}</span>{n.label}
              {n.badge > 0 && <span className={`sidebadge ${n.tone}`}>{n.badge}</span>}
            </button>
          ))}
        </nav>
        <div className="sidefoot">
          <button className="sideitem" onClick={() => go("/create")}><span className="sideicon">+</span>Create treasury</button>
        </div>
      </aside>

      <div className="content">
        <header className="topbar" style={{ justifyContent: "flex-end" }}>
          <div className="topbar-right"><KeyBar /></div>
        </header>

        <div className="page-in wide">
          {/* Only surface a banner when there's something to act on. Node-direct
              (zero backend, endpoint set) is the normal healthy state — no banner.
              A chain-recovered treasury is operable from the endpoint alone; whether
              a backend happens to be reachable no longer changes what the owner can
              do, so the endpoint is the only thing worth asking for. */}
          {recovered && !getRpcUrl() && (
            <div className="panel" style={{ borderColor: "rgba(240,180,40,.4)", background: "rgba(240,180,40,.06)", marginBottom: 16 }}>
              <span className="warn" style={{ display: "block" }}>⌁ No node endpoint yet — set one in ⚙ to propose / approve / sweep. Viewing works from chain in the meantime.</span>
            </div>
          )}
          {s.policySource === "genesis" && <GenesisPolicyBanner />}
          {gate?.verdict !== "clean" && (
            // opened through the unverified escape hatch: the one defence against a
            // forged genesis covenant did not run, so say so on every page
            <div className="panel" style={{ borderColor: "rgba(240,180,40,.4)", background: "rgba(240,180,40,.06)", marginBottom: 16 }}>
              <span className="warn" style={{ display: "block" }}>
                ⌁ Opened WITHOUT genesis verification — {gate?.reason || "the genesis transaction could not be read."} Do not deposit into this treasury until it verifies.
              </span>
            </div>
          )}
          {gate?.verdict === "clean" && !gate.cryptographic && <GenesisPartial gate={gate} />}
          {/* The deposit address turns on the BINDING, not on the verdict. The audit
              now refuses to call a genesis clean when it could not tie the transaction
              to this address, so the two agree — and they are still asked separately
              on purpose. This is the one control where money is at stake, so it names
              the property it needs (this genesis derives THIS vault) instead of
              trusting a summary word to keep meaning that. */}
          {page === "assets" && <Assets s={s} busy={busy} act={act} recovered={recovered} live={live} onSweep={sweepWasm} myIndex={myIndex} genesisVerified={gate?.verdict === "clean" && !!gate?.cryptographic} genesisConfirmed={!!gate?.cryptographic} />}
          {page === "transactions" && <Transactions s={s} busy={busy} myIndex={myIndex} act={act} signedAct={signedAct} wasm={{ doApprove, doReject, doExecute, doRetire }} onPropose={() => setProposeOpen(true)} recovered={recovered} scanning={scanning} daaScore={daaScore} payoutAddress={payoutAddress} />}
          {page === "settings" && <Settings s={s} myIndex={myIndex} busy={busy} act={act} signedAct={signedAct} wasm={{ doConfigPropose }} recovered={recovered} />}
        </div>
      </div>

      <ProposeModal open={proposeOpen} onClose={() => setProposeOpen(false)} s={s} busy={busy} myIndex={myIndex} act={act} doPropose={doPropose} />
    </div>
  );
}

// ---------- New-transfer modal (opened from the sidebar / Transactions) ----------
function ProposeModal({ open, onClose, s, busy, myIndex, act, doPropose }) {
  const [amount, setAmount] = useState("1");
  const [recipient, setRecipient] = useState("");
  const [expiryDays, setExpiryDays] = useState(30);
  if (!open) return null;
  const clientSigned = (s.owners?.length ?? 0) > 0 && !s.owners.some((o) => o.local);
  const needsKey = clientSigned && myIndex < 0;
  // Creating the proposal COSTS the proposer a 0.5 KAS bond, and the covenant only
  // discovers an unfundable transfer at execute time — after the bond is paid, the
  // co-owners have signed, and (until the proposal expires) with no way to get the
  // bond back. The vault balance is on this very screen, so the check belongs here,
  // where the amount is still just text in a box.
  const bal = s.vault?.balanceSompi;
  const { sompi, ok, error } = checkTransfer(amount, bal);
  const canSubmit = !busy && !needsKey && ok;
  const submit = () => {
    const to = recipient || s.fundingAddress;
    onClose(); // progress streams in the global console dock (auto-opens)
    if (clientSigned) doPropose(sompi, to, expiryDays * 86400); // route B: built in the browser
    else act("create proposal", "proposal", { amountSompi: sompi, recipient: to, proposer: 0 });
  };
  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>New transfer</h3><button className="x" onClick={busy ? undefined : onClose} disabled={busy}>✕</button></div>
        <p className="muted">Propose moving KAS out of the vault. Co-owners approve, then any owner executes.</p>
        <label className="lbl">Recipient address</label>
        <input className="input" placeholder={s.fundingAddress} value={recipient} onChange={(e) => setRecipient(e.target.value)} />
        <label className="lbl">Amount (KAS)</label>
        <input className={`input ${error ? "input-bad" : ""}`} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        <div className="propose-bal">
          <span className="muted">Vault balance <b className="mono ok">{KAS(bal)} KAS</b></span>
          {bal != null && <button className="btn btn-ghost" style={{ padding: "2px 10px" }} onClick={() => setAmount(String(Number(bal) / 1e8))}>Use balance</button>}
        </div>
        {error && <p className="warn" style={{ fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
        <label className="lbl">Expires after</label>
        <div style={{ display: "flex", gap: 6 }}>
          {[7, 30, 90].map((d) => (
            <button key={d} className={`btn ${expiryDays === d ? "btn-primary" : "btn-ghost"}`} style={{ padding: "4px 14px" }} onClick={() => setExpiryDays(d)}>{d} days</button>
          ))}
        </div>
        <p className="muted" style={{ fontSize: 11.5, margin: "6px 0 0" }}>
          An approved-but-unexecuted proposal stays executable until it expires — a shorter life is a shorter
          standing authorization. After expiry it can be retired, which frees the bond.
        </p>
        <p className="muted" style={{ fontSize: 11.5, margin: "10px 0 0" }}>
          Proposing locks a {KAS(PROPOSAL_BOND)} KAS bond from your wallet. Executing the proposal returns it; if the proposal is
          never executed, the bond goes back to the vault once the committed expiry passes and someone retires it.
        </p>
        <button className="btn btn-primary btn-block" style={{ marginTop: 18 }} disabled={!canSubmit} onClick={submit}>
          {needsKey ? "Import an owner key to propose" : "Propose transfer"}
        </button>
      </div>
    </div>
  );
}

// ---------- Assets: vault holdings + deposit/sweep + on-chain activity ----------
const ago = (t) => {
  if (!t) return "—";
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 60) return `${sec | 0}s ago`;
  if (sec < 3600) return `${(sec / 60) | 0}m ago`;
  if (sec < 86400) return `${(sec / 3600) | 0}h ago`;
  return `${(sec / 86400) | 0}d ago`;
};
const signedKAS = (net) => `${net < 0 ? "−" : "+"}${KAS(Math.abs(net))}`;

function Assets({ s, busy, act, recovered, live, onSweep, myIndex, genesisVerified = true, genesisConfirmed = true }) {
  const bal = s.vault?.balanceSompi;
  const unswept = s.vault?.unsweptSompi || 0;
  const strays = s.vault?.strays || [];
  const addr = s.vault?.address;
  const netId = useNetworkId();

  // On-chain activity of the vault address, straight from the REST indexer —
  // re-pulled when the balance moves (a tx landed) and on a slow poll.
  const [acts, setActs] = useState(null);
  const [actErr, setActErr] = useState(false);
  const [filter, setFilter] = useState("all");
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    if (!addr) return;
    let alive = true;
    const pull = () => fetchAddressActivity(addr, 25)
      .then((a) => { if (alive) { setActs(a); setActErr(false); } })
      .catch(() => { if (alive) setActErr(true); });
    pull();
    const id = setInterval(() => { if (document.visibilityState === "visible") pull(); }, 30000);
    return () => { alive = false; clearInterval(id); };
  }, [addr, bal, unswept, netId]);

  const shown = (acts || []).filter((a) => (filter === "out" ? a.kind === "out" : filter === "in" ? a.kind === "in" || a.kind === "genesis" : true));

  const [copied, setCopied] = useState(false);
  const copyAddr = () => { copy(addr); setCopied(true); setTimeout(() => setCopied(false), 1600); };

  // A sweep is only "done" once the chain reflects it (the stray UTXO set
  // changes) — keep the button locked through submit + confirm so it can't be
  // double-fired, with a 45s safety release.
  const [sweeping, setSweeping] = useState(false);
  const strayKey = strays.map((u) => `${u.txid}:${u.index}`).join(",");
  // A multi-batch run shrinks the stray set batch by batch — releasing on every
  // strayKey change would kill the progress label + cancel button mid-run, so
  // only release when no engine run is in flight.
  const runningRef = useRef(false);
  useEffect(() => { if (!runningRef.current) setSweeping(false); }, [strayKey]);
  // Batched sweeps: dust filter toggle, live per-batch progress, cancel flag,
  // and a pre-sweep quote (batch count + fee) from the exact wasm mass model.
  const [includeDust, setIncludeDust] = useState(false);
  const [prog, setProg] = useState(null);
  const [quote, setQuote] = useState(null);
  const cancelRef = useRef(false);
  useEffect(() => {
    let alive = true;
    if (!strays.length || !s.treasuryId) { setQuote(null); return; }
    quoteSweep(s.treasuryId, strays, { includeDust }).then((q) => { if (alive) setQuote(q); });
    return () => { alive = false; };
  }, [strayKey, includeDust, s.treasuryId]);
  // safety release: 90s per batch — each progress tick resets the timer
  useEffect(() => {
    if (!sweeping) return;
    const t = setTimeout(() => setSweeping(false), 90000);
    return () => clearTimeout(t);
  }, [sweeping, prog]);
  const clickSweep = async () => {
    cancelRef.current = false;
    setProg(null);
    setSweeping(true);
    runningRef.current = true;
    const r = await onSweep({
      includeDust,
      onProgress: (p) => setProg(p),
      shouldCancel: () => cancelRef.current,
    });
    runningRef.current = false;
    setProg(null);
    if (!r || r.ok === false) setSweeping(false); // failed/aborted — release now
  };

  // KAS → USD equivalent next to the vault total (CoinGecko, indexer fallback)
  const [kasUsd, setKasUsd] = useState(null);
  useEffect(() => {
    let alive = true;
    const pull = () => fetchKasUsd().then((p) => { if (alive) setKasUsd(p); }).catch(() => {});
    pull();
    const id = setInterval(() => { if (document.visibilityState === "visible") pull(); }, 60000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  const usdVal = kasUsd != null && bal != null ? (Number(bal) / 1e8) * kasUsd : null;

  // KasWare mode: deposit into the vault straight from the connected wallet
  const source = useWalletSource();
  const [depAmt, setDepAmt] = useState("");
  const [depBusy, setDepBusy] = useState(false);
  const depositFromWallet = async () => {
    const sompi = Math.round(parseFloat(depAmt) * 1e8);
    if (!(sompi > 0) || !addr) return;
    setDepBusy(true);
    try { await kaswareSend(addr, sompi); setDepAmt(""); }
    catch (e) { termPush(`kasware deposit failed: ${e.message || e}`, "err"); }
    setDepBusy(false);
  };

  return (
    <>
      <div className="page-head">
        <h2 className="page-title" style={{ margin: 0 }}>Assets</h2>
        <span className={`livepill ${live === "live" ? "on" : ""}`} title={live === "live" ? "Live via direct wRPC subscription" : "Auto-refreshing every 8s (set a wRPC endpoint in ⚙ for live)"}>
          <span className="livedot" />{live === "live" ? "Live" : live === "connecting" ? "Connecting…" : "Auto-refresh"}
        </span>
      </div>

      <div className="assets-grid">
        <div className="assets-main">
          {/* the deposit address is what people come here for — it leads. It is also
              the one thing a forged-genesis treasury must never be able to show, so
              it is withheld until the genesis audit has actually cleared. */}
          {!genesisVerified ? (
            <div className="panel depositcard" style={{ borderColor: "rgba(240,180,40,.4)" }}>
              <div className="deposit-k">◈ Deposit address withheld</div>
              <p className="muted" style={{ margin: "10px 0 0" }}>
                This treasury's genesis transaction has not been verified, so its deposit address is not
                shown. Until it is, two things are unknown: whether this address descends from that
                genesis at all, and whether the genesis bound anything beyond the KoRoot into the
                covenant — a second member is a proposal the creator can execute against your deposits at
                any time, and no contract can detect it. See SECURITY.md → "Genesis provenance". Reload
                once the chain indexer has caught up.
              </p>
            </div>
          ) : (
          <div className="panel depositcard">
            <div className="deposit-k">◈ Deposit address</div>
            <div className="deposit-row">
              <code className="mono deposit-addr">{addr || "—"}</code>
              <button className={`btn ${copied ? "btn-primary" : "btn-ghost"} deposit-copy`} onClick={copyAddr} disabled={!addr}>
                {copied ? "Copied ✓" : "⧉ Copy"}
              </button>
            </div>
            <p className="muted" style={{ margin: "10px 0 0" }}>The vault address is fixed — funds sent straight to it can always be swept into the covenant (never locked).</p>
            {!genesisConfirmed && (
              // The genesis audit cleared on structure and member identity, but the chain
              // source did not report the genesis in full (no funding outpoint), so the
              // covenant id could not be recomputed and this address could not be derived
              // from it. The treasury looks honest; nothing yet says it is THIS one's.
              <p className="warn" style={{ margin: "10px 0 0", fontSize: 12 }}>
                ⌁ This address was not derived from the genesis — the chain source gave only part of
                it. Reload before depositing anything you would mind losing.
              </p>
            )}
            {source === "kasware" && (
              <div className="deposit-kw">
                <input className="input mono" placeholder="amount (KAS)" value={depAmt} onChange={(e) => setDepAmt(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && depositFromWallet()} style={{ margin: 0, flex: 1 }} />
                <button className="btn btn-ghost" disabled={depBusy || !(parseFloat(depAmt) > 0)} onClick={depositFromWallet}>
                  {depBusy ? "waiting for KasWare…" : "⛓ Deposit from KasWare"}
                </button>
              </div>
            )}
          </div>
          )}

          <div className="total-row">
            <div>
              <div className="muted" style={{ margin: 0 }}>Total vault value</div>
              <div className="total">{KAS(bal)} <span className="total-unit">KAS</span>{usdVal != null && <span className="total-usd">≈ {usdFmt(usdVal)}</span>}</div>
              {kasUsd != null && <div className="usd-basis">KAS/USD {priceFmt(kasUsd)} · coingecko</div>}
            </div>
          </div>

          <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
            <div className="atable-head"><span>Asset</span><span style={{ textAlign: "right" }}>Balance</span></div>
            <div className="atable-row">
              <span className="asset-cell"><span className="coin">K</span><div><b>Kaspa</b><div className="muted" style={{ margin: 0, fontSize: 11 }}>KAS</div></div></span>
              <span style={{ textAlign: "right" }}>
                <b className="ok">{KAS(bal)} KAS</b>
                {usdVal != null && <div className="usd-sub">≈ {usdFmt(usdVal)} USD</div>}
              </span>
            </div>
          </div>
        </div>

        <aside className="assets-side">
          {unswept > 0 && (
            <div className="straycard">
              <div className="term-bar">
                <span className="term-dots"><i /><i /><i /></span>
                <span className="term-title">unswept · inputs</span>
                <span className="term-status stray-status">⚠ {strays.length || 1} pending</span>
              </div>
              <div className="stray-body">
                <p className="stray-note">Sent straight to the vault address. The covenant already protects it: the only spend it permits is a sweep back into this vault, so nobody can take it — it simply isn't part of the covenant balance until swept. Sweeping keeps every sompi; the network fee comes from your connected wallet.</p>
                {(strays.length ? strays.slice(0, 8) : [{ txid: null, index: 0, amountSompi: unswept }]).map((u) => (
                  <div className="strayrow" key={u.txid ? `${u.txid}:${u.index}` : "pending"}>
                    <span className="stray-glyph">◇</span>
                    <div className="stray-mid">
                      <b className="stray-amt">+{KAS(u.amountSompi)} KAS</b>
                      <code className="mono stray-tx">{u.txid ? `${u.txid.slice(0, 10)}…${u.txid.slice(-6)} #${u.index}` : "awaiting sweep"}</code>
                    </div>
                    <span className="stray-tag">unswept</span>
                  </div>
                ))}
                {strays.length > 8 && (
                  <div className="mono" style={{ fontSize: 11, opacity: 0.7, padding: "4px 2px" }}>
                    …and {strays.length - 8} more deposit{strays.length - 8 === 1 ? "" : "s"}
                  </div>
                )}
                {!recovered && quote && (quote.batches > 1 || quote.dust > 0) && (
                  <div className="mono" style={{ fontSize: 11, opacity: 0.8, marginTop: 8, lineHeight: 1.6 }}>
                    {quote.keep > 0 && (
                      <div>{quote.keep} deposit{quote.keep === 1 ? "" : "s"} → {quote.batches} chained tx{quote.batches === 1 ? "" : "s"} (≤{quote.cap}/tx) · est. fee ≥ {(quote.feeSompi / 1e8).toFixed(2)} KAS from your wallet</div>
                    )}
                    {quote.dust > 0 && (
                      <label style={{ display: "block", cursor: "pointer" }}>
                        <input type="checkbox" checked={includeDust} onChange={(e) => setIncludeDust(e.target.checked)} style={{ verticalAlign: "middle", marginRight: 5 }} />
                        include {quote.dust} dust deposit{quote.dust === 1 ? "" : "s"} ({(quote.dustSompi / 1e8).toFixed(4)} KAS) — sweeping dust can cost more than it's worth
                      </label>
                    )}
                  </div>
                )}
                {!recovered && strays.length >= 10 && !sweeping && (
                  <div className="mono" style={{ fontSize: 11, color: "#e0b64f", marginTop: 6 }}>
                    ⚠ deposits are piling up — sweep regularly: each pending deposit adds ~{quote && quote.keep ? (quote.feeSompi / quote.keep / 1e8).toFixed(3) : "0.014"} KAS to the eventual sweep fee
                  </div>
                )}
                {!recovered && (
                  <button className={`btn btn-primary btn-block${sweeping ? " sweeping" : ""}`} style={{ marginTop: 10 }}
                    disabled={!!busy || sweeping || source !== "manual" || myIndex < 0} onClick={clickSweep}
                    title={source !== "manual" ? "The sweeper pays the network fee (sized from the tx mass), so the sweep needs a signing key"
                      : myIndex < 0 ? "Sweeping from here is owner-only (the connected key isn't one of this treasury's signers)" : undefined}>
                    {sweeping ? (prog && prog.batches > 1 ? `⇣ batch ${prog.batch}/${prog.batches} — ${prog.swept}/${prog.total} deposits swept…` : "⇣ sweeping — waiting for on-chain confirm…")
                      : source === "kasware" ? "⌘ Manual key needed — KasWare can't sign the fee input yet"
                      : source !== "manual" ? "⌘ Connect a wallet (Manual key) to sweep"
                      : myIndex < 0 ? "⌘ Connected key isn't a treasury owner — sweep is owner-only"
                      : `⇣ Sweep ${KAS(quote && !includeDust ? unswept - quote.dustSompi : unswept)} KAS into the covenant`}
                  </button>
                )}
                {!recovered && sweeping && prog && prog.batches > 1 && prog.batch < prog.batches && (
                  <button className="btn btn-block" style={{ marginTop: 6 }} onClick={() => { cancelRef.current = true; }}
                    title="Finishes the in-flight batch, then stops — swept deposits stay final, the rest remain pending">
                    ✕ stop after current batch
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="actcard">
            <div className="term-bar">
              <span className="term-dots"><i /><i /><i /></span>
              <span className="term-title">vault · on-chain activity</span>
              <span className="term-status">● {getNetwork().rest.replace("https://", "")}</span>
            </div>
            <div className="act-filters">
              {["all", "out", "in"].map((f) => (
                <button key={f} className={`act-filter ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>{f.toUpperCase()}</button>
              ))}
              <span className="act-hint">tap a tx for details</span>
            </div>
            <div className="act-body">
              {acts === null && !actErr && <div className="act-empty"><span className="act-scan" />scanning the DAG…</div>}
              {actErr && acts === null && <div className="act-empty">indexer unreachable — retrying…</div>}
              {acts !== null && shown.length === 0 && <div className="act-empty">no {filter !== "all" ? `${filter}going ` : ""}transactions yet</div>}
              {shown.map((a) => {
                const k = a.kind || (a.net < 0 ? "out" : "in");
                const glyph = k === "sweep" ? "⟲" : k === "genesis" ? "◈" : k === "out" ? "⇡" : "⇣";
                const cls = k === "sweep" || k === "genesis" ? "sweep" : k;
                const label = k === "sweep"
                  ? (a.absorbed > 0 ? `+${KAS(a.absorbed)} KAS swept in` : "compaction · ±0")
                  : `${signedKAS(a.net)} KAS`;
                const kindWord = k === "sweep" ? "sweep" : k === "genesis" ? "genesis" : k === "out" ? "transfer" : "deposit";
                return (
                  <button className="actrow" key={a.txid} onClick={() => setDetail(a)}>
                    <span className={`act-glyph ${cls}`}>{glyph}</span>
                    <span className="act-mid">
                      <b className={`act-amt ${cls}`}>{label}</b>
                      <code className="mono act-tx">{kindWord} · {a.txid.slice(0, 10)}…{a.txid.slice(-6)}{a.covenant ? " ⛓" : ""}</code>
                    </span>
                    <span className="act-end">
                      <span className={`act-pill ${a.accepted ? "ok" : ""}`}>{a.accepted ? "Confirmed" : "Pending"}</span>
                      <span className="act-time">{ago(a.time)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>
      </div>

      <TxDetailModal tx={detail} addr={addr} onClose={() => setDetail(null)} />
    </>
  );
}

// ---------- Transaction detail modal (explorer-style, data from the indexer) ----------
function TxDetailModal({ tx, addr, onClose }) {
  if (!tx) return null;
  const fmt = (t) => (t ? new Date(t).toLocaleString() : "—");
  const cut = (h, n = 14) => (h ? `${h.slice(0, n)}…${h.slice(-8)}` : "—");
  const Row = ({ k, children, copyVal }) => (
    <div className="drow">
      <span className="dk">{k}</span>
      <span className="dv">{children}{copyVal && <button className="dcopy" title="Copy" onClick={() => copy(copyVal)}>⧉</button>}</span>
    </div>
  );
  const IO = ({ list, sign }) => (
    <div className="dio">
      {list.map((x, i) => (
        <div className="diorow" key={i}>
          <span className={`dioaddr mono ${x.address === addr ? "self" : ""}`}>
            {x.address ? `${x.address.slice(0, 18)}…${x.address.slice(-8)}` : "—"}
            {x.address === addr ? " (this vault)" : ""}{x.covenant ? " ⛓" : ""}
          </span>
          <b className={`dioamt ${sign === "-" ? "out" : "in"}`}>{x.amount != null ? `${sign}${KAS(x.amount)}` : "—"}</b>
        </div>
      ))}
      {list.length === 0 && <div className="muted" style={{ fontSize: 12 }}>none (coinbase)</div>}
    </div>
  );
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal txmodal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Transaction detail</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        {tx.kind === "sweep" ? (
          <div className="dnet sweep">
            <span className="dnet-glyph">⟲</span>
            <b>{tx.absorbed > 0 ? `+${KAS(tx.absorbed)} KAS swept into the covenant` : "compaction — vault value preserved"}</b>
            <span className="dnet-sub">sweep · net {signedKAS(tx.net)}</span>
          </div>
        ) : (
          <div className={`dnet ${tx.net < 0 ? "out" : "in"}`}>
            <span className="dnet-glyph">{tx.kind === "genesis" ? "◈" : tx.net < 0 ? "⇡" : "⇣"}</span>
            <b>{signedKAS(tx.net)} KAS</b>
            <span className="dnet-sub">net for this vault</span>
          </div>
        )}
        <Row k="Type"><b className={tx.kind === "out" ? "warn" : "ok"}>{
          tx.kind === "sweep" ? "⟲ Sweep — strays consolidated into the covenant (fee paid by the sweeper)"
          : tx.kind === "genesis" ? "◈ Genesis — covenant vault minted"
          : tx.kind === "out" ? "⇡ Transfer out (covenant execute)"
          : "⇣ Deposit"
        }</b></Row>
        <Row k="Transaction ID" copyVal={tx.txid}>
          <a className="dlink mono" href={`${getNetwork().explorer}/txs/${tx.txid}`} target="_blank" rel="noreferrer" title="Open in explorer">{cut(tx.txid)} ↗</a>
        </Row>
        <Row k="Hash" copyVal={tx.hash}><span className="mono">{cut(tx.hash)}</span></Row>
        <Row k="Status"><b className={tx.accepted ? "ok" : "warn"}>{tx.accepted ? "Accepted" : "Pending"}</b></Row>
        <Row k="Time"><span className="mono">{fmt(tx.time)}</span></Row>
        <Row k="Mass"><span className="mono">{tx.mass ?? "—"}</span></Row>
        <Row k="Fee"><span className="mono">{tx.fee != null ? `${KAS(tx.fee)} KAS` : "—"}</span></Row>
        <Row k="Subnetwork" copyVal={tx.subnetworkId}><span className="mono">{cut(tx.subnetworkId, 10)}</span></Row>
        <Row k="Blue score"><span className="mono">{tx.blueScore?.toLocaleString() ?? "—"}</span></Row>
        <Row k="Accepting block" copyVal={tx.acceptingBlockHash}><span className="mono">{cut(tx.acceptingBlockHash, 10)}</span></Row>
        {tx.covenant && <Row k="Covenant"><b className="ok">⛓ covenant transaction</b></Row>}
        <div className="dk dio-h">Inputs ({tx.inputs.length})</div>
        <IO list={tx.inputs} sign="-" />
        <div className="dk dio-h">Outputs ({tx.outputs.length})</div>
        <IO list={tx.outputs} sign="+" />
      </div>
    </div>
  );
}

// ---------- Settings: signers + required confirmations + signer activity ----------
function Settings({ s, myIndex, busy, act, signedAct, wasm, recovered }) {
  return (
    <>
      <h2 className="page-title">Settings</h2>
      <div className="txs-grid">
        <div className="txs-main">
          <div className="h3" style={{ marginTop: 4 }}>Signers</div>
          <div className="panel">
            <p className="muted">Signers have full control: they can propose, approve and execute transactions. Each signs in their own browser with an imported key — the backend holds no keys.{recovered ? " (Recovered from chain — shown as x-only pubkeys.)" : ""}</p>
            {s.policySource === "genesis" && <GenesisPolicyNote />}
            {s.owners.map((o, i) => (
              <div className="member" key={i}>
                <Avatar seed={o.address || o.pubkey || String(i)} />
                <div className="member-body">
                  <div className="member-name">owner {i}{i === myIndex ? <span className="you-tag">you</span> : null}{o.local ? <span className="you-tag local">backend key</span> : null}</div>
                  <code className="mono">{o.address || o.pubkey || "—"}</code>
                </div>
                <button className="btn btn-ghost copybtn" onClick={() => copy(o.address || o.pubkey)}>Copy</button>
              </div>
            ))}
          </div>

          {!recovered && <ManageSigners s={s} myIndex={myIndex} busy={busy} act={act} signedAct={signedAct} wasm={wasm} />}

          <div className="h3">Required confirmations</div>
          <div className="panel">
            <div className="row" style={{ borderBottom: 0 }}>
              <span className="k">Any transaction requires</span>
              <b className="big"><span className="ok">{s.threshold}</span> out of {s.owners.length} signers</b>
            </div>
            {s.policySource === "genesis" && <GenesisPolicyNote />}
          </div>
        </div>

        <SignerSide s={s} myIndex={myIndex} />
      </div>
    </>
  );
}

// ---------- Settings right column: per-signer participation + on-chain activity log ----------
function SignerSide({ s, myIndex }) {
  const owners = s.owners || [];
  // flatten every proposal's audit events into one chronological signer log
  const seen = new Set();
  const evs = [];
  for (const p of [...(s.proposals || []), ...(s.history || [])]) {
    if (seen.has(String(p.proposalId))) continue;
    seen.add(String(p.proposalId));
    for (const ev of p.events || []) evs.push({ ...ev, p });
  }
  evs.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  const stats = owners.map(() => ({ created: 0, signed: 0, rejected: 0, executed: 0 }));
  for (const e of evs) {
    const t = e.type === "created" ? "created" : e.type === "signed" ? "signed" : e.type === "rejected" ? "rejected" : e.type === "executed" ? "executed" : null;
    if (t && e.owner != null && stats[e.owner]) stats[e.owner][t]++;
  }

  const what = (p) => (p.operation === 2 ? "Signer change" : `Transfer ${KAS(p.amount)} KAS`);
  const verbOf = { created: "proposed", signed: "approved", rejected: "rejected", executed: "executed", closed: "closed (expired)" };
  const iconOf = { created: "＋", signed: "✎", rejected: "✗", executed: "✓", closed: "⊘" };
  const fmt = (t) => (t ? new Date(t).toLocaleString() : "—");

  return (
    <aside className="txs-side">
      <div className="sidecard">
        <div className="term-bar">
          <span className="term-dots"><i /><i /><i /></span>
          <span className="term-title">signers · participation</span>
          <span className="term-status">{s.threshold}-of-{owners.length}</span>
        </div>
        <div className="sidecard-body">
          {owners.map((o, i) => (
            <div className="signer" key={i}>
              <Avatar seed={o.address || o.pubkey || String(i)} size={26} />
              <div className="signer-mid">
                <div className="signer-name">owner {i}{i === myIndex ? <span className="you-tag">you</span> : null}</div>
                <div className="sstat-nums">
                  <span title="proposals created">＋{stats[i]?.created ?? 0}</span>
                  <span title="approvals signed" className="ok">✎{stats[i]?.signed ?? 0}</span>
                  <span title="rejections" className="sstat-no">✗{stats[i]?.rejected ?? 0}</span>
                  <span title="executions" className="ok">✓{stats[i]?.executed ?? 0}</span>
                </div>
              </div>
            </div>
          ))}
          <div className="side-note">Counts are rebuilt from each proposal's on-chain audit log — created / approved / rejected / executed per signer.</div>
          {s.policySource === "genesis" && <GenesisPolicyNote />}
        </div>
      </div>

      <div className="sidecard">
        <div className="term-bar">
          <span className="term-dots"><i /><i /><i /></span>
          <span className="term-title">signers · activity log</span>
          <span className="term-status">● {evs.length} events</span>
        </div>
        <div className="sidecard-body slog-body">
          {evs.length === 0 && <div className="act-empty" style={{ padding: "14px 0" }}>no on-chain signer activity yet</div>}
          {evs.slice(0, 40).map((e, i) => {
            const who = e.owner != null ? owners[e.owner] : null;
            return (
              <div className="auditrow slog-row" key={i}>
                <span className={`auditicon ${e.type === "executed" ? "ok" : ""}`}>{iconOf[e.type] ?? "▸"}</span>
                <div style={{ minWidth: 0 }}>
                  <div className="auditlabel">
                    {e.owner != null ? `owner ${e.owner}${e.owner === myIndex ? " (you)" : ""} ` : ""}{verbOf[e.type] ?? e.type} #{e.p.proposalId} — {what(e.p)}
                  </div>
                  {who && <code className="mono audit-addr">{who.address || who.pubkey}</code>}
                  <div className="muted" style={{ fontSize: 11 }}>{fmt(e.at)}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

// ---------- Manage signers: add/remove owner + change threshold (CONFIG op) ----------
// Owners + threshold are mutable on-chain STATE, so changing them keeps the SAME
// vault address. This proposes a CONFIG change (operation 2); co-owners approve it
// like any proposal, then any owner applies it from the Transactions queue.
function ManageSigners({ s, myIndex, busy, act, signedAct, wasm }) {
  const clientSigned = (s.owners?.length ?? 0) > 0 && !s.owners.some((o) => o.local);
  const needsKey = clientSigned && myIndex < 0;
  const [editing, setEditing] = useState(false);
  const [addrs, setAddrs] = useState([]);
  const [threshold, setThreshold] = useState(s.threshold || 1);

  const open = () => {
    setAddrs(s.owners.map((o) => o.address || o.pubkey || ""));
    setThreshold(s.threshold || 1);
    setEditing(true);
  };
  const setAddr = (i, v) => setAddrs((a) => a.map((x, j) => (j === i ? v : x)));
  const addRow = () => setAddrs((a) => (a.length >= 5 ? a : [...a, ""]));
  const removeRow = (i) => setAddrs((a) => a.filter((_, j) => j !== i));

  const clean = addrs.map((a) => a.trim()).filter(Boolean);
  const tn = Number(threshold);
  const hasDup = new Set(clean).size !== clean.length;
  const valid = clean.length >= 1 && clean.length <= 5 && tn >= 1 && tn <= clean.length && !hasDup;
  const changed = clean.join(",") !== s.owners.map((o) => o.address || o.pubkey || "").join(",") || tn !== s.threshold;

  const submit = async () => {
    if (clientSigned) await wasm.doConfigPropose({ addresses: clean, threshold: tn }); // route B
    else await act("propose signer change", "config-proposal", { owners: clean, threshold: tn, proposer: 0 });
    setEditing(false);
  };

  return (
    <>
      <div className="h3">Manage signers</div>
      <div className="panel">
        {!editing ? (
          <>
            <p className="muted">Add or remove a signer, or change the required confirmations. This proposes an on-chain change — co-owners approve it, then any owner applies it. The vault address stays the same.</p>
            <button className="btn btn-ghost btn-block" onClick={open} disabled={!!busy}>Edit signers / threshold</button>
          </>
        ) : (
          <>
            <p className="muted">Owner addresses (1–5). Removing or adding takes effect once approved to threshold and applied.</p>
            {(s.proposals || []).some((p) => (p.status ?? 0) < 2) && (
              <p className="warn" style={{ fontSize: 12 }}>
                This treasury has open proposals. A signer change does NOT revoke them: pending and approved
                proposals keep their original signer snapshot, so a removed signer can still vote on — and execute —
                anything created before the change. Reject or retire the open proposals first if that is the point of this change.
              </p>
            )}
            {addrs.map((a, i) => (
              <div className="row" key={i} style={{ gap: 8, borderBottom: 0, alignItems: "center" }}>
                <input className="input" placeholder={`owner ${i} address (kaspatest:…)`} value={a} onChange={(e) => setAddr(i, e.target.value)} style={{ margin: 0, flex: 1 }} />
                <button className="btn btn-ghost copybtn" disabled={addrs.length <= 1} onClick={() => removeRow(i)}>Remove</button>
              </div>
            ))}
            {addrs.length < 5 && <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={addRow}>+ Add signer</button>}

            <label className="lbl" style={{ marginTop: 14 }}>Required confirmations</label>
            <select className="input" value={threshold} onChange={(e) => setThreshold(e.target.value)}>
              {Array.from({ length: Math.max(1, clean.length) }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n} of {clean.length || 1}</option>
              ))}
            </select>

            <div className="actions" style={{ marginTop: 16 }}>
              <button className="btn btn-ghost" onClick={() => setEditing(false)} disabled={!!busy}>Cancel</button>
              <button className="btn btn-primary" disabled={!!busy || !valid || !changed || needsKey} onClick={submit}>
                {needsKey ? "Import an owner key to propose" : busy ? "Working…" : "Propose change"}
              </button>
            </div>
            {hasDup && <p className="warn" style={{ fontSize: 12 }}>Each signer must be a different address — remove the duplicate.</p>}
            {!valid && !hasDup && clean.length > 0 && <p className="warn" style={{ fontSize: 12 }}>Threshold must be between 1 and the number of signers.</p>}
          </>
        )}
      </div>
    </>
  );
}

// ---------- Transactions: propose + queue + history ----------
function Transactions({ s, busy, myIndex, act, signedAct, wasm, onPropose, recovered, scanning, daaScore, payoutAddress }) {
  const [tab, setTab] = useState("queue");
  const [openIds, setOpenIds] = useState({});
  const toggleOpen = (id) => setOpenIds((o) => ({ ...o, [id]: !o[id] }));
  // every on-chain action (approve / reject / execute) goes through an explicit
  // confirmation modal — no silent submits
  const [confirm, setConfirm] = useState(null); // { kind, item, ownerIndex, run, ...extra }
  const ask = (kind, item, ownerIndex, run, extra) => setConfirm({ kind, item, ownerIndex, run, ...extra });

  // imported treasury (no backend keys) -> sign in browser; generated test treasury -> backend signs
  const clientSigned = (s.owners?.length ?? 0) > 0 && !s.owners.some((o) => o.local);
  const histById = Object.fromEntries((s.history || []).map((h) => [h.proposalId, h]));
  const queue = (s.proposals || [])
    .filter((pr) => (pr.status ?? 0) < 2) // exclude Failed (2) / Executed (3)
    .map((pr) => ({ ...(histById[pr.proposalId] || {}), ...pr, events: pr.events?.length ? pr.events : histById[pr.proposalId]?.events || [] }))
    .sort((a, b) => b.proposalId - a.proposalId);
  const closed = (s.proposals || []).filter((pr) => (pr.status ?? 0) >= 2);
  const done = [...(s.history || []).filter((h) => h.status === 3 || h.status === 2), ...closed]
    .filter((v, i, a) => a.findIndex((x) => x.proposalId === v.proposalId) === i)
    .sort((a, b) => b.proposalId - a.proposalId);

  return (
    <>
      <div className="page-head">
        <h2 className="page-title" style={{ margin: 0 }}>Transactions</h2>
        {!recovered && <button className="btn btn-primary" onClick={onPropose}>+ New transfer</button>}
      </div>
      {recovered && (
        <div className="panel"><p className="muted" style={{ margin: 0 }}>This treasury was recovered read-only from chain. Proposals and the audit log live with the backend — re-import the treasury to view and create them.</p></div>
      )}

      <div className="txs-grid">
        <div className="txs-main">
          <div className="subtabs">
            <button className={`subtab ${tab === "queue" ? "on" : ""}`} onClick={() => setTab("queue")}>Queue{queue.length ? ` ${queue.length}` : ""}</button>
            <button className={`subtab ${tab === "history" ? "on" : ""}`} onClick={() => setTab("history")}>History{done.length ? ` ${done.length}` : ""}</button>
            {scanning && <span className="scanpill"><span className="act-scan" />syncing from chain</span>}
          </div>

          {tab === "queue" ? (
            queue.length === 0
              ? (scanning
                ? <div className="panel"><div className="chainsync"><span className="act-scan" />⌁ syncing the proposal queue from the DAG — walking the covenant history, a few seconds…</div></div>
                : <div className="panel"><p className="muted" style={{ margin: 0 }}>Queue is empty — use <b>+ New transfer</b> to propose one.</p></div>)
              : queue.map((it) => (
                <TxCard key={it.proposalId} item={it} owners={s.owners} threshold={s.threshold}
                  live busy={busy} clientSigned={clientSigned} myIndex={myIndex}
                  daaScore={daaScore} payoutAddress={payoutAddress}
                  onRetire={() => ask("retire", it, -1, () => wasm.doRetire?.(it.proposalId), { vaultAddress: s.vaultAddress })}
                  expanded={openIds[it.proposalId] ?? true} onToggle={() => toggleOpen(it.proposalId)}
                  onApprove={(i) => ask("approve", it, i, () => clientSigned
                    ? wasm.doApprove(it.proposalId, i) // route B: built in the browser
                    : act(`approve #${it.proposalId} (owner ${i})`, "approve", { ownerIndex: i, proposalId: it.proposalId }))}
                  onReject={(i) => ask("reject", it, i, () => wasm.doReject?.(it.proposalId, i))}
                  onExecute={() => ask("execute", it, myIndex, () => clientSigned
                    ? wasm.doExecute(it.proposalId, myIndex)
                    : act(`${it.operation === 2 ? "apply signer change" : "execute"} #${it.proposalId}`, it.operation === 2 ? "config-execute" : "execute", { ownerIndex: 0, proposalId: it.proposalId }))} />
              ))
          ) : (
            // a proposal that failed still holds its bond until someone retires it, so
            // a history card can carry a live action — open those without a click
            done.length === 0
              ? (scanning
                ? <div className="panel"><div className="chainsync"><span className="act-scan" />⌁ rebuilding history from the DAG — scanning executed covenant transitions…</div></div>
                : <div className="panel"><p className="muted" style={{ margin: 0 }}>No executed or cancelled proposals yet.</p></div>)
              : done.map((it) => (
                <TxCard key={it.proposalId} item={it} owners={s.owners} threshold={s.threshold}
                  live={false} busy={busy} clientSigned={clientSigned} myIndex={myIndex}
                  daaScore={daaScore} payoutAddress={payoutAddress}
                  onRetire={() => ask("retire", it, -1, () => wasm.doRetire?.(it.proposalId), { vaultAddress: s.vaultAddress })}
                  expanded={openIds[it.proposalId] ?? canRetire(it, daaScore)} onToggle={() => toggleOpen(it.proposalId)} />
              ))
          )}
          <p className="note">The backend holds no owner keys — propose / approve / execute are all signed in your browser with the key you import (top-right). Any owner can execute a proposal once it reaches threshold.</p>
        </div>

        <TxSide s={s} myIndex={myIndex} queueCount={queue.length} doneCount={done.length} />
      </div>

      <ConfirmModal c={confirm} owners={s.owners} threshold={s.threshold} onClose={() => setConfirm(null)} />
    </>
  );
}

// ---------- Confirmation modal for on-chain actions (approve / reject / execute) ----------
const ACTION_META = {
  approve: { title: "Confirm approval", glyph: "✓", cls: "ok" },
  reject: { title: "Confirm rejection", glyph: "✗", cls: "no" },
  execute: { title: "Confirm execution", glyph: "⇢", cls: "exec" },
  retire: { title: "Retire expired proposal", glyph: "⊘", cls: "no" },
};
function ConfirmModal({ c, owners, threshold, onClose }) {
  if (!c) return null;
  const meta = ACTION_META[c.kind];
  const it = c.item;
  const isConfig = it.operation === 2;
  const me = c.ownerIndex >= 0 ? owners[c.ownerIndex] : null;
  const cfgOwners = (it.configOwners || []).filter((o) => !o.padding);
  const newCount = (it.approvalCount ?? 0) + 1;
  const toFail = owners.length - threshold + 1;
  const newRejects = Number(it.rejectCount ?? 0) + 1;
  const effect = c.kind === "approve"
    ? (newCount >= threshold
      ? `Signature ${newCount} of ${threshold} — the proposal reaches threshold and any owner can execute it.`
      : `Signature ${newCount} of ${threshold} — ${threshold - newCount} more still needed.`)
    : c.kind === "reject"
      ? (newRejects >= toFail
        ? `Rejection ${newRejects} of ${toFail} — the proposal fails permanently.`
        : `Rejection ${newRejects} of the ${toFail} needed to fail the proposal.`)
    : c.kind === "retire"
      // The one covenant path that pays nobody. Say so before it is signed, because
      // "close a transfer proposal" is exactly the phrase a user could read as
      // "send the money" — it does the opposite: the vault is never touched.
      ? `Closes proposal #${it.proposalId} for good and returns its ${KAS(it.proposalValue ?? PROPOSAL_BOND)} KAS bond to the address below as ordinary, unlocked coin. `
        + `${isConfig ? "The signer set is left exactly as it is" : `The ${KAS(it.amount)} KAS transfer is NOT made and the vault is not touched`} — nobody is paid.`
      : isConfig
        ? `Installs the new ${it.configThreshold ?? "—"}-of-${cfgOwners.length || "—"} signer set on-chain. The vault address stays the same.`
        : `Irreversibly moves ${KAS(it.amount)} KAS out of the vault to the recipient below.`;
  const verb = c.kind === "approve" ? `Approve as owner ${c.ownerIndex}`
    : c.kind === "reject" ? `Reject as owner ${c.ownerIndex}`
    : c.kind === "retire" ? "Retire & return bond"
    : isConfig ? "Apply signer change" : "Execute transfer";
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={`modal confirmmodal ${meta.cls}`} onClick={(e) => e.stopPropagation()}>
        <div className="cm-head">
          <span className={`cm-glyph ${meta.cls}`}>{meta.glyph}</span>
          <h3>{meta.title}</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>

        <div className={`cm-target ${meta.cls}`}>
          <span className="cm-no">#{it.proposalId}</span>
          <b>{isConfig ? `Signer change → ${it.configThreshold ?? "—"}-of-${cfgOwners.length || "—"}` : `Transfer ${KAS(it.amount)} KAS`}</b>
          <span className="cm-status">{statusLabel(it)}</span>
        </div>

        {c.kind === "retire" ? (
          <>
            <div className="drow">
              <span className="dk">Bond returns to the vault</span>
              <span className="dv"><code className="mono" style={{ fontSize: 11.5 }}>{c.vaultAddress || "—"}</code></span>
            </div>
            <p className="muted" style={{ fontSize: 11.5, margin: "6px 0 0" }}>
              The whole bond goes back to the treasury's own vault address (the covenant enforces it);
              your wallet pays only the network fee.
            </p>
            <div className="drow">
              <span className="dk">Expired at (DAA score)</span>
              <span className="dv"><span className="mono" style={{ fontSize: 11.5 }}>{Number(it.expiresAtDaa || 0).toLocaleString()}</span></span>
            </div>
          </>
        ) : isConfig ? (
          <>
            <div className="dk dio-h">New signers ({cfgOwners.length})</div>
            <div className="dio">
              {cfgOwners.map((o, i) => (
                <div className="diorow" key={i}><span className="dioaddr mono" style={{ whiteSpace: "normal", wordBreak: "break-all" }}>{o.address || o.xonly_pubkey}</span></div>
              ))}
              {cfgOwners.length === 0 && <div className="diorow"><span className="dioaddr mono">—</span></div>}
            </div>
          </>
        ) : (
          <div className="drow">
            <span className="dk">Recipient</span>
            <span className="dv"><code className="mono" style={{ fontSize: 11.5 }}>{it.recipientAddress || "—"}</code></span>
          </div>
        )}
        {me && (
          <div className="drow">
            <span className="dk">Signing as · owner {c.ownerIndex}</span>
            <span className="dv"><code className="mono" style={{ fontSize: 11.5 }}>{me.address || me.pubkey}</code></span>
          </div>
        )}

        <div className={`cm-effect ${meta.cls}`}>{effect}</div>
        <div className="cm-note">{c.kind === "retire"
          ? "Retiring is permissionless — the covenant asks for no owner index and checks no signature, so this needs no key. Whoever submits it receives the bond. On-chain actions cannot be rolled back."
          : "Signs locally with your imported key (BIP340 Schnorr) and submits a covenant transaction to the Kaspa network — on-chain actions cannot be rolled back."}</div>

        <div className="cm-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className={`btn cm-go ${meta.cls}`} onClick={() => { onClose(); c.run(); }}>{meta.glyph} {verb}</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Transactions right column: signing policy + live covenant state ----------
function TxSide({ s, myIndex, queueCount, doneCount }) {
  const owners = s.owners || [];
  return (
    <aside className="txs-side">
      <div className="sidecard">
        <div className="term-bar">
          <span className="term-dots"><i /><i /><i /></span>
          <span className="term-title">signing · policy</span>
          <span className="term-status">{s.threshold}-of-{owners.length}</span>
        </div>
        <div className="sidecard-body">
          <div className="policy-big"><b>{s.threshold}</b><span>of {owners.length} signatures required to move funds</span></div>
          {owners.map((o, i) => (
            <div className="signer" key={i}>
              <Avatar seed={o.address || o.pubkey || String(i)} size={26} />
              <div className="signer-mid">
                <div className="signer-name">owner {i}{i === myIndex ? <span className="you-tag">you</span> : null}</div>
                <code className="mono signer-addr">{o.address || o.pubkey || "—"}</code>
              </div>
              <button className="dcopy" title="Copy address" onClick={() => copy(o.address || o.pubkey)}>⧉</button>
            </div>
          ))}
          {s.policySource === "genesis" && <GenesisPolicyNote />}
          {myIndex < 0 && <div className="side-note">No owner key imported in this tab — import one (top-right) to approve, reject or execute. Signatures are BIP340 Schnorr, made locally.</div>}
        </div>
      </div>

      <div className="sidecard">
        <div className="term-bar">
          <span className="term-dots"><i /><i /><i /></span>
          <span className="term-title">covenant · state</span>
          <span className="term-status">● on-chain</span>
        </div>
        <div className="sidecard-body">
          <div className="dk side-h">treasury ID (covenant id)</div>
          <div className="side-hexrow">
            <code className="mono side-hex">{s.treasuryId || "—"}</code>
            {s.treasuryId && <button className="dcopy" title="Copy" onClick={() => copy(s.treasuryId)}>⧉</button>}
          </div>
          <div className="siderow"><span className="dk">Network</span><b className="mono">{s.network || "—"}</b></div>
          <div className="siderow"><span className="dk">Vault balance</span><b className="mono ok">{KAS(s.vault?.balanceSompi)} KAS</b></div>
          {s.root?.value != null && <div className="siderow"><span className="dk">Root bond</span><b className="mono">{KAS(s.root.value)} KAS</b></div>}
          <div className="siderow"><span className="dk">Open proposals</span><b className={`mono ${queueCount ? "warn" : ""}`}>{queueCount}</b></div>
          <div className="siderow"><span className="dk">Completed</span><b className="mono">{doneCount}</b></div>
          <div className="side-note">Every proposal, approval and rejection is a covenant transition on the Kaspa DAG — this queue and its audit logs are rebuilt from chain, not a database.</div>
        </div>
      </div>
    </aside>
  );
}

// One proposal row: collapsible header + details + audit log.
function TxCard({ item, owners, threshold, live, busy, clientSigned, myIndex, expanded, onToggle, onApprove, onReject, onExecute, onRetire, daaScore, payoutAddress }) {
  const bm = Number(item.approvalBitmap ?? 0);
  const approvedBy = (i) => (bm & (1 << i)) !== 0;
  const rm = Number(item.rejectBitmap ?? 0);
  const rejectedBy = (i) => (rm & (1 << i)) !== 0;
  const isPending = item.status === 0;
  const ready = item.status === 1;
  const statusCls = item.status === 3 ? "ok" : item.status === 2 ? "muted" : "warn";
  const retire = retireState(item, daaScore);
  const outcome = outcomeNote(item);
  const fmt = (t) => (t ? new Date(t).toLocaleString() : "");
  const isConfig = item.operation === 2;
  const cfgThreshold = item.configThreshold ?? item.config?.newThreshold;
  const cfgCount = item.configOwnerCount ?? item.config?.newOwnerCount;
  const cfgOwners = (item.configOwners || []).filter((o) => !o.padding);
  // A transfer's displayed recipient is trustworthy only when its address hashes to
  // the on-chain commitment — enrichDiscovered sets recipientSpkHex on a match and
  // recipientMismatch on a mismatch. A shown-but-unverified recipient is a hostile
  // indexer/proposer displaying an address the owner never authorises (the execute
  // pays the committed hash, not the screen), so approval is refused until it clears.
  const recipientUnverified = !isConfig && !!item.recipientAddress && !item.recipientSpkHex;
  let signed = 0;
  return (
    <div className="txcard">
      <div className="txhead" onClick={onToggle}>
        <span className="txno">#{item.proposalId}</span>
        <span className="txtitle">{isConfig ? "Signer change" : "Transfer KAS"}</span>
        <b>{isConfig ? (cfgThreshold != null ? `${cfgThreshold}-of-${cfgCount}` : "config") : `${KAS(item.amount)} KAS`}</b>
        <span className="muted txtime">{fmt(item.createdAt)}</span>
        <span className={statusCls} style={{ fontWeight: 700 }}>{statusLabel(item)}</span>
        <span className="chev">{expanded ? "▴" : "▾"}</span>
      </div>
      {expanded && (
        <div className="txbody">
          <div className="txdetails">
            {isConfig ? (
              <>
                <div className="row"><span className="k">New threshold</span><b>{cfgThreshold ?? "—"} of {cfgCount ?? "—"}</b></div>
                <div className="row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                  <span className="k">New signers</span>
                  {cfgOwners.length
                    ? cfgOwners.map((o, i) => <code className="mono" key={i}>{o.address || o.xonly_pubkey}</code>)
                    : <span className="muted">—</span>}
                </div>
              </>
            ) : (
              <>
                <div className="row"><span className="k">Amount</span><b>{KAS(item.amount)} KAS</b></div>
                <div className="row" style={{ gap: 10 }}>
                  <span className="k">Recipient</span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <code className="mono" style={{ wordBreak: "break-all" }}>{item.recipientAddress || "—"}</code>
                    {item.recipientAddress && <button className="dcopy" title="Copy" onClick={() => copy(item.recipientAddress)}>⧉</button>}
                  </span>
                </div>
                {recipientUnverified && (
                  <div className="row" style={{ borderBottom: 0 }}>
                    <span className="warn" style={{ fontSize: 11.5 }}>
                      ⚠ This recipient is shown by the chain indexer but does NOT match the address committed on-chain for this proposal. An execute pays the committed address, which is not the one shown — do not approve. Re-create the proposal, or open the executed tx to see where funds actually went.
                    </span>
                  </div>
                )}
              </>
            )}
            <div className="row"><span className="k">Proposed</span><span className="mono" style={{ fontSize: 12 }}>{fmt(item.createdAt) || "—"}</span></div>
            {item.proposalValue != null && item.status < 2 && (
              <div className="row"><span className="k">Proposal bond</span><b className="mono">{KAS(item.proposalValue)} KAS</b></div>
            )}
            {Number(item.maxFee) > 0 && (
              <div className="row"><span className="k">Max execution fee</span><b className="mono">{KAS(item.maxFee)} KAS</b></div>
            )}
            {Number(item.expiresAtDaa) > 0 && (
              <div className="row">
                <span className="k">Expires (DAA score)</span>
                <span className="mono" style={{ fontSize: 12 }}>
                  {Number(item.expiresAtDaa).toLocaleString()}
                  {retire.state === "retirable" && <span className="warn" style={{ marginLeft: 8 }}>expired — bond retirable</span>}
                  {retire.state === "waiting" && <span className="muted" style={{ marginLeft: 8 }}>{daaEta(retire.blocks)} away (chain at {retire.daaScore.toLocaleString()})</span>}
                </span>
              </div>
            )}
            {item.status < 2 && item.proposalOutpoint?.txid && (
              <div className="row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                <span className="k">Live proposal UTXO</span>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <code className="mono" style={{ fontSize: 11, wordBreak: "break-all", color: "var(--teal-2)" }}>{item.proposalOutpoint.txid}:{item.proposalOutpoint.index}</code>
                  <button className="dcopy" title="Copy txid" onClick={() => copy(item.proposalOutpoint.txid)}>⧉</button>
                </span>
              </div>
            )}
            {item.executedTxid && (
              <div className="row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                <span className="k">{item.status === 2 ? "Closing tx" : "Executed tx"}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <a className="dlink mono" style={{ fontSize: 11, wordBreak: "break-all" }} href={`${getNetwork().explorer}/txs/${item.executedTxid}`} target="_blank" rel="noreferrer">{item.executedTxid} ↗</a>
                  <button className="dcopy" title="Copy txid" onClick={() => copy(item.executedTxid)}>⧉</button>
                </span>
              </div>
            )}

            {outcome && (
              <div className="row" style={{ borderBottom: 0 }}>
                <span className={`${item.status === 3 ? "ok" : "muted"}`} style={{ fontSize: 12.5 }}>{outcome}</span>
              </div>
            )}

            {/* A proposal reconstructed from chain (discovered) has its terminal
                outcome — paid out vs retired, and the amount/recipient shown — read
                from the REST indexer, which is untrusted and never cross-checked
                against your node here. Whether it is still open and signable is
                node-anchored and safe; this label and these figures are not. Say so,
                so nobody reconciles their books against a number a hostile indexer
                chose. Locally-tracked proposals (not discovered) came from this app's
                own submissions and carry no such note. */}
            {item.discovered && (item.status === 2 || item.status === 3) && (
              <div className="row" style={{ borderBottom: 0 }}>
                <span className="muted" style={{ fontSize: 11.5 }}>
                  ⌁ Outcome, amount and recipient are read from the chain indexer, not confirmed by your node. Open the {item.status === 2 ? "closing" : "executed"} tx above to verify what actually moved.
                </span>
              </div>
            )}

            <div className="sigs">
              <div className="k sigs-h">Signatures — {item.approvalCount} of {threshold} required</div>
              {owners.map((o, i) => {
                const st = approvedBy(i) ? "ok" : rejectedBy(i) ? "no" : "wait";
                return (
                  <div className={`sigrow ${st}`} key={i}>
                    <span className="sig-glyph">{st === "ok" ? "✓" : st === "no" ? "✗" : "◌"}</span>
                    <div className="sig-mid">
                      <div className="sig-name">owner {i}{i === myIndex ? <span className="you-tag">you</span> : null}</div>
                      <code className="mono sig-addr">{o.address || o.pubkey || "—"}</code>
                    </div>
                    <span className={`sig-state ${st}`}>{st === "ok" ? "Approved" : st === "no" ? "Rejected" : "Awaiting"}</span>
                  </div>
                );
              })}
            </div>
            {live && (
              <div className="actions">
                {clientSigned ? (
                  <button className="btn btn-ghost" disabled={busy || myIndex < 0 || approvedBy(myIndex) || rejectedBy(myIndex) || !isPending || recipientUnverified}
                    onClick={() => onApprove(myIndex)}>
                    {recipientUnverified ? "Recipient unverified — can't approve" : myIndex < 0 ? "Import an owner key to approve" : approvedBy(myIndex) ? `You (owner ${myIndex}) approved ✓` : `Approve as owner ${myIndex}`}
                  </button>
                ) : (
                  owners.map((_, i) => (
                    <button className="btn btn-ghost" key={i} disabled={busy || approvedBy(i) || !isPending || recipientUnverified} onClick={() => onApprove(i)}>
                      {recipientUnverified ? `owner ${i} — recipient unverified` : approvedBy(i) ? `owner ${i} ✓` : `Approve owner ${i}`}
                    </button>
                  ))
                )}
                {clientSigned && onReject && (
                  <button className="btn btn-ghost" disabled={busy || myIndex < 0 || approvedBy(myIndex) || rejectedBy(myIndex) || !isPending}
                    onClick={() => onReject(myIndex)} title="Vote to reject. Enough rejections fail the proposal.">
                    {rejectedBy(myIndex) ? `You (owner ${myIndex}) rejected ✗` : "Reject"}
                  </button>
                )}
                <button className="btn btn-primary" disabled={busy || !ready || (clientSigned && myIndex < 0)} onClick={onExecute}>
                  {ready && clientSigned && myIndex < 0 ? "Import an owner key to execute" : isConfig ? "Apply signer change" : "Execute transfer"}
                </button>
              </div>
            )}
            {retire.state === "retirable" && onRetire && (
              <div className="actions" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                <button className="btn btn-ghost" disabled={!!busy || !payoutAddress} onClick={onRetire}
                  title="Permissionless: the covenant checks no signature here, so anyone may retire an expired proposal.">
                  {payoutAddress ? `⊘ Retire & return the ${KAS(item.proposalValue ?? PROPOSAL_BOND)} KAS bond` : "⊘ Connect a wallet to receive the returned bond"}
                </button>
                <span className="muted" style={{ fontSize: 11.5 }}>
                  This proposal has expired, so its {KAS(item.proposalValue ?? PROPOSAL_BOND)} KAS bond can be freed. Retiring closes it and sends the bond
                  to your wallet as ordinary coin — it pays no recipient and moves nothing out of the vault. Anyone can do this, owner or not.
                </span>
              </div>
            )}
            {Number(item.rejectCount ?? 0) > 0 && (
              <div className="row" style={{ borderBottom: 0 }}><span className="k">Rejections</span><b className="muted">{item.rejectCount} / {(owners?.length ?? threshold) - threshold + 1} to fail</b></div>
            )}
          </div>
          <div className="auditlog">
            <div className="k" style={{ marginBottom: 10, textTransform: "uppercase", letterSpacing: ".1em" }}>Audit log</div>
            {(item.events || []).map((ev, i) => {
              if (ev.type === "signed") signed++;
              const label = ev.type === "created" ? "Created"
                : ev.type === "executed" ? "Executed"
                : ev.type === "rejected" ? "Rejected (vote)"
                : ev.type === "closed" ? (item.closedReason === "expired" ? "Retired (expired)" : "Closed — no payout")
                : `Signed (${signed}/${threshold})`;
              const icon = ev.type === "created" ? "＋" : ev.type === "executed" ? "✓" : ev.type === "rejected" || ev.type === "closed" ? "✗" : "✎";
              const who = ev.owner != null ? owners[ev.owner] : null;
              return (
                <div className="auditrow" key={i}>
                  <span className={`auditicon ${ev.type === "executed" ? "ok" : ""}`}>{icon}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="auditlabel">{label}{ev.owner != null ? ` — owner ${ev.owner}${ev.owner === myIndex ? " (you)" : ""}` : ""}</div>
                    {who && <code className="mono audit-addr">{who.address || who.pubkey}</code>}
                    <div className="muted" style={{ fontSize: 11 }}>{fmt(ev.at)}</div>
                  </div>
                </div>
              );
            })}
            {(!item.events || item.events.length === 0) && <div className="muted" style={{ fontSize: 12 }}>No audit log (created before logging).</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// The signer set on screen came from the genesis inscription — the record a
// treasury is REBUILT from, written once and never rewritten. The owners it names
// are the ones the treasury was created with, and KoRoot.executeConfig has been
// free to replace them ever since, in continuations the inscription knows nothing
// about. Following those takes a node (the walk in proposalScan.walkRoot reads the
// KoRoot's whole spend history), and without one this view cannot tell an owner
// who was removed last week from one who is still a signer today.
//
// That is a dangerous thing to leave implicit: the list looks exactly like the
// authoritative one. So it is named where the user is looking, and the fix — point
// the app at a node — is one click away rather than a sentence about a gear icon.
export function GenesisPolicyBanner() {
  const hasNode = !!getRpcUrl();
  return (
    <div className="panel" style={{ borderColor: "rgba(240,180,40,.4)", background: "rgba(240,180,40,.06)", marginBottom: 16 }}>
      <span className="warn" style={{ display: "block", marginBottom: 8 }}>⌁ Showing the ORIGINAL signers, not necessarily the current ones.</span>
      <p className="muted" style={{ margin: "0 0 10px" }}>
        This treasury was rebuilt from its genesis record on chain, which names the signers it was CREATED with. Signer changes since
        then are also on chain, but reading them means following the treasury's covenant forward from genesis — and that needs a node.
        Until one is set, treat every signer below as historical: one of them may have been removed, and a signer added later will not
        appear at all. {hasNode
          ? "A node is set and the walk hasn't landed yet — it retries on its own, or pick a different node if it keeps failing."
          : "Deposits and the vault address are unaffected."}
      </p>
      <button className="btn btn-primary" onClick={() => window.dispatchEvent(new Event("kosign-open-rpc"))}>
        {hasNode ? "Change node endpoint" : "Set a node endpoint to read the current signers"}
      </button>
    </div>
  );
}

// A one-line version of the same warning, for the panels that list the signers.
export const GenesisPolicyNote = () => (
  <div className="side-note" style={{ color: "var(--warn)" }}>
    ⌁ Genesis signers — read from the treasury's creation record, so a signer removed since then is still listed and one added since is
    missing. Set a node endpoint (⚙) to follow the covenant to the current set.
  </div>
);

// ---------- Genesis provenance gate screens ----------

// CLEAN, but only structurally: the genesis's single covenant member was re-derived
// from the on-chain inscription and matched, and its binding set is what an honest
// genesis produces — yet the covenant id could not be recomputed, because the chain
// source did not report the funding outpoint the id commits to. Without that id the
// vault address cannot be derived from the genesis, and deriving it is the only step
// that connects the transaction just audited to the money at this address. Everything
// checked here is a fact about a transaction someone handed us; that last step is what
// makes it a fact about YOUR treasury, so its absence is never left implicit.
export function GenesisPartial({ gate }) {
  return (
    <div className="panel" style={{ borderColor: "rgba(240,180,40,.4)", background: "rgba(240,180,40,.06)", marginBottom: 16 }}>
      <span className="warn" style={{ display: "block" }}>
        ⌁ Genesis verified — but this address was NOT derived from it.
      </span>
      <p className="muted" style={{ margin: "8px 0 0", fontSize: 12.5 }}>
        Output 0 was re-derived as this treasury&apos;s KoRoot straight from the genesis inscription, and
        the covenant it minted has no other member. But the chain source did not report the outpoint
        that genesis spends, so the covenant id it mints could not be recomputed — and a vault address
        is derived from exactly that id. Nothing therefore proves this transaction is <em>this</em>{" "}
        address&apos;s genesis rather than some other treasury&apos;s.
        {gate?.independent?.note ? ` ${gate.independent.note}` : ""}
        {" "}Reload to try again, or set a node endpoint in ⚙ for a second, independent reading.
      </p>
      <GenesisChecks gate={gate} />
    </div>
  );
}

// These REPLACE the treasury view; they are deliberately dead ends. There is no
// deposit address, no balance, no "continue anyway" for a refused genesis — a
// genesis is immutable and a covenant id cannot be re-minted, so retrying can only
// produce the same finding, and the only safe action is to leave the address alone.
const CHECK_ICON = { pass: "✓", fail: "✕", skip: "–" };

function GenesisChecks({ gate }) {
  if (!gate?.checks?.length) return null;
  return (
    <ul className="genesis-checks">
      {gate.checks.map((c, i) => (
        <li key={i} className={`gc-${c.state}`}>
          <span className="gc-icon">{CHECK_ICON[c.state] || "•"}</span>
          <span><code className="mono">{c.id}</code> — {c.note}</span>
        </li>
      ))}
    </ul>
  );
}

export function GenesisRefused({ param, gate }) {
  // `not-this-build` means the derived KoRoot does not match what this release
  // publishes — which an honest treasury from another release also fails. It
  // refuses for the same reason it could not operate the treasury anyway (every
  // redeem script is rebuilt from these templates), so it must not be worded as a
  // forged-genesis finding.
  const otherBuild = gate?.code === "not-this-build";
  // `vault-not-from-this-genesis` says the inscribed transaction mints a lineage
  // that derives a DIFFERENT vault address. That is a statement about two values
  // not matching, not about anyone's intent: an address from an untrusted source
  // and a treasury whose vault template belongs to another release both land here.
  // Say what is true and let the reader draw the conclusion.
  const wrongGenesis = gate?.code === "vault-not-from-this-genesis";
  const net = getNetwork();
  return (
    <div className="app"><div className="content"><div className="page-in">
      <div className="panel genesis-refused">
        <div className="genesis-head">
          {otherBuild ? "This treasury was built by a different release"
            : wrongGenesis ? "This is not this vault's genesis"
            : "⛔ This treasury is refused"}
        </div>
        <p className="muted" style={{ fontSize: 13.5 }}>
          {otherBuild ? (
            <>Its covenant scripts do not match the ones this build publishes, so this build cannot
            verify what rules protect it — nor could it operate the treasury, since it rebuilds every
            script from those same templates. <strong>This is not an accusation:</strong> a treasury
            minted by another Ko-sign release is honest, it simply speaks a different dialect.</>
          ) : wrongGenesis ? (
            <>The transaction that carries this address&apos;s genesis inscription mints a covenant that
            belongs to a <strong>different vault address</strong>. Ko-sign will not open this address or
            show you a deposit address for it, because nothing here establishes who is allowed to move
            money held at it.</>
          ) : (
            <>Its <strong>genesis transaction</strong> did not create an honest covenant. Ko-sign will not
            open it and will not show you a deposit address for it.</>
          )}
        </p>
        <p className="genesis-reason">{gate.reason}</p>
        {wrongGenesis ? (
          <p className="muted">
            A vault holds its <strong>covenant lineage</strong> — the id minted by the genesis
            transaction it descends from — and it accepts deposits and executes proposals under that
            lineage and no other. The address is derived from it, so every vault address has exactly
            one genesis, and this page checks which by deriving the address from the transaction rather
            than taking the pairing on trust. The two do not agree here. That happens when an address
            was paired with a genesis it did not come from, and also when a treasury was minted by a
            Ko-sign release whose vault template differs from this one — the derivation is only as
            valid as the templates it runs on.
          </p>
        ) : (
          <p className="muted">
            Every treasury's covenant id is minted once, by whoever built its genesis transaction, and
            that transaction decides which outputs belong to the covenant. An honest Ko-sign genesis
            binds exactly one: the <strong>KoRoot</strong> at output 0. The <strong>KoVault</strong> is
            not there at all — it is minted afterwards, around the id this transaction creates.
            Anything else in the group is a covenant member the vault will treat as one of its own —
            most usefully for an attacker, a proposal that is already approved and can be executed
            against your deposits at any moment. The contracts cannot detect this: no Kaspa opcode
            reveals whether an input's covenant binding was created at genesis. Reading the genesis
            transaction, as this page just did, is the only defence — which is why it happens before
            you can deposit.
          </p>
        )}
        <dl className="genesis-facts">
          <dt>Address</dt><dd className="mono">{param}</dd>
          <dt>Finding</dt><dd className="mono">{gate.code}</dd>
          {gate.genesisTxid && (
            <>
              <dt>Genesis tx</dt>
              <dd><a className="dlink mono" href={`${net.explorer}/txs/${gate.genesisTxid}`} target="_blank" rel="noreferrer">{gate.genesisTxid} ↗</a></dd>
            </>
          )}
          {gate.treasuryId && (<><dt>Covenant id</dt><dd className="mono">{gate.treasuryId}</dd></>)}
          {/* A refusal is cached permanently and returned before any network call,
              on the reasoning that a genesis is immutable so a refusal is a
              permanent fact. It is — of the transaction that was READ. A source
              that served a corrupted one gets its refusal frozen too, and from
              then on this page never asks anyone again. Deliberately kept: the
              alternative lets a refusal be re-rolled until it passes, and failing
              closed is the right direction. But a verdict that answers from
              storage must SAY so, or an owner has no way to tell a permanent
              finding from a bad afternoon. */}
          {gate.cached && (
            <>
              <dt>Answered from</dt>
              <dd>this browser&apos;s stored verdict{gate.checkedAt ? ` of ${new Date(gate.checkedAt).toLocaleString()}` : ""} — no chain source was consulted just now. Clearing this site&apos;s storage makes the check run again.</dd>
            </>
          )}
        </dl>
        <GenesisChecks gate={gate} />
        <p className="note">
          {otherBuild ? (
            <>Open it with the release that minted it, or create a new treasury here. Nothing is wrong
            with the funds — this build simply has no way to check or move them.</>
          ) : wrongGenesis ? (
            <>Check the address against the treasury's genesis transaction id with whoever gave it to
            you, and if it came from a different Ko-sign release, open it there. Until the two agree:
            do not send funds to this address, and treat any balance already there as at risk.</>
          ) : (
            <>If you created this treasury yourself with an unmodified Ko-sign build, this is a bug and we
            want to hear about it — see SECURITY.md. Otherwise: do not send funds to this address, and
            treat any balance already there as at risk.</>
          )}
        </p>
        <button className="btn btn-primary" onClick={() => go("/create")}>Create a treasury you control →</button>
      </div>
    </div></div></div>
  );
}

export function GenesisChecking({ param, gate, freshlyMinted, onOverride }) {
  const stuck = gate?.verdict === "unverified" && !freshlyMinted;
  const waiting = gate?.verdict === "unverified" && freshlyMinted;
  return (
    <div className="app"><div className="content"><div className="loadwrap">
      <div className="loader">
        <div className="orbit"><i /><i /><i /><span className="core" /></div>
        <div className="load-title">Verifying genesis provenance</div>
        <div className="load-bar"><i /></div>
        <code className="mono load-addr">{param}</code>
        <div className="load-note">
          Reading this treasury's genesis transaction from chain to confirm that its covenant contains
          the KoRoot and nothing else, and that the id it mints derives this exact vault address. Until
          both are established the treasury stays closed and no deposit address is shown.
        </div>
        {waiting && (
          <div className="panel genesis-waiting">
            <span className="ok" style={{ display: "block", marginBottom: 8 }}>◷ Waiting for the chain indexer</span>
            <p className="muted" style={{ marginBottom: 10 }}>
              Your node accepted both transactions and this treasury is minted. The genesis
              check reads from the chain indexer, which trails the node by a few minutes —
              it will pass by itself as soon as the transaction appears there. Nothing is wrong,
              and nothing needs doing.
            </p>
            <p className="muted" style={{ marginBottom: 10 }}>
              The deposit address stays hidden until the check completes, so the treasury cannot
              be paid into on the strength of this browser's own word about what it just built.
            </p>
            <button className="btn btn-ghost" onClick={onOverride}>Open without waiting (this session only)</button>
          </div>
        )}
        {stuck && (
          <div className="panel genesis-stuck">
            <span className="warn" style={{ display: "block", marginBottom: 8 }}>⌁ Could not verify the genesis</span>
            <p className="muted" style={{ marginBottom: 10 }}>{gate.reason} Retrying automatically — a treasury created moments ago can take a few minutes to appear in the chain indexer.</p>
            <p className="muted" style={{ marginBottom: 10 }}>
              This is <em>not</em> evidence of an attack; it means the check could not run. Opening
              anyway skips the only defence there is against a forged genesis covenant, so do it only
              for a treasury you created yourself, and do not deposit into an unverified one.
            </p>
            <button className="btn btn-ghost" onClick={onOverride}>Open unverified (this session only)</button>
          </div>
        )}
      </div>
    </div></div></div>
  );
}
