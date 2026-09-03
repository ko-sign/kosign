// Native reference for build_sweep — same fixed inputs as the wasm test, prints
// the resulting TXID so we can confirm the browser-wasm build is byte-identical.
use kaspa_consensus_core::tx::TransactionId;
use kaspa_hashes::Hash;
use std::str::FromStr;

fn hexdec(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn main() {
    let redeem = hexdec("aabbccddeeff00112233");
    let treasury_id = Hash::from_str(&"22".repeat(32)).unwrap();
    let utxos = vec![
        (TransactionId::from_str(&"33".repeat(32)).unwrap(), 0u32, 500_000_000u64, true),  // covenant vault
        (TransactionId::from_str(&"44".repeat(32)).unwrap(), 1u32, 3_000_000u64, false),   // stray
    ];
    let tx = kosign_wasm_tx::build_sweep(&redeem, treasury_id, &utxos, 5_000_000);
    let txid = tx.id();
    // Borsh round-trip: the relay reconstructs this exact tx from the wasm output.
    let bytes = borsh::to_vec(&tx).unwrap();
    let back: kaspa_consensus_core::tx::Transaction = borsh::from_slice(&bytes).unwrap();
    assert_eq!(back.id(), txid, "borsh round-trip changed the txid");
    eprintln!("borsh round-trip OK ({} bytes)", bytes.len());
    println!("{txid}");
}
