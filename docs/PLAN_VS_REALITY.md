# plan.md assumptions vs. verified reality

Built against the real Toccata/Silverscript compiler (cloned + built, rustc 1.96)
and the TN10 endpoint. ✅ verified · ⚠️ holds with caveat · ❌ wrong/changed.

| plan.md assumption | Reality | Notes |
|---|---|---|
| Toccata / covenant features exist | ✅ | Live on testnet; mainnet ~2026-06-30. |
| Silverscript compiler `silverc x.sil` | ⚠️ | Real CLI is `silverc`, files are `.sil` (plan was right) — but **no published binary**; build from source (rustc ≥ 1.90). We use a clap-free `examples/silc`. |
| `TransactionOutput.covenant` / `authorizing_input` / `covenant_id` | ✅ | Exposed as `OpInputCovenantId`, `OpCov*` (KIP-20). Binding modes auth/cov. |
| introspect inputs/outputs/scriptPubKey/values | ✅ | `tx.inputs[i].value/.scriptPubKey`, `tx.outputs[i]...`, `this.activeInputIndex`. |
| `validateOutputState` for continuation | ✅ | `validateOutputState(idx, {…})`; `validateOutputStateWithTemplate(...)` for foreign template. |
| `readInputStateWithTemplate` for foreign state | ✅ | Exact signature `(idx, prefixLen, suffixLen, expectedTemplateHash)`; needs a **declared struct** to bind into (not inline destructuring). |
| verify foreign input via covenant_id / template hash | ✅ | Both available; we use covenant-id + template-hash (KCC20Minter pattern). |
| proposal can enforce age/timelock when spent | ⚠️ | `this.age` compiles & is used; **confirm it gates on-chain** (KIP-10 reserves the age opcode). |
| fee/mass uses current node policy | ⚠️ | Must account for **storage mass (KIP-9)** — small UTXOs are expensive. plan didn't. |
| `tx.time <= expiresAt` blocks expired execution | ❌ | `tx.time` is lower-bound only; expiry enforceable on close (`>=`) not execute (`<=`). |
| `treasuryId` chosen = covenant_id, computed at genesis | ⚠️ | Correct instinct; builder must **precompute** covenant id before signing genesis. Verify derivation. |
| symmetric Vault↔Proposal template verification | ⚠️ | Vault→Proposal uses template hash; Proposal→Vault uses covenant-id only (avoids circular hash). |
| `1 << ownerIndex` for bitmap | ❌ | No shift operator. Replaced with an if-chain `bitFor()` helper. |
| owners as indexed array `owners[i]` | ❌ | No dynamic array indexing in practice. Replaced with 5 explicit params + if-chain `ownerAt()`. |
| 3-of-5, single vault, single transfer, migration, PSKT, TN tests | ✅ (scope) | MVP scope adopted. PSKT signing + on-chain tests blocked on SDK (see RISKS #1). |
| `silverc` JSON artifact (script, abi, template hash) | ⚠️ | Artifact has `script`, `abi`, `state_layout{start,len}` — **template hash is derived** by us from `state_layout` (descriptor), not emitted directly. |

**Net:** the architecture is sound and largely matches the real primitives. The
real corrections are operator/array ergonomics (shift, indexing), the timelock
asymmetry, storage mass, and the (large) tooling/SDK maturity gap.
