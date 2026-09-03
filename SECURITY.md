# Security Policy

Ko-sign holds funds under Kaspa covenant scripts. The contracts are the security
model — everything else is a client that talks to them — so contract-level
reports get the highest priority.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via **GitHub → Security → "Report a vulnerability"** on
[ko-sign/kosign](https://github.com/ko-sign/kosign/security/advisories/new).
You can expect an acknowledgement within 72 hours.

Please include the affected component, reproduction steps or a proof of concept,
and the impact you believe it has. Testnet PoCs are very welcome — TN10 funds are
free, and a fixture under `contracts/*.test.json` that fails on the current
contract is the clearest possible report.

## Scope

In scope:

- **The covenant contracts** (`contracts/*.sil`) — anything that moves funds
  without a threshold of valid owner signatures, forges a proposal into a foreign
  covenant lineage, mints or re-parents a covenant id, replays an approval, burns
  vault value, or corrupts an owner-set change.
- **Address derivation and templates** (`scripts/gen-templates.ts`,
  `frontend/src/treasuryTemplates.js`, `packages/descriptor`) — anything that
  makes a vault address correspond to rules other than the published source.
- **Transaction building and signing** (`tools/wasm-tx`, `frontend/src/wasm/`,
  `frontend/src/wasmTx.js`, `packages/signer`) — wrong sighashes, signature
  misuse, key exfiltration.
- **Chain-state reconstruction** (`frontend/src/proposalScan.js`,
  `treasuryRebuild.js`, `kaspaRest.js`) — anything that makes a client display a
  proposal, owner set or balance that does not match the chain.
- **The genesis provenance check** (`packages/descriptor/src/genesis.js`,
  `frontend/src/genesisAudit.js`, `indexer/genesisAudit.mjs`) — any genesis that
  binds anything beyond the KoRoot into a treasury's covenant, or whose single
  member is not the KoRoot its own inscription derives, yet passes the audit; and
  any transaction that the audit certifies as the genesis of a vault address it
  does not derive. See "Genesis provenance" below: this check is the only defence
  against that attack, so a way past it is a way to drain a vault.
- **XSS or dependency compromise** that can reach the imported key.

Out of scope (known, documented trade-offs — see `docs/RISKS.md` and the
whitepaper):

- The imported key living unencrypted in `localStorage` *per se* — a concrete
  escalation that steals it is in scope.
- Public visibility of proposals, votes and owner pubkeys — on-chain by design.
- Availability of third-party infrastructure (public nodes, REST indexers).
- The permissionless nature of covenant sweeps — value preservation is enforced
  by contract, and a way to *break* it is very much in scope.
- The 5-owner ceiling — it follows from fixed-size covenant state, not from a
  missing check.

## Genesis provenance

**The property being relied on.** `KoVault.executeProposal` authenticates a
proposal by its template shape and its covenant id, and nothing else. That is
sound only if every member of a treasury's covenant domain was put there by
`KoRoot`. Ko-sign's guarantee therefore rests on an assumption the contracts
cannot check: **the treasury's genesis transaction bound exactly one output into
the covenant — the KoRoot at output 0.**

That assumption is not enforced by consensus. A covenant id is minted by
`populate_genesis_covenants`, whose group is
`{ authorizing_input, outputs: Vec<u32> }` — the spender chooses **which** outputs
join. The forged member is a KoProposal-shaped P2SH whose state its author wrote
himself (`status = Approved`, `snapThreshold = 1`, `owner0 = his key`). It matches
the template, and if it carries a vault's lineage the vault will execute it.

The vault closes this from the outside: its state **is** the treasury's covenant id
and both entrypoints refuse every other lineage, so nobody can bring a covenant of
his own to somebody else's treasury address. What remains is the inside — the
author of a genesis decides what his treasury's lineage IS. Two ways in, needing
different defences:

- **(a)** bind a **second** output — `outputs: vec![0, 1]`, output 1 the forged
  proposal — so the lineage has an extra member from the moment it exists.
- **(b)** bind exactly **one**, where output **0 is the forged proposal** rather
  than a KoRoot. That is a genuine one-member group: right binding set, one id, one
  authorizing input, and the covenant id recomputes correctly *because the group
  really is that output*. The vault it derives is a real vault whose lineage really
  is that id. Nothing about counts or hashes distinguishes it from an honest
  genesis — only **which contract the member is**, and a KoProposal is a P2SH
  exactly like a KoRoot. `executeProposal` needs no KoRoot in the transaction at
  all, so (b) is the cheapest version of the attack, not a corner case.

**Why it cannot be fixed in script.** The entire covenant instruction set is
`OpInputCovenantId`, `OpOutputCovenantId`, `OpCovOutputCount`, `OpCovOutputIdx`,
`OpOutputAuthorizingInput`. None reveals whether an input's covenant binding was
created at genesis or minted by a rule-following spend. A contract sees an id, not
its provenance. Everything *after* genesis is governed — the
`OpCovOutputCount`/`OpCovOutputIdx` guards pinned by `scripts/test-security.sh`
fix the exact number of covenant outputs each path may create — so genesis is the
one moment when covenant membership is decided by a party rather than a script.

**The check.** The genesis transaction is on chain and immutable, so the forgery is
visible to anyone who looks before depositing. Ko-sign looks, in four layers:

1. **Structural** — the genesis must have at most two outputs; output 0 must be
   P2SH; **exactly one** output may carry a covenant binding and it must be output
   0, authorized by input 0; a second output must be an ordinary wallet payment
   (never P2SH, never bound). Script shapes are read from the bytes, never from the
   source's label. Both sources report the bindings (`covenant_id` /
   `covenant_authorizing_input` over REST; `output.covenant` over JSON wRPC).
   Catches (a); cannot see (b).
