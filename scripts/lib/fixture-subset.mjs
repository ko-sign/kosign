#!/usr/bin/env node
// ===========================================================================
// fixture-subset — pick the tests that pin one guard family out of a contract's
// fixture file, and write them out as a fixture file of their own.
//
// WHY scripts/test-security.sh needs this
//   The differential (layer 3) runs a contract's suite against a MUTANT with a
//   guard family stripped out. Running all 56 KoRoot tests for that costs ~2
//   minutes per family, and all but a handful of them say nothing about the
//   family being stripped. So the harness selects the tests that DO — by name,
//   because in this repo test names are the documentation — and runs only those.
//
//   Selecting by name is also the pin itself: if the tests that pin a family are
//   renamed away or deleted, the selection shrinks and the harness fails loudly
//   instead of quietly checking nothing. That is why an empty selection is an
//   error here rather than an empty run.
//
//   Only `expect: "fail"` tests are eligible. A guard removal can only ever turn
//   a REJECTION into an acceptance; a positive test that breaks on a mutant is
//   noise (usually a signature that no longer verifies because the redeem script
//   moved), never evidence.
//
// Usage
//   node scripts/lib/fixture-subset.mjs --tests <fixtures.json> --match <regex>
//        [--from <other-fixtures.json>] [--out <path>] [--list]
//
//   --from  take the selected tests from THIS file instead (matched by name),
//           e.g. fixtures regenerated against the mutant so that signature-gated
//           tests can actually flip. Every selected name must be present there,
//           or the two files have drifted and that is reported as an error.
//   --out   where to write the subset (default: stdout)
//   --list  also print the selected names, one per line, to stderr
//
// Prints the number of selected tests to stdout. Exit 1 = nothing selected, or
// --from is missing one of them.
// ===========================================================================
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
const has = (name) => argv.includes(name);

const testsPath = arg('--tests');
const match = arg('--match');
if (!testsPath || !match) {
  console.error('usage: fixture-subset.mjs --tests <fixtures.json> --match <regex> [--from <f>] [--out <f>] [--list]');
  process.exit(2);
}

const load = (p) => {
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return Array.isArray(j) ? j : (j.tests || []);
};

const re = new RegExp(match, 'i');
const all = load(testsPath);
const selected = all.filter((t) => t.expect === 'fail' && re.test(t.name));

if (!selected.length) {
  console.error(`no test in ${testsPath} matches /${match}/ among the ${all.length} present — `
    + 'the tests that pinned this guard family were renamed or deleted, or the selector is stale');
  process.exit(1);
}

let out = selected;
const from = arg('--from');
if (from) {
  const byName = new Map(load(from).map((t) => [t.name, t]));
  const missing = selected.filter((t) => !byName.has(t.name)).map((t) => t.name);
  if (missing.length) {
    console.error(`${from} is missing ${missing.length} of the ${selected.length} selected test(s) — `
      + 'the checked-in fixtures and the generated ones have drifted apart '
      + `(regenerate them: npm run gen:${/KoRoot/.test(testsPath) ? 'koroot' : /KoVault/.test(testsPath) ? 'kovault' : 'koproposal'}-tests)`);
    for (const m of missing) console.error(`  missing: ${m}`);
    process.exit(1);
  }
  out = selected.map((t) => byName.get(t.name));
}

const json = JSON.stringify({ tests: out }, null, 2) + '\n';
const dest = arg('--out');
if (dest) writeFileSync(dest, json); else process.stdout.write(json);
if (has('--list')) for (const t of out) console.error(t.name);
if (dest) console.log(String(out.length));
