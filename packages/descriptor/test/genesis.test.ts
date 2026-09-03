// Genesis provenance audit — the client-side defence against a forged genesis
// covenant group (see src/genesis.js for the attack).
//
// The fixtures are the REAL TN10 genesis of treasury 8ff0e529…48e0, captured from
// both sources the app reads: the REST indexer (api-tn10.kaspa.org) and a public
// node's JSON wRPC getBlock. They pin the covenant-id derivation and the KoRoot
// re-derivation to chain bytes nobody in this repo controls.
//
// That transaction predates the stateful vault, so it has the two-member shape
// (root + vault + change). An honest genesis now binds ONE output — a covenant id
// hashes the scriptPubKeys of its own group, so a vault built around the id cannot
// sit inside it. The honest cases below are therefore re-minted from the fixture:
// same funding outpoint, same inscription, same change, one covenant member.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  auditGenesis, normalizeRestGenesisTx, normalizeRpcGenesisTx, computeCovenantId,
  scriptKind, GENESIS_AUDIT_VERSION, decodeInscription, deriveGenesisMembers,
  deriveVaultFromLineage, rebuildRootRedeem, rebuildVaultRedeem, hashScriptHex,
  p2shScriptHash, ROOT_OUTPUT_INDEX, CHANGE_OUTPUT_INDEX, MAX_GENESIS_OUTPUTS,
} from "../src/genesis.js";
import { blake2b256Keyed } from "../src/hash.js";
import { TEMPLATES } from "../src/treasuryTemplates.js";
import { rebuildRoot, rebuildVault } from "../../../frontend/src/treasuryRebuild.js";

const fx = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));

const REST = fx("tn10-genesis-rest.json");
const RPC = fx("tn10-genesis-rpc.json");
// …and the covenant templates of the build that MINTED it (commit 470be03). The
// contracts move; this treasury does not. Pinning them lets the member-identity
// derivation be proved against real on-chain script hashes forever.
const MINTING_BUILD = fx("tn10-build-470be03-templates.json");

const ROOT = "kaspatest:prlv9xvzgxdsd5cs9aac4gzkxf9swh243zpztwsnq3f8fwdhwj0exggfnzqxk";
const TREASURY_ID = "8ff0e529655e0a5b6090c8e4d906fd85376d94b37ee90aac1b2a531f6bcd48e0";
const FUNDING_OUTPOINT = { txid: "be6288e9c53947279abeef00afd3029c0835ea052e8eed53512b98cb608117a5", index: 1 };

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const hex = { p2pk: `20${"ab".repeat(32)}ac` };

// The attacker's pre-approved KoProposal: the REAL published proposal template, so it
// is P2SH and is exactly what KoVault.executeProposal accepts as a proposal input.
const FORGED_P2SH = `aa20${hashScriptHex(TEMPLATES.proposal.prefix + "00".repeat(TEMPLATES.proposal.stateLen) + TEMPLATES.proposal.suffix)}87`;

// ── the honest genesis, under the build under test ─────────────────────────────
// The fixture's own outputs are the minting build's, so re-derive this build's
// KoRoot from the SAME inscription and pay it from the SAME funding outpoint, with
// the fixture's real change output behind it. Everything an attacker controls is
// unchanged; only the single covenant member is this build's.
const ROOT_VALUE = 30_000_000;
const CHANGE_OUT = REST.outputs[2]; // real, unbound P2PK change back to the funder
const CHANGE_ADDRESS: string = CHANGE_OUT.script_public_key_address;

const INS = decodeInscription(REST.payload)!;
const MEMBERS = deriveGenesisMembers(INS);

/** The covenant id an honest genesis mints: one member, the KoRoot at output 0. */
const LINEAGE = computeCovenantId(FUNDING_OUTPOINT, [
  { index: ROOT_OUTPUT_INDEX, value: ROOT_VALUE, spkVersion: 0, spkHex: MEMBERS.rootSpkHex },
]);
/** …and therefore the one vault address that lineage can ever transact at. */
const VAULT = deriveVaultFromLineage(LINEAGE);

