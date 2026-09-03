// Central network config + the official public-node resolver client.
//
// Ko-sign can run on Testnet-10 (default) or Mainnet. Every network-dependent
// constant (address prefix, wasm prefix, REST indexer, default node) lives here so
// the rest of the frontend just asks getNetwork().
//
// Official RPC: the Kaspa Public Node Network is fronted by kaspa-resolver
// (github.com/aspectron/kaspa-resolver). A resolver answers
//   GET {resolver}/v2/kaspa/{networkId}/{tls|any}/wrpc/{encoding} → { uid, url }
// with the least-loaded public node. The resolver only indexes the borsh
// encoding, but the very same nodes ALSO serve JSON wRPC at the sibling
// /wrpc/json path (verified: getInfo + covenant-aware getUtxos on 2.0.1 nodes),
// so we ask for borsh and swap the path — our browser client speaks JSON.
import { useSyncExternalStore } from "react";

const NET_KEY = "kosign.network";
const CHOICE_KEY = (id) => `kosign.rpcChoice.${id}`; // {mode:"public"|"custom", url}
const RESOLVED_KEY = (id) => `kosign.rpcResolved.${id}`; // cached resolver pick

export const NETWORKS = {
  "testnet-10": {
    id: "testnet-10", label: "Testnet-10", prefix: "kaspatest", wasm: "testnet",
    rest: "https://api-tn10.kaspa.org",
    explorer: "https://explorer-tn10.kaspa.org",
    // default to the official public-node resolver: it returns wss:// endpoints,
    // which work on an HTTPS deployment (a plain ws:// node would be blocked as
    // mixed content). Point ⚙ → Custom at your own node for local/private use.
    defaultRpc: "", // Custom starts blank — bring your own node
    defaultMode: "public",
  },
  mainnet: {
    id: "mainnet", label: "Mainnet", prefix: "kaspa", wasm: "mainnet",
    rest: "https://api.kaspa.org",
    explorer: "https://explorer.kaspa.org",
    defaultRpc: "",
    defaultMode: "public",
  },
};

// RPC/network events also stream into the global console dock. This module is
// imported by the dock itself, so it logs via a window event (no import cycle).
const tlog = (text, kind = "info") => {
  try { window.dispatchEvent(new CustomEvent("kosign-termlog", { detail: { text, kind } })); } catch { /* SSR/no-op */ }
};

export const getNetworkId = () => { try { return localStorage.getItem(NET_KEY) || "testnet-10"; } catch { return "testnet-10"; } };
export const getNetwork = () => NETWORKS[getNetworkId()] || NETWORKS["testnet-10"];
export const setNetworkId = (id) => {
  if (!NETWORKS[id]) return;
  try { localStorage.setItem(NET_KEY, id); } catch { /* ignore */ }
  tlog(`⚙ network → ${id}`);
  window.dispatchEvent(new Event("kosign-rpc"));
};

// React hook: the active network id, reactively (re-renders on ⚙ network switch
// so address derivations / placeholders / REST bases follow the network).
export function useNetworkId() {
  return useSyncExternalStore(
    (cb) => { window.addEventListener("kosign-rpc", cb); return () => window.removeEventListener("kosign-rpc", cb); },
    getNetworkId,
    () => "testnet-10",
  );
}

// Per-network endpoint choice: official public node (resolver) or a custom URL.
export const getRpcChoice = (id = getNetworkId()) => {
  try {
    const c = JSON.parse(localStorage.getItem(CHOICE_KEY(id)) || "null");
    if (c?.mode) return c;
    // migrate the pre-network single custom URL (kosign.rpcUrl) as a tn10 choice
    const legacy = id === "testnet-10" && localStorage.getItem("kosign.rpcUrl");
    if (legacy) return { mode: "custom", url: legacy };
  } catch { /* fall through */ }
  const n = NETWORKS[id];
  return { mode: n.defaultMode, url: n.defaultRpc };
};
export const setRpcChoice = (choice, id = getNetworkId()) => {
  try { localStorage.setItem(CHOICE_KEY(id), JSON.stringify(choice)); } catch { /* ignore */ }
  tlog(`⚙ ${id} endpoint → ${choice.mode === "custom" ? (choice.url || "(custom, blank)") : "official public nodes (kaspa-resolver)"}`);
  window.dispatchEvent(new Event("kosign-rpc"));
};
export const getResolvedRpc = (id = getNetworkId()) => { try { return localStorage.getItem(RESOLVED_KEY(id)) || ""; } catch { return ""; } };

