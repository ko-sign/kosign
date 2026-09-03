// Check that a live deployment is serving what this commit builds.
//
// This is the question the rest of the repository cannot answer. The covenants are
// enforced by every Kaspa node. The wasm builder is tied to its Rust. The spend
// guard re-reads a transaction before it goes out. All of it protects the code in
// this repository — and none of it helps if the page a person loaded is not that
// code. A CDN is the last link, and it is the only one with no cryptography in it.
//
//   node scripts/verify-deployed.mjs https://kosign.app
//
// Builds the manifest from frontend/dist (so build first), fetches every file the
// deployment claims to serve, and compares hashes. Anything the site serves that
// does not match, or does not exist, is reported by name.
//
// What this proves and what it does not: matching hashes mean the bytes served
// right now are the bytes this working tree built. It does not mean they will be
// in an hour, and it does not defend against a server that serves one thing to
// this script and another to a browser. It is a spot check by someone who can
// rebuild the source — which is exactly the check nobody could perform before.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { buildManifest, DIST, MANIFEST_NAME } from "./frontend-manifest.mjs";

const CONCURRENCY = 8;

const usage = () => {
  console.error("usage: node scripts/verify-deployed.mjs <url> [--only-code]");
  console.error("  --only-code   check index.html and the JS/CSS only, skipping fonts and images");
  process.exit(2);
};

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith("--")) || "").replace(/\/$/, "");
if (!base) usage();
const onlyCode = args.includes("--only-code");

if (!existsSync(DIST)) {
  console.error(`no frontend/dist — build first:  npm run build:frontend`);
  process.exit(1);
}

const manifest = buildManifest();
const isCode = (f) => /\.(html|js|mjs|css|json|wasm)$/i.test(f);
const wanted = Object.entries(manifest.files).filter(([f]) => (onlyCode ? isCode(f) : true));

console.log(`local build digest ${manifest.tree}`);
console.log(`checking ${wanted.length} file(s) against ${base}${onlyCode ? " (code only)" : ""}…\n`);

/** @type {{file: string, problem: string}[]} */
const problems = [];
let checked = 0;

async function check([file, want]) {
  const url = `${base}/${file}`;
  let res;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (e) {
    problems.push({ file, problem: `could not be fetched (${e.message})` });
    return;
  }
  if (!res.ok) {
    problems.push({ file, problem: `the deployment returned ${res.status} for it` });
    return;
  }
  const got = createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
  if (got !== want) {
    // A hashed asset name that resolves to different bytes is the interesting case:
    // the name commits to the content, so this cannot be an innocent stale cache.
    const named = /-[A-Za-z0-9_-]{8}\.(js|css)$/.test(file);
    problems.push({
      file,
      problem: `served ${got.slice(0, 16)}… but this build produces ${want.slice(0, 16)}…` +
        (named ? " — and its filename is a content hash, so these bytes were never built from this source" : ""),
    });
  }
  checked++;
}

const queue = [...wanted];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) await check(queue.shift());
}));

if (!problems.length) {
  console.log(`DEPLOYMENT MATCHES — all ${checked} file(s) served by ${base} are byte-identical to this build.`);
  console.log(`\nThis is a spot check of what is served right now, by someone who can rebuild`);
  console.log(`the source. It says nothing about the next request.`);
  process.exit(0);
}

console.error(`DEPLOYMENT DOES NOT MATCH — ${problems.length} of ${wanted.length} file(s):\n`);
for (const p of problems) console.error(`  ${p.file}\n    ${p.problem}`);
console.error(`\nEither the deployment is older or newer than this working tree — check out the`);
console.error(`commit it was built from and run this again — or it is serving something this`);
console.error(`source does not produce.`);
process.exit(1);