// The inscription's 32-byte slot carries the lineage, so a recoverer can recompute
// it from the transaction and rebuild the vault address from the chain alone.
const inscribe = (lineageHex: string): string => REST.payload.slice(0, 16) + lineageHex + REST.payload.slice(80);

const honestRest = () => {
  const t = clone(REST);
  t.payload = inscribe(LINEAGE);
  t.outputs = [
    {
      ...clone(REST.outputs[0]),
      amount: ROOT_VALUE,
      script_public_key: MEMBERS.rootSpkHex,
      // this build's KoRoot is not the script the fixture paid, so the fixture's
      // address label would be a different contract's — say nothing rather than lie
      script_public_key_address: null,
      covenant_authorizing_input: 0,
      covenant_id: LINEAGE,
    },
    { ...clone(CHANGE_OUT), index: CHANGE_OUTPUT_INDEX },
  ];
  return t;
};

const honestRpc = () => {
  const t = clone(RPC);
  t.payload = inscribe(LINEAGE);
  t.outputs = [
    {
      covenant: { authorizingInput: 0, covenantId: LINEAGE },
      scriptPublicKey: `0000${MEMBERS.rootSpkHex}`,
      value: ROOT_VALUE,
      verboseData: null,
    },
    clone(RPC.outputs[2]),
  ];
  return t;
};

describe("covenant id derivation (consensus/core/src/hashing/covenant_id.rs)", () => {
  it("reproduces a live TN10 covenant id from its genesis", () => {
    // Ground truth for the hasher: this outpoint, these outputs and this id are on
    // chain. The group has two members because that treasury was minted before the
    // vault became stateful — the derivation is the same either way.
    const id = computeCovenantId(
      FUNDING_OUTPOINT,
      [
        { index: 0, value: 30_000_000, spkVersion: 0, spkHex: REST.outputs[0].script_public_key },
        { index: 1, value: 30_000_000, spkVersion: 0, spkHex: REST.outputs[1].script_public_key },
      ],
      blake2b256Keyed,
    );
    expect(id).toBe(TREASURY_ID);
  });

  it("commits to the SIZE of the group — the whole reason the attack is detectable", () => {
    const one = [{ index: 0, value: ROOT_VALUE, spkVersion: 0, spkHex: MEMBERS.rootSpkHex }];
    const two = [...one, { index: 1, value: 50_000_000, spkVersion: 0, spkHex: FORGED_P2SH }];
    expect(computeCovenantId(FUNDING_OUTPOINT, one, blake2b256Keyed)).toBe(LINEAGE);
    expect(computeCovenantId(FUNDING_OUTPOINT, two, blake2b256Keyed)).not.toBe(LINEAGE);
  });
});

describe("scriptKind classifies by bytes, not by the source's label", () => {
  it("recognises the three scripts a Ko-sign genesis can pay", () => {
    expect(scriptKind(REST.outputs[0].script_public_key)).toBe("p2sh");
    expect(scriptKind(REST.outputs[2].script_public_key)).toBe("p2pk");
    expect(scriptKind(`21${"cd".repeat(33)}ab`)).toBe("p2pk-ecdsa");
    expect(scriptKind("6a")).toBe("other");
  });
});

