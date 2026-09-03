// Report which covenant build a live treasury runs — BOTH of its scripts, each
// judged separately.
//
//   node scripts/treasury-version.mjs kaspatest:pq05ne9c…    (the VAULT address)
//
// A treasury is two covenant scripts, not one: KoVault holds the funds, KoRoot
// holds the policy (owners, threshold, proposal nonce) and is the only path to
// creating a proposal — so it is the half that decides who may move money. Both
// are P2SH and a P2SH address IS blake2b(redeemScript), so rebuilding each from
// its on-chain state under THIS build's templates and comparing addresses is a
// cryptographic identity check, not a guess.
//
// It has to be BOTH. This tool used to reconstruct the vault alone and print
// "current" on a match, which was sound only while the two scripts moved
// together. They no longer do: the genesis-bounds change altered KoRoot alone
// (4694 → 4715 bytes) with the vault constant byte-identical, so a treasury
// minted by the previous build reconstructs its vault exactly while its KoRoot
// is still the OLD, unbounded script — precisely the contract that changed. A
// root that cannot be located is reported as UNKNOWN, never folded into a pass.
//
// Exit: 0 = every contract matches this build
//       1 = at least one contract was minted by a different build
//       3 = indeterminate — the chain data needed for a verdict is missing
import { fileURLToPath } from "node:url";

const vault = process.argv[2];
if (!vault) { console.error("usage: node scripts/treasury-version.mjs <vaultAddress>"); process.exit(2); }
const net = vault.startsWith("kaspatest:") ? { id: "testnet-10", rest: "https://api-tn10.kaspa.org", wasm: "testnet" }
          : vault.startsWith("kaspa:")     ? { id: "mainnet",    rest: "https://api.kaspa.org",      wasm: "mainnet" }
          : null;
if (!net) { console.error("  unrecognised address prefix"); process.exit(2); }

// The frontend modules below share ONE network config (frontend/src/network.js),
// which reads the active network from localStorage. Node has none, so they would
// silently fall back to testnet-10 and walk the wrong indexer for a mainnet
// address. Pin it to the network this address names, before importing them.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map([["kosign.network", net.id]]);
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
}

// NUMS point: the dead key every unused owner slot is padded with (wasmTx.js).
const NUMS = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";

const repo = fileURLToPath(new URL("..", import.meta.url));
const W = (await import(`${repo}frontend/test/wasm-loader.mjs`)).default;
// The SAME derivations the browser uses — no second implementation to drift.
const { rebuildRoot, rebuildVault } = await import(`${repo}frontend/src/treasuryRebuild.js`);
const { decodeInscription, fetchGenesisTx } = await import(`${repo}frontend/src/kaspaRest.js`);
const { walkRoot } = await import(`${repo}frontend/src/proposalScan.js`);

const RED = "\x1b[31m", GRN = "\x1b[32m", YEL = "\x1b[33m", DIM = "\x1b[2m", RST = "\x1b[0m";
const p2sh = (hex) => W.p2sh_address(hex, net.wasm);
const rest = async (p) => {
  const r = await fetch(`${net.rest}${p}`);
  if (!r.ok) throw new Error(`REST indexer ${r.status}`);
  return r.json();
};

// ---- 1. genesis + inscription ----------------------------------------------
// The genesis is not in this address's history and cannot be: a covenant id hashes
// the scriptPubKeys of its own genesis group, so the vault — whose state IS that id
// — is minted a transaction later by KoRoot.bootstrapVault. fetchGenesisTx walks
// back through it, and it is the browser's own walk, so this tool reads exactly the
// transaction the app would audit.
let gen;
try { gen = await fetchGenesisTx(vault); }
catch (e) { console.error(`  cannot reach the REST indexer: ${e.message}`); process.exit(3); }
if (!gen) { console.error("  no KOSGN genesis inscription found on-chain for this address"); process.exit(3); }
const rec = decodeInscription(gen.payload);
if (!rec) { console.error("  the genesis payload carries the KOSGN magic but does not decode"); process.exit(3); }
const genesisTxid = gen.transaction_id || gen.hash || null;
const owners5 = [...rec.owners]; while (owners5.length < 5) owners5.push(NUMS);

console.log(`  vault address : ${vault}`);
console.log(`  genesis tx    : ${genesisTxid ?? "(unknown)"}`);
console.log(`  inscription   : KOSGN v${rec.version} — ${rec.threshold}-of-${rec.ownerCount}, lineage ${rec.lineage.slice(0, 8)}…${rec.lineage.slice(-4)}`);
console.log();

