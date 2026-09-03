// KAS/USD spot price for display. CoinGecko is the primary source; the Kaspa
// REST indexer's /info/price is the fallback. Cached for 60s so the Assets
// page (and its refresh loops) never hammer either API.
import { getNetwork } from "./network.js";

let cache = { t: 0, usd: null };

const getJson = async (url) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
};

export async function fetchKasUsd() {
  if (cache.usd != null && Date.now() - cache.t < 60_000) return cache.usd;
  let usd = null;
  try { usd = (await getJson("https://api.coingecko.com/api/v3/simple/price?ids=kaspa&vs_currencies=usd"))?.kaspa?.usd ?? null; }
  catch { /* rate-limited/blocked — try the indexer */ }
  if (usd == null) {
    try { usd = (await getJson(`${getNetwork().rest}/info/price`))?.price ?? null; }
    catch { /* no price available */ }
  }
  if (usd != null) cache = { t: Date.now(), usd: Number(usd) };
  return cache.usd;
}

export const usdFmt = (v) => `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const priceFmt = (p) => `$${Number(p).toLocaleString(undefined, { maximumSignificantDigits: 4 })}`;
