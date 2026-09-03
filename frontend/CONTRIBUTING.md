# Contributing to Ko-sign

Thanks for your interest!

## Getting started

```sh
npm install
npm run dev            # http://localhost:5173
```

That's it — the app runs fully standalone against Kaspa **testnet-10** using
public nodes and public REST indexers. For a wallet to play with:

1. Generate a throwaway key (any 64-hex string from a CSPRNG) and import it
   via **Connect Wallet → Manual key**.
2. Fund its address from the [TN10 faucet](https://faucet-tn10.kaspanet.io/).
3. **Create treasury** — genesis is built, signed and submitted from your browser.

Everything a PR touches can be exercised on live testnet for free. We treat
"validated on TN10" as the bar for merging behavior changes.

## Ground rules

- **The frontend must stay standalone.** No feature may *require* a backend,
  an API key, or our infrastructure. Optional integrations (like the
  landing-page stats service) must degrade gracefully to nothing.
- **Keys never leave the browser.** No code path may transmit private keys or
  signatures over anything but the signed transaction itself.
- **The chain is the source of truth.** UI state must be reconstructible from
  on-chain data; `localStorage` is a cache, not a database.
- **Don't edit generated files by hand**: `src/wasm/` (the compiled covenant
  transaction builder) and `src/treasuryTemplates.js` (the covenant script
  templates) are build artifacts, updated as a set by maintainers. PRs that
  hand-modify them will be declined — describe the needed change in an issue
  instead.

## Style

- Plain React + Vite, no state-management framework — keep it that way unless
  a PR demonstrates real pain.
- Match the existing code: small modules, `camelCase`, comments explain *why*
  (constraints, chain quirks), not *what*.
- Monetary values are **sompi integers** end-to-end; format to KAS only at the
  render boundary.
- User-visible failures must surface in the UI (not only the console dock).

## Pull requests

1. One concern per PR; keep diffs reviewable.
2. Describe **what changed and how you verified it** — for anything touching
   covenant operations, include the TN10 txids of your validation run.
3. `npm run build` must pass warning-free.
4. UI changes: include a screenshot; the design language is the existing
   sci-fi/terminal aesthetic — glowing accents on dark, mono for data.

## Reporting bugs

Use GitHub issues for non-security bugs, with reproduction steps and the
network/endpoint you were on. **Security issues: see [SECURITY.md](SECURITY.md)
— never open a public issue.**