// ── the load-bearing layer ────────────────────────────────────────────────────
// A vault address is a pure function of the covenant id its genesis mints, and the
// vault refuses to release or absorb funds under any other lineage. So an auditor
// does not look for the vault in the genesis — he DERIVES it, and a transaction
// that derives a different address was never that vault's genesis.
describe("a vault address is derived from its lineage, never observed", () => {
  it("is the state splice the app itself spends: prefix ‖ push32 ‖ lineage ‖ suffix", () => {
    const redeem = rebuildVaultRedeem(LINEAGE);
    expect(redeem).toBe(TEMPLATES.vault.prefix + "20" + LINEAGE + TEMPLATES.vault.suffix);
    expect(redeem.slice(TEMPLATES.vault.stateStart * 2, (TEMPLATES.vault.stateStart + TEMPLATES.vault.stateLen) * 2))
      .toBe("20" + LINEAGE);
    // …and the address is that script's P2SH commitment, nothing else
    expect(VAULT.vaultRedeem).toBe(redeem);
    expect(VAULT.vaultHash).toBe(hashScriptHex(redeem));
    expect(VAULT.vaultSpkHex).toBe(`aa20${VAULT.vaultHash}87`);
    expect(p2shScriptHash(VAULT.vaultSpkHex)).toBe(VAULT.vaultHash);
  });

  it("is a bijection — one lineage, one address, and no second lineage reaches it", () => {
    // Two genesis transactions differing in nothing but their funding outpoint mint
    // different ids, so they cannot land on the same vault. If they could, the
    // planted-covenant attack the lineage exists to stop would be back.
    const other = computeCovenantId({ txid: FUNDING_OUTPOINT.txid, index: FUNDING_OUTPOINT.index + 1 }, [
      { index: ROOT_OUTPUT_INDEX, value: ROOT_VALUE, spkVersion: 0, spkHex: MEMBERS.rootSpkHex },
    ]);
    expect(other).not.toBe(LINEAGE);
    expect(deriveVaultFromLineage(other).vaultHash).not.toBe(VAULT.vaultHash);
    // deterministic in the other direction: the same lineage always rebuilds the
    // same address, or a recovered treasury would be unspendable
    expect(deriveVaultFromLineage(LINEAGE).vaultHash).toBe(VAULT.vaultHash);
    expect(deriveVaultFromLineage(TREASURY_ID).vaultHash).not.toBe(VAULT.vaultHash);
  });

  it("refuses to derive an address from anything that is not a 32-byte id", () => {
    expect(() => rebuildVaultRedeem("")).toThrow(/32-byte hex covenant id/);
    expect(() => rebuildVaultRedeem("ab".repeat(31))).toThrow(/32-byte hex covenant id/);
    expect(() => rebuildVaultRedeem("zz".repeat(32))).toThrow(/32-byte hex covenant id/);
  });

  it("derives byte-for-byte what the app itself rebuilds (no second implementation)", () => {
    // treasuryRebuild.js is what the browser uses to OPERATE a treasury. If the audit
    // certified one script and the app then spent another, the audit would be
    // certifying a contract nobody runs.
    const owners5 = [...INS.owners];
    while (owners5.length < 5) owners5.push("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0");
    expect(rebuildRootRedeem(0, INS.threshold, INS.ownerCount, owners5))
      .toBe(rebuildRoot(0, INS.threshold, INS.ownerCount, owners5));
    expect(rebuildVaultRedeem(LINEAGE)).toBe(rebuildVault(LINEAGE));
  });
});

describe("a stranger's covenant parked at the vault address cannot indict the genesis", () => {
  // Consensus lets anyone create an output at any address, so a stranger can park a
  // covenant of his own making at a treasury's published deposit address for the
  // price of the dust — confirmed on chain, not assumed. KoVault already denies him
  // the money. What is left to protect is the treasury's NAME: a caller that scans
  // the address and reports the first covenant id it finds would hand the auditor a
  // foreign id, and refusing on that brands an honest treasury as forged, in public
  // and for good.
  const FOREIGN = "ee".repeat(32);

  it("stays CLEAN when a foreign id is reported but the address derives from this genesis", () => {
    const v = auditGenesis(normalizeRestGenesisTx(honestRest()), {
      vaultScriptHash: VAULT.vaultHash,
      treasuryId: FOREIGN,
    });
    expect(v.ok).toBe(true);
    expect(v.verdict).toBe("clean");
    expect(v.code).toBe(null);
    expect(v.treasuryId).toBe(LINEAGE);
    // and it is SAID, not silently swallowed
    const note = v.checks.find((c) => c.id === "independent-covenant-id");
    expect(note?.state).toBe("pass");
    expect(note?.note).toContain("nobody can ever spend it");
  });

  it("still REFUSES a contradicting id when the address could NOT be derived", () => {
    // Without the derivation the contradiction is the only evidence there is, so it
    // has to keep counting — the fix narrows the rule, it does not delete it.
    const v = auditGenesis(normalizeRestGenesisTx(honestRest()), { treasuryId: FOREIGN });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("treasury-id-mismatch");
  });

  it("counts a MATCHING independent id as corroboration", () => {
    const v = auditGenesis(normalizeRestGenesisTx(honestRest()), {
      vaultScriptHash: VAULT.vaultHash,
      treasuryId: LINEAGE,
    });
    expect(v.ok).toBe(true);
    expect(v.independentId).toBe(true);
    expect(v.checks.find((c) => c.id === "independent-covenant-id")?.state).toBe("pass");
  });
});

