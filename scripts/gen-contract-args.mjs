// Regenerate contracts/args/<name>.json — the illustrative constructor arguments
// that scripts/compile-all.sh feeds to silc as a compile check.
//
// These are derived from each contract's OWN declared constructor signature, so
// adding or removing a parameter can no longer leave the compile check behind
// (it silently rotted once: three contracts stopped compiling and nothing said so).
// Real per-treasury args come from packages/descriptor at deploy time.
import { readFileSync, writeFileSync } from "node:fs";

const CONTRACTS = ["KoVault", "KoProposal", "KoRoot"];
const arr = (n, fill = 1) => ({ kind: "array", data: Array.from({ length: n }, () => ({ kind: "byte", data: fill })) });
const int = (n) => ({ kind: "int", data: n });

// plausible placeholder values per parameter name, so the compile check exercises
// realistic shapes (lengths must satisfy the contract's own byte[N] declarations)
const VALUE = (type, name) => {
  const m = /^byte\[(\d*)\]$/.exec(type);
  if (m) return arr(m[1] ? +m[1] : 64);            // byte[] (unsized) -> a 64-byte stand-in
  if (type !== "int") throw new Error(`unhandled param type ${type} (${name})`);
  if (/PrefixLen$/.test(name)) return int(1);
  if (/SuffixLen$/.test(name)) return int(1251);
  if (/maxDepositInputs/.test(name)) return int(16);
  if (/Fee$/i.test(name)) return int(10_000_000);
  if (/Amount$/.test(name)) return int(100_000_000);
  if (/ExpiresAt$/.test(name)) return int(9_999_999_999);
  if (/ExecutionDelay$/.test(name)) return int(3600);
  if (/OwnerCount$/.test(name)) return int(3);
  if (/Threshold$/.test(name)) return int(2);
  return int(1);
};

for (const name of CONTRACTS) {
  const src = readFileSync(`contracts/${name}.sil`, "utf8");
  const sig = src.slice(src.indexOf(`contract ${name}(`));
  const params = sig.slice(sig.indexOf("(") + 1, sig.indexOf(")"))
    .split(",").map((s) => s.replace(/\/\/.*$/gm, "").trim()).filter(Boolean)
    .map((p) => { const [type, pname] = p.split(/\s+/); return { type, name: pname }; });
  const args = params.map((p) => VALUE(p.type, p.name));
  writeFileSync(`contracts/args/${name}.json`, JSON.stringify(args) + "\n");
  console.log(`  ${name}: ${args.length} args (${params.map((p) => p.name).join(", ").slice(0, 60)}…)`);
}
