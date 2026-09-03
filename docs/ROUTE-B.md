# Route B — browser-side covenant tx building (WASM)

Goal: the user shouldn't have to trust a backend to **build** their covenant
transactions. Route B compiles the proven Toccata tx-building logic to WebAssembly
so the **browser** builds every covenant flow itself; signing is already client-side
(@noble). The only residual backend is a thin, stateless **relay** that forwards a
finished, signed transaction to the node.

This complements route A (the local backend) — they converge: route B moves
*building* into the browser; the relay (route A's stateless relayer) only submits.

## Two operating modes

**Node-direct (zero backend)** — point the ⚙ at a node's **JSON wRPC** endpoint
(`kaspad --rpclisten-json`, testnet-10 port 18210). The browser then talks straight
to the node: `getUtxosByAddresses` (returns covenantId + outpoint) for inputs,
`submitTransaction` for submit. Combined with the wasm builder + @noble signing,
operating needs **no backend at all**. Verified on a real TN10 node end-to-end
(`frontend/src/wrpc.js`, `borsh_to_rpc_json`). The node's JSON wRPC `RpcTransaction`
is fully Toccata-aware (covenant + compute_budget + payload), unlike api-tn10's REST
`SubmitTxModel` (pre-Toccata — drops them).

**Relay (when there's no browser-reachable node)** — the browser still builds + signs,
and a thin stateless relay forwards the finished tx (`submit-tx`). Needed because the
node's *Borsh* wRPC isn't browser-speakable (the wasm wRPC client pulls `rustls`,
which doesn't compile to wasm) and api-tn10's REST submit is pre-Toccata. The relay
holds no keys/state — it's swappable/public.

## The wasm tx-builder (`tools/wasm-tx`)

`kosign-wasm-tx` compiles `kaspa-consensus-core` + `kaspa-txscript` (wasm32-sdk) to
wasm. Signing stays in JS, so secp256k1 isn't needed at runtime (it still compiles —
needs LLVM clang for its C, see below). Release + DCE strips the unused Groth16
verifier: debug 43MB → release 741KB → `wasm-bindgen --target web` 272KB → **~100KB
gzipped**.

Each flow has a two-phase API mirroring the native `kaspa-probe` tools:
`<flow>_sighash(inputsJson)` → the data the owner signs, and
`<flow>_build(inputsJson, sigHex)` → the signed tx as Borsh hex (for the relay).
State encoding (int = OP_DATA_8+8LE, bytes32 = OP_DATA_32+32, splice, bitmap) matches
the Silverscript compiler exactly. Flows: `genesis`, `create_proposal`, `approve`,
`execute`, `execute_config`, `build_sweep` (no sig); helpers `recipient_info`,
`config_commit`, `inscription`.

**Verified end-to-end on TN10** — each flow built entirely client-side in wasm,
signed with @noble (same code as `signer.js`), submitted via the relay, and ACCEPTED
by the node: a full transfer lifecycle (create → approve → execute), a full config
change (2-of-3 → 2-of-2 via executeConfig), a fresh genesis (a treasury + its KOSGN
inscription), and a sweep. The `probe_sighash` / `build_sweep` outputs are also
byte-identical to the same code run natively.

> Genesis caveat: the node assigns a different txid than the local build for the
> covenant-genesis tx (mass canonicalization with the payload), so use the relay's
> returned txid for the genesis outpoints. The treasury + inscription are correct.

## Frontend wiring

- `frontend/src/wasm/` — the prebuilt ESM bundle (committed so `pnpm build` needs no
  Rust/wasm toolchain). `frontend/src/wasmTx.js` loads it and runs the pipeline.
- Backend (stateless, no keys): `GET /api/treasury/:id/wasmctx` returns the public data
  the builder needs (compiled scripts + layouts + live covenant UTXOs);
  `POST /api/treasury/:id/relay` forwards a Borsh tx to `submit-tx`.
- **Every flow is wired to route B** for client-signed treasuries: sweep, propose, approve,
  execute, and signer-change all go GET wasmctx → build in the browser (wasm) → sign
  with `signer.js` → POST relay. The relay tracks the advancing state (proposal
  create/approve/consume, root nonce, owner-set install) so the backend view stays
  consistent. Generate-mode (backend-key) treasuries keep the old backend path.
- Verified end-to-end through the real backend endpoints on TN10: a full transfer
  lifecycle (propose→approve→execute) and a full config change (2-of-3 → 2-of-2),
  every tx built client-side and accepted by the node.

## Toolchain (rebuilding the wasm)

```
rustup target add wasm32-unknown-unknown
brew install llvm                          # clang with a wasm target (for secp256k1's C)
cargo install wasm-bindgen-cli --version 0.2.100   # must match the wasm-bindgen crate

npm run build:wasm     # rebuild, install into frontend/src/wasm/, record the manifest
npm run verify:wasm    # rebuild and require the committed artefacts to match, byte for byte
```

Do not build it by hand. `scripts/build-wasm.sh` is the only sanctioned path
because the artefact it produces is committed and verified, and three things had
to be pinned before "rebuild it and compare" could mean anything: `Cargo.lock` is
now tracked (it was gitignored, leaving 392 dependency versions unrecorded),
`tools/wasm-tx/rust-toolchain.toml` fixes rustc, and the script passes
`--remap-path-prefix` so the binary stops carrying the builder's home directory.
An ad-hoc `cargo build` skips all three and produces a blob that only the machine
that made it can reproduce. See [WASM-PROVENANCE.md](WASM-PROVENANCE.md).

getrandom 0.3's wasm backend is selected via `.cargo/config.toml`
(`--cfg getrandom_backend="wasm_js"`); note that setting `RUSTFLAGS` as an
environment variable REPLACES that file's flags rather than adding to them, which
is why the build script repeats the cfg. For Node verification use
`--target nodejs` and drop a `pkg/package.json` `{"type":"commonjs"}` (the repo is
`type: module`).

## Not covered

- Contract **compilation** (build-treasury / silc) is still native — "create treasury" needs
  it for the scripts. A wasm silc is a separate, larger port.
- UTXO fetch with outpoint+covenant_id needs the node or a covenant-aware indexer;
  api-tn10's UTXO model lacks both, so the backend (or such an indexer) provides it.