describe("an honest genesis passes from either source", () => {
  it("REST — clean and cryptographic with no independent node at all", () => {
    // The address the user typed IS the second opinion: only one lineage derives it,
    // and only one transaction mints that lineage. Nothing else had to be fetched.
    const v = auditGenesis(normalizeRestGenesisTx(honestRest()), { vaultScriptHash: VAULT.vaultHash });
    expect(v.verdict).toBe("clean");
    expect(v.ok).toBe(true);
    expect(v.identified).toBe(true);
    expect(v.independentId).toBe(false);
    expect(v.cryptographic).toBe(true);
    expect(v.treasuryId).toBe(LINEAGE);
    expect(v.changeAddress).toBe(CHANGE_ADDRESS);
    expect(v.genesisTxid).toBe(REST.transaction_id);
    expect(v.version).toBe(GENESIS_AUDIT_VERSION);
    expect(v.checks.find((c) => c.id === "vault-derivation")?.state).toBe("pass");
    expect(v.reason).toMatch(/derives exactly the vault address being opened/);
  });

  it("JSON wRPC (version-prefixed scriptPublicKey, nested covenant object)", () => {
    const v = auditGenesis(normalizeRpcGenesisTx(honestRpc()), { vaultScriptHash: VAULT.vaultHash });
    expect(v.verdict).toBe("clean");
    expect(v.cryptographic).toBe(true);
    expect(v.treasuryId).toBe(LINEAGE);
  });

  it("both sources normalize to the same covenant facts", () => {
    const a = normalizeRestGenesisTx(honestRest());
    const b = normalizeRpcGenesisTx(honestRpc());
    expect(b.outputs.map((o) => o.spkHex)).toEqual(a.outputs.map((o) => o.spkHex));
    expect(b.outputs.map((o) => o.covenantId)).toEqual(a.outputs.map((o) => o.covenantId));
    expect(b.outputs.map((o) => o.value)).toEqual(a.outputs.map((o) => o.value));
    expect(b.inputs[0]).toEqual(a.inputs[0]);
  });

  it("accepts a genesis with no change output (folded into the fee)", () => {
    const t = honestRest();
    t.outputs = t.outputs.slice(0, 1);
    const v = auditGenesis(normalizeRestGenesisTx(t), { vaultScriptHash: VAULT.vaultHash });
    expect(v.verdict).toBe("clean");
    expect(v.cryptographic).toBe(true);
    expect(v.changeAddress).toBe(null);
  });

  it("carries the lineage in the inscription, so recovery needs nothing but the tx", () => {
    // The 32-byte inscription slot is a CLAIM, and a checkable one: recompute the id
    // from the transaction and compare. That is how a recoverer rebuilds the vault
    // address with no index and no backend.
    const t = honestRest();
    const ins = decodeInscription(t.payload)!;
    const recomputed = computeCovenantId(FUNDING_OUTPOINT, [
      { index: ROOT_OUTPUT_INDEX, value: t.outputs[0].amount, spkVersion: 0, spkHex: t.outputs[0].script_public_key },
    ]);
    expect(ins.lineage).toBe(recomputed);
    expect(deriveVaultFromLineage(ins.lineage).vaultHash).toBe(VAULT.vaultHash);
  });
});

