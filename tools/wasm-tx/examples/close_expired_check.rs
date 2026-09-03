// Native reference for close_expired_build — the BOND-TO-VAULT shape (RISKS #17).
//
// The previous version of this check pinned the builder byte-for-byte against
// TN10 tx 701709040a276a3b80b53f481c43be5413efc545001679278bbd5ebafb1fd16f, which
// paid the bond (less fee) to the CLOSER. That transaction is now the historical
// record of the covenant this build replaces: KoProposal.closeExpired requires
// output 0 to pay the treasury's vault P2SH the FULL bond (unbound — it arrives
// as a stray the next sweep folds in), and the closer funds the network fee from
// their own signed wallet inputs. So this checks the structural rules the new
// covenant enforces, and the refusals that keep the builder honest.
//
//   cargo run --example close_expired_check
use kosign_wasm_tx::ce_build;

// Any 32-byte-push-bearing script works as a stand-in vault redeem here: the
// builder must pay P2SH(blake2b(this)) whatever the bytes are.
const VAULT_REDEEM: &str = "6b20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa75";
const PROPOSAL_REDEEM: &str = "6b080400000000000000080100000000000000";
const OWNER: &str = "kaspatest:qpmjluzk2zk6vf8kzq53shfcuvhgf70cjp0079qc7tuf3hf6u2a0z54d6sw36";
const BOND: u64 = 50_000_000;

fn inputs(fee: u64, lock_time: u64, funding: bool) -> serde_json::Value {
    let mut j = serde_json::json!({
        "proposalRedeem": PROPOSAL_REDEEM,
        "propTxid": "78aa5e5394a3ad135a73f421ed35e2a5308846472161e66875293f9cf0ad2548",
        "propIndex": 0,
        "propAmount": BOND,
        "vaultRedeem": VAULT_REDEEM,
        "fee": fee,
        "lockTime": lock_time,
    });
    if funding {
        j["ownerAddress"] = OWNER.into();
        j["fundingUtxos"] = serde_json::json!([
            { "txid": "11".repeat(32), "index": 0, "amount": 10_000_000u64 }
        ]);
    }
    j
}

fn main() {
    let (signable, out_val, funding_count) = ce_build(&inputs(600_000, 548_298_226, true)).expect("ce_build");
    let tx = signable.tx;
    assert_eq!(out_val, BOND, "the bond must come back WHOLE — the fee is the closer's, not the treasury's");
    assert_eq!(funding_count, 1);

    // Output 0 pays the vault's P2SH the full bond, and NOTHING inherits the lineage.
    let vault_spk = kaspa_txscript::pay_to_script_hash_script(&hexdec(VAULT_REDEEM));
    assert_eq!(tx.outputs[0].value, BOND, "output 0 must carry the whole bond");
    assert_eq!(tx.outputs[0].script_public_key, vault_spk, "output 0 must pay the vault redeem's P2SH");
    assert!(tx.outputs.iter().all(|o| o.covenant.is_none()), "a covenant output would let the lineage be inherited");

    // The closer's change comes home; the fee is theirs.
    assert_eq!(tx.outputs[1].value, 10_000_000 - 600_000, "closer change = funding - fee");
    assert_eq!(tx.outputs[1].script_public_key, kaspa_txscript::pay_to_address_script(&kaspa_addresses::Address::try_from(OWNER).unwrap()));

    // Timelock mechanics unchanged from the chain-proven original.
    assert_eq!(tx.lock_time, 548_298_226, "lock_time must carry the expiry the contract checks");
    assert_ne!(tx.inputs[0].sequence, u64::MAX, "a final input disables OP_CHECKLOCKTIMEVERIFY");
    assert_eq!(tx.inputs[0].signature_script[0], 0x52, "the witness starts with the closeExpired selector (OP_2)");

    // Refusals: a zero lock time reads as `tx.time == 0`; a close without fee
    // funding has nothing to pay the network with (the bond may no longer);
    // funding short of the fee is named as such.
    let refused = |fee, lock, funding| ce_build(&inputs(fee, lock, funding)).unwrap_err();
    assert!(refused(600_000, 0, true).contains("lockTime must be non-zero"), "a zero lockTime must be refused");
    assert!(refused(600_000, 548_298_226, false).contains("needs fee-funding"), "a fundingless close must be refused");
    assert!(refused(20_000_000, 548_298_226, true).contains("can't cover"), "funding short of the fee must be refused");

    println!("close_expired_check OK — bond {} sompi returns whole to the vault; the closer pays the fee", BOND);
}

fn hexdec(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}
