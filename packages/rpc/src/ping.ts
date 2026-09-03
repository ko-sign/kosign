/**
 * TN10 connectivity probe.
 *
 *   pnpm --filter @kosign/rpc ping        (reads .env at repo root)
 *
 * Two layers:
 *   1. raw WebSocket reachability (always works) — proves TLS + apikey + node up.
 *   2. Kaspa WASM SDK getServerInfo — needs a Toccata-compatible SDK build. The
 *      published kaspa-wasm (0.13.0) is pre-Toccata and panics ("memory access
 *      out of bounds") against a TN10 node; see docs/RISKS.md. We attempt it and
 *      degrade gracefully.
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), "../../.env") });
loadEnv();

const url = process.env.KASPA_RPC_URL;
const networkId = process.env.KASPA_NETWORK ?? "testnet-10";

function redact(u: string): string {
  return u.replace(/apikey=[^&]+/, "apikey=***");
}

function rawReachability(u: string): Promise<boolean> {
  return new Promise((res) => {
    const ws = new WebSocket(u);
    const t = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      res(false);
    }, 8000);
    ws.onopen = () => { clearTimeout(t); try { ws.close(); } catch { /* ignore */ } res(true); };
    ws.onerror = () => { clearTimeout(t); res(false); };
  });
}

async function trySdk(u: string): Promise<boolean> {
  let sdk: any;
  for (const name of ["kaspa-wasm", "kaspa"]) {
    try { sdk = await import(name); break; } catch { /* next */ }
  }
  if (!sdk) { console.log("• SDK: not installed"); return false; }
  sdk.initConsolePanicHook?.();
  try {
    const rpc = new sdk.RpcClient({ url: u, encoding: sdk.Encoding?.Borsh, networkId });
    await rpc.connect();
    const server = await rpc.getServerInfo();
    console.log("• SDK getServerInfo:", JSON.stringify(server));
    const dag = await rpc.getBlockDagInfo();
    console.log("• virtualDaaScore:", dag.virtualDaaScore ?? dag.virtual_daa_score);
    await rpc.disconnect?.();
    return true;
  } catch (e: any) {
    console.log(`• SDK connect failed: ${e?.message ?? e}`);
    console.log("  (expected with pre-Toccata kaspa-wasm — see docs/RISKS.md)");
    return false;
  }
}

async function main(): Promise<void> {
  if (!url) { console.error("KASPA_RPC_URL not set. cp .env.example .env"); process.exit(2); }
  console.log(`endpoint: ${redact(url)}  (network ${networkId})`);

  const reachable = await rawReachability(url);
  console.log(reachable ? "• reachable: WebSocket opened (TLS + apikey OK)" : "• reachable: NO");

  const sdkOk = await trySdk(url);
  if (!reachable) process.exit(1);
  if (!sdkOk) {
    console.log("\nEndpoint is live but the SDK path is blocked on a Toccata-compatible build.");
    process.exit(0);
  }
  console.log("\n✓ full connectivity. Next: run the probe contracts on-chain (see contracts/probes).");
}

main().catch((e) => { console.error("ping error:", e?.message ?? e); process.exit(1); });