describe("SECURITY: the genesis must be THIS vault's genesis", () => {
  it("refuses an honest genesis that derives a different vault than the one being opened", () => {
    // Nothing is wrong with this transaction. It simply is not the genesis of the
    // address holding the money, which is the only question that matters.
    const v = auditGenesis(normalizeRestGenesisTx(honestRest()), {
      vaultScriptHash: deriveVaultFromLineage(TREASURY_ID).vaultHash,
    });
    expect(v.ok).toBe(false);
    expect(v.verdict).toBe("refused");
    expect(v.code).toBe("vault-not-from-this-genesis");
    expect(v.cryptographic).toBe(false);
    expect(v.reason).toMatch(/accepts no other/);
  });

  it("catches a hidden second covenant member with no independent id at all", () => {
    // THE bypass, and the reason the derivation layer exists. The attacker's genesis
    // really bound a forged pre-approved KoProposal alongside the root, so the vault
    // he hands the victim carries the TWO-member lineage. His indexer then serves a
    // one-member transaction whose every structural check passes and whose reported
    // id matches its own outputs. Under a salted vault only a second opinion about
    // the treasury id could see this. Now the victim's own address does: the visible
    // transaction derives a different vault.
    const forgedLineage = computeCovenantId(FUNDING_OUTPOINT, [
      { index: 0, value: ROOT_VALUE, spkVersion: 0, spkHex: MEMBERS.rootSpkHex },
      { index: 1, value: 50_000_000, spkVersion: 0, spkHex: FORGED_P2SH },
    ]);
    const victimsVault = deriveVaultFromLineage(forgedLineage).vaultHash;
    const v = auditGenesis(normalizeRestGenesisTx(honestRest()), { vaultScriptHash: victimsVault });
    expect(v.verdict).toBe("refused");
    expect(v.code).toBe("vault-not-from-this-genesis");
  });

  it("refuses a genesis that binds a SECOND output into the covenant", () => {
    // The extra member is a contract the creator smuggled into the treasury's
    // covenant domain, and KoVault cannot tell a smuggled proposal from a real one.
    const t = honestRest();
    const forgedLineage = computeCovenantId(FUNDING_OUTPOINT, [
      { index: 0, value: ROOT_VALUE, spkVersion: 0, spkHex: MEMBERS.rootSpkHex },
      { index: 1, value: 50_000_000, spkVersion: 0, spkHex: FORGED_P2SH },
    ]);
    t.outputs[0].covenant_id = forgedLineage;
    t.outputs[1] = {
      index: 1, amount: 50_000_000, script_public_key: FORGED_P2SH,
      script_public_key_address: "kaspatest:pforgedproposal", script_public_key_type: "scripthash",
      covenant_authorizing_input: 0, covenant_id: forgedLineage,
    };
    const v = auditGenesis(normalizeRestGenesisTx(t), {
      vaultScriptHash: deriveVaultFromLineage(forgedLineage).vaultHash,
    });
    expect(v.ok).toBe(false);
    expect(v.verdict).toBe("refused");
    expect(v.code).toBe("bad-covenant-group");
    expect(v.reason).toMatch(/binds exactly output 0/);
  });

  it("refuses a second bound output even when it is disguised as a payment", () => {
    // not P2SH, so only the binding set (or the recomputation) can see it
    const t = honestRest();
    t.outputs[1].covenant_id = LINEAGE;
    t.outputs[1].covenant_authorizing_input = 0;
    expect(auditGenesis(normalizeRestGenesisTx(t), { vaultScriptHash: VAULT.vaultHash }).code)
      .toBe("bad-covenant-group");
  });

  it("refuses a second bound output the source HIDES, via the recomputation", () => {
    // The source reports output 1 as unbound change and hands back the two-member id
    // it claims the treasury carries. The recomputation over {output 0} cannot match.
    const t = honestRest();
    const forgedLineage = computeCovenantId(FUNDING_OUTPOINT, [
      { index: 0, value: ROOT_VALUE, spkVersion: 0, spkHex: MEMBERS.rootSpkHex },
      { index: 1, value: CHANGE_OUT.amount, spkVersion: 0, spkHex: CHANGE_OUT.script_public_key },
    ]);
    t.outputs[0].covenant_id = forgedLineage;
    const v = auditGenesis(normalizeRestGenesisTx(t), { vaultScriptHash: VAULT.vaultHash });
    expect(v.verdict).toBe("refused");
    expect(v.code).toBe("covenant-id-mismatch");
    expect(v.reason).toMatch(/BEYOND output 0/);
  });
});

