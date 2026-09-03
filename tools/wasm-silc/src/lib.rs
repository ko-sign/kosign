// Compile a Silverscript contract to its JSON artifact (script bytes + state
// layout + abi), exactly like the native `silc` front-end, but in wasm so the
// browser can compile a treasury's contracts with no backend. Mirrors
// .tooling/silverscript/silverscript-lang/examples/silc.rs.
use silverscript_lang::ast::Expr;
use silverscript_lang::compiler::{compile_contract, CompileOptions};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn compile_sil(source: &str, ctor_json: &str) -> Result<String, JsError> {
    // Own both inputs so the borrowed AST/Expr lifetimes unify for compile_contract.
    let src = source.to_owned();
    let cj = ctor_json.to_owned();
    let ctor: Vec<Expr> = if cj.trim().is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(&cj).map_err(|e| JsError::new(&format!("ctor parse: {e}")))?
    };
    let c = compile_contract(&src, &ctor, CompileOptions::default())
        .map_err(|e| JsError::new(&format!("compile error: {e}")))?;
    serde_json::to_string(&c).map_err(|e| JsError::new(&format!("serialize: {e}")))
}