// The published public resolver set (rusty-kaspa Resolvers.toml).
const RESOLVERS = ["eric", "maxim", "sean", "troy"].map((n) => `https://${n}.kaspa.stream`)
  .concat(["john", "mike", "paul", "alex"].map((n) => `https://${n}.kaspa.red`))
  .concat(["jake", "mark", "adam", "liam"].map((n) => `https://${n}.kaspa.green`))
  .concat(["noah", "ryan", "jack", "luke"].map((n) => `https://${n}.kaspa.blue`));

// Quick liveness probe: JSON getInfo over the websocket (public nodes answer <1s).
const probeJson = (url, ms = 5000) => new Promise((resolve) => {
  let ws; const done = (ok) => { try { ws?.close(); } catch { /* ignore */ } resolve(ok); };
  const t = setTimeout(() => done(false), ms);
  try { ws = new WebSocket(url); } catch { clearTimeout(t); return resolve(false); }
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "getInfo", params: {} }));
  ws.onmessage = () => { clearTimeout(t); done(true); };
  ws.onerror = () => { clearTimeout(t); done(false); };
});

// Ask the resolvers (random order) for a public node of `networkId`, swap the
// borsh path for JSON, verify it actually answers JSON getInfo, cache + return it.
export async function resolvePublicNode(networkId = getNetworkId(), log = () => {}) {
  const L = (t, k) => { tlog(t, k); log(t, k); }; // console dock + caller
  const tls = typeof location !== "undefined" && location.protocol === "https:" ? "tls" : "any";
  const shuffled = [...RESOLVERS].sort(() => Math.random() - 0.5);
  L(`resolving a public ${networkId} node via kaspa-resolver…`);
  for (const r of shuffled.slice(0, 6)) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      const res = await fetch(`${r}/v2/kaspa/${networkId}/${tls}/wrpc/borsh`, { signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const { url } = await res.json();
      if (!url) continue;
      const jsonUrl = url.replace(/\/wrpc\/borsh$/, "/wrpc/json");
      L(`resolver ${new URL(r).host} → ${new URL(jsonUrl).host}, probing JSON wRPC…`);
      if (await probeJson(jsonUrl)) {
        L(`public node ready → ${jsonUrl}`, "ok");
        try { localStorage.setItem(RESOLVED_KEY(networkId), jsonUrl); } catch { /* ignore */ }
        window.dispatchEvent(new Event("kosign-rpc"));
        return jsonUrl;
      }
    } catch { /* try the next resolver */ }
  }
  L("no public JSON wRPC node reachable — set a custom endpoint in ⚙", "err");
  return null;
}

// Drop the cached public-node pick and resolve a fresh one — used when a pool
// node turns out to be flaky mid-session (dead websocket, hanging calls).
export async function reResolvePublicNode(id = getNetworkId(), log = () => {}) {
  if (getRpcChoice(id).mode !== "public") return null;
  try { localStorage.removeItem(RESOLVED_KEY(id)); } catch { /* ignore */ }
  tlog("public node looked flaky — asking the resolver for another…");
  return resolvePublicNode(id, log);
}

// Make sure the current network has a usable endpoint (resolving if the choice is
// "public" and nothing is cached yet). Returns the URL or "".
export async function ensureRpcUrl(log = () => {}) {
  const id = getNetworkId();
  const c = getRpcChoice(id);
  if (c.mode === "custom") return c.url || "";
  return getResolvedRpc(id) || (await resolvePublicNode(id, log)) || "";
}
