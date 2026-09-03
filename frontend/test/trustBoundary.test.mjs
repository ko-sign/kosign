// The trust boundary between this app and the servers it talks to
// (run: node --test frontend/test/trustBoundary.test.mjs).
//
// Ko-sign runs its own indexer. It is convenient and it is NOT trustworthy: it is
// one machine we operate, with no consensus behind it, and it has already been the
// source of one real vulnerability — for 0.2 KAS an attacker could park a covenant
// UTXO at an honest vault's address and have the indexer report that vault as
// forged. The money was never at risk; the reputation was.
//
// There are TWO clients that talk to that untrusted machine, and the honest thing
// is to say what is true of each rather than assert one clean rule that is false:
//
//   stats.js     — the landing page's stat strip. It reads three numbers and gates
//                  NOTHING, and it must never be reached from a path that moves
//                  money. That is a real avoidance invariant, checked below.
//
//   kaspaRest.js — the REST indexer client. The money path DOES read it (genesisAudit
//                  fetches the genesis tx; proposalScan/recovery read address history),
//                  so "the signing path never touches the indexer" is simply not true,
//                  and an earlier version of this file that implied it gave false
//                  assurance. What keeps that safe is not avoidance but RE-ANCHORING:
//                  every value taken from the indexer is either recomputed
//                  cryptographically (auditGenesis re-derives the covenant id) or
//                  pinned to a node UTXO (walkRoot/scanOpenProposals require the
//                  reconstructed address to hold the live outpoint) before it can
//                  influence a build, a signature, or a safety claim. The one place
//                  that is NOT re-anchored — a closed proposal's history, and an open
//                  transfer's displayed recipient — is labelled/gated explicitly
//                  (see the R6.1 note and the R7 recipient gate tested below).
//
// The stats.js check is transitive on purpose. "Does wasmTx.js import stats.js" is
// easy to keep true while a helper two levels down does the fetching.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const rel = (p) => relative(SRC, p);

/** Local (./ or ../) imports only — a bare specifier is a package, not our code. */
function localImports(file) {
  const src = readFileSync(file, "utf8");
  const specs = [...src.matchAll(/^\s*import\s[^;]*?from\s*["'](\.[^"']+)["']/gm)].map((m) => m[1]);
  specs.push(...[...src.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g)].map((m) => m[1]));
  return specs
    .map((sp) => resolve(dirname(file), sp.replace(/\?.*$/, "")))
    .filter((p) => existsSync(p));
}

/** Every local module reachable from `entry`, including itself. */
function reachable(entry) {
  const seen = new Set();
  const stack = [resolve(SRC, entry)];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    stack.push(...localImports(f));
  }
  return seen;
}

// Everything that decides what a transaction does, or whether one is safe to make.
const MONEY_PATH = [
  "wasmTx.js",        // builds and submits every covenant transaction
  "txGuard.js",       // decides whether a built transaction may be broadcast
  "txDecode.js",      // the independent reading the guard depends on
  "genesisAudit.js",  // decides whether a vault is safe to open at all
  "proposalScan.js",  // decides what the on-chain proposals mean
  "proposalPolicy.js",// decides what may be proposed
  "treasuryRebuild.js", // rebuilds the scripts addresses are derived from
  "signer.js",        // holds the key
];

const UNTRUSTED = "stats.js"; // the client for OUR indexer

test("no money-path module reaches the landing stat client (stats.js), even indirectly", () => {
  const target = resolve(SRC, UNTRUSTED);
  for (const entry of MONEY_PATH) {
    const via = reachable(entry);
    assert.ok(
      !via.has(target),
      `${entry} can reach ${UNTRUSTED}. The indexer is one machine we run with no ` +
      `consensus behind it; a safety decision that reads from it is a safety decision ` +
      `an attacker can influence. Reachable set included: ${[...via].map(rel).sort().join(", ")}`,
    );
  }
});

test("the landing stat client is reached only from the landing page", () => {
  // Not a style rule. Keeping the blast radius to one cosmetic component is what
  // makes the test above cheap to keep true. (This is stats.js only — kaspaRest.js,
  // the REST indexer, IS on the money path and is re-anchored, see the test below.)
  const all = ["App.jsx", "main.jsx", ...MONEY_PATH];
  const importers = [];
  for (const entry of all) {
    const p = resolve(SRC, entry);
    if (!existsSync(p)) continue;
    for (const f of reachable(entry)) {
      if (localImports(f).some((i) => i === resolve(SRC, UNTRUSTED))) importers.push(rel(f));
    }
  }
  assert.deepEqual([...new Set(importers)].sort(), ["Landing.jsx"]);
});

