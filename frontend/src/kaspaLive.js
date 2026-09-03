// Optional real-time vault updates via a DIRECT browser→Kaspa wRPC (JSON)
// subscription — no backend in the path. Kaspa's wRPC speaks JSON on a SerdeJson
// endpoint; we subscribe to UTXO changes for the vault address and fire a refresh
// on the push. Message framing is derived from the authoritative source:
//   workflow-rpc JsonClientMessage { id, method, params }  (method = RpcApiOps,
//   which is #[serde(rename_all="camelCase")] → "notifyUtxosChanged"/"getInfo";
//   the notification op is UtxosChangedNotification). Command serde = "Start".
//
// NOTE: the only endpoints we have today are Borsh-only (they drop JSON), so this
// fails fast and the caller falls back to polling. It goes live the moment a
// reachable public JSON wRPC endpoint is configured. The endpoint is user-set
// (getRpcUrl/setRpcUrl) so no node apikey is hardcoded in the bundle.
// The endpoint now comes from the per-network choice in network.js: either the
// official public-node resolver (cached pick) or a custom URL (default = the
// project TN10 node), all managed in the ⚙ panel.
import { getRpcChoice, getResolvedRpc, setRpcChoice } from "./network.js";
import { termPush } from "./Terminal.jsx";
export const getRpcUrl = () => {
  const c = getRpcChoice();
  return c.mode === "custom" ? (c.url || "") : getResolvedRpc();
};
export const setRpcUrl = (u) => setRpcChoice({ mode: "custom", url: (u || "").trim() });

// Connection-state lines go to the global console dock, deduped so re-binds and
// the 8s polling never spam it — only state CHANGES are logged.
let lastLog = "";
const clog = (key, text, kind) => { if (lastLog === key) return; lastLog = key; termPush(text, kind); };
const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };

// Subscribe to UTXO changes for `addresses`. onChange() fires on any utxosChanged
// push; onStatus(state) with "connecting" | "live" | "off". Returns stop().
export function subscribeUtxos(addresses, onChange, onStatus) {
  const url = getRpcUrl();
  if (!url || !/^wss?:\/\//i.test(url) || !addresses?.length) { onStatus?.("off"); return () => {}; }

  let ws, alive = true, announced = false;
  onStatus?.("connecting");
  try { ws = new WebSocket(url); } catch { onStatus?.("off"); return () => {}; }

  const stop = () => { alive = false; clearTimeout(probe); try { ws.close(); } catch { /* ignore */ } };
  const fail = (why) => {
    if (!alive) return;
    if (why) clog(`fail|${url}|${why}`, `wRPC ${hostOf(url)}: ${why} — falling back to 8s polling`, "err");
    onStatus?.("off"); stop();
  };
  // if no message arrives shortly after connecting, treat as not-a-JSON-wRPC → poll
  const probe = setTimeout(() => fail("no JSON wRPC answer in 6s"), 6000);

  ws.onopen = () => {
    if (!alive) return;
    ws.send(JSON.stringify({ id: 1, method: "notifyUtxosChanged", params: { addresses, command: "Start" } }));
    ws.send(JSON.stringify({ id: 2, method: "getInfo", params: {} })); // liveness probe
  };
  ws.onmessage = (e) => {
    if (!alive) return;
    clearTimeout(probe);
    if (!announced) {
      announced = true;
      clog(`live|${url}|${addresses[0]}`, `⛓ wRPC live @ ${hostOf(url)} — utxosChanged subscription on ${addresses[0].slice(0, 22)}…`, "ok");
    }
    onStatus?.("live");
    let m; try { m = JSON.parse(String(e.data)); } catch { return; }
    const method = typeof m?.method === "string" ? m.method.toLowerCase() : "";
    if (method.includes("utxoschanged")) onChange?.(); // a UTXO touched our address
  };
  ws.onerror = () => fail("connection error");
  ws.onclose = () => fail(announced ? "connection closed" : "");
  return stop;
}
