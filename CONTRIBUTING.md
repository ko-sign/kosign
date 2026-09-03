# Contributing to Ko-sign

The covenants are the security model. Everything else is a client that talks to
them — so the bar for a change scales with how close it sits to the money.

Working on the web UI only? [frontend/CONTRIBUTING.md](frontend/CONTRIBUTING.md)
is the shorter, self-contained guide; you do not need the compiler for it.

## Build

```sh
pnpm install
pnpm build:compiler      # clones + builds Silverscript (rustc >= 1.90); cached after the first run
pnpm test                # wasm manifest · unit · packages · contracts · guard mutation suites
```

`pnpm test` is the whole gate and it must be green before you send anything. The
contract suites need the compiler from `build:compiler`; the rest do not.

## The two mutation harnesses

These are the unusual part of this repo, and the part most likely to reject an
otherwise-correct PR.

- `scripts/test-security.sh` — for each family of covenant guards, deletes the
  family from a throwaway copy of the contract and requires the tests pinning it
  to fail. A guard nothing fails without is a guard a refactor can delete.
- `scripts/test-js-guards.sh` — the same discipline for the code no Kaspa node
  checks: the spend guard, the transaction decoder, the genesis auditor, the
  proposal scanner. One rule per line, each removable by a one-line `perl`
  expression, each required to break a **named** test.

**If you add a check that protects funds, add its mutation rule too.** If you
remove or move one, update its rule — a rule whose expression no longer matches
is reported as a failure, not skipped, precisely so it cannot rot.

## Generated files

Do not hand-edit: `frontend/src/treasuryTemplates.js` (and its mirrors),
`frontend/src/wasm/`, `contracts/*.test.json`. They are rebuilt as a set:

```sh
node_modules/.bin/tsx scripts/gen-templates.ts --write   # after any contract change
pnpm run gen:contract-tests                              # contract fixtures
pnpm build:wasm                                          # the browser's tx builder
```

A stale `treasuryTemplates.js` is not a cosmetic problem: the genesis auditor
derives the covenants it demands from that file, so a stale copy is a security
check pointed at contracts nobody runs. CI recompiles and requires byte identity.

## Verifying on-chain

Behaviour changes to covenant operations are merged on evidence, not argument.
Run the flow on **testnet-10** and put the txids in the PR. TN10 funds are free
([faucet](https://faucet-tn10.kaspanet.io/)); `frontend/test/*.manual.mjs` are
the scripted lifecycle runs and are deliberately excluded from `pnpm test`
because they spend real testnet coin.

## Pull requests

1. One concern per PR.
2. Say **what changed and how you verified it**. For covenant operations, TN10
   txids. For guards, the mutation rule that now pins it.
3. Comments explain *why* — the chain quirk, the attack, the constraint. What
   the code does is already in the code.
4. Monetary values are **sompi integers** end-to-end; format to KAS only at the
   render boundary.

## Security issues

**Never open a public issue.** See [SECURITY.md](SECURITY.md) — private
reporting via GitHub Security Advisories, acknowledged within 72 hours.