test("the landing page treats indexer numbers as decoration, not as facts to act on", () => {
  // A stat strip that renders three numbers cannot mislead anyone into signing
  // something. A stat that gated an action could, so nothing here may do that.
  // drop the import lines first, or "./stats.js" reads as a property access
  const src = readFileSync(resolve(SRC, "Landing.jsx"), "utf8").replace(/^\s*import\s[^;]*;$/gm, "");
  const uses = [...src.matchAll(/\bstats\??\.[A-Za-z]+/g)].map((m) => m[0]);
  assert.ok(uses.length > 0, "this test is vacuous if the landing page stopped using stats");
  for (const u of uses) {
    // the only permitted shapes are rendering and the "have we got any" check
    // `stale` chooses between two labels about the DATA's freshness, which is
    // still decoration — it says nothing about whether anything is safe.
    assert.match(u, /^stats\??\.(treasuries|tvlSompi|signers|network|checkedAt|stale)$/, `unexpected use of the indexer's answer: ${u}`);
  }
  assert.doesNotMatch(src, /disabled=\{[^}]*stats/, "an indexer number must never gate a control");
  assert.doesNotMatch(src, /href=\{[^}]*stats/, "an indexer number must never choose where a link goes");
});

test("chain-reconstructed proposal history is labelled as indexer-sourced, not confirmed", () => {
  // The live/signable state of a proposal is anchored to the node's UTXO set and is
  // safe. But a CLOSED proposal's outcome (paid out vs retired) and its amount and
  // recipient are reconstructed from the REST indexer's bytes and never cross-checked
  // — a hostile indexer could label a real payout as a retirement, or show a wrong
  // recipient an owner then reconciles their books against. The app cannot make that
  // display trustworthy without the node, so it must at least SAY it is not. Pin that
  // the note exists and is gated on `discovered` (chain-reconstructed) proposals in a
  // terminal state — locally-tracked history came from this app's own submissions and
  // must not carry the note.
  const src = readFileSync(resolve(SRC, "TreasuryView.jsx"), "utf8");
  assert.match(src, /item\.discovered && \(item\.status === 2 \|\| item\.status === 3\)/,
    "closed discovered proposals must be flagged as indexer-sourced");
  assert.match(src, /read from the chain indexer, not confirmed by your node/,
    "the note must say the outcome is not node-confirmed");
});

test("an unswept deposit is described as protected, not as unprotected", () => {
  // The mirror of the test above, and the same discipline: say what is true about
  // safety. A stray arrives UNBOUND (covenant id ZERO) and is not yet part of the
  // covenant balance — but it sits at the vault's P2SH address, so spending it runs
  // KoVault, and the only entrypoint a ZERO-id input can satisfy is `deposit`, which
  // forces output 0 back to this same vault for >= the sum of every vault-address
  // input. Keyless theft was attempted on-chain in all three shapes it could take
  // (tools/kaspa-probe/src/bin/steal_stray.rs) and the node refused each one.
  //
  // The old copy said strays were "not covenant-controlled until swept in", which
  // reads as "unprotected until you act" and would push a user into an urgent sweep
  // they do not need — the opposite of the truth, and exactly the kind of scary
  // half-sentence that gets a person to hurry through a transaction. Understating
  // protection is a defect the same way overstating it is.
  const src = readFileSync(resolve(SRC, "TreasuryView.jsx"), "utf8");
  const note = src.match(/<p className="stray-note">([^<]*)</)?.[1];
  assert.ok(note, "the unswept-deposit note must exist");
  assert.doesNotMatch(note, /not covenant-controlled/,
    "an unswept deposit IS covenant-protected on arrival — saying otherwise understates it");
  assert.match(note, /only spend it permits is a sweep back into this vault/,
    "the note must say what the covenant actually permits");
  assert.match(note, /isn't part of the covenant balance until swept/,
    "the note must still be honest that the deposit is not yet bound into the balance");
});

test("a discovered transfer's recipient is trusted only when it hashes to the on-chain commitment", () => {
  // Round 7 F3: the displayed recipient comes from an untrusted REST payload; the
  // committed recipientSpkHash is node-anchored. enrichDiscovered must bind the two —
  // set recipientSpkHex ONLY on a hash match, and flag a mismatch (or an unparseable
  // address) rather than leave the misleading label to be approved.
  const src = readFileSync(resolve(SRC, "wasmTx.js"), "utf8");
  assert.match(src, /if \(ri\.spkHash === p\.recipientSpkHash\) p\.recipientSpkHex = ri\.spkHex;\s*[\r\n]+\s*else p\.recipientMismatch = true;/,
    "enrichDiscovered must set recipientSpkHex on match and recipientMismatch otherwise");
  assert.match(src, /catch \{ p\.recipientMismatch = true; \}/,
    "an unparseable claimed recipient must be flagged, not silently trusted");
});

test("an open transfer with a recipient that fails the on-chain commitment cannot be approved", () => {
  // The gate that makes F3 safe: a shown-but-unverified recipient disables approval in
  // both the client-signed and per-owner paths, and carries a visible warning.
  const src = readFileSync(resolve(SRC, "TreasuryView.jsx"), "utf8");
  assert.match(src, /const recipientUnverified = !isConfig && !!item\.recipientAddress && !item\.recipientSpkHex;/,
    "unverified = a recipient shown without a commitment-matched recipientSpkHex");
  const disables = src.match(/disabled=\{[^}]*recipientUnverified[^}]*\}/g) || [];
  assert.ok(disables.length >= 2, `approve must be gated on recipientUnverified in both approve paths (found ${disables.length})`);
  assert.match(src, /does NOT match the address committed on-chain/,
    "an unverified recipient must carry a visible do-not-approve warning");
});