describe("SECURITY: output 0 must BE this treasury's KoRoot", () => {
  it("re-derives the REAL on-chain KoRoot from the inscription alone", () => {
    // Against chain bytes nobody in this repo controls: the live TN10 genesis paid
    // this P2SH script, and its inscription plus the templates of the build that
    // minted it reproduce the hash exactly. That is what makes the identity check a
    // proof rather than a convention — and it holds however the contracts move.
    const m = deriveGenesisMembers(INS, MINTING_BUILD as typeof TEMPLATES);
    expect(m.rootHash).toBe(p2shScriptHash(REST.outputs[0].script_public_key));
    expect(`aa20${m.rootHash}87`).toBe(m.rootSpkHex);
  });

  it("refuses a one-member covenant whose member is a forged proposal", () => {
    // A genuine one-member group: the binding set, the authorizing input, the group
    // size and the recomputed id are all exactly an honest genesis's. Only identity
    // separates it from a real treasury — and no proposal hashes to the KoRoot the
    // inscription derives.
    const t = honestRest();
    const forgedLineage = computeCovenantId(FUNDING_OUTPOINT, [
      { index: 0, value: ROOT_VALUE, spkVersion: 0, spkHex: FORGED_P2SH },
    ]);
    t.outputs[0].script_public_key = FORGED_P2SH;
    t.outputs[0].covenant_id = forgedLineage;
    const v = auditGenesis(normalizeRestGenesisTx(t), {
      vaultScriptHash: deriveVaultFromLineage(forgedLineage).vaultHash,
      treasuryId: forgedLineage,
    });
    expect(v.verdict).toBe("refused");
    expect(v.code).toBe("not-this-build");
    expect(v.identified).toBe(false);
    expect(v.cryptographic).toBe(false);
  });

  it("refuses when the inscribed owners are not the ones the root commits to", () => {
    // The creator writes the inscription, so he can claim any policy he likes — but
    // the KoRoot address commits to the policy it actually enforces, and a claim that
    // does not reproduce that address is a claim about a different contract.
    const t = honestRest();
    t.payload = t.payload.slice(0, 12) + "0101" + t.payload.slice(16, 80) + "7".repeat(64);
    const v = auditGenesis(normalizeRestGenesisTx(t), { vaultScriptHash: VAULT.vaultHash });
    expect(v.verdict).toBe("refused");
    expect(v.code).toBe("not-this-build");
  });

  it("refuses a genesis with no decodable inscription", () => {
    const t = honestRest();
    t.payload = "4b4f53474e"; // the KOSGN magic alone
    const v = auditGenesis(normalizeRestGenesisTx(t), { vaultScriptHash: VAULT.vaultHash });
    expect(v.verdict).toBe("refused");
    expect(v.code).toBe("genesis-not-inscribed");
  });

  it("refuses, rather than certifies, a genesis this build cannot reconstruct", () => {
    // A treasury minted by a different build of the contracts. Not evidence of an
    // attack — but this build cannot say what governs that money, and "I cannot tell"
    // must never render as "verified". (scripts/treasury-version.mjs is the tool that
    // says WHICH build; the audit only says "not this one".)
    const stale = deriveGenesisMembers(INS, MINTING_BUILD as typeof TEMPLATES);
    const staleLineage = computeCovenantId(FUNDING_OUTPOINT, [
      { index: 0, value: ROOT_VALUE, spkVersion: 0, spkHex: stale.rootSpkHex },
    ]);
    const t = honestRest();
    t.outputs[0].script_public_key = stale.rootSpkHex;
    t.outputs[0].script_public_key_address = ROOT;
    t.outputs[0].covenant_id = staleLineage;
    const v = auditGenesis(normalizeRestGenesisTx(t), {
      vaultScriptHash: deriveVaultFromLineage(staleLineage).vaultHash,
    });
    if (stale.rootHash === MEMBERS.rootHash) {
      expect(v.verdict).toBe("clean"); // this build IS the one that minted it
    } else {
      expect(v.verdict).toBe("refused");
      expect(v.code).toBe("not-this-build");
      expect(v.ok).toBe(false);
    }
  });
});

