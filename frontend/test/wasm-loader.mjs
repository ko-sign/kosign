// Load the SAME wasm build the browser ships — frontend/src/wasm is committed,
// so tests exercise exactly what users get and CI needs no Rust toolchain.
// (The nodejs-target pkg under tools/wasm-tx/pkg is a local build artifact and
// is gitignored; the web target's init() accepts raw bytes, which works in Node.)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const W = await import("../src/wasm/kosign_wasm_tx.js");
await W.default({ module_or_path: readFileSync(fileURLToPath(new URL("../src/wasm/kosign_wasm_tx_bg.wasm", import.meta.url))) });

export default W;
