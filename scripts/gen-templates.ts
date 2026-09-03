// Regenerate frontend/src/treasuryTemplates.js from the contracts — the constant
// prefix/suffix templates every treasury shares (owners/threshold/nonce live in
// KoRoot's STATE; the treasury's covenant lineage lives in KoVault's).
//
//   pnpm tsx scripts/gen-templates.ts            # verify against current file
//   pnpm tsx scripts/gen-templates.ts --write    # rewrite treasuryTemplates.js
//
// Uses NUMS-padded placeholder owners: the emitted TEMPLATE bytes (prefix/suffix
// outside the state region) are owner-agnostic, which this script asserts by
// checking the proposal template hash stays stable.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fromHex, toHex, deriveTemplate,
  koProposalArgs, koVaultArgs, koRootArgs,
  type CompiledArtifact, type Expr,
} from "../packages/descriptor/src/index.js";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const SILC = resolve(ROOT, ".tooling/silverscript/target/debug/examples/silc");
const OUT = resolve(ROOT, "frontend/src/treasuryTemplates.js");
// The genesis auditor DERIVES a treasury's covenant member — and, from the id that
// member's genesis mints, its vault address — out of these templates, and refuses to
// certify a genesis that does not reproduce them (packages/descriptor/src/genesis.js,
// layers 5 and 7), so it has to carry them too — and so does the indexer,
// which ships as a standalone image and vendors the auditor byte-identically. Both
// mirrors are pinned by tests, but a stale mirror is a security check auditing the
// wrong contracts, so regeneration writes all three at once. A checkout that does
// not contain a mirror (the published repo ships without indexer/) skips it and
// says so, rather than dying on a path it was never meant to have.
const MIRRORS = [
  resolve(ROOT, "packages/descriptor/src/treasuryTemplates.js"),
  resolve(ROOT, "indexer/treasuryTemplates.js"),
];
const tmp = mkdtempSync(join(tmpdir(), "kosign-templates-"));

function compile(silFile: string, ctor: Expr[]): CompiledArtifact {
  const argPath = join(tmp, "ctor.json");
  writeFileSync(argPath, JSON.stringify(ctor));
  const out = execFileSync(SILC, [resolve(ROOT, "contracts", silFile), argPath], { encoding: "utf8", maxBuffer: 64 << 20 });
  return JSON.parse(out) as CompiledArtifact;
}

// Placeholder owners — the NUMS point ×5 (state-only; not part of the template)
const NUMS = fromHex("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0");
const owners = [NUMS, NUMS, NUMS, NUMS, NUMS];
const zero32 = new Uint8Array(32);
// Production caps — this file is the one place they are set.
const maxProposalFee = 10_000_000;
const maxExecutionFee = 10_000_000;
const maxDepositInputs = 16;
const depositMaxFee = 10_000_000; // ctor arg kept for layout compat; deposit() no longer spends it

const proposalArtifact = compile("KoProposal.sil", koProposalArgs({
  owners, threshold: 1, ownerCount: 1, treasuryId: zero32,
  initProposalId: 0, initOperation: 1, initRecipientSpkHash: zero32,
  initAmount: 1, initMaxFee: 0, initExpiresAt: 0, initExecutionDelay: 0,
  initApprovalBitmap: new Uint8Array(8), initApprovalCount: 0, initStatus: 0,
}));
const tpl = deriveTemplate(proposalArtifact);

// The vault is compiled with a PLACEHOLDER lineage: the real covenant id does not
// exist until the genesis transaction that mints KoRoot does. Only the template
// (prefix/suffix around the state slot) is invariant, and that is all anyone needs
// — KoRoot.bootstrapVault stamps the real id in, and the browser rebuilds any
// treasury's vault redeem as prefix ‖ push(lineage) ‖ suffix.
const vaultArtifact = compile("KoVault.sil", koVaultArgs({
  lineage: zero32, proposalTemplate: tpl, maxExecutionFee, maxDepositInputs, depositMaxFee,
}));
const vaultTpl = deriveTemplate(vaultArtifact);

const rootArtifact = compile("KoRoot.sil", koRootArgs({
  owners, threshold: 1, ownerCount: 1, treasuryId: zero32, proposalTemplate: tpl,
  vaultTemplateHash: vaultTpl.templateHash, maxProposalFee, initProposalNonce: 0,
}));