describe("SECURITY: other malformed genesis shapes", () => {
  it("refuses a third output outright", () => {
    const t = honestRest();
    t.outputs.push({ index: 2, amount: 1000, script_public_key: hex.p2pk, script_public_key_address: "kaspatest:qx", covenant_id: null, covenant_authorizing_input: null });
    const v = auditGenesis(normalizeRestGenesisTx(t), { vaultScriptHash: VAULT.vaultHash });
    expect(v.code).toBe("extra-outputs");
    expect(v.reason).toMatch(new RegExp(`at most ${MAX_GENESIS_OUTPUTS}`));
  });

  it("refuses a genesis with no outputs at all", () => {
    const t = honestRest();
    t.outputs = [];
    expect(auditGenesis(normalizeRestGenesisTx(t), { vaultScriptHash: VAULT.vaultHash }).code).toBe("too-few-outputs");
  });

  it("refuses when output 0 is not a script at all", () => {
    const t = honestRest();
    t.outputs[0].script_public_key = hex.p2pk;
    expect(auditGenesis(normalizeRestGenesisTx(t), { vaultScriptHash: VAULT.vaultHash }).code).toBe("root-not-p2sh");
  });

  it("refuses change that is itself a script — that is how a forgery gets in", () => {
    const t = honestRest();
    t.outputs[1].script_public_key = FORGED_P2SH;
    expect(auditGenesis(normalizeRestGenesisTx(t), { vaultScriptHash: VAULT.vaultHash }).code).toBe("extra-p2sh-output");
  });

  it("refuses change that is neither a wallet payment nor recognisable", () => {
    const t = honestRest();
    t.outputs[1].script_public_key = "6a";
    expect(auditGenesis(normalizeRestGenesisTx(t), { vaultScriptHash: VAULT.vaultHash }).code).toBe("change-not-wallet");
  });

  it("refuses covenant-bound change even from a source that hides the binding fields", () => {
    // Only half the pair is reported, so the group check has nothing to look at —
    // change must still be plain, unbound value.
    const t = honestRest();
    delete t.outputs[0].covenant_id;
    delete t.outputs[0].covenant_authorizing_input;
    delete t.outputs[1].covenant_authorizing_input;
    t.outputs[1].covenant_id = LINEAGE;
    expect(auditGenesis(normalizeRestGenesisTx(t), { vaultScriptHash: VAULT.vaultHash }).code).toBe("change-covenant-bound");
  });

  it("refuses a genesis that minted nothing", () => {
    const t = honestRest();
    t.outputs[0].covenant_id = "0".repeat(64);
    expect(auditGenesis(normalizeRestGenesisTx(t), { vaultScriptHash: VAULT.vaultHash }).code).toBe("covenant-id-split");
  });

  it("refuses a covenant authorized by an input other than 0", () => {
    const t = honestRest();
    t.outputs[0].covenant_authorizing_input = 1;
    expect(auditGenesis(normalizeRestGenesisTx(t), { vaultScriptHash: VAULT.vaultHash }).code).toBe("bad-authorizing-input");
  });

  it("does NOT refuse on an independently observed id once the address has settled the lineage", () => {
    // This rule used to be a refusal outright, and that was a weapon: anyone can put
    // an output at any address, so a stranger's parked covenant would have refused
    // an honest treasury. Once the address itself derives from the genesis there is
    // nothing left for a foreign id to contradict. The narrowed rule still bites
    // where the derivation cannot run — see "a stranger's covenant parked at the
    // vault address cannot indict the genesis".
    const v = auditGenesis(normalizeRestGenesisTx(honestRest()), {
      vaultScriptHash: VAULT.vaultHash, treasuryId: "b".repeat(64),
    });
    expect(v.ok).toBe(true);
    expect(v.code).toBe(null);
    expect(v.treasuryId).toBe(LINEAGE);
  });
});