test("the REST indexer client IS on the money path, and its reads are re-anchored, not avoided", () => {
  // The honest counterpart to the stats.js avoidance test. kaspaRest.js is the REST
  // indexer; genesisAudit and wasmTx reach it, and that is expected — pretending
  // otherwise is the false assurance an earlier version of this file gave. What must
  // hold is that every value from it is re-anchored before it decides anything.
  const restClient = resolve(SRC, "kaspaRest.js");
  const onMoneyPath = reachable("genesisAudit.js").has(restClient) || reachable("wasmTx.js").has(restClient);
  assert.ok(onMoneyPath, "kaspaRest.js is expected on the money path; if this is false the safety story changed and this file must be rewritten, not quietly left asserting avoidance");
  // the re-anchor points those reads depend on:
  const audit = readFileSync(resolve(SRC, "genesisAudit.js"), "utf8") + readFileSync(resolve(SRC, "../../packages/descriptor/src/genesis.js"), "utf8");
  assert.match(audit, /computeCovenantId/, "the genesis audit must RECOMPUTE the covenant id, not trust the indexer's");
  assert.match(readFileSync(resolve(SRC, "proposalScan.js"), "utf8"), /getUtxos/, "live proposals must be pinned to the node's UTXO set, not the indexer's word");
});

test("configProposeClientSide refuses a config the contract would reject at execute time (bounds + distinctness)", () => {
  // Round 7 critic (G5): without client-side validation an invalid config (threshold above
  // the signer count, or a duplicate address) builds and co-owners can approve it — but
  // KoRoot.executeConfig enforces the same 1..5 / distinctness bounds and always rejects,
  // stranding the 0.5 KAS bond until expiry. createTreasuryClientSide validates the genesis
  // owner set the same way; the two entry points must agree.
  const src = readFileSync(resolve(SRC, "wasmTx.js"), "utf8");
  assert.match(src, /new Set\(pubkeys\)\.size !== realCount/, "must reject duplicate signers");
  assert.match(src, /realCount < 1 \|\| realCount > 5/, "must bound the signer count to 1..5");
  assert.match(src, /threshold < 1 \|\| threshold > realCount/, "must bound the threshold to 1..count");
});

test("the freshly-minted waiting state softens the message only, never the genesis gate", () => {
  // A treasury this browser just minted is missing from the chain indexer because the
  // indexer trails the node — expected, not alarming, and shown as "waiting" instead of
  // "could not verify". The danger in that change is obvious and is exactly the pattern
  // rounds 5 and 7 kept punishing: softening a safety signal on the strength of what the
  // app told itself. So pin that the softening is narrow and load-bearing nowhere:
  const src = readFileSync(resolve(SRC, "TreasuryView.jsx"), "utf8");

  // (1) it applies ONLY to the indexer-lag code, not to any other unverified reason
  assert.match(src, /gate\?\.code !== "no-genesis"[\s\S]{0,80}return false;/,
    "only the indexer-lag code may take the calm path");
  // (2) it requires this browser's own mint record AND a bounded window
  assert.match(src, /st\?\.genesis\?\.txid && Date\.now\(\) - Number\(st\.mintedAt \?\? 0\) < FRESH_MINT_GRACE_MS/,
    "the calm path needs a local mint record inside a bounded grace window");
  // (3) the gate itself is untouched: still clean-or-overridden, never freshlyMinted
  const gateOk = src.match(/const gateOk = [^;]+;/)?.[0] ?? "";
  assert.ok(gateOk && !/freshlyMinted/.test(gateOk),
    `gateOk must not consider freshlyMinted — it decides whether the treasury opens at all: ${gateOk}`);
  // (4) the deposit address still requires a cryptographic clean verdict
  assert.match(src, /genesisVerified=\{gate\?\.verdict === "clean" && !!gate\?\.cryptographic\}/,
    "the deposit address must stay gated on a cryptographic clean verdict");
});

test("a proposal's expiry is computed and bounded, never the eternal constant", () => {
  // expiresAt was hard-coded to DAA 4,000,000,000 (~11 years): every Approved
  // proposal a decade-lived standing authorization no signer rotation could
  // revoke, every Rejected proposal's bond stranded as long. Both builders must
  // commit an expiryDaa() the chain's clock anchors, and the execute path must
  // consult executeWindow() so an expired proposal is retired, not raced for its
  // bond against permissionless closers.
  const src = readFileSync(resolve(SRC, "wasmTx.js"), "utf8");
  assert.ok(!/expiresAt:\s*4_000_000_000/.test(src), "the 11-year constant is back in a builder");
  const anchored = src.split("expiryDaa(").length - 1;
  assert.ok(anchored >= 2, `both proposal builders must anchor their expiry via expiryDaa() — found ${anchored} call(s)`);
  assert.ok(src.split("executeWindow(").length - 1 >= 1, "executeClientSide no longer consults executeWindow() before signing");
});
