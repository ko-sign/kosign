import React, { useEffect, useState } from "react";
import { NETWORKS, useNetworkId } from "./network.js";
import { fetchStats, cachedStats } from "./stats.js";

// sompi → display KAS: whole numbers once it's large, cents while it's small
const kasFmt = (sompi) => {
  const kas = (sompi || 0) / 1e8;
  return kas.toLocaleString("en-US", { maximumFractionDigits: kas >= 1000 ? 0 : 2 });
};

const FEATURES = [
  { i: "⛓", h: "On-chain proposals", p: "Approvals are UTXO covenant state, not off-chain signatures. Every step is verifiable on the Kaspa DAG." },
  { i: "◈", h: "M-of-N covenant", p: "Funds move only when an Approved proposal of the same covenant lineage is consumed. No single key, no admin." },
  { i: "⬡", h: "Covenant-id lineage", p: "A network-enforced 32-byte id ties the Root, Vault and Proposals together. Fake proposals can't be forged." },
  { i: "▣", h: "No custodian, no backend", p: "Your browser builds, signs and submits every covenant tx straight to a Kaspa node. The rules live in the script." },
  { i: "↯", h: "Kaspa-fast", p: "Built on Kaspa's BlockDAG — proposals, approvals and execution confirm in seconds." },
  { i: "✔", h: "Verified end-to-end", p: "genesis → propose → approve → execute proven live on testnet-10, moving real KAS." },
];
const STEPS = [
  { h: "Create the treasury", p: "Set an M-of-N policy. Genesis mints the KoRoot + KoVault into one covenant domain." },
  { h: "Propose a transfer", p: "An owner opens an on-chain proposal — recipient, amount and the first approval." },
  { h: "Approve to threshold", p: "Each owner's approval is an on-chain state transition; a bitmap blocks duplicates." },
  { h: "Execute", p: "Once Approved, anyone spends the Vault + Proposal together; the covenant enforces the payout." },
];
const BADGES = ["Toccata", "Silverscript", "KIP-10 introspection", "KIP-20 covenant-id", "Schnorr", "rusty-kaspa"];

// the hero terminal — a replay of the real covenant lifecycle, line by line
const DEMO = [
  { k: "cmd", t: "create & sign (2-of-3)" },
  { k: "ok", t: "treasury minted — KoRoot + KoVault in one covenant domain" },
  { k: "cmd", t: "propose 100 KAS → kaspatest:qzqk…u3akg" },
  { k: "info", t: "built in your browser (wasm) · signed locally (BIP340) · node-direct" },
  { k: "ok", t: "approve (owner 1) → 2/3 · threshold reached" },
  { k: "cmd", t: "execute" },
  { k: "ok", t: "covenant enforced the payout — confirmed on the DAG in seconds" },
];
const glyph = (k) => (k === "cmd" ? "$" : k === "ok" ? "✔" : "▸");