const rootHex = toHex(Uint8Array.from(rootArtifact.script));
const rootLayout = rootArtifact.state_layout as { start: number; len: number };
const propHex = toHex(Uint8Array.from(proposalArtifact.script));
const propLayout = proposalArtifact.state_layout as { start: number; len: number };
const vaultHex = toHex(Uint8Array.from(vaultArtifact.script));
const vaultLayout = vaultArtifact.state_layout as { start: number; len: number };

const templates = {
  root: {
    prefix: rootHex.slice(0, rootLayout.start * 2),
    suffix: rootHex.slice((rootLayout.start + rootLayout.len) * 2),
    stateStart: rootLayout.start, stateLen: rootLayout.len,
  },
  proposal: {
    prefix: propHex.slice(0, propLayout.start * 2),
    suffix: propHex.slice((propLayout.start + propLayout.len) * 2),
    stateStart: propLayout.start, stateLen: propLayout.len,
  },
  vault: {
    prefix: vaultHex.slice(0, vaultLayout.start * 2),
    suffix: vaultHex.slice((vaultLayout.start + vaultLayout.len) * 2),
    stateStart: vaultLayout.start, stateLen: vaultLayout.len,
  },
  proposalTemplateHash: toHex(tpl.templateHash),
  vaultTemplateHash: toHex(vaultTpl.templateHash),
  network: "testnet-10",
};

// compare against the current file
const current = readFileSync(OUT, "utf8");
const curVault = current.match(/vaultTemplateHash:\s*"([0-9a-f]+)"/)?.[1];
const curHash = current.match(/proposalTemplateHash:\s*"([0-9a-f]+)"/)?.[1];
console.log(`proposal template hash : ${templates.proposalTemplateHash} ${templates.proposalTemplateHash === curHash ? "(matches current)" : "(DIFFERS from current!)"}`);
console.log(`vault template hash    : ${templates.vaultTemplateHash} ${templates.vaultTemplateHash === curVault ? "(matches current)" : "(DIFFERS from current)"}`);
console.log(`vault prefix/suffix    : ${templates.vault.prefix.length / 2}/${templates.vault.suffix.length / 2} bytes, state @${templates.vault.stateStart}+${templates.vault.stateLen}`);
console.log(`root prefix/suffix     : ${templates.root.prefix.length / 2}/${templates.root.suffix.length / 2} bytes, state @${templates.root.stateStart}+${templates.root.stateLen}`);
console.log(`proposal prefix/suffix : ${templates.proposal.prefix.length / 2}/${templates.proposal.suffix.length / 2} bytes, state @${templates.proposal.stateStart}+${templates.proposal.stateLen}`);

if (process.argv.includes("--write")) {
  const body = `// AUTO-GENERATED constant covenant templates (do not hand-edit; see scripts/gen-templates.ts).
// The treasury contracts' script LOGIC is owner/threshold/lineage-agnostic — owners,
// threshold and nonce live in KoRoot's UTXO STATE, and the treasury's covenant lineage
// lives in KoVault's. So every treasury (fixed fee params: 0.1 KAS caps, 16 deposit
// inputs) shares these exact prefix/suffix bytes. The browser rebuilds a recovered
// treasury's redeem scripts from these + the chain-recovered owners/threshold/nonce and
// the lineage its genesis mints — NO silc needed to OPERATE. Regenerate if the
// contracts or fee params change.
export const TEMPLATES = ${JSON.stringify(templates, null, 2).replace(/"([a-zA-Z][a-zA-Z0-9]*)":/g, "$1:")};
`;
  writeFileSync(OUT, body);
  console.log(`wrote ${OUT}`);
  for (const m of MIRRORS) {
    if (!existsSync(dirname(m))) { console.log(`skipped ${m} (mirror) — not part of this checkout`); continue; }
    writeFileSync(m, body);
    console.log(`wrote ${m} (mirror)`);
  }
} else {
  for (const m of MIRRORS) {
    if (!existsSync(m)) { console.log(`  (no ${m} in this checkout — nothing to compare)`); continue; }
    if (readFileSync(m, "utf8") !== current) {
      console.error(`  DRIFT: ${m} is not byte-identical to ${OUT} — rerun with --write`);
      process.exitCode = 1;
    }
  }
}
