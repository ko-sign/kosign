// Client-side Ko-sign signer. The user imports a Kaspa private key here; it is
// persisted in this browser's localStorage (never sent to the backend) so you don't
// have to re-import every visit, and signs the sighashes locally. This is what makes
// a raw key usable for covenant txs — unlike Kasware, whose pre-Toccata SDK can't
// sign them. TRADEOFF: localStorage persistence trades some XSS exposure for
// convenience — use "Forget key" on shared machines. (Testnet dev tool.)
//
// Crypto: BIP340 Schnorr over the 32-byte sighash, verified to interop with the
// native Rust tooling (secp256k1 sign_schnorr) — same x-only pubkey, same sigs.
import { useSyncExternalStore } from "react";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export function normalizePriv(s) {
  const h = (s || "").trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("private key must be 64 hex chars (32 bytes)");
  return h;
}
export const xonlyFromPriv = (privHex) => bytesToHex(schnorr.getPublicKey(hexToBytes(normalizePriv(privHex))));
export const signSighash = (sighashHex, privHex) => bytesToHex(schnorr.sign(hexToBytes(sighashHex), hexToBytes(normalizePriv(privHex))));

// --- persisted wallet store: ONE active source ---
//   manual  — raw key in localStorage; full covenant signing (sign()).
//   kasware — extension connection; owner identity + deposits, but KasWare
//             can't sign covenant P2SH inputs yet, so sign() explains that.
const STORAGE_KEY = "kosign.ownerKey";
const KW_KEY = "kosign.kasware"; // { address, pubkey } — re-hydrated on load
const load = () => { try { const v = localStorage.getItem(STORAGE_KEY); return v && /^[0-9a-f]{64}$/.test(v) ? v : null; } catch { return null; } };
const loadKw = () => { try { return JSON.parse(localStorage.getItem(KW_KEY) || "null"); } catch { return null; } };
let _priv = load();
let _kasware = _priv ? null : loadKw(); // manual key wins if both were stored
const subs = new Set();
const emit = () => subs.forEach((f) => f());

export function importKey(s) {
  _priv = normalizePriv(s); _kasware = null;
  try { localStorage.setItem(STORAGE_KEY, _priv); localStorage.removeItem(KW_KEY); } catch { /* ignore */ }
  emit(); return xonlyFromPriv(_priv);
}
export function connectKasware({ address, pubkey }) {
  if (!pubkey) throw new Error("KasWare returned no public key");
  _kasware = { address, pubkey: pubkey.toLowerCase() }; _priv = null;
  try { localStorage.setItem(KW_KEY, JSON.stringify(_kasware)); localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  emit(); return _kasware;
}
export function forgetKey() {
  _priv = null; _kasware = null;
  try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(KW_KEY); } catch { /* ignore */ }
  emit();
}
export const pubkey = () => (_priv ? xonlyFromPriv(_priv) : _kasware?.pubkey || null);
export const walletSource = () => (_priv ? "manual" : _kasware ? "kasware" : null);
export const walletAddress = () => _kasware?.address || null;
export const canSign = () => !!_priv;
export function sign(sighashHex) {
  if (_priv) return signSighash(sighashHex, _priv);
  if (_kasware) throw new Error("KasWare can't sign covenant inputs yet (signPskt only signs its own addresses) — import the owner's raw key to sign");
  throw new Error("connect a wallet first");
}
export const signAll = (hexes) => hexes.map(sign);

// React hook: returns the active owner's x-only pubkey (or null), reactively.
export function useWallet() {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, pubkey, () => null);
}
// Reactive wallet source ("manual" | "kasware" | null) for UI badges.
export function useWalletSource() {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, walletSource, () => null);
}
