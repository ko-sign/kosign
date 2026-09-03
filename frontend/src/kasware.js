// KasWare wallet provider (window.kasware) — docs.kasware.xyz.
//
// What KasWare gives Ko-sign today: connect (address), getPublicKey (33-byte
// compressed → we use the x-only 32 bytes, same as our owner keys), network
// get/switch, balance, and sendKaspa (deposit straight into the vault).
// What it can NOT do yet: sign covenant sighashes — signPskt only signs inputs
// that belong to the wallet's own addresses, and KoRoot/KoProposal inputs
// are covenant P2SH. So a KasWare connection is an OWNER IDENTITY + DEPOSIT
// mode; covenant signing still needs the manual raw key.
import { getNetworkId } from "./network.js";

const tlog = (text, kind = "info") => {
  try { window.dispatchEvent(new CustomEvent("kosign-termlog", { detail: { text, kind } })); } catch { /* no-op */ }
};

export const kaswareAvailable = () => typeof window !== "undefined" && !!window.kasware;

// Ko-sign network id ↔ KasWare network name
const TO_KASWARE = { "testnet-10": "kaspa_testnet_10", mainnet: "kaspa_mainnet" };
const FROM_KASWARE = Object.fromEntries(Object.entries(TO_KASWARE).map(([a, b]) => [b, a]));
export const kaswareNetworkFor = (id = getNetworkId()) => TO_KASWARE[id] || "kaspa_mainnet";
export const kosignNetworkOf = (kw) => FROM_KASWARE[kw] || null;

// Connect: accounts + pubkey (+ align the wallet's network with the ⚙ one).
// Returns { address, pubkey (x-only hex), network (kasware name), balance? }.
export async function kaswareConnect() {
  const k = window.kasware;
  if (!k) throw new Error("KasWare not detected — install the extension from kasware.xyz");
  tlog("kasware: requesting accounts…");
  const accounts = await k.requestAccounts();
  if (!accounts?.length) throw new Error("KasWare returned no accounts");

  let network = null;
  try { network = await k.getNetwork(); } catch { /* older builds */ }
  const want = kaswareNetworkFor();
  if (network && network !== want && typeof k.switchNetwork === "function") {
    tlog(`kasware: switching network ${network} → ${want}…`);
    try { await k.switchNetwork(want); network = want; } catch { tlog(`kasware: network switch refused — wallet stays on ${network}`, "err"); }
  }

  const compressed = await k.getPublicKey(); // 33-byte compressed hex
  const pubkey = /^[0-9a-f]{66}$/i.test(compressed) ? compressed.slice(2).toLowerCase() : (compressed || "").toLowerCase();
  const address = accounts[0];

  let balance = null;
  try { const b = await k.getBalance(); balance = b?.total != null ? Number(b.total) : null; } catch { /* best-effort */ }

  tlog(`⛓ kasware connected — ${address.slice(0, 22)}… (${network || "network unknown"})`, "ok");
  return { address, pubkey, network, balance };
}

export async function kaswareDisconnect() {
  try { await window.kasware?.disconnect?.(window.location.origin); } catch { /* ignore */ }
  tlog("kasware: disconnected");
}

// Deposit from the connected KasWare wallet. Returns the txid (or null).
export async function kaswareSend(toAddress, sompi) {
  const k = window.kasware;
  if (!k) throw new Error("KasWare not detected");
  tlog(`kasware: sendKaspa ${sompi / 1e8} KAS → ${toAddress.slice(0, 22)}…`, "cmd");
  const res = await k.sendKaspa(toAddress, sompi);
  // sendKaspa returns a serialized tx JSON string carrying the id
  let txid = null;
  try { const j = JSON.parse(res); txid = j?.id || j?.transactionId || null; } catch { txid = typeof res === "string" && /^[0-9a-f]{64}$/i.test(res) ? res : null; }
  tlog(`kasware: deposit submitted${txid ? ` — txid ${txid}` : ""}`, "ok");
  return txid;
}

// accountsChanged / networkChanged subscriptions (kasware.on / removeListener)
export function kaswareOn(event, handler) {
  const k = window.kasware;
  if (!k?.on) return () => {};
  k.on(event, handler);
  return () => { try { k.removeListener?.(event, handler); } catch { /* ignore */ } };
}
