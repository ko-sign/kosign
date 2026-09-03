# Ko-sign contracts

Silverscript (`.sil`) covenants. Compiled with the locally-built compiler — see
[../scripts/build-compiler.sh](../scripts/build-compiler.sh). All files here
compile clean against the real compiler (Toccata / `rusty-kaspa` tn12 branch).

## Core

| File | Entrypoints | Purpose |
|---|---|---|
| `KoProposal.sil` | `approve`, `reject`, `execute`, `closeExpired` | one proposal's on-chain state machine (bitmap approvals + rejections) |
| `KoVault.sil` | `executeProposal`, `deposit` | treasury; releases funds only for an Approved proposal of the same covenant, and sweeps stray deposits into it |
| `KoRoot.sil` | `createProposal`, `executeConfig` | treasury config + proposal factory; applies approved signer/threshold changes |

State field order is shared across all three (and `@kosign/descriptor`); do not
reorder without updating the mirrors. See [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

## Probes — run these on the target node FIRST

These verify the load-bearing primitives actually work on-chain before trusting
the full system (see [../docs/RISKS.md](../docs/RISKS.md)):

| Probe | Verifies |
|---|---|
| `probes/probe_covenant_id.sil` | `OpInputCovenantId` + `OpCov*` group enumeration (lineage) |
| `probes/probe_read_template.sil` | `readInputStateWithTemplate` cross-template foreign read |
| `probes/probe_validate_output.sil` | `validateOutputState` continuation |
| `probes/probe_age_time.sil` | `this.age` / `tx.time` timelocks |

## Compile

```bash
../scripts/compile.sh KoProposal.sil args/KoProposal.json   # one file
../scripts/compile-all.sh                                        # everything -> ../artifacts/
```

`args/*.json` are **placeholder** constructor args for compile checks only. Real
per-treasury args are produced by `@kosign/descriptor` at deploy time (the proposal
template prefix/suffix/hash baked into Root/Vault must come from the actually
compiled `KoProposal` — see the deploy order in ARCHITECTURE.md).

## Tests

`*.test.json` are fixtures for the Silverscript **cli-debugger**, run by
[../scripts/test-contracts.sh](../scripts/test-contracts.sh) and
[../scripts/test-security.sh](../scripts/test-security.sh) on every `npm test`.

All three `*.test.json` files are **generated, not hand-written**, because each
one bakes a value that only the compiled contract can produce:

| fixture | generator | what it bakes |
| --- | --- | --- |
| `KoRoot.test.json` | `scripts/gen-koroot-tests.mjs` | real BIP340 signatures over the real Kaspa sighash, which commits to the spent input's scriptPubKey — i.e. to the *compiled* KoRoot script |
| `KoProposal.test.json` | `scripts/gen-koproposal-tests.mjs` | the same signatures, plus the continuation output's redeem script (the proposal STATE lives in the script, so every vote changes the address) |
| `KoVault.test.json` | `scripts/gen-kovault-tests.mjs` | P2SH(compiled KoVault) — `executeProposal` returns change to the vault's own address — and the pinned KoProposal template |

Change one byte of a contract and a stale fixture stops testing what its name
says: a signed one fails at `checkSig`, and a vault one fails at the scriptPubKey
compare *before* reaching the rule it was written for — a **false green** for
every test that expects `fail`. So after any edit to a contract:

```bash
npm run gen:contract-tests    # all three; or gen:koroot-tests / gen:kovault-tests / gen:koproposal-tests
npm run test:contracts && npm run test:security
```

The generators compile through `examples/silc_dbg` (`record_debug_infos: true`),
because that is what the debugger runs and it emits **different bytes** from the
production `silc`. See the header of
[../scripts/gen-koroot-tests.mjs](../scripts/gen-koroot-tests.mjs).

A test may only be named `SECURITY` if stripping the lineage guards makes it
**pass** (`scripts/test-security.sh` proves the suite bites by requiring exactly
that). A signed fixture can never qualify *against the checked-in fixtures*:
deleting any line moves the script, hence the address, hence the sighash, so it
fails for a reason unrelated to the guard. Those are labelled `[weak: …]`
instead. `KoVault.executeProposal` and `KoProposal.closeExpired` check no
signature, which is why the label-driven differential controls live there.

The other guard families — owner-slot distinctness, threshold/ownerCount bounds,
the proposal's tally invariant, the value floors — are pinned by tests that mostly
live on signature-gated paths, so `test-security.sh` gets around the staleness above by
**rebuilding the fixtures against the mutant**: it runs the generators below over
a throwaway mirror of the repo whose contract has the family stripped out, so the
signatures are valid for the mutant and the only thing that can change a verdict
is the missing guard. Those families select their tests by NAME pattern instead
of by label — which means renaming one of them away is itself a failure ("no test
matches …"), and is why the names in the generators should describe the guard the
test actually trips. Run `bash scripts/test-security.sh --rederive` to print the
per-family guard counts and flip counts as the current tree has them.

Adding a rule means adding (or extending) its family in the same commit. The
inventory only counts what a family's regex matches, so a rule no family describes
is pinned by nothing — which is exactly how six new `require` lines in KoProposal
and two new bounded loops in KoRoot were briefly invisible to a harness that was
reporting green. The one family that cannot have a negative control is `SCAN`: a
contract with the loop header deleted does not compile, so it is inventory-only and
the VALUE require that consumes its sum is the strippable half.

## Language notes (gotchas found the hard way)

- No shift operator (`<<`): use the `bitFor()` if-chain for `2^index`.
- No dynamic array indexing: owners are 5 explicit params + `ownerAt()` if-chain.
- `readInputStateWithTemplate` must bind into a **declared `struct`**, not inline
  destructuring.
- `validateOutputStateWithTemplate` takes a **bare object literal** `{…}` (no
  struct-type prefix) for the new state.
- `tx.time` is a lower bound only — see RISKS #3.
