# Wasm provenance — tying the committed binary to the Rust it claims to come from

`frontend/src/wasm/kosign_wasm_tx_bg.wasm` builds every transaction an owner
signs. It chooses the amount, the recipient, and the covenant continuation; the
signature an owner produces authorises whatever that blob assembled. It is a
committed binary, and until this was written nothing in the repository connected
it to `tools/wasm-tx/src/lib.rs`.

Reviewing the Rust therefore proved nothing about the product.

## The two failures this closes

**The routine one, which has nothing to do with an attacker.** Edit `lib.rs`,
forget to rebuild. Every suite in the repo stays green — because every suite
exercises the *old* blob. The fix you can read in the diff is not in the app, and
nothing says so. This is not hypothetical: `lib.rs` and the `.wasm` were both
modified in the same commit more than once during development, with no check that
they corresponded.

**The supply-chain one.** A blob that was never built from this source at all.
Nobody could have detected it, because there was nothing to compare against.

## What was in the way

"Rebuild it and compare" is only meaningful if a rebuild is deterministic. Three
things had to be fixed first, and each was silent:

| Problem | Effect |
|---|---|
| `Cargo.lock` was gitignored | 392 packages, no version recorded. A rebuild resolved crates.io afresh, so two honest people building the same commit got different binaries — and nobody could say which `serde_json` was inside the code that decides a recipient address. |
| rustc was unpinned | Instruction selection, inlining and section ordering are the compiler's choice. A different rustc is a different binary from identical source. |
| Build paths were embedded | rustc records the path of every file it compiles. The shipped blob carried **47 occurrences of one developer's home directory** and could only ever be reproduced by that one account — and leaked a username to everyone who loaded the app. |

Fixed by tracking the lockfile, adding `tools/wasm-tx/rust-toolchain.toml`, and
passing `--remap-path-prefix` for both `CARGO_HOME` and the repo root. The build
script asserts the remap worked rather than trusting the flag, because a typo in
a prefix fails silently.

## The two tiers

**`node scripts/wasm-manifest.mjs`** — runs in `npm test`, needs no toolchain at
all. `frontend/src/wasm/MANIFEST.json` records the sha256 of the four artefacts
*and* of the five build inputs (`lib.rs`, `Cargo.toml`, `Cargo.lock`,
`rust-toolchain.toml`, `.cargo/config.toml`). Source hashes moving while artefact
hashes stand still is exactly the "forgot to rebuild" case, and it is reported in
those words. This tier is the gating one, because it runs everywhere.

**`npm run verify:wasm`** — rebuilds from source and compares byte for byte. This
is the tier that proves the blob came from the source; the manifest alone cannot,
since whoever swapped a blob could also update a manifest. Incremental, so it
costs about half a second once the object cache is warm.

`npm run build:wasm` does the same rebuild and *adopts* the result: installs the
four artefacts and rewrites the manifest. That is the only sanctioned way to
change the committed wasm.

## The canonical build is the container

`secp256k1-sys` compiles C with the host clang and some of it survives into the
wasm, so a laptop build is byte-reproducible by exactly one account on one machine.
That is not reproducibility, it is a coincidence with good paperwork — and it is
useless to anyone auditing an open-source wallet.

`tools/wasm-tx/Dockerfile.repro` fixes every input the build reads:

| Input | Pinned by |
|---|---|
| base image | its **digest**, not a tag — a tag is a moving pointer |
| apt packages | `snapshot.debian.org` at a fixed date, so `apt-get install clang` resolves the same next year as today |
| rustc | the image, which `rust-toolchain.toml` then agrees with |
| wasm-bindgen | the version read out of `Cargo.lock`, not written twice |
| dependencies | the tracked `Cargo.lock` |
| source paths | `--remap-path-prefix`, to the same `/cargo` and `/src` the host script uses |

The committed artefacts come from that container. Adopting it changed all four
files, which is the point: the previous ones were built with Homebrew clang 22.1.8
and could only ever be reproduced by that machine. The container uses Debian clang
14.0.6, and so will anyone who runs it.

| Command | Who can run it | What it establishes |
|---|---|---|
| `npm test` | anyone, no toolchain | the committed blob matches its recorded sources |
| `npm run verify:wasm` | anyone with Docker | **the blob is what this source builds** |
| `npm run verify:wasm:host` | a matching toolchain | the same, faster, locally |

`scripts/build-wasm.sh --write` **refuses** by default. Writing a host build over
the committed artefacts is how reproducibility dies quietly: one person regenerates
the wasm on a laptop and nobody can ever reproduce it again. Overriding it needs
`--not-reproducible`, spelled out.

A host rebuild against a differently-built artefact reports the two toolchains side
by side and says the difference is expected — reporting it as tampering would train
people to ignore the tool.

## Proving the checks bite

A check nobody has tried to defeat is a check nobody should trust. Both tiers
were verified by mutation, the same discipline `scripts/test-security.sh` applies
to the covenants:

| Mutation | Must be reported as |
|---|---|
| `lib.rs` edited, wasm untouched | the Rust changed and the wasm was not rebuilt |
| `.wasm` byte appended, sources untouched | the committed wasm is not the one the manifest records |
| `Cargo.lock` edited | source drift |
| both sides edited | both moved without the manifest being updated |
| `rust-toolchain.toml` deleted | source drift |
| clean tree | passes — otherwise the five above are noise |
| `.wasm` tampered, full rebuild | byte comparison fails |
| `ROOT_PROPOSAL_VAL` 50 → 60 KAS in `lib.rs`, full rebuild | byte comparison fails |
| `cargo`/`wasm-bindgen` absent | **exit 1**, never a silent pass |

That last row is deliberate. `scripts/test-contracts.sh` once exited 0 when the
debugger was missing, so `npm test` reported success having run zero contract
tests. A verification tool that quietly does nothing is worse than no tool, since
it converts an unknown into a false assurance.
