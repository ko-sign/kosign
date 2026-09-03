// The browser's covenant transaction builder ships as a committed binary:
// frontend/src/wasm/kosign_wasm_tx_bg.wasm decides the amount, the recipient and
// the covenant continuation of every transaction an owner signs. Reviewing
// tools/wasm-tx/src/lib.rs tells you nothing about it unless the two are tied
// together, and until this manifest existed they were not.
//
// The routine way that bites has nothing to do with an attacker: edit lib.rs,
// forget to rebuild, and every suite in the repo stays green — because every
// suite exercises the OLD blob. The source under review and the code that runs
// have silently diverged, and the only symptom is that a fix you can read in the
// diff is not actually in the product.
//
// So the manifest records both sides. The artefact hashes catch a blob that was
// swapped or rebuilt without recording it. The SOURCE hashes catch the opposite
// and far more common case: the Rust moved and the blob did not. Neither check
// needs rustc, clang or wasm-bindgen — it is four files hashed against a JSON
// file, so it can run in `npm test` on a machine that has no Rust at all.
//
// What it deliberately does NOT prove is that the blob was built from these
// sources; only a rebuild can do that (scripts/build-wasm.sh). A manifest can be
// updated by whoever swapped the blob. Its job is to make drift impossible to
// miss, not to make substitution impossible.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Everything the build reads. Cargo.lock is in here because without it the
// dependency graph is not pinned at all — a rebuild resolves crates.io afresh
// and produces a different binary for reasons no diff would show.
export const SOURCES = [
  "tools/wasm-tx/src/lib.rs",
  "tools/wasm-tx/Cargo.toml",
  "tools/wasm-tx/Cargo.lock",
  "tools/wasm-tx/rust-toolchain.toml",
  "tools/wasm-tx/.cargo/config.toml",
];

// Everything the build writes, all four of which the app loads.
export const ARTEFACTS = [
  "frontend/src/wasm/kosign_wasm_tx_bg.wasm",
  "frontend/src/wasm/kosign_wasm_tx.js",
  "frontend/src/wasm/kosign_wasm_tx.d.ts",
  "frontend/src/wasm/kosign_wasm_tx_bg.wasm.d.ts",
];

export const MANIFEST = "frontend/src/wasm/MANIFEST.json";

const sha256 = (rel) => createHash("sha256").update(readFileSync(join(ROOT, rel))).digest("hex");

export function hashAll(paths) {
  const out = {};
  for (const p of paths) {
    if (!existsSync(join(ROOT, p))) throw new Error(`missing: ${p}`);
    out[p] = sha256(p);
  }
  return out;
}

export function readManifest() {
  const p = join(ROOT, MANIFEST);
  if (!existsSync(p)) throw new Error(`no ${MANIFEST} — run: npm run build:wasm`);
  return JSON.parse(readFileSync(p, "utf8"));
}

export function write(toolchain) {
  const m = { version: 1, toolchain, sources: hashAll(SOURCES), artefacts: hashAll(ARTEFACTS) };
  writeFileSync(join(ROOT, MANIFEST), JSON.stringify(m, null, 2) + "\n");
  return m;
}

// Returns a list of human-readable problems; empty means the tree is consistent.
export function check() {
  const m = readManifest();
  const problems = [];
  const cmp = (kind, recorded, actual) => {
    for (const [p, want] of Object.entries(recorded)) {
      const got = actual[p];
      if (got !== want) problems.push({ kind, path: p, want, got });
    }
  };
  cmp("source", m.sources ?? {}, hashAll(SOURCES));
  cmp("artefact", m.artefacts ?? {}, hashAll(ARTEFACTS));
  return { manifest: m, problems };
}

if (process.argv[1] && relative(process.cwd(), process.argv[1]).endsWith("wasm-manifest.mjs")) {
  const args = process.argv.slice(2);
  if (args[0] === "--write") {
    const i = args.indexOf("--toolchain");
    const toolchain = i >= 0 ? JSON.parse(args[i + 1]) : {};
    const m = write(toolchain);
    console.log(`wrote ${MANIFEST}`);
    console.log(`  wasm sha256 ${m.artefacts["frontend/src/wasm/kosign_wasm_tx_bg.wasm"]}`);
  } else {
    const { manifest, problems } = check();
    if (!problems.length) {
      console.log(`wasm manifest OK — ${SOURCES.length} sources and ${ARTEFACTS.length} artefacts match`);
      console.log(`  built with ${manifest.toolchain?.rustc ?? "?"} / wasm-bindgen ${manifest.toolchain?.wasmBindgen ?? "?"}`);
      process.exit(0);
    }
    const srcDrift = problems.filter((p) => p.kind === "source");
    const artDrift = problems.filter((p) => p.kind === "artefact");
    console.error("WASM MANIFEST FAILED\n");
    if (srcDrift.length && !artDrift.length) {
      console.error("The Rust changed and the wasm was not rebuilt. The app is still running");
      console.error("the OLD builder — your change is in the diff but not in the product.\n");
    } else if (artDrift.length && !srcDrift.length) {
      console.error("The committed wasm is not the one this manifest records, and no source");
      console.error("changed to explain it. Either it was rebuilt without recording it, or it");
      console.error("was replaced.\n");
    } else {
      console.error("Both the sources and the committed wasm moved without the manifest being");
      console.error("updated.\n");
    }
    for (const p of problems) console.error(`  ${p.kind.padEnd(8)} ${p.path}\n    recorded ${p.want}\n    actual   ${p.got}`);
    console.error("\nRebuild and record: npm run build:wasm");
    process.exit(1);
  }
}