2. **Covenant id recompute** — `covenant_id` is
   `blake2b-256(key="CovenantID")` over the genesis outpoint and the authorized
   outputs, and it commits to the **count**, so a two-output group cannot produce a
   one-output id. Recomputing it over `{output 0}` catches (a) even when the
   indexer hides the extra output. Cannot see (b) either.
3. **Member identity** — the layer that catches (b), and the only one that can.
   A P2SH script *is* `blake2b-256(redeemScript)`, and the genesis payload carries
   the KOSGN inscription (threshold, ownerCount, owners, covenant lineage). So
   output 0 must equal `p2sh(KoRoot at nonce 0 for that policy)`, rebuilt from the
   covenant templates this build publishes — identity, not shape. The creator
   writes the inscription, but he cannot make a forged KoProposal hash to the
   KoRoot his own inscription derives; lying in it only changes the address the
   audit demands. Same derivation `scripts/treasury-version.mjs` uses, and the same
   one the app uses to operate a treasury. A genesis this build cannot reconstruct
   is **refused** (`not-this-build`), never waved through: "I cannot tell" is not
   "verified".
4. **Vault derivation** — the layer that ties the other three to the money. The
   vault is not a genesis output and cannot be (a covenant id hashes the
   scriptPubKeys of its own genesis group, so a vault holding that id would contain
   a hash of itself); `KoRoot.bootstrapVault` mints it one transaction later, as a
   continuation, stamping the id into its state. A vault address is therefore
   `p2sh(vaultPrefix ‖ push32(lineage) ‖ vaultSuffix)` — a pure function of the
   genesis. The audit derives it and requires it to BE the address being opened, so
   a forged genesis fails not by looking wrong but by deriving a **different
   address**. That is also why the verdict no longer needs a covenant id from an
   independent source to be cryptographic: only one lineage derives the address the
   user typed, so the address is itself the second opinion. A node's UTXO id, when
   available, still confirms it on a second view of the chain
   (`assurance: "independent"` rather than `"lineage"`).

**How it is enforced.** The frontend runs the check before a treasury may be
opened: a refused treasury shows an explanation and nothing else — no balance, no
proposals, **no deposit address**, and no override. A treasury whose genesis cannot
be reached, or whose `bootstrapVault` has not landed yet, is `unverified`, which is
also not openable (it retries, and offers a clearly-labelled session-only escape
that still withholds the deposit address). The stats indexer runs the same check on
both discovery paths and keeps a refused treasury out of the public registry,
listing it under `refusedGenesis` on `/api/health`.

**What it does not cover.** It says nothing about who holds the owner keys. A
source that reports no genesis funding outpoint leaves the covenant id
unrecomputable, and with it the vault address underivable — the verdict is then
`cryptographic: false` and the UI shows an amber "structurally verified, NOT
independently confirmed" banner on every page; configure a node in ⚙ to close it.
Full detail, including the exact rules and every caveat, is in
[docs/GENESIS-PROVENANCE.md](docs/GENESIS-PROVENANCE.md).

## Verifying what a vault actually runs

A vault address is `blake2b(redeemScript)`, so you never have to take our word
for which rules protect a treasury:

```
node scripts/treasury-version.mjs <vaultAddress>
```

It reads the treasury's genesis inscription from chain, rebuilds the redeem
script from the published contracts, and compares the resulting address.

That tells you which *rules* guard a treasury. The genesis provenance check above
tells you whether those rules are being applied to an honest *covenant* — both are
needed, and the app runs the second one for you before it will open a treasury. The
two share one derivation: the audit's member-identity layer is the same rebuild
this script performs, decided on instead of reported, which is why a treasury this
build cannot reconstruct is refused by the app and reported as "not this build"
here.

And to check that the rules themselves are still all there:

```
bash scripts/test-security.sh [<vaultAddress>]
```

It counts each family of guard in the contract sources (covenant lineage,
owner-slot distinctness, threshold/ownerCount bounds, the proposal's tally
invariant, value floors, and the bounded input scans in KoVault and KoRoot), then
strips each family on its own into a throwaway copy and
requires the tests that pin it to FAIL — rebuilding those fixtures against the
mutant where the path is signature-gated, since a stale signature would otherwise
make a control pass for the wrong reason. A regression test that cannot fail proves
nothing; this is what proves the suite bites.

## Disclosure

We ask for coordinated disclosure: give us a reasonable window to ship a fix
before publishing. Because deployed covenants are immutable, a contract-level fix
protects **new** treasuries only — reports affecting live treasuries are
prioritised and users are notified with migration guidance.

## Supported versions

Only the latest `main` is supported. The project is experimental; there are no
LTS branches.
