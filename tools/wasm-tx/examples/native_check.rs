// Native reference: call the same probe_sighash the wasm build exposes, with fixed
// test vectors, so we can compare the browser-wasm output byte-for-byte.
fn main() {
    let prev = "11".repeat(32);
    let redeem = "aabbccddeeff00112233"; // 10-byte placeholder redeem
    let amount: u64 = 500_000_000;
    let treasury_id = "22".repeat(32);
    println!("{}", kosign_wasm_tx::probe_sighash(&prev, redeem, amount, &treasury_id));
}