describe("what the audit will not claim", () => {
  it("is clean but NOT cryptographic when the caller names no vault", () => {
    // Structurally sound, member identified — but nothing ties the transaction to
    // any money, so the strong verdict is withheld.
    const v = auditGenesis(normalizeRestGenesisTx(honestRest()), {});
    expect(v.verdict).toBe("clean");
    expect(v.identified).toBe(true);
    expect(v.cryptographic).toBe(false);
    expect(v.reason).toMatch(/nothing yet ties this transaction to the money/);
    expect(v.checks.find((c) => c.id === "vault-derivation")?.state).toBe("skip");
  });

  it("will not call a genesis clean for an address it could not tie it to", () => {
    // Round 5. This asserted verdict "clean" — for the HONEST genesis of this very
    // vault, where clean is harmless. On that path the danger cannot arise, so the
    // test could not see it; the next one substitutes an unrelated genesis and it
    // is the same input to this function.
    const t = honestRest();
    t.inputs = [];
    const v = auditGenesis(normalizeRestGenesisTx(t), { vaultScriptHash: VAULT.vaultHash });
    expect(v.verdict).toBe("unverified");
    expect(v.code).toBe("vault-binding-unestablished");
    expect(v.cryptographic).toBe(false);
    expect(v.checks.find((c) => c.id === "covenant-id-recompute")?.state).toBe("skip");
    expect(v.checks.find((c) => c.id === "vault-derivation")?.state).toBe("skip");
  });

  it("SECURITY: withholding the funding outpoint cannot turn a refusal into a pass", () => {
    // The whole attack in three lines. One genesis, one unrelated vault. Reported
    // in full it is REFUSED — the id it mints derives a different address. Report
    // it with the funding outpoint withheld and every check that could object is
    // skipped: the id cannot be recomputed, so the address cannot be derived from
    // it, and (in the browser) the node's own reading is filtered by that same
    // absent lineage and corroborates nothing.
    //
    // The field is not exotic or optional. Locating the genesis at all already
    // required previous_outpoint_hash on the mint transaction, from the same
    // endpoint. A source that supplies it once supplies it twice — supplying it
    // for the mint and withholding it for the genesis is an asymmetry no honest
    // indexer produces, and it used to buy a clean verdict.
    const other = deriveVaultFromLineage("cd".repeat(32)).vaultHash;

    const reported = auditGenesis(normalizeRestGenesisTx(honestRest()), { vaultScriptHash: other });
    expect(reported.verdict).toBe("refused");
    expect(reported.code).toBe("vault-not-from-this-genesis");

    const t = honestRest();
    t.inputs = [];
    const withheld = auditGenesis(normalizeRestGenesisTx(t), { vaultScriptHash: other });
    expect(withheld.verdict).not.toBe("clean");
  });

  it("still reaches cryptographic from a source too old to report bindings", () => {
    // The recomputation and the derivation need only the outpoint and the outputs.
    const t = honestRest();
    for (const o of t.outputs) { delete o.covenant_id; delete o.covenant_authorizing_input; }
    const v = auditGenesis(normalizeRestGenesisTx(t), { vaultScriptHash: VAULT.vaultHash });
    expect(v.verdict).toBe("clean");
    expect(v.cryptographic).toBe(true);
    expect(v.checks.find((c) => c.id === "covenant-group")?.state).toBe("skip");
  });

  it("returns 'unverified' when nothing can pin the covenant group", () => {
    const t = honestRest();
    t.inputs = [];
    for (const o of t.outputs) { delete o.covenant_id; delete o.covenant_authorizing_input; }
    const v = auditGenesis(normalizeRestGenesisTx(t), { vaultScriptHash: VAULT.vaultHash });
    expect(v.ok).toBe(false);
    expect(v.verdict).toBe("unverified");
    expect(v.code).toBe("unverifiable");
  });
});

describe("the templates the audit derives from cannot go stale", () => {
  it("packages/descriptor/src/treasuryTemplates.js is byte-identical to the frontend's", () => {
    // One build, one set of covenant scripts. If this copy lags, the audit certifies
    // (or refuses) a treasury against contracts the app does not run — a security
    // check pointed at the wrong target. `pnpm tsx scripts/gen-templates.ts --write`
    // regenerates all three copies together; running it without --write reports drift.
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    expect(read("../src/treasuryTemplates.js")).toBe(read("../../../frontend/src/treasuryTemplates.js"));
  });
});