// ---- 2. KoVault: the vault template around the inscribed lineage ------------
// The address is p2sh(prefix ‖ push32(lineage) ‖ suffix), so a mismatch means one
// of two things: the inscription lies about the lineage, or KoVault's bytes have
// moved since this treasury was minted. Either way this build cannot say what
// guards the funds sitting there.
const vaultRedeem = rebuildVault(rec.lineage);
const vaultRebuilt = p2sh(vaultRedeem);
const vaultOk = vaultRebuilt === vault;

// ---- 3. KoRoot: genesis output 0 is the root mint ---------------------------
// wasm-tx gen_build() binds output 0 = KoRoot and nothing else (output 1, if
// present, is ordinary unbound change), and the root is minted with the
// inscription's own config at nonce 0 — so rebuildRoot(0, …) is the exact script
// that address commits to.
// This is the same derivation proposalScan.js walkRoot uses at every hop.
const rootOnChain = gen.outputs?.[0]?.script_public_key_address || null;
const rootRedeem = rebuildRoot(0, rec.threshold, rec.ownerCount, owners5);
const rootRebuilt = p2sh(rootRedeem);

// Walk the root forward from genesis (createProposal advances the nonce,
// executeConfig installs new owners) to reach the CURRENT root UTXO. Reuses
// walkRoot verbatim, so what it derives is what the browser derives.
let live = null, walkErr = null;
if (genesisTxid) {
  try {
    ({ live } = await walkRoot({
      genesisTxid, threshold: rec.threshold, ownerCount: rec.ownerCount, owners5,
      p2sh,
      getUtxos: async (addr) => { try { return await rest(`/addresses/${addr}/utxos`); } catch { return []; } },
    }));
  } catch (e) { walkErr = e.message; }
}

// A verdict on the root SCRIPT: the genesis comparison is definitive (its state
// is fully known from the inscription); a successful walk is definitive too, as
// it found the treasury's live outpoint at an address this build derived.
const rootOk = rootOnChain ? rootOnChain === rootRebuilt : (live ? true : null);

// ---- 4. report, per contract ------------------------------------------------
const verdict = (ok, what) => ok === true ? `${GRN}✓ current${RST} — the live ${what} runs this build's script.`
  : ok === false ? `${RED}✗ not this build${RST} — the live ${what} was minted by a different build; its rules are whatever that build compiled.`
  : `${YEL}? unknown${RST} — the live ${what} could not be located on-chain, so this build says NOTHING about it.`;

console.log(`  KoVault  ${DIM}(${vaultRedeem.length / 2} bytes under this build)${RST}`);
console.log(`    on-chain   : ${vault}`);
console.log(`    this build : ${vaultRebuilt}`);
console.log(`    ${verdict(vaultOk, "vault")}`);
console.log();
console.log(`  KoRoot   ${DIM}(${rootRedeem.length / 2} bytes under this build)${RST}`);
console.log(`    on-chain   : ${rootOnChain ?? `${DIM}(genesis output 0 not readable from the indexer)${RST}`}`);
console.log(`    this build : ${rootRebuilt}`);
console.log(`    ${verdict(rootOk, "root")}`);
if (live) console.log(`    ${DIM}live root walked to nonce ${live.nonce}, now ${live.threshold}-of-${live.ownerCount}${RST}`);
else console.log(`    ${YEL}live root not walked${RST} — ${walkErr ? `walk failed: ${walkErr}` : "the indexer did not yield the current root UTXO"}; ${rootOnChain ? "the verdict above rests on genesis alone." : "and genesis output 0 was unreadable, so nothing pins the root."}`);
console.log();

// A definite mismatch outranks a missing answer: report it even if the other
// contract could not be located.
const differ = [vaultOk === false && "KoVault", rootOk === false && "KoRoot"].filter(Boolean);
if (differ.length) {
  console.log(`  ${RED}NOT THIS BUILD${RST} — ${differ.join(" and ")} ${differ.length > 1 ? "were" : "was"} minted by a different build.`);
  process.exit(1);
}
if (rootOk === null) {
  console.log(`  ${YEL}INDETERMINATE${RST} — the vault answered, KoRoot did not. Do not read this as "current".`);
  process.exit(3);
}
console.log(`  ${GRN}CURRENT${RST} — both covenant scripts are this build's.`);
process.exit(0);
