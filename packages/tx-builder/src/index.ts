export * from "./plans.js";
import type { TxPlan } from "./plans.js";

/**
 * Serialize a TxPlan into a signable Kaspa PSKT with covenant-bound outputs.
 *
 * BLOCKED: no published Kaspa SDK yet exposes covenant-bound output
 * construction (covenant id binding, authorizing input, state-carrying P2SH
 * outputs) for Toccata. Options, in order of preference:
 *   1. wait for / vendor a Toccata-capable kaspa-wasm build (tn12 branch).
 *   2. build the transaction via the rusty-kaspa Rust SDK behind a small CLI.
 *   3. hand-assemble the script/PSKT bytes (last resort).
 * See docs/RISKS.md "SDK gap" and docs/ARCHITECTURE.md.
 */
export function realize(_plan: TxPlan): never {
  throw new Error(
    "realize(): covenant tx serialization needs a Toccata-capable Kaspa SDK (not yet published). " +
      "The TxPlan defines the exact graph; see docs/RISKS.md for the unblock path.",
  );
}
