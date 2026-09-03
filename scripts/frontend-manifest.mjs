// Names a built frontend by its contents.
//
// Every file under frontend/dist is hashed, and the sorted list of
// "<path> <sha256>" lines is itself hashed into one tree digest. That digest is
// what a deployment can be called: short enough to put in a release note, and
// specific enough that a single changed byte anywhere produces a different one.
//
// Path ordering is fixed by sorting rather than by filesystem order, because
// readdir order varies between machines and a digest that depends on it would
// disagree with itself for no reason.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DIST = join(ROOT, "frontend/dist");
export const MANIFEST_NAME = "BUILD-MANIFEST.json";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Every emitted file, relative to dist, POSIX-separated, sorted. */
export function distFiles(dist = DIST) {
  /** @type {string[]} */
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dist, p).split(sep).join("/"));
    }
  };
  walk(dist);
  // the manifest cannot describe itself
  return canonicalOrder(out.filter((f) => f !== MANIFEST_NAME));
}

/**
 * The order the digest is computed in.
 *
 * Split out and exported so it can be tested against a deliberately unsorted list.
 * Asserting that `distFiles` comes back sorted proves nothing on a filesystem whose
 * readdir happens to be ordered — which is most of them, and is exactly how a
 * missing sort survives every test on a developer's machine and then produces a
 * different digest in CI. Every deployment check would then report a tamper that
 * never happened.
 */
export const canonicalOrder = (files) => [...files].sort();

export function buildManifest(dist = DIST) {
  const files = {};
  for (const f of distFiles(dist)) files[f] = sha256(readFileSync(join(dist, f)));
  const tree = sha256(Object.entries(files).map(([f, h]) => `${f} ${h}`).join("\n"));
  return { version: 1, tree, files };
}

if (process.argv[1] && process.argv[1].endsWith("frontend-manifest.mjs")) {
  if (!existsSync(DIST)) {
    console.error(`no ${relative(ROOT, DIST)} — run: npm run build:frontend`);
    process.exit(1);
  }
  const m = buildManifest();
  const n = Object.keys(m.files).length;
  if (process.argv.includes("--write")) {
    writeFileSync(join(DIST, MANIFEST_NAME), JSON.stringify(m, null, 2) + "\n");
    console.log(`wrote frontend/dist/${MANIFEST_NAME} — ${n} files`);
  }
  console.log(`build digest ${m.tree}`);
  console.log(`  publish this where the server that hosts the bundle cannot edit it;`);
  console.log(`  a manifest served alongside the bundle proves nothing by itself.`);
}
