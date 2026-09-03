// Optional stats telemetry → the Ko-sign stats service, a separate deployment that
// keeps a chain-verified registry of treasuries for the landing page numbers. It is
// NOT part of this repository and its source is not published, which is exactly why
// nothing here may depend on it: it is treated as an untrusted stranger that happens
// to answer, and the app must be identical without it.
//
// STRICTLY additive: every call is fire-and-forget, everything no-ops when no URL is
// configured, and no number it returns may gate a control or reach a money path —
// pinned by frontend/test/trustBoundary.test.mjs, which fails if a signing module so
// much as imports this file. Only the vault ADDRESS is ever sent: already-public
// chain data, no keys, no balances, nothing user-identifying.
//
// One indexer PER NETWORK (they run on separate machines): testnet-10 and
// mainnet each get their own URL, so testnet numbers can never leak into the
// mainnet strip and vice versa.
import { getNetworkId } from "./network.js";

const URLS = {
  // VITE_INDEXER_URL is the legacy single-URL name — kept as the tn10 fallback
  "testnet-10": import.meta.env.VITE_INDEXER_URL_TN10 || import.meta.env.VITE_INDEXER_URL || (import.meta.env.DEV ? "http://localhost:8788" : ""),
  mainnet: import.meta.env.VITE_INDEXER_URL_MAINNET || (import.meta.env.DEV ? "http://localhost:8789" : ""),
};
const indexerFor = (netId) => (URLS[netId] || "").replace(/\/$/, "");

// Landing-page stats for `netId`: { treasuries, signers, tvlSompi, network, … } or
// null. An indexer answering for the WRONG network (misconfigured URL) is
// treated as unset — better no strip than testnet numbers on the mainnet page.
// Successful responses are cached (per network) so a down indexer degrades to
// last-known-good numbers instead of a blank strip.
const CACHE_KEY = (id) => `kosign.stats.${id}`;
export async function fetchStats(netId = getNetworkId()) {
  const base = indexerFor(netId);
  if (!base) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(`${base}/api/stats`, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const s = await r.json();
    if (s?.network !== netId) return null;
    try { localStorage.setItem(CACHE_KEY(netId), JSON.stringify({ s, at: Date.now() })); } catch { /* private mode */ }
    return s;
  } catch { return null; }
}

// Last-known-good stats (≤ 7 days old) for when the indexer is unreachable —
// shown with a "cached" marker while the caller retries in the background.
export function cachedStats(netId = getNetworkId()) {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY(netId)) || "null");
    if (!c?.s || c.s.network !== netId) return null;
    if (Date.now() - (c.at || 0) > 7 * 86_400_000) return null;
    return { ...c.s, stale: true };
  } catch { return null; }
}

// NOTE: the frontend deliberately does NOT push anything to the stats service.
// treasury discovery is the indexer's job (it follows the chain over RPC with a
// persistent cursor); this module only READS aggregate numbers for the landing
// strip. Keeping the services independent means the app works identically
// whether the indexer exists or not.
