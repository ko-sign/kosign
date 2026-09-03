// Browser-direct Kaspa JSON wRPC client (route B, zero backend). Talks straight
// to a node's JSON wRPC endpoint (kaspad --rpclisten-json). Verified on TN10:
// getUtxosByAddresses returns covenantId + outpoint, and submitTransaction accepts
// a wasm-built covenant tx (RpcTransaction JSON). Envelope: { id, method, params }
// request; the result comes back in `params` (workflow-rpc JSON), errors in `error`.
//
// Public pool nodes can die mid-session, so nothing here may hang: connecting has
// a 12s deadline, every call a 20s deadline, and a closing socket rejects all
// in-flight calls — callers get a real error to log/retry instead of silence.
const READY_MS = 12_000;
const CALL_MS = 20_000;

export function connectWrpc(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const waiters = new Map(); // id -> { cb, timer }
  const settle = (i, m) => {
    const w = waiters.get(i);
    if (!w) return;
    waiters.delete(i);
    clearTimeout(w.timer);
    w.cb(m);
  };
  const flushAll = (why) => {
    for (const [i] of waiters) settle(i, { error: why });
  };
  ws.addEventListener("message", (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    settle(m.id, m);
  });
  ws.addEventListener("close", () => flushAll("wRPC connection closed"));
  ws.addEventListener("error", () => flushAll("wRPC connection error"));

  const ready = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`wRPC connect timed out (${url})`)), READY_MS);
    ws.addEventListener("open", () => { clearTimeout(t); res(); });
    ws.addEventListener("error", () => { clearTimeout(t); rej(new Error(`wRPC connect failed (${url})`)); });
    ws.addEventListener("close", () => { clearTimeout(t); rej(new Error(`wRPC closed before ready (${url})`)); });
  });
  ready.catch(() => {}); // callers who never await ready shouldn't trip unhandled-rejection

  const call = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      const timer = setTimeout(() => settle(i, { error: `${method} timed out (${CALL_MS / 1000}s)` }), CALL_MS);
      waiters.set(i, { timer, cb: (m) => (m.error ? rej(new Error(typeof m.error === "string" ? m.error : JSON.stringify(m.error))) : res(m.params)) });
      try { ws.send(JSON.stringify({ id: i, method, params })); }
      catch (e) { settle(i, { error: `send failed: ${e.message || e}` }); }
    });
  return {
    ready,
    call,
    close: () => { try { ws.close(); } catch { /* ignore */ } },
    getInfo: () => call("getInfo", {}),
    getUtxos: (addresses) => call("getUtxosByAddresses", { addresses }),
    submit: (transaction) => call("submitTransaction", { transaction, allowOrphan: false }),
  };
}
