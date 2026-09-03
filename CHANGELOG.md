# Changelog

Feature-level history of Ko-sign, newest first. One entry per shipped feature
(not per commit — polish/fix commits fold into their feature). Add an entry
here whenever a user-visible capability lands; the story behind each entry
lives in [docs/DEVLOG.md](docs/DEVLOG.md).

## 2026-09-03

- **The expired-proposal bond returns to the vault, and closing pays nothing** — a
  covenant change (RISKS #17's contract-level half). `closeExpired` was a public
  bounty: permissionless by design, it paid the bond to whoever ran it, so a
  proposal nearing a real expiry invited strangers to snipe the close — destroying
  an Approved transfer for profit, racing the owners' own execute. Now every
  proposal's state carries `vaultSpkHash` (a 20th field), written by
  `KoRoot.createProposal` from a hash-pinned vault-template reveal and the live
  covenant id — never by the proposer, whose bond can be root-reserve-funded and
  whose chosen return address would drain the reserve 0.5 KAS a proposal — and
  `closeExpired` requires output 0 to pay that P2SH the full input-SET bond,
  unbound, with nothing inheriting the lineage. The closer funds the fee from
  their own signed wallet inputs; sniping now costs money and yields none. New
  templates and layouts throughout (proposal state 315 → 348 bytes), regenerated
  fixtures with the destination / value-floor / template-pin / commitment guards
  covered (181 contract tests), the VALUE and SCAN guard families extended, the
  spend guard's close-expired rules reversed to demand the vault payment, and the
  wasm builders rebuilt. Validated on TN10 end-to-end: a full lifecycle on the new
  covenants (genesis → bootstrap → deposit → steal-stray refusals → propose →
  approve → execute), then a short-lived proposal whose dishonest close (bond
  routed to a wrong P2SH) the node REFUSED in script and whose honest close landed
  the whole 0.5 KAS bond back at the vault address as a sweepable stray.

## 2026-09-02

- **`executionDelay` is real, and it counts in DAA blocks — proven on a live node** —
  RISKS #3 had carried "confirm `this.age` actually gates spends" since the first
  design doc, because the compiler exposes it while KIP-10 reserves the opcode, and
  every on-chain execute so far had only proven it tolerates zero. A five-spend
  probe (`tools/kaspa-probe/src/bin/probe_age.rs`, ProbeAgeTime minAge=600) settled
  it: the script pins the declared delay into the input's sequence
  (OpCheckSequenceVerify), consensus enforces the declared wait in DAA score blocks
  (BIP-68-shaped `check_sequence_lock` — the probe's old "seconds" comment was
  wrong), a spend lying with sequence 0 dies in script, the DISABLED-bit escape
  hatch dies in the opcode on young and aged UTXOs alike, and the mature spend was
  accepted (txid `c9a00f28…`). One builder note recorded with it: a nonzero delay
  requires the execute to set the proposal input's sequence ≥ the delay — today's
  builders set 0, correct exactly as long as the UI commits delay 0.

- **Proposals now expire on a human schedule, chosen at creation** — both builders
  hard-coded `expiresAt` to DAA 4,000,000,000, eleven years out, which quietly made
  every Approved proposal a decade-lived standing authorization (signer rotation
  cannot revoke one: approvals check the proposal's snapshot) and stranded every
  Rejected proposal's 0.5 KAS bond for as long. A proposal now commits a bounded
  lifetime (1 hour–1 year, default 30 days, picked in the New-transfer dialog),
  anchored to the chain's DAA score and refusing to guess without a node. The
  execute path refuses an EXPIRED proposal outright — `closeExpired` is
  permissionless and pays the bond to whoever runs it, so executing past expiry
  races bond snipers with the transfer as the stake — and warns inside the final
  hour. The Manage-signers form now says out loud what the snapshot semantics
  imply: rotating a signer out does not revoke proposals they already touched;
  reject the open ones first. Four new mutation rules pin the bounds, the expired
  verdict, and both builders' anchoring (53 total). The recipient commitment an
  execute verifies against is now read from the chain-anchored redeem script
  rather than the local record's copy. Risk register: #17 (this), #18 (reorg
  note), #19 (served-wasm integrity), and the rotation corollary in
  `docs/OWNER-MANAGEMENT.md`.

- **A lying node can no longer name its own fee** — every submit-retry re-signed at the
  exact fee a rejecting node demanded (`required amount of N`), and the owner-funded
  paths carry no covenant cap by design, so a hostile RPC endpoint answering
  `required amount of 5000000000` would have re-signed 50 KAS of the owner's wallet
  into a miner's fee automatically — invisible to the spend guard, which conserves
  treasury value and is never told the wallet input total. Found in an eighth,
  three-lane adversarial review round (covenant scripts, browser signing path,
  protocol lifecycle — the first two lanes came back with no funds-at-risk finding;
  this was the round's one confirmed drain, of the paying wallet, never the vault).
  All four retry sites (covenant ops, sweeps, genesis, bootstrap) now clamp the
  demand to 20× the honestly mass-priced fee via `saneFeeDemand`, anchored to the
  pre-retry price so a two-step lie cannot walk the anchor; beyond it the demand is
  refused and the owner is told to switch endpoints. Pinned by two new mutation
  rules (49 total). Alongside it, two hardenings from the same round: the execute
  path's vault-UTXO picker no longer falls back to an alien-lineage UTXO a lagging
  node might surface (an attacker-planted one now yields "not visible yet" instead
  of an opaque script failure), and the risk register gains #16 plus the review's
  residual findings. See `docs/RISKS.md` #16 and `docs/FEES.md` safety nets.

## 2026-08-24

- **The published repo now builds, installs and tests from a clean clone** — `opensource/`
  is generated by `scripts/make-opensource.sh`, and nothing had ever run the result. It
  would have failed three ways on the first push: `pnpm install --frozen-lockfile` rejects
  a lockfile still carrying the `backend` importer the script strips from the workspace;
  CI hard-codes `npm ci --prefix indexer` and an `indexer/treasuryTemplates.js` diff for a
  directory that does not ship; and `scripts/test-js-guards.sh` dies in its CONTROL stage
  on `indexer/test/policy.test.mjs`, so `npm test` never reaches a single mutation. Each is
  fixed where it lives rather than in the copy: the lockfile importer is stripped alongside
  the workspace entry, the CI steps are conditional on the directory existing and the
  template list is read back from git, and the guard harness now narrows a rule to the files
  the checkout has — the ten genesis-auditor rules keep biting on
  `packages/descriptor/src/genesis.js` alone (46 of 47 rules run in the published repo,
  and the one that cannot is named on stdout, not silently dropped).
- **The boundary is fenced in the prose it applies to** — README sections describing
  `tools/kaspa-probe`, `backend/` and `plan.md` are wrapped in `<!-- oss:strip -->`, which
  the generator removes and then asserts is gone, replacing a line filter that matched
  `backend/` and would have stopped matching the first time anyone reworded a bullet. The
  generator also names untracked files it did not copy — a new doc that was never `git
  add`ed used to vanish in silence, first visible as a dead link in the published README.
- **Root `CONTRIBUTING.md`** — the build, the two mutation harnesses and the rule that a
  check protecting funds ships with the mutation rule that pins it. The README now leads
  with what the status actually is: testnet-10, seven internal review rounds, no external
  audit, not for mainnet funds.
- **A correction: the app does not make zero external requests** — the 2026-08-04 entry
  claimed the last third-party runtime request was gone. Self-hosting Inter removed the last
  third-party *asset*; `frontend/src/price.js` still calls `api.coingecko.com` for the
  KAS/USD figure on every open Assets page. Now stated as an open item instead of a closed
  one. Two manual TN10 scripts also hard-coded a local scratchpad path carrying a username;
  they default to `os.tmpdir()`.

- **Creating a treasury no longer ends in a warning about that treasury** — the genesis check
  reads from the chain indexer, which trails your node by minutes, so a treasury minted
  seconds ago could not verify yet and the app showed "Could not verify the genesis". It now
  tells "the check has not run yet" apart from "the check could not run": a treasury this
  browser minted in the last 15 minutes shows a calm "waiting for the chain indexer" state
  instead of a warning. The audit itself is unchanged — it still runs, still retries, and the
  deposit address stays hidden until it passes, because trusting a treasury on the app's own
  word about what it built is the exact pattern earlier rounds kept finding bugs in.

## 2026-08-21

- **A signer-change that the contract would reject is now refused before you propose it** —
  proposing a config with a threshold above the signer count, or a duplicate signer address,
  used to build and be approvable, only for the on-chain rule to reject it at execute time and
  strand the 0.5 KAS bond until it expired. The proposer flow now validates the same 1–5 /
  distinctness bounds the creation flow and the contract already enforce. (Round-7 critic
  robustness gap; also hardened the spend guard's test coverage for the builder-supplied fee
  ceiling.)

- **Owner rotation now actually revokes: a stale approved config can no longer be replayed**
  — `KoRoot.executeConfig` installed the owner set from any approved CONFIG proposal of this
  treasury without checking it was created under the current owner set, and the nonce it
  preserves is not a version. So a config approved under an old set, then abandoned, could be
  executed after a later rotation to reinstate a removed owner with a single former-era key —
  defeating rotation as a compromise-recovery action. It now requires the proposal's snapshot
  to match the current config, so every executed rotation invalidates every prior
  approved-but-unexecuted config. (MEDIUM; needs a former key + a stale approved proposal.)
  Also fixed: a net-zero self-send transfer could alias its recipient and change onto one
  output to leak up to amount+maxFee — now the two output indices must be distinct (LOW). A
  third finding — an owner can waste an approved proposal by pairing it with a deposit
  (owner-only griefing, fully recoverable) — is documented as accepted (RISKS §15). Contract
  changes; all covenant addresses change, which is a non-issue pre-launch.

- **An open proposal's recipient is now verified against the on-chain commitment before you
  can approve it** — a transfer's amount and approvals are anchored to your node, but the
  human-readable recipient address came from the untrusted REST indexer's payload. The app
  checked whether it matched the on-chain commitment but, on a mismatch, still showed the
  misleading address with no warning. A malicious proposer (or a hostile indexer) could
  commit a payout to an attacker while displaying a trusted address, so honest co-owners
  would approve a destination they never actually authorised. Open transfers whose recipient
  does not hash to the on-chain commitment now show a do-not-approve warning and disable
  approval until it verifies; your own proposals are unaffected. Also corrected the
  trust-boundary regression test, which asserted the money path never reads the indexer while
  checking only the landing stat client — the REST indexer client is on the money path and is
  kept safe by re-anchoring, and the test now says so instead of giving false assurance.

- **The sweep, genesis and bootstrap now re-read their bytes before broadcasting** — these
  three flows sign the operator's own wallet inputs (a signature over every output) but
  were the only wallet-signing flows that skipped `assertSpend`, the independent second
  reading every covenant op runs. The covenant floor keeps the treasury safe, but nothing
  checked the operator's own change output, so a wrong or hostile transaction builder could
  keep the vault/root outputs valid while routing the wallet change — often nearly the whole
  wallet, since coin selection is largest-first — to an attacker, authorised by the owner's
  own signature. All three now run the guard before every broadcast (and on each fee retry),
  refusing any output that isn't the treasury's own continuation or change home to the
  operator. Also fixed: the guard ignored an output's script version, so a non-standard
  (anyone-can-spend) output could render as an honest recipient and pass — it now refuses
  any non-zero script version. Round-7 findings; needs a compromised/buggy builder to
  exploit, so no funds were at risk in normal use, but the app's stated
  guard-before-every-broadcast defense had three gaps and now has none.

- **Unswept deposits are now described as protected, and it's proven on-chain** — the
  Assets panel used to call a deposit sitting at the vault address "not
  covenant-controlled until swept in", which reads as *unprotected until you act* and
  could push someone into an urgent sweep they don't need. A deposit is covenant-locked
  the moment it lands: it sits at the vault's P2SH address, so the only spend `KoVault`
  permits for it is a sweep back into this same vault — nobody can carry it off. A new
  adversarial tool (`tools/kaspa-probe/steal_stray.rs`) attempts a keyless theft against
  a real funded TN10 vault in all three shapes it could take; the node rejected every
  one. The copy now says what the covenant actually permits, pinned by a trust-boundary
  test and a mutation rule. Wording + docs; no contract or fund-path change.

- **Reconstructed proposal history is now labelled as indexer-sourced** — whether a
  proposal is still open and signable is anchored to your node and safe, but a closed
  proposal's outcome (paid out vs retired), amount and recipient are rebuilt from the
  untrusted REST indexer. A hostile indexer could mislabel a payout as a retirement,
  or show a wrong recipient. Chain-reconstructed history now carries a note that these
  are not node-confirmed, with a pointer to the on-chain tx; the app's own tracked
  history is unaffected. Display-only (no signing over indexer data), found in the
  round-6 follow-up review.


- **Amounts too large for a JS Number to hold exactly are now refused, not
  rounded** — every sompi value off the node was read into a JS Number, exact only
  to 2^53-1 sompi (~90,071,992 KAS). Above that a value rounds, and the rounded
  figure was both signed by the wasm builder and checked by the spend guard: an
  honest payout from a ~90M KAS treasury was refused as "the builder and screen
  disagree", while a 1-sompi over-loss above the limit slipped past the
  conservation check. The money path now validates every amount through `safeSompi`
  and the guard refuses when the treasury's own value is not exactly representable —
  a treasury above the limit is told to split into smaller vault UTXOs instead of
  being silently mis-signed or mis-checked. No funds were ever at risk (the bound is
  ~0.3% of supply in a single UTXO), but a silent conservation bypass and a frozen
  honest payout are exactly what the guard exists to prevent.
- **A sweep run right after another wallet-funded op no longer fails as a
  double-spend** — the sweep was the only flow that did not use the session's
  mempool-spend tracking, so a proposal/approve immediately followed by a sweep
  re-picked the wallet UTXO the first op had just spent (still listed by the node
  until it confirms) and the node rejected the sweep. It now reads its fee UTXOs
  through the same filter every other flow uses and records each batch's inputs as
  spent.
- **Sweeping with nothing to sweep now does nothing, instead of charging a fee** —
  a sweep with no consolidatable deposits and a single vault UTXO used to submit a
  transaction that re-minted the vault to itself for a wallet fee. It returns before
  building anything. Real compaction (merging a second vault UTXO) is unaffected.
- **The genesis creation check now runs before the irreversible submit** — its one
  invariant (the built genesis mints the lineage the inscription names) ran after
  the broadcast and before the recovery record was written, so a mismatch could
  strand the on-chain root with no way to resume. Moved ahead of the submit, and
  checked on every fee-retry rebuild.

## 2026-08-20

- **A genesis that cannot be tied to the address being opened is no longer called
  "clean"** — the provenance gate derives a vault address from the covenant id its
  genesis mints and requires it to be the address you are opening. That derivation
  needs one field, `previous_outpoint_hash`, from the same chain source the audit is
  auditing. Withheld, the check was skipped and the verdict stayed `clean` — while
  the reason string said "nothing yet ties this transaction to the money" — and the
  deposit address was shown. A hostile source could therefore serve a real but
  unrelated genesis, one that is REFUSED when reported in full, and have it pass.
  The same missing field also disabled the independent cross-check against your own
  node. Now `unverified`, with the deposit address gated on the binding itself
  rather than on the verdict word. This costs an honest user nothing: locating the
  genesis at all already required that field, from the same endpoint.
- **A new treasury's deposit address is now derived, not taken from the builder** —
  both creation paths published `p2sh(vaultRedeemHex)`, the transaction builder's own
  account of the vault it had just minted. The covenant pins what reaches the chain,
  but it cannot pin a return value: a builder that minted the right vault and handed
  back a different redeem script would produce a correct treasury with somebody
  else's deposit address printed under it, and nothing on chain would look wrong. A
  vault address is a pure function of its lineage, so it is now worked out from the
  lineage and the two must agree before anything is published.
- **The spend guard no longer trusts a covenant id to say where money went** — it
  accepted any output tagged with the treasury's lineage, and a covenant id is a tag
  written beside the script, not a property of it. A vault continuation repointed at
  a stranger, binding untouched, read as an honest continuation and its value even
  counted as "came back", balancing the arithmetic. Consensus rejects such a
  transaction, so no funds were ever at risk — it is fixed because the guard exists
  precisely so the browser does not have to depend on that.

- **Fixed a guard that refused honest proposals** — the conservation rule shipped
  as an equality and refused every owner-funded proposal with "0.5 KAS less than
  accounted for", in the product, to a real user, twice. When the proposer funds a
  proposal from their wallet the KoRoot is returned whole and the 0.5 KAS bond is
  minted out of the *wallet*, so the treasury ends up ahead — and a rule counting
  every covenant output as "came back", without counting what came in from outside,
  read that gain as a shortfall. The rule is now a ceiling rather than an equality:
  the treasury must not LOSE more than it was told it would. Theft is caught
  identically, because theft is exactly that. The owner-funded case had a test from
  the start, but through `approve`, where treasury value passes straight through —
  **the dangerous shape was tested on the one path where it cannot occur.**


- **The wasm is now reproducible by anyone, not just by the machine that built it**
  — `verify:wasm` proved the committed blob was what the Rust builds, but silently
  meant *on this machine*: `secp256k1-sys` compiles C with the host clang, so the
  artefact was byte-reproducible by one account on one laptop. `Dockerfile.repro`
  pins every input — base image by digest, apt by `snapshot.debian.org` at a fixed
  date, rustc by the image, wasm-bindgen read from the lockfile, paths remapped to
  the same canonical prefixes. The container produced different bytes (Homebrew
  clang 22.1.8 vs Debian 14.0.6) and **became canonical**: the committed artefacts
  were regenerated from it and the full suite re-run to confirm identical
  behaviour. `npm run verify:wasm` now means "anyone with Docker can check this".
  Adopting it also closed a footgun bigger than the feature — `build:wasm` used to
  write a host build, so one person running it on a laptop would silently replace
  the canonical artefact with one nobody could reproduce. It now runs the
  container, and the host script refuses `--write` without an explicit
  `--not-reproducible`. See [docs/WASM-PROVENANCE.md](docs/WASM-PROVENANCE.md).


- **Anyone can now check that a live deployment is serving what this commit
  builds** — everything else verified so far protects the code in this repository,
  and none of it helps if the page a person loaded is not that code. The build is
  deterministic (checked by building twice, which matters because rollup names
  chunks by content hash, so one stray timestamp renames half of them and every
  future check would report a tamper that never happened). Every emitted file is
  hashed into a manifest with one tree digest naming the whole deployment, and
  `npm run verify:deployed -- <url>` fetches a live site and compares. Tested end to
  end: append a line to the bundled JS and it is caught, with the point that makes
  it damning — its filename is a content hash, so those bytes were never built from
  this source. Stated limit: a manifest served by the same host as the bundle proves
  nothing; the digest has to be published where that host cannot edit it. 28 rules
  pinned by mutation.


- **The signing path provably cannot reach the indexer** — Ko-sign runs its own
  indexer, and it is one machine with no consensus behind it; for 0.2 KAS an
  attacker could once make it report an honest treasury as forged. Checking before
  building showed the browser already does not trust it for anything: it is reached
  only by the landing page's stat strip. But that held by habit, not by
  construction, and a future change that started consulting it from the signing
  path would fail no test. `frontend/test/trustBoundary.test.mjs` now walks the
  import graph **transitively** from every module that can move money and asserts
  none reaches the indexer client — "does wasmTx import stats" stays true easily
  while a helper two levels down does the fetching. The landing page may render the
  numbers and may not let one gate a control. Both pinned by mutation; 26 rules.


- **The vault can no longer lose money to a fee nobody showed you** — the spend
  guard checked where money went and how much was paid out, but took the fee and
  the change entirely on trust. A builder that quietly overstates the fee sends
  money nowhere suspicious; it just leaves less behind, and miners take the
  remainder whatever it is called. Every caller already knows what the operation
  spends out of the treasury's own UTXOs, so the guard now requires *what left −
  what came back − what was paid out* to equal the displayed fee. Two ways this
  could have refused honest work are pinned as tests rather than discovered in
  production: an owner-funded operation conserves the treasury completely
  (`treasuryFee` is zero, and claiming otherwise refuses every honest one), and a
  fee retry re-signs with different numbers, so the rebuilt transaction carries a
  rebuilt guard. Where a caller cannot state the numbers the check is skipped, not
  guessed. 24 rules now pinned by mutation.


- **The mutation harness now covers the whole browser-and-server side, not just the
  spend guard** — 22 rules across `txGuard.js`, `txDecode.js`, the genesis auditor
  (both byte-identical mirrors), `proposalScan.js`, `proposalPolicy.js` and the
  indexer, each removed in turn and required to fail a **named** test. Extending it
  exposed two bugs in the harness itself, both of the family this whole effort is
  about — a checking tool whose failure mode looks like a result. `pipefail` made it
  die silently at the first rule with no test behind it, so it failed exactly when
  it found something; and pointing every genesis rule at the indexer's `node --test`
  file made three well-guarded rules report as unguarded, including the fix for the
  0.2 KAS defamation vector, whose adversarial fixtures live in `packages/descriptor`'s
  vitest suite. It now runs whichever runner a rule names, and mutates
  byte-identical mirrors together so the mirror tripwire is not mistaken for a bite.


- **The app now reads a transaction back before it sends it, and refuses if it is
  not what you asked for** — the covenants enforce *no transfer without owner
  signatures*, which every Kaspa node checks and three on-chain rounds have watched
  real nodes enforce. What no covenant can enforce is *that the owner meant this
  transfer*. You see "send 2 KAS to kaspatest:qr…", you sign a sighash, and that
  sighash is a hash of whatever the wasm builder assembled — if it assembled
  something else, the signature is still valid, the covenant is still satisfied,
  and the money still moves. `frontend/src/txDecode.js` now decodes the finished
  transaction from its bytes without calling the builder (borsh by hand, addresses
  rebuilt with its own cashaddr encoder), and `frontend/src/txGuard.js` requires
  every output to be one of exactly three things: a continuation of **this**
  treasury's lineage, a payment to an address you declared, or change back to your
  own wallet. Plus three rules the covenants never state: approve/reject/propose/
  retire must not spend the vault, a transfer that pays nobody is a failure rather
  than a no-op, and the declared address is paid exactly once. It runs **inside**
  the fee-retry loop, because a node asking for a higher fee sends the flow back
  through `rebuild()`, which re-signs different bytes. `scripts/test-js-guards.sh`
  pins all ten rules by mutation — the same discipline the covenants get — and
  immediately found one rule with no test behind it. See
  [docs/SPEND-GUARD.md](docs/SPEND-GUARD.md).


- **The wasm that builds every transaction you sign can now be checked against
  its source** — `frontend/src/wasm/kosign_wasm_tx_bg.wasm` chooses the amount,
  the recipient and the covenant continuation of every transaction an owner
  signs, and nothing tied it to `tools/wasm-tx/src/lib.rs`. Reviewing the Rust
  proved nothing about the product, and the routine failure needed no attacker:
  edit `lib.rs`, forget to rebuild, and every suite stays green because every
  suite exercises the OLD blob. Three things were in the way of "rebuild it and
  compare", each silent: `Cargo.lock` was **gitignored** (392 dependency versions
  unrecorded, so a rebuild resolved crates.io afresh), rustc was unpinned, and
  the binary embedded **47 occurrences of the builder's home directory** — which
  both leaked a username to everyone who loaded the app and meant no second
  machine could reproduce it. Now: the lockfile is tracked,
  `tools/wasm-tx/rust-toolchain.toml` pins rustc, and `scripts/build-wasm.sh`
  remaps build paths and asserts the remap worked. Two tiers — a manifest of
  source AND artefact hashes that runs in `npm test` with no toolchain at all
  (`npm run test:wasm`), and a full rebuild-and-compare (`npm run verify:wasm`).
  Both were mutation-tested: nine mutations, every one reported for the right
  reason, and a missing toolchain exits 1 rather than passing silently. One
  honest limit: `secp256k1-sys` compiles C with the host clang, so byte identity
  holds per-toolchain; the recorded toolchain is in the manifest and a mismatch
  is reported as a mismatch, not as tampering. See
  [docs/WASM-PROVENANCE.md](docs/WASM-PROVENANCE.md).


- **A treasury address is now a function of its genesis, and no other covenant can
  transact there** — a vault address used to be a random salt spliced into a
  stateless redeem script, and a stateless script does not care whose covenant it
  spends under. So anyone could plant a covenant **lineage of his own** at a
  treasury address, wait for an incoming payment — payments arrive UNBOUND, which
  is what a deposit address is for — fold it into his lineage with `deposit`, and
  spend it with a proposal he had pre-approved for himself. **No owner key
  required.** `KoVault` now carries the treasury's covenant id in STATE and refuses
  every other lineage (`executeProposal` requires `cid == lineage`, `deposit`
  requires `cid0 == lineage`), so a foreign covenant dies at the first `require`.
  That id cannot be baked at genesis — `covenant_id` hashes the scriptPubKeys of
  its own genesis group, so a vault holding the id would contain a hash of itself —
  so a treasury is now created by **two transactions**: the genesis binds output 0
  = KoRoot **alone** (output 1, if present, is ordinary unbound change; there is no
  vault output), which fixes `C = covenant_id(fundingOutpoint, [(0, rootValue,
  rootSpk)])` before broadcast; then a new `KoRoot.bootstrapVault` entrypoint
  spends the root and mints the vault as a CONTINUATION of `C`, stamping `C` into
  its state while the root continues unchanged. The vault template is supplied by
  the spender and pinned by a new `vaultTemplateHash` constructor argument, so 3.9
  kB of vault script is hash-checked at spend time instead of being carried inside
  the root's redeem and revealed on every proposal. The result is the point of the
  whole change: `vaultAddress = p2sh(vaultPrefix ‖ push32(lineage) ‖ vaultSuffix)`
  — **one covenant id, one vault address, and no second lineage can ever transact
  at it.** See [docs/GENESIS-PROVENANCE.md](docs/GENESIS-PROVENANCE.md).

- **The genesis audit derives the vault address instead of observing it** — with no
  vault output at genesis there is nothing to observe, so the auditor recomputes the
  covenant id over `{output 0}` and *derives* the one vault address that id can
  produce, then requires it to be the address being opened. A forged genesis no
  longer fails by being detectably forged; it fails by deriving a **different
  address**, which is to say it was never that vault's genesis. This also retires a
  weakness the previous round shipped with: `cryptographic: true` used to need a
  covenant id supplied by a source independent of the transaction, because matching
  an indexer's id against its own outputs restates what it already said. It no
  longer does — **the address the user typed is the second opinion**, since only one
  lineage derives it. A node's UTXO id still strengthens a verdict, so `assurance`
  now reads `independent` / `lineage` / `structural` rather than two levels.
  `GENESIS_AUDIT_VERSION` is 3; refusal codes `root-not-koroot`,
  `vault-not-kovault`, `vault-not-p2sh` and `vault-index-mismatch` are gone,
  replaced by `vault-not-from-this-genesis` and `vault-underivable`. Because the
  genesis no longer pays the vault, both the browser gate and the indexer's REST
  second line reach it by a two-hop walk — oldest covenant-bound payment to the
  vault (its `bootstrapVault` mint) → the outpoint that transaction's input 0 spent
  → that **txid** in the KoRoot's history — matched by txid rather than by "the
  first KOSGN payload there", since anyone may pay the root address with any
  payload. A treasury whose bootstrap has not landed yet is `unverified` and shows
  **no deposit address**, never a refusal.

- **The KOSGN inscription's 32-byte slot is a checkable claim** — unchanged on the
  wire, but it now carries the treasury's covenant **lineage** rather than a random
  salt, so `decodeInscription` returns `lineage` and an auditor recomputes it from
  the genesis and compares. A salt was a number only its creator knew.

- **KoRoot's entrypoint selectors are pinned by a test** — `bootstrapVault` sits
  between `createProposal` and `executeConfig` in declaration order, so silc
  renumbered `executeConfig` from 1 to 2. A selector is a coupling between a
  contract's source order and a client's witness parser with no compiler in
  between, and a stale number does not fail to parse — it parses the *wrong*
  witness, which is how the browser's chain walk came to read a bootstrap as a
  signer change and die rebuilding the root on the first hop out of every genesis.
  New `frontend/test/proposalScan.test.mjs` drives `walkRoot` over real witness
  shapes for all three selectors; 3 of its 4 tests fail if the old mapping is
  restored.

## 2026-08-19

- **The covenant's 16-input ceiling is enforced where transactions are built** —
  `KoVault` now scans its inputs with a bounded loop, and the compiler emits
  `require(end - start <= MAX)` before unrolling it, so **any** spend of the vault
  carrying more than 16 inputs fails script verification outright. Nothing on the
  client side knew that: the fee-sizing loop for approve / reject / execute /
  config-execute kept adding wallet UTXOs until the fee was covered, and the wasm
  builder attached every one of them — so an owner whose wallet was scattered
  across dust built a transaction the covenant rejects, and got an opaque script
  failure instead of the "your wallet needs…" message every other funding path
  produces. Coin selection is now capped at the ceiling **minus the inputs the
  covenant itself contributes** (1 for approve/reject, 2 for execute and
  config-execute), and when the fee cannot be paid within that budget the owner is
  told what to do about it — *consolidate your wallet, or fund the fee from a
  single UTXO* — while the treasury pays the fee instead, so fragmentation alone
  never blocks an operation. On the submit-retry path, where no fallback is left,
  the same condition is an error rather than a transaction that will be rejected.
  `createProposal` is capped too — in `wasmTx.proposerFunding`, because it funds a
  fixed bond rather than a mass-priced fee, and at 15 wallet UTXOs because the root
  is its only covenant input. (It was exempt for a day, on the grounds that KoRoot
  had no bounded scan; the root-input value floors below gave it one, so the
  exemption was a bug for as long as it stood.) New
  `frontend/test/opFunding.test.mjs` drives the real wasm builders and counts the
  inputs of what comes out, over every wallet shape from one fat UTXO to 500 dust
  ones; 6 of its 13 tests fail if the cap is removed from `pickFrom`. See
  [docs/FEES.md](docs/FEES.md).

- **The security suite pins six families of guard, not one** — `test-security.sh`
  counted and stripped only the covenant-**lineage** guards, so every rule added
  since (owner-slot distinctness ×20, the threshold/ownerCount bounds, the
  proposal's tally invariant, the value floors, the vault's and the root's
  input-set sums) could be deleted while the inventory still
  reported its old numbers and every SECURITY-labelled test still passed: the
  closing "the guards hold and the tests prove it" was narrower than it read. Each
  family now has its own inventory count and its own negative control, kept
  separate so a red run names **which** family broke. The differential also stopped
  lying by omission: deleting a line moves a contract's compiled bytes, hence its
  P2SH address, hence every sighash, so a fixture carrying a real signature fails
  on any mutant for a reason unrelated to the guard — which made the signature-gated
  paths (createProposal, approve, reject, execute) impossible to pin at all. Those
  families now **rebuild their fixtures against the mutant**, running the repo's own
  generators over a throwaway mirror, so the signatures are valid and the only thing
  that can flip a verdict is the missing guard. Because each control now runs only
  the tests that pin its family (selected by name, or by the SECURITY label) rather
  than all 63, the differential covers five families in about the wall time the
  single lineage one used to take (the sixth, the bounded input scans, is
  inventory-only: deleting a loop header does not compile, so it cannot be made
  into a negative control). A failing contract is also diagnosed rather than
  just reported: the same mirror regenerates its fixtures and says whether they were
  **stale** (a contract edited without `npm run gen:*-tests` — fails at `checkSig`
  and looks exactly like a broken rule) or **current** (a real change in what the
  contract accepts). `--rederive` prints the expected counts and flip counts as the
  current tree has them, and `--only=FAMILY` iterates on one.

- **Genesis provenance is checked before a treasury can be opened** — a
  treasury's covenant id is minted once, by whoever builds its genesis
  transaction, and `populate_genesis_covenants` lets that party choose **how many
  outputs join the group**. Ko-sign binds exactly two (KoRoot, KoVault); a
  malicious creator binds a third — a KoProposal-shaped P2SH whose state he wrote
  himself (`status = Approved`, `snapThreshold = 1`, `owner0 = his key`). It
  matches the template and carries the treasury's covenant id, so
  `KoVault.executeProposal` accepts it as genuine and it drains the vault on
  demand, from a treasury whose addresses, KOSGN inscription, owners and balances
  all look right. **No contract can catch this**: the whole covenant instruction
  set (`OpInputCovenantId`, `OpOutputCovenantId`, `OpCovOutputCount`,
  `OpCovOutputIdx`, `OpOutputAuthorizingInput`) exposes an id but never its
  provenance — genesis is the one moment when covenant membership is decided by a
  party rather than by a script. The genesis transaction is on chain and
  immutable, though, so clients now read it *before the first deposit*, in three
  layers. **Structural**: at most three outputs, outputs 0/1 P2SH with 1 the vault
  being opened, **exactly two** covenant members and they must be 0 and 1 under one
  id and one authorizing input, any third output an ordinary wallet payment.
  **Covenant id recompute**: the id is `blake2b-256(key="CovenantID")` over the
  genesis outpoint and the authorized outputs and commits to their COUNT, so a
  three-output group cannot hash to a two-output id; matching it against the id the
  vault actually carries — read from *your own node's* UTXO set, a source
  independent of the indexer that supplied the transaction — defeats even an
  indexer that hides the extra output. **Member identity**: outputs 0 and 1 must
  BE this treasury's KoRoot and KoVault, re-derived from the genesis KOSGN
  inscription under the covenant templates this build publishes and compared by
  redeem-script hash. That last layer is what closes the two-member variant of the
  attack — bind `[0, 1]` with the forged proposal at index 0 and the real vault at
  index 1, and the group is genuinely two members, so every count- and hash-based
  check agrees with it; only identity does not. The frontend REFUSES a bad genesis
  outright — no balance, no proposals, **no deposit address**, no override, and
  no treasury state persisted (the verdict itself is cached, keyed to the
  templates that produced it, so a re-audit is not re-fetched); a genesis that
  cannot be fetched is
  `unverified` and also stays closed. The stats indexer applies the same check on
  both discovery paths, keeps such a treasury out of the public registry and
  lists it under `refusedGenesis` on `/api/health`. Rules live once in
  `packages/descriptor/src/genesis.js` (byte-identical vendored copy in
  `indexer/genesisAudit.mjs`, pinned by a drift test). See
  [docs/GENESIS-PROVENANCE.md](docs/GENESIS-PROVENANCE.md) and SECURITY.md.

- **The genesis audit hashes for itself, and says how far it actually got** — the
  auditor used to take keyed blake2b as an injected option and treat "the caller
  passed no hasher" as "run the structural layer only", which is how the stats
  indexer ended up auditing both of its discovery paths without the cryptographic
  layer at all. It now imports `@noble/hashes` and the covenant templates directly,
  so **no call site can weaken it by omission**. The covenant-id recomputation is
  also no longer allowed to confirm itself: `cryptographic: true` is set only when
  the id came from a source independent of the transaction (your node's UTXO set),
  because an indexer that hides a covenant member also hides it from the id it
  quotes. Every way the independent lookup can come back empty — no endpoint, a
  node error, a node that reports no `covenantId` — used to return `null` silently
  and leave the verdict looking like a proof; each now returns a reason that
  travels with the verdict, renders as an amber **"structurally verified, NOT
  independently confirmed"** panel plus a deposit-card warning, and keeps the
  verdict out of the permanent cache so the proof completes as soon as a node is
  reachable. The indexer's chain follower re-runs the audit with the covenant id
  from its own node's UTXO set (block and UTXO set being two views), and every
  registered treasury records what its audit proved as
  `genesisAudit: { version, assurance }` on `/api/treasuries`, tallied on
  `/api/health`.

- **Owner slots must hold distinct keys** — identity in this design is the
  SLOT, not the key: `ownerAt(i)` returns the key in slot *i*, `maskFor(i)`
  returns bit *i*, and the duplicate-vote guard compares **bitmap bits, never
  keys**. One key sitting in several live slots was therefore several owners to
  every later check, and could approve once per slot it occupied — owners
  `[A, A, A, B, C]` at threshold 3 is a 1-of-3 treasury presenting itself as
  3-of-5, and A alone reaches a threshold his co-signers believe needs three of
  them. Every bound the genesis check already enforced passed for that set.
  `KoRoot.createProposal` now compares every pair below `ownerCount` before it
  authenticates anyone, and `KoRoot.executeConfig` applies the same rule to the
  set an approved CONFIG proposal installs — otherwise the honest path could
  reach exactly the state the genesis check rejects. Slots at or above
  `ownerCount` are the shared NUMS pad and are deliberately **not** compared, so
  a 2-of-2 treasury still works. `koRootArgs`/`koProposalArgs` refuse to build
  the same configurations, so the failure arrives as an error message rather than
  as an unusable Safe. The rule is deliberately not repeated in `KoProposal`: a
  snapshot only reaches a proposal UTXO through `createProposal`, `executeConfig`
  or a genesis-planted mint, and whoever can plant one can equally plant a 1-of-1
  naming a single key they hold — which distinctness would not touch. The ~280
  bytes it would add are paid on every approve, reject and execute, so the
  planted-proposal class is closed at genesis instead (see the genesis audit).

- **KoRoot's value floors are bounded over the root-input SET too** — the same
  bug as the vault's, in the other contract: `createProposal` and `executeConfig`
  each compared their outputs against `this` input's value alone, while every root
  UTXO spent in the transaction runs its own copy of the script and all the copies
  are satisfied by the same outputs. Two bound root UTXOs, one honest proposal, and
  the second root's whole reserve walked out to an ordinary output — the outputs
  only had to clear `thisInput.value - maxProposalFee`, which one root already
  covers. Both now sum every input paying the active input's `scriptPubKey`, the same walk
  KoVault makes, and require the id-bearing outputs to cover that sum less
  `maxProposalFee`. The loop bound is a **compile-time constant** (`int constant
  maxTxInputs = 16`), not a constructor argument, so KoRoot's ctor signature —
  and `packages/descriptor`'s encoding of it — is untouched. Cost: +979 bytes.
  Consequence to know: root spends now carry the same hard 16-input ceiling the
  vault has, which is why `createProposal`'s wallet funding is capped above.
  7 new fixtures — two roots accepted when the outputs cover both, refused when
  they cover one (from either root's point of view), a 17-input spend refused at
  the loop's own bound and a 16-input one accepted, and the same pair on
  `executeConfig`.

- **The vault's value rule is bounded over the whole vault-input SET, not per
  input** — each vault UTXO spent in an execution runs its **own copy** of
  `KoVault.executeProposal`, and every copy is satisfied by the SAME change
  output. A bound written against `this` input's value alone therefore protected
  one UTXO while the rest walked out to whoever the transaction paid: with two
  bound vault UTXOs, one honest, fully approved transfer of `amount` carried the
  second one off. The change must now cover **every sompi arriving from the vault
  address**, less the one approved amount and the proposal's fee cap — the same
  walk `deposit` makes over the same bounded window. The window is what makes the
  sum complete: the loop form also requires `tx.inputs.length` to fit within
  `maxDepositInputs`, so a vault UTXO parked past the last scanned index does not
  escape the total, the transaction simply fails to validate. The rule PERMITS
  legitimate multi-UTXO spends rather than banning them. Side effect worth
  knowing: executions now inherit the deposit path's 16-input ceiling, so an
  execution may carry at most 14 wallet inputs to fund its fee.

- **A proposal bounds its own owner snapshot** — a covenant id does not prove
  KoRoot minted a UTXO: the genesis covenant group may bind an arbitrary number
  of outputs, so a treasury's creator (or a buggy tool acting for one) can plant
  a template-shaped proposal carrying any `snapThreshold`/`ownerCount` it likes.
  `approve`, `reject` and `execute` now re-establish `ownerCount` 1..5 and
  `snapThreshold` 1..`ownerCount` before any index, bitmap or signature work
  happens. Each bound closes a degenerate shape: `ownerCount` past the last slot
  makes `ownerAt`/`maskFor` fall through to owner 0, and — worse — makes
  `(ownerCount - rejectCount) < snapThreshold` unreachable, so a proposal minted
  with `ownerCount` 99 can never be **Failed** and the owners it names cannot
  vote it down at all; `snapThreshold` 0 makes one vote sufficient however many
  owners the snapshot names. `closeExpired` deliberately does **not** check them
  — it reads neither field, takes no owner index and checks no signature, and
  retiring the UTXO is the one thing that must stay possible once the voting
  paths reject a malformed proposal. Owner distinctness is deliberately not
  repeated here (~280 bytes of script revealed on every vote, against ~60 for the
  bounds): whoever can plant a snapshot with a repeated owner can equally plant
  one naming a single key they hold, so it is redundant on honest snapshots and
  sidestepped on forged ones. The bounds are not in that bucket — they constrain
  the arithmetic rather than the key material, which is what stops a snapshot
  naming the REAL owners from being shaped so those owners' votes cannot work.

- **…and its own tally, which the bounds alone did not** — bounding `ownerCount`
  and `snapThreshold` left the other three numbers of the decision surface
  (`approvalCount`, `rejectCount`, `status`) exactly as the minter wrote them, and
  that gap was not cosmetic: a 3-of-5 planted with `approvalCount` 1000 and an
  **empty** bitmap passed every bound (5 and 3 are in range; no bit is set, so the
  duplicate-vote guard sleeps), and then ONE owner's approve computed
  `newCount 1001 >= 3` and wrote **Approved**. `requireSaneSnapshot` now also
  requires `approvalCount >= 0`, `rejectCount >= 0` and
  `approvalCount + rejectCount <= ownerCount`; `approve`/`reject` add
  `approvalCount < snapThreshold` and `(ownerCount - rejectCount) >= snapThreshold`
  (both have already required Pending, so a state carrying enough votes to be
  Approved or Failed is a claim about a history that never happened); and `execute`
  adds `approvalCount >= snapThreshold`, because **Approved** is the label KoVault
  and KoRoot both act on without re-deriving anything. Together: `status 0` means
  `0 <= approvalCount < snapThreshold` and `0 <= rejectCount <= ownerCount -
  snapThreshold`; `status 1` means `snapThreshold <= approvalCount <= ownerCount`.
  The negatives matter in both directions — `rejectCount` −1000 makes
  `ownerCount - rejectCount < snapThreshold` unreachable, so a planted proposal
  naming the real owners could never be **Failed** by them. Cost, measured by
  compiling each rule out on its own: +15, +12, +27, +30 and +6 bytes, +90 in
  total (KoProposal 1630 → 1720). Tying the counts to the **bitmaps** is
  deliberately out, and not on cost alone (+959 bytes measured, 1720 → 2679: a 56%
  growth of a script revealed in every vote's signature script): only a genesis
  planter can write an inconsistent count, and he can equally write a consistent
  one that demands the
  same remainder of real signatures — so the rule would reject the clumsier of two
  equivalent forgeries. What these rules buy exactly: every state this contract
  acts on is one a fully self-consistent state could equally present, leaving the
  planter's ability to forge **votes** — which no spend-time rule can reach — and
  not, on top of it, arithmetic no vote could produce. 12 new fixtures
  (8 rejections, 4 boundary acceptances), each rejection verified to die at its own
  `require` line, and a TALLY family in `test-security.sh` where all 8 flip when
  the six lines are stripped.

- **Every contract's fixtures are now generated, and the differential control
  actually bites** — `KoVault.test.json` and `KoProposal.test.json` join
  `KoRoot.test.json` as generated files (`npm run gen:contract-tests`), because
  each bakes something only the compiled contract can produce: a real BIP340
  signature over a sighash that commits to the spent script, the continuation's
  redeem script, or P2SH(compiled KoVault). A stale fixture does not fail loudly
  — it fails EARLY, at the scriptPubKey compare, which is a false green for
  every test that expects rejection. Coverage grew from 54 contract tests to 141
  (KoVault 4 → 25, KoProposal 7 → 53, KoRoot 43 → 63): `executeProposal` had no
  coverage at all, which is why the per-input value bug had no failing test, and
  `approve` had no positive test whatsoever because the debugger cannot
  auto-sign. Both entrypoints now carry real differential
  controls: `KoVault` went from 2 SECURITY tests to 6 and `KoProposal` from 1 to
  2 — and the vault's change output deliberately carries no `script_hex` so that
  it follows a MUTATED contract, without which every new lineage control would
  have been vacuous.

- **Addresses moved.** Every rule in this round changes at least one script, and
  all three compiled sizes moved — KoProposal 1567 → **1720** bytes (+153),
  KoVault 2240 → **2724** (+484), KoRoot 4694 → **6219** (+1525) — measured with
  `silc` and the production constructor arguments `scripts/gen-templates.ts`
  supplies. (KoRoot grows most because it also bakes in the proposal template,
  which grew with KoProposal; its own two input-set walks account for 979 of the
  1525.) So `proposalTemplateHash` (`ef591cea…` → `9963c721…`) and `vaultConstant`
  both move, and with them every derived address. Existing on-chain treasuries keep
  running their old scripts and are unaffected but also **not covered by these
  fixes**; `scripts/treasury-version.mjs` reports them as running an older script,
  and — new this round, and stronger than it sounds — the genesis audit's member
  identity layer derives both covenant members from the templates **this** build
  publishes, so a treasury minted by any earlier build is now REFUSED
  (`not-this-build`) rather than opened. That is deliberate: this build cannot
  derive such a treasury's own addresses, so it could not operate it, and "I cannot
  tell" must not render as "verified". It also means every treasury minted before
  today must be re-minted to be openable — including the TN10 reference treasury.
  If that trade ever needs reversing, the extension is a registry of known
  historical template sets in `genesis.js`, accepting a match against any one of
  them and reporting which; `packages/descriptor/test/fixtures/tn10-build-470be03-templates.json`
  is already the first entry's worth of data.

- **The compiler is pinned, because a security property lives in its output** —
  `scripts/build-compiler.sh` cloned whatever `silverscript`'s `main` was on the
  day someone rebuilt. Two things depend on that not floating. The project's
  central claim is that anyone can recompile the covenants and check the derived
  P2SH against the chain — a moving compiler makes two honest people derive
  different addresses from identical source, and the natural reading of that is
  tampering. And `KoVault.executeProposal` plus both `KoRoot` entrypoints sum the
  inputs paying the active input's script with a bounded `for`, where what makes
  the sum *complete* — what stops a UTXO being parked past the scan window — is
  not in the contract source at all: the compiler emits
  `require(end - start <= max)` before unrolling, and that line carries a `TODO:
  Consider moving check to debug-mode compilation`. Pinned to
  `2c46231`, with the checkout verified rather than assumed. Confirmed the
  regression would be caught rather than trusted to be: with that `require`
  deleted from the compiler and the toolchain rebuilt, KoVault's 17-input
  rejection fixture flips red immediately (and eight of KoRoot's), so
  `npm test` fails the day the TODO lands — the guard-family inventory would not,
  since it pins the loop's shape in the source, not the compiler's output.

- **Genesis policy bounds — a treasury can no longer be minted outside its own rules**
  — `executeConfig` enforced `ownerCount` 1..5 and `threshold` 1..`ownerCount` on
  every *later* change, but the constructor enforced nothing and
  `packages/descriptor` only checked that five owner slots were supplied, so the
  bounds lived solely in the UI. Any non-UI minting path could bake an
  out-of-spec policy into genesis that every co-signer then inherited: with
  `threshold` 0, `threshold <= 1` mints proposals already **Approved**, so one key
  moves funds a co-signer believed were under M-of-N; with `ownerCount` 6,
  `ownerAt()` and `maskFor()` fall through past the last slot and hand index 5
  owner 0's identity and bitmap bit, so an invited sixth signer cannot sign at all
  and their votes land on owner 0. `createProposal` — the only path that can
  create a proposal, and therefore the only path to moving vault funds — now
  checks all four bounds, so a malformed genesis is **unusable rather than
  dangerous**: the vault's rules stay value-preserving, so a bricked treasury
  leaks nothing. `koRootArgs`/`koProposalArgs` reject the same configurations, so
  a wallet integrating `@kosign/descriptor` cannot mint one either. Proven at the
  script layer with real BIP340 signatures over the real Kaspa sighash: the
  fixtures that previously *accepted* `threshold` 0 and `proposerIndex` 5 now trip
  `require(threshold >= 1)` and `require(ownerCount <= 5)`. KoRoot's suite changes
  character rather than appearing: it already existed (43 fixtures, added in
  `7e3966b` with no changelog entry of its own) and the fixtures that *demonstrated*
  these holes — `HYPOTHESIS CONFIRMED createProposal ACCEPTS proposerIndex 5…`,
  `GENESIS UNCHECKED createProposal ACCEPTS a threshold-0 genesis treasury…` — are
  now rejection fixtures asserting the bound fires, alongside new ones for duplicate
  owner slots and the storage-mass floor, and later in the round for the
  root-input value floors (43 → 63). It stays generated by
  `scripts/gen-koroot-tests.mjs` because each fixture carries a real signature
  over a sighash that depends on the compiled script and so cannot be hand-edited.
  Shipped together with the three rules below; the combined address impact is
  recorded there.

- **Covenant lineage is pinned on every spend path** — every entrypoint requires a
  non-zero covenant id on its own input, then pins the exact set of outputs that
  may carry it. Both halves are load-bearing: `OpInputCovenantId` returns
  `ZERO_HASH` rather than an error for an input whose UTXO carries no covenant
  binding (rusty-kaspa `opcodes/mod.rs`), so a bare
  `OpInputCovenantId(a) == OpInputCovenantId(b)` would hold for *any* two unbound
  inputs; and consensus never restricts which outputs inherit a covenant id, so a
  permissionless path without an output pin would be a covenant-minting oracle.
  The counts, via `OpCovOutputCount` / `OpCovOutputIdx`: `createProposal` 2,
  `executeConfig` / `executeProposal` / `deposit` / `approve` / `reject` /
  `execute` 1, `closeExpired` 0. `deposit` additionally requires a genuine
  vault-address covenant UTXO to take part, so a sweep continues the treasury
  rather than starting a new covenant. The contracts' own suites now run in
  `npm test` (`scripts/test-contracts.sh`) — they exercise compiled script
  against synthetic transactions with real covenant bindings, which the JS tests
  cannot do. `npm run test:security` checks all three layers: the invariants
  hold, every contract still carries its full set of guard lines, and — by
  stripping those guards into a throwaway copy — that the tests genuinely fail
  without them. `node scripts/treasury-version.mjs <vaultAddress>` reports which
  template a live vault runs.

- **The object is now a treasury, and the contracts are `Ko*`** — the previous
  rename moved the project to Ko-sign but left the thing it manages called a
  Safe. It is now a **treasury** throughout: UI copy, prose, identifiers, the
  `/#/treasury/:address` route, the `treasuries` table and the `/api/treasuries`
  + `/api/stats {treasuries}` fields. The covenants are `KoRoot`, `KoVault` and
  `KoProposal` (`contracts/Ko*.sil`). **Contract addresses are unchanged** — a
  harness compiled all three from the original and renamed trees with identical
  ctor args and the emitted scripts are byte-identical (1408 / 1638 / 4258 bytes,
  matching sha256 and `state_layout`), because a contract's name never reaches
  its compiled output. `vault` still names the component that holds funds, so
  "Total vault value" and the deposit address read the same as before.
  **Breaking, deliberately** (nothing is launched): the on-chain inscription
  magic is now `KOSGN` (`4b4f53474e`, still 5 bytes), reversing the 2026-08-14
  decision below — every treasury created before this is unrecoverable from chain
  and invisible to the indexer. The wasm was rebuilt because the encoder is Rust;
  `KOSGN` ×1 / `KSAFE` ×0 in the binary, with an encode→decode round-trip and an
  old-payload rejection test. Both indexers need their databases recreated and
  must ship in lockstep with the frontend (the stats field was renamed), and
  bookmarked `/#/safe/…` URLs now 404.

- **The "which build does this treasury run?" check now reads BOTH covenants, and
  the compile is pinned in CI** — `scripts/treasury-version.mjs` reconstructed the
  vault alone and printed "✓ current", calling itself "a cryptographic identity
  check — not a guess". It was one, of half the treasury. That was sound only while
  the two scripts moved together; the genesis-bounds change above moved **KoRoot
  alone** with the vault constant byte-identical, so a treasury minted by the
  previous build reconstructed its vault exactly and was certified current while
  its KoRoot was still the old, unbounded script — the very contract that changed,
  and the one that decides who may move money. It now rebuilds the root too, from
  the chain-recovered state (`rebuildRoot(0, threshold, ownerCount, owners)`
  against genesis output 0, then `proposalScan.walkRoot` forward to the live root),
  reports a verdict **per contract**, and exits `3` on a root it could not locate
  instead of implying the treasury is fine. Three process gaps closed alongside:
  CI now recompiles the contracts and requires `frontend/src/treasuryTemplates.js`
  to be byte-identical (nothing pinned the browser's address derivation to a fresh
  compile — a skipped regeneration left every suite green while the app derived
  addresses for a script that no longer exists); the toolchain assertion covers
  `examples/silc_dbg`, which the KoRoot fixtures are signed against; and
  `scripts/verify-contracts.sh` — a hand-listed duplicate that omitted KoRoot and
  all of its fixtures — is deleted, with `pnpm verify:contracts` now running the
  globbing `scripts/test-contracts.sh` (extended to cover `contracts/probes/`).

## 2026-08-14

- **The project is now Ko-sign** — the name leads with the action the product and
  the business are both built on: co-signing. Applied across 90 files: prose and
  UI strings, `KOSIGN_*` env vars, package names, the npm scope `@kosign/*`,
  localStorage keys (`kosign.*`), Postgres and compose identifiers, and the four
  committed wasm artifacts (`kosign_wasm_tx.*`). The wasm binary is byte-identical
  — the bundle still hashes to `kosign_wasm_tx_bg-CrBTtZTI.wasm` — so nothing was
  recompiled and the covenant/fee tests exercise the same artifact as before.
  **The `KSAFE` on-chain inscription magic is deliberately unchanged**: it is
  written into the genesis payload of every treasury that already exists, so renaming
  it would leave every one of them unrecoverable and blind the stats indexer to
  them. No client-side storage migration ships with this, by design — the chain is
  the source of truth, so a browser holding no local state rebuilds a treasury on
  first open (`recoverTreasuryFromChain` → `seedFromChain`, which needs only the vault
  address) and owners re-import their signing key. Deployments need two manual
  steps the code cannot do for them: rename the GitHub repository, and rename the
  Postgres role and database plus carry the volumes over to the new compose
  project name before bringing an indexer up.

## 2026-08-04

- **Self-hosted Inter — no asset is fetched from a third party** — the
  sans font was still pulled from fonts.googleapis.com, which sent every
  visitor's IP to Google and let a third party ship arbitrary CSS into a wallet
  UI (and SRI cannot pin that request, since the response varies by
  User-Agent). Inter is now bundled via `@fontsource`, exactly as Fira Code
  already was. The built app now loads **every byte of code, font and style from
  its own origin**. Runtime data is a separate question and still leaves the
  browser: the Kaspa node, the REST indexer, the optional stats service, and
  `api.coingecko.com` for the KAS/USD figure — the last of these is the one
  party in that list with no role in the protocol, and it sees a request from
  every open Assets page. Tracked as an open item rather than claimed closed.
- **CI + tests wired into `npm test`** — GitHub Actions runs the unit tests,
  workspace package tests, typecheck and the frontend build on every push and
  PR. The 25 covenant/fee/sweep unit tests load the *committed* browser wasm
  artifact, so they need no Rust toolchain and no install. Fixing the harness
  surfaced three pre-existing breakages, now repaired: the descriptor state
  codec could not encode its own numeric-enum fields, and the descriptor +
  signer tests still described the pre-mutable-owners 114-byte proposal state
  (the live layout is 315 bytes).
- **Owner-funded covenant ops — the fee cap can no longer freeze a treasury** —
  approve, reject, execute and config-execute now pay their network fee from
  the connected owner's wallet, leaving the covenant output at full value; the
  contracts' 0.1 KAS fee caps stop being a ceiling, so no future feerate rise
  can make a treasury unspendable. The treasury also keeps more value (the bond and
  vault are no longer nibbled). Covenant-funded remains the fallback for an
  empty wallet. Proven on-chain with a 0.2 KAS fee — 2× the cap — accepted by
  the node. See [docs/FEES.md](docs/FEES.md) and RISKS #11.
- **Dynamic mass-priced fees for every flow** — genesis (38× cheaper), create
  proposal (10×), approve/reject (10×), execute (2.7×), config-execute (2.4×)
  now price their network fee from the node-exact tx mass via the new
  `borsh_masses` wasm export, with a zero-sig probe, per-proposal maxFee caps
  decoded from covenant state, small-change folding, exact `meta.fee` state
  tracking, and a "required amount of N" re-sign retry. The covenants' fee
  rules are caps, not equalities, so no contract change or migration was
  needed. On-chain validated with a full 2-of-2 matrix (11 txs: 0.114 KAS paid
  vs 0.80 legacy). See [docs/FEES.md](docs/FEES.md).

## 2026-08-03

- **Batched sweeps — thousands of deposits in chained ≤16-input txs** (`c371e8e`)
  — the covenant caps a sweep at 16 inputs, so large deposit sets consolidate as
  a chain of batches, each spending the previous batch's still-in-mempool
  outputs. Pre-sweep quote, per-batch progress, stop-after-batch, 0.05 KAS dust
  floor with include-dust toggle. Compute budgets calibrated 120 → 2
  (engine-measured, node-verified) — per-deposit sweep cost drops ~7× to
  ~0.0035 KAS. On-chain E2E on TN10. See [docs/SWEEP.md](docs/SWEEP.md).
- **Dynamic mass-based sweep fees** (`b6a3827`) — node v1.2.1-toc.3 raised the
  min relay fee to 100 sompi/gram; sweep fees are now sized from the wasm-exact
  tx mass (node-validated to the sompi), with small-change folding and a
  self-correcting resubmit that adopts the node's demanded fee.

## 2026-07-09 → 07-15

- **Stats indexer in production on both networks** (`990b565`…`3d1d6c9`) —
  chain-verified treasury registry (Docker + Postgres, RPC chain follower with a
  persistent cursor), one VM serving the per-network API hosts; landing
  page shows live usage numbers with stale-cache fallback.

## 2026-07-02 → 07-05

- **Chain-verified landing stats** (`c172ebd`, `513cca7`) — per-network treasury
  registry + usage strip.
- **Value-preserving sweeps** (`8fa3232`) — KoVault enforces
  `output0 ≥ vault inputs`; the sweeper pays the fee, closing a fee-burn
  griefing vector. Sweep is owner-only in the UI.
- **KasWare wallet integration** (`d3c1547`) — identity + deposits (covenant
  P2SH signing stays with the imported key); two-pane wallet picker.
- **Standalone frontend** (`cfc419f`) — default public-node endpoint baked in,
  zero-backend out of the box; official public RPC resolver + mainnet/testnet
  switch (`2987e43`). Whitepaper v1 (`bb55b30`).

## 2026-06-24 → 06-27

- **Route B: everything builds in the browser** (`9465e27`…`3600b8b`) — covenant
  txs built in wasm client-side, submitted node-direct over JSON wRPC; zero
  backend for propose/approve/reject/execute/config. Co-owners discover each
  other's proposals from chain alone (`f5a00e0`); reject votes (`2b1c7ca`).
- **Tier-1 on-chain recovery** (`97599ed`) — `KSAFE` inscription in the genesis
  payload rebuilds a treasury from chain alone. See [docs/RECOVERY.md](docs/RECOVERY.md).
- **Mutable owners** (`42be25a`) — add/remove signers at a stable address
  (owners live in covenant state). See [docs/OWNER-MANAGEMENT.md](docs/OWNER-MANAGEMENT.md).
- **Owner-signed execute + browser signer** (`6461a9b`) — client-side signing
  end to end; concurrent proposals.

## 2026-06-18

- **Initial release** (`65ef46b`, `f5ad1ec`) — KoRoot/KoVault/KoProposal
  covenants live on TN10 with the full on-chain proposal lifecycle and a web UI;
  unique per-treasury vault addresses via a salted redeem script.