export default function Landing({ onLaunch }) {
  const netId = useNetworkId(); // follows the ⚙ network switch (testnet-10 / mainnet)
  const net = NETWORKS[netId] || NETWORKS["testnet-10"];
  // live usage stats from the chain-verified indexer registry — purely additive.
  // Failure handling: render last-known-good numbers instantly (marked "cached"),
  // retry the live fetch with backoff until the indexer answers, then refresh
  // every 5 min. No cache + no indexer → the strip simply stays hidden.
  const [stats, setStats] = useState(null);
  useEffect(() => {
    let on = true;
    const timers = [];
    const later = (fn, ms) => timers.push(setTimeout(fn, ms));
    setStats(cachedStats(netId)); // instant paint from cache (may be null)
    const load = async (attempt) => {
      const live = await fetchStats(netId);
      if (!on) return;
      if (live) { setStats(live); later(() => load(0), 5 * 60_000); } // fresh — periodic refresh
      else later(() => load(attempt + 1), Math.min(8_000 * 2 ** attempt, 120_000)); // down — backoff retry
    };
    load(0);
    return () => { on = false; timers.forEach(clearTimeout); };
  }, [netId]);
  return (
    <main>
      <section className="hero">
        <div className="orb a" /><div className="orb b" />
        <div className="orbit hero-orbit"><i /><i /><i /><span className="core" /></div>
        <span className="eyebrow mono-eyebrow"><span className="live" /> Live on Kaspa {net.label}</span>
        <h1>Multisig, <span className="grad">enforced by Kaspa L1</span></h1>
        <p className="lede">
          Ko-sign is an on-chain multisig built as a native Kaspa <b>covenant</b>.
          M-of-N approvals are stored on-chain as proposal state — the treasury can only
          move when the covenant says so.
        </p>
        <div className="cta">
          <button className="btn btn-primary" onClick={onLaunch}>Launch App →</button>
          <a className="btn btn-ghost" href="whitepaper.html" target="_blank" rel="noreferrer">⟨ Whitepaper ⟩</a>
          <a className="btn btn-ghost" href="https://github.com/ko-sign/kosign" target="_blank" rel="noreferrer">View source</a>
        </div>
        <div className="badges">{BADGES.map((b) => <span key={b} className="badge">{b}</span>)}</div>

        {stats?.treasuries > 0 && (
          <div className="statstrip" title="Chain-verified: every treasury's KOSGN genesis inscription was found on-chain; totals re-read from the chain.">
            <span className="stat"><i>◈</i><b>{stats.treasuries.toLocaleString("en-US")}</b> {stats.treasuries === 1 ? "treasury" : "treasuries"} deployed</span>
            <span className="statdot">·</span>
            <span className="stat"><i>⛁</i><b>{kasFmt(stats.tvlSompi)}</b> KAS secured on-chain</span>
            <span className="statdot">·</span>
            <span className="stat"><i>⌁</i><b>{(stats.signers || 0).toLocaleString("en-US")}</b> signers</span>
            {stats.stale
              ? <span className="stat-verified stale">⌁ cached · re-syncing…</span>
              : <span className="stat-verified">⛓ verified from chain</span>}
          </div>
        )}

        <div className="term hero-term">
          <div className="term-bar">
            <span className="term-dots"><i /><i /><i /></span>
            <span className="term-title">kosign@{netId}:~</span>
            <span className="term-status">● replayed from chain</span>
          </div>
          <div className="term-body">
            {DEMO.map((l, i) => (
              <div className={`term-line demo ${l.k}`} key={i} style={{ animationDelay: `${0.5 + i * 0.55}s` }}>
                <span className="term-ts">{`00:00:0${i}`}</span>
                <span className="term-glyph">{glyph(l.k)}</span>
                <span className="term-txt">{l.t}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="kicker">⟨ why on-chain covenant ⟩</div>
      <h2 className="section-title">Not signatures — <span className="grad">consensus rules</span></h2>
      <p className="section-sub">Not “M-of-N signatures can spend.” The Vault can only spend by consuming an Approved Proposal of the same covenant — un-forgeable, un-replayable.</p>
      <div className="grid">
        {FEATURES.map((f) => (
          <div className="panel feature" key={f.h}>
            <div className="ico">{f.i}</div>
            <h4>{f.h}</h4>
            <p>{f.p}</p>
          </div>
        ))}
      </div>

      <div className="kicker">⟨ protocol trace ⟩</div>
      <h2 className="section-title">How it works</h2>
      <p className="section-sub">Four covenant transactions — every one validated by the Kaspa network.</p>
      <div className="panel steps">
        {STEPS.map((s) => (
          <div className="step" key={s.h}>
            <div className="n" />
            <div><h4>{s.h}</h4><p>{s.p}</p></div>
          </div>
        ))}
      </div>

      <div className="footer">
        <div style={{ marginBottom: 8 }}>
          <button className="btn btn-primary" onClick={onLaunch}>Open the wallet →</button>
        </div>
        Ko-sign · Kaspa L1 covenant multisig · {netId} · experimental · <a className="foot-link" href="whitepaper.html" target="_blank" rel="noreferrer">whitepaper</a>
      </div>
    </main>
  );
}
