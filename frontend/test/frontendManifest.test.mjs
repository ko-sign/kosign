// Naming a built frontend by its contents
// (run: node --test frontend/test/frontendManifest.test.mjs).
//
// The digest this produces is what a deployment gets called in a release note, and
// what scripts/verify-deployed.mjs compares a live site against. Two properties
// decide whether it is worth anything, and neither is obvious from reading it:
//
//   It must be STABLE — the same tree must always produce the same digest, on any
//   machine. A digest that depends on readdir order disagrees with itself between
//   a developer's laptop and CI, and every verification then reports a tamper that
//   never happened. A security tool that cries wolf gets switched off.
//
//   It must be SENSITIVE — one changed byte anywhere must change it. A digest that
//   misses a file is worse than no digest, because it is trusted.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildManifest, distFiles, canonicalOrder, MANIFEST_NAME } from "../../scripts/frontend-manifest.mjs";

function fixture(files) {
  const d = mkdtempSync(join(tmpdir(), "kosign-dist-"));
  for (const [p, body] of Object.entries(files)) {
    const full = join(d, p);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return d;
}

const BASE = {
  "index.html": "<!doctype html>",
  "assets/a.js": "console.log(1)",
  "assets/b.css": "body{}",
  "assets/font.woff2": "pretend-binary",
};

test("the digest is stable - same tree, same number, every time", () => {
  const d = fixture(BASE);
  try {
    const a = buildManifest(d), b = buildManifest(d);
    assert.equal(a.tree, b.tree);
    assert.deepEqual(a.files, b.files);
    // and it is a real digest, not a placeholder
    assert.match(a.tree, /^[0-9a-f]{64}$/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("the digest's ordering sorts, and is tested where the filesystem cannot hide it", () => {
  // Handing distFiles a directory and checking the result is sorted proves nothing
  // on a filesystem whose readdir is already ordered - which is most of them. That
  // is how a missing sort passes on a laptop and produces a different digest in CI.
  assert.deepEqual(canonicalOrder(["index.html", "assets/b.css", "assets/a.js"]),
    ["assets/a.js", "assets/b.css", "index.html"]);
  assert.deepEqual(canonicalOrder(["z", "a", "m"]), ["a", "m", "z"]);
  const input = ["b", "a"];
  canonicalOrder(input);
  assert.deepEqual(input, ["b", "a"], "ordering must not mutate the caller's list");
});

test("file order is fixed by sorting, not by the filesystem", () => {
  // readdir order varies between machines and filesystems. If it leaked into the
  // digest, a developer and CI would compute different numbers for identical
  // bytes - and every deployment check would report a tamper that never happened.
  const d = fixture(BASE);
  try {
    assert.deepEqual(distFiles(d), ["assets/a.js", "assets/b.css", "assets/font.woff2", "index.html"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("one changed byte anywhere changes the digest", () => {
  const before = fixture(BASE);
  const after = fixture({ ...BASE, "assets/a.js": "console.log(2)" });
  const deep = fixture({ ...BASE, "assets/font.woff2": "pretend-binaryX" });
  try {
    const b = buildManifest(before).tree;
    assert.notEqual(buildManifest(after).tree, b, "a changed script must change the digest");
    assert.notEqual(buildManifest(deep).tree, b, "a changed font must change it too - every served byte counts");
  } finally { for (const d of [before, after, deep]) rmSync(d, { recursive: true, force: true }); }
});

test("a file added or removed changes the digest", () => {
  const base = fixture(BASE);
  const extra = fixture({ ...BASE, "assets/sneaky.js": "fetch('http://evil')" });
  try {
    assert.notEqual(buildManifest(extra).tree, buildManifest(base).tree,
      "an extra file the build never emitted must not slip past the digest");
  } finally { for (const d of [base, extra]) rmSync(d, { recursive: true, force: true }); }
});

test("the manifest does not describe itself", () => {
  // It is written INTO dist, so including it would make the digest depend on a
  // file that does not exist until after the digest is computed.
  const withManifest = fixture({ ...BASE, [MANIFEST_NAME]: '{"tree":"whatever"}' });
  const plain = fixture(BASE);
  try {
    assert.ok(!distFiles(withManifest).includes(MANIFEST_NAME));
    assert.equal(buildManifest(withManifest).tree, buildManifest(plain).tree,
      "a stale manifest lying in dist must not change the digest");
  } finally { for (const d of [withManifest, plain]) rmSync(d, { recursive: true, force: true }); }
});
