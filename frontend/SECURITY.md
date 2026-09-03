# Security Policy

Ko-sign is a wallet. We take every report seriously and we appreciate the time
it takes to make one.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via **GitHub → Security → "Report a vulnerability"** on the
[ko-sign/kosign](https://github.com/ko-sign/kosign/security/advisories/new)
repository. You can expect an acknowledgement within 72 hours.

Please include: the affected module, reproduction steps or a proof of
concept, and the impact you believe it has. Testnet PoCs are very welcome —
TN10 funds are free.

## Scope

In scope:

- **Covenant script templates & on-chain behavior** (`src/treasuryTemplates.js`,
  `src/treasuryRebuild.js`) — anything that lets funds move without a threshold of
  valid owner signatures, forge a proposal into a foreign lineage, replay an
  approval, burn vault value (e.g. fee-griefing), or corrupt owner-set changes.
- **Transaction building & signing** (`src/wasmTx.js`, `src/wasm/`,
  `src/signer.js`) — wrong sighashes, signature misuse, key exfiltration.
- **Chain-state reconstruction** (`src/proposalScan.js`, `src/kaspaRest.js`,
  `src/treasuryRebuild.js`) — anything that lets an attacker make the UI display a
  proposal, owner set or balance that does not match the chain (spoofed
  approvals, forged inscriptions, address confusion).
- **XSS or dependency compromise** that can reach the imported key in
  `localStorage`.

Out of scope (known, documented trade-offs — see the whitepaper):

- The imported key living unencrypted in `localStorage` *per se* (a concrete
  escalation to steal it is in scope).
- Public visibility of proposals, votes and owner pubkeys — on-chain by design.
- Availability of third-party infrastructure (public nodes, REST indexers).
- The permissionless nature of covenant sweeps (value-preservation is enforced
  by contract; a way to *break* value preservation is very much in scope).

## Disclosure

We ask for coordinated disclosure: give us a reasonable window to ship a fix
before publishing. Because deployed covenants are immutable, a contract-level
fix protects **new** Treasuries only — reports that affect live Treasuries will be
prioritized and users notified with migration guidance.

## Supported versions

Only the latest `main` is supported. The project is experimental and runs on
Kaspa testnet-10; there are no LTS branches.
