// WASM probe for route B: build a 1-in/1-out Toccata covenant continuation tx and
// return its sighash. Exercises the exact machinery the real browser tx-builder
// needs — covenant binding, with_covenant output, Toccata tx version, the
// compute-budget mass, and the schnorr sighash — to prove it compiles + runs in
// wasm32. If this works, each kaspa-probe flow (create_proposal/approve/execute/
// execute_config/deposit/genesis) can be ported the same way.
use kaspa_consensus_core::constants::TX_VERSION_TOCCATA;
use kaspa_consensus_core::hashing::covenant_id::covenant_id;
use kaspa_consensus_core::hashing::sighash::{calc_schnorr_signature_hash, SigHashReusedValuesUnsync};
use kaspa_consensus_core::hashing::sighash_type::SIG_HASH_ALL;
use kaspa_consensus_core::constants::STORAGE_MASS_PARAMETER;
use kaspa_consensus_core::mass::{ComputeBudget, MassCalculator};
use kaspa_consensus_core::subnets::SUBNETWORK_ID_NATIVE;
use kaspa_consensus_core::tx::{
    CovenantBinding, GenesisCovenantGroup, MutableTransaction, ScriptPublicKey, Transaction, TransactionId, TransactionInput, TransactionOutpoint,
    TransactionOutput, UtxoEntry,
};
use kaspa_addresses::{Address, Prefix, Version};
use kaspa_hashes::Hash;
use kaspa_txscript::script_builder::ScriptBuilder;
use kaspa_txscript::{extract_script_pub_key_address, pay_to_address_script, pay_to_script_hash_script};
use std::str::FromStr;
use wasm_bindgen::prelude::*;

fn blake2b256(data: &[u8]) -> [u8; 32] {
    let h = blake2b_simd::Params::new().hash_length(32).to_state().update(data).finalize();
    let mut o = [0u8; 32];
    o.copy_from_slice(h.as_bytes());
    o
}

/// Extract the x-only pubkey (hex) from a P2PK Kaspa address — used to turn
/// owner addresses into the pubkeys a CONFIG change commits.
#[wasm_bindgen]
pub fn address_pubkey(address: &str) -> Result<String, JsError> {
    let addr = Address::try_from(address).map_err(|e| JsError::new(&format!("{e:?}")))?;
    let spk = pay_to_address_script(&addr);
    let s = spk.script(); // P2PK: OP_DATA_32(0x20) + xonly[32] + OP_CHECKSIG(0xac)
    if s.len() >= 34 && s[0] == 0x20 {
        Ok(hexenc(&s[1..33]))
    } else {
        Err(JsError::new("not a P2PK address"))
    }
}

/// Resolve a recipient address → { spkHash (for the proposal commitment),
/// spkHex (the version-prefixed scriptPubKey, revealed at execute) }. Matches the
/// native tools' blake2b(spk_full).
#[wasm_bindgen]
pub fn recipient_info(address: &str) -> Result<String, JsError> {
    let addr = Address::try_from(address).map_err(|e| JsError::new(&format!("{e:?}")))?;
    let spk = pay_to_address_script(&addr);
    let mut spk_full = spk.version().to_be_bytes().to_vec();
    spk_full.extend_from_slice(spk.script());
    Ok(serde_json::json!({ "spkHash": hexenc(&blake2b256(&spk_full)), "spkHex": hexenc(&spk_full) }).to_string())
}

/// P2SH address (bech32) for a redeem script — lets the browser derive the
/// vault/root/proposal covenant addresses from reconstructed scripts (node-direct
/// recovery), so it can query their UTXOs with no backend. prefix: "testnet"|"mainnet".
#[wasm_bindgen]
pub fn p2sh_address(redeem_hex: &str, prefix: &str) -> Result<String, JsError> {
    let redeem = hexdec(redeem_hex);
    let spk = pay_to_script_hash_script(&redeem);
    let pfx = match prefix {
        "mainnet" => Prefix::Mainnet,
        "testnet" | "testnet-10" | "testnet-11" => Prefix::Testnet,
        _ => Prefix::Testnet,
    };
    let addr = extract_script_pub_key_address(&spk, pfx).map_err(|e| JsError::new(&format!("{e:?}")))?;
    Ok(addr.to_string())
}

/// Owner address (bech32 P2PK) for an x-only public key — lets the browser show
/// owner addresses (kaspatest:q…) with no backend, e.g. for a chain-recovered treasury
/// whose inscription stores only pubkeys. prefix: "testnet"|"mainnet".
#[wasm_bindgen]
pub fn pubkey_address(xonly_hex: &str, prefix: &str) -> Result<String, JsError> {
    let pk = hexdec(xonly_hex);
    if pk.len() != 32 {
        return Err(JsError::new("x-only pubkey must be 32 bytes"));
    }
    let pfx = match prefix {
        "mainnet" => Prefix::Mainnet,
        "testnet" | "testnet-10" | "testnet-11" => Prefix::Testnet,
        _ => Prefix::Testnet,
    };
    Ok(Address::new(pfx, Version::PubKey, &pk).to_string())
}

const DEPOSIT_SELECTOR: i64 = 1; // KoVault abi: executeProposal=0, deposit=1

fn hexdec(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}
fn hexenc(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn h32(s: &str) -> [u8; 32] {
    let v = hexdec(s);
    let mut o = [0u8; 32];
    o.copy_from_slice(&v);
    o
}

/// Build a covenant continuation tx (1 in / 1 out) and return its schnorr sighash.
#[wasm_bindgen]
pub fn probe_sighash(prev_txid_hex: &str, redeem_hex: &str, amount: u64, treasury_id_hex: &str) -> String {
    let redeem = hexdec(redeem_hex);
    let spk = pay_to_script_hash_script(&redeem);
    let treasury_id = TransactionId::from_bytes(h32(treasury_id_hex));
    let prev = TransactionId::from_bytes(h32(prev_txid_hex));

    let cov = Some(CovenantBinding::new(0, treasury_id));
    let out = TransactionOutput::with_covenant(amount.saturating_sub(1000), spk.clone(), cov);
    let input = TransactionInput::new(TransactionOutpoint::new(prev, 0), vec![], 0, 1);
    let tx = Transaction::new(TX_VERSION_TOCCATA, vec![input], vec![out], 0, SUBNETWORK_ID_NATIVE, 0, vec![]);

    let entry = UtxoEntry { amount, script_public_key: spk, block_daa_score: 0, is_coinbase: false, covenant_id: Some(treasury_id) };
    let mut signable = MutableTransaction::with_entries(tx, vec![entry]);
    signable.tx.inputs[0].mass = ComputeBudget(20).into();
    let reused = SigHashReusedValuesUnsync::new();
    let sighash = calc_schnorr_signature_hash(&signable.as_verifiable(), 0, SIG_HASH_ALL, &reused);
    hexenc(sighash.as_bytes().as_slice())
}

/// Convert a Borsh-serialized consensus Transaction (our *_build output) into the
/// RpcTransaction JSON the node's JSON wRPC `submitTransaction` expects — so the
/// browser can submit DIRECTLY to a node (no backend). RpcTransaction carries the
/// covenant binding + compute_budget + payload, all camelCase.
#[wasm_bindgen]
pub fn borsh_to_rpc_json(borsh_hex: &str) -> Result<String, JsError> {
    let tx: Transaction = borsh::from_slice(&hexdec(borsh_hex)).map_err(|e| JsError::new(&e.to_string()))?;
    let rpc = kaspa_rpc_core::RpcTransaction::from(&tx);
    serde_json::to_string(&rpc).map_err(|e| JsError::new(&e.to_string()))
}

// ---- state encoding helpers (must match the Silverscript compiler) ------------
// int  = OP_DATA_8 (0x08) + 8 LE bytes; bytes32 = OP_DATA_32 (0x20) + 32 bytes.
fn enc_int(v: i64) -> Vec<u8> {
    let mut o = vec![0x08u8];
    o.extend_from_slice(&v.to_le_bytes());
    o
}
fn enc_b32(b: &[u8; 32]) -> Vec<u8> {
    let mut o = vec![0x20u8];
    o.extend_from_slice(b);
    o
}
fn dec_int(s: &[u8], off: usize) -> i64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&s[off + 1..off + 9]);
    i64::from_le_bytes(b)
}
fn dec_b32(s: &[u8], off: usize) -> [u8; 32] {
    let mut b = [0u8; 32];
    b.copy_from_slice(&s[off + 1..off + 33]);
    b
}
fn splice(s: &[u8], start: usize, old_len: usize, new: &[u8]) -> Vec<u8> {
    let mut o = s[..start].to_vec();
    o.extend_from_slice(new);
    o.extend_from_slice(&s[start + old_len..]);
    o
}
fn bit_for(i: i64) -> i64 { 1i64 << i }

fn jstr(v: &serde_json::Value, k: &str) -> Result<String, String> {
    Ok(v[k].as_str().ok_or(format!("missing string {k}"))?.to_string())
}
fn jint(v: &serde_json::Value, k: &str) -> Result<i64, String> {
    v[k].as_i64().ok_or(format!("missing int {k}"))
}
fn jhash(v: &serde_json::Value, k: &str) -> Result<Hash, String> {
    Hash::from_str(&jstr(v, k)?).map_err(|e| e.to_string())
}
fn jb32(v: &serde_json::Value, k: &str) -> Result<[u8; 32], String> {
    let d = hexdec(&jstr(v, k)?);
    let mut o = [0u8; 32];
    o.copy_from_slice(&d);
    Ok(o)
}
// sign a sighash JS-side (@noble) → 64-byte sig; the script wants sig + sighashtype.
fn sig65(sig_hex: &str) -> Vec<u8> {
    let mut s = hexdec(sig_hex);
    s.push(SIG_HASH_ALL.to_u8());
    s
}

// ---- Increment 2a: create_proposal (owner-signed; mints a KoProposal) --------
// Mirrors tools/kaspa-probe/src/bin/create_proposal.rs. Reads the owner snapshot
// from the current KoRoot state, builds the proposal state, continues KoRoot
// (nonce+1), and produces the proposer's sighash (phase A) / signed tx (phase B).
const CREATE_PROPOSAL_SELECTOR: i64 = 0;
const ROOT_PROPOSAL_VAL: u64 = 50_000_000;
const ROOT_CREATE_FEE: u64 = 10_000_000;

struct CpBuilt {
    signable: MutableTransaction<Transaction>,
    proposal_redeem: Vec<u8>,
    root_cont: Vec<u8>,
    proposal_id: i64,
    status: i64,
    bitmap: i64,
    funding_count: usize, // owner-funded inputs (indices 1..=funding_count), P2PK
}

fn cp_build(j: &serde_json::Value) -> Result<CpBuilt, String> {
    let root = hexdec(&jstr(j, "rootScript")?);
    let r = jint(j, "rStart")? as usize;
    let treasury_id = jhash(j, "treasuryId")?;
    let proposer_index = jint(j, "proposerIndex")?;
    let operation = jint(j, "operation")?;
    let recipient_spk_hash = jb32(j, "recipientSpkHash")?;
    let amount = jint(j, "amount")?;
    let max_fee = jint(j, "maxFee")?;
    let expires_at = jint(j, "expiresAt")?;
    let execution_delay = jint(j, "executionDelay")?;
    let root_amount = jint(j, "rootAmount")? as u64;

    // snapshot the CURRENT owner config out of KoRoot state
    let threshold = dec_int(&root, r + 9);
    let owner_count = dec_int(&root, r + 18);
    let snap_owners = [dec_b32(&root, r + 27), dec_b32(&root, r + 60), dec_b32(&root, r + 93), dec_b32(&root, r + 126), dec_b32(&root, r + 159)];

    let new_nonce = dec_int(&root, r) + 1;
    let bitmap = bit_for(proposer_index);
    let status = if threshold <= 1 { 1 } else { 0 };

    let mut state = Vec::new();
    state.extend(enc_int(new_nonce)); // proposalId
    state.extend(enc_int(operation));
    state.extend(enc_b32(&recipient_spk_hash));
    state.extend(enc_int(amount));
    state.extend(enc_int(max_fee));
    state.extend(enc_int(expires_at));
    state.extend(enc_int(execution_delay));
    state.extend(enc_int(bitmap)); // approvalBitmap (byte[8])
    state.extend(enc_int(1)); // approvalCount
    state.extend(enc_int(status));
    state.extend(enc_int(threshold)); // snapThreshold
    state.extend(enc_int(owner_count));
    for o in &snap_owners {
        state.extend(enc_b32(o));
    }
    state.extend(enc_int(0)); // rejectBitmap (byte[8], initially none)
    state.extend(enc_int(0)); // rejectCount
    // vaultSpkHash: blake2b of THIS treasury's vault redeem, the address
    // closeExpired must return the bond to. KoRoot recomputes it on-chain from
    // the hash-pinned template + live covenant id, so this must match exactly.
    let vault_redeem = vault_redeem_for(&hexdec(&jstr(j, "vPrefix")?), &treasury_id, &hexdec(&jstr(j, "vSuffix")?));
    let vault_spk_hash = blake2b256(&vault_redeem);
    state.extend(enc_b32(&vault_spk_hash));
    let mut proposal_redeem = hexdec(&jstr(j, "pPrefix")?);
    proposal_redeem.extend_from_slice(&state);
    proposal_redeem.extend_from_slice(&hexdec(&jstr(j, "pSuffix")?));
    let root_cont = splice(&root, r, 9, &enc_int(new_nonce));

    let cov = Some(CovenantBinding::new(0, treasury_id));
    let prop_cost = ROOT_PROPOSAL_VAL + jfee(j, ROOT_CREATE_FEE)?;
    let root_txid = TransactionId::from_str(&jstr(j, "rootTxid")?).map_err(|e| e.to_string())?;
    let root_input = TransactionInput::new(TransactionOutpoint::new(root_txid, jint(j, "rootIndex")? as u32), vec![], 0, 1);
    let root_entry = UtxoEntry { amount: root_amount, script_public_key: pay_to_script_hash_script(&root), block_daa_score: 0, is_coinbase: false, covenant_id: Some(treasury_id) };

    // Owner-funded mode (preferred): the PROPOSER pays the proposal bond + fee from
    // their OWN wallet, so the KoRoot value is PRESERVED and never depletes. The
    // covenant only checks output STATE (not value), so this is valid with no contract
    // change — and it un-bricks Treasuries whose old root reserve is already spent. Legacy
    // root-funded mode (no fundingUtxos) keeps deducting from the root.
    let funding = j["fundingUtxos"].as_array().filter(|a| !a.is_empty());
    let (root_out_val, mut inputs, mut entries, mut outputs, funding_count) = if let Some(utxos) = funding {
        let owner_addr = Address::try_from(jstr(j, "ownerAddress")?.as_str()).map_err(|e| format!("ownerAddress: {e:?}"))?;
        let owner_spk = pay_to_address_script(&owner_addr);
        let total: u64 = utxos.iter().map(|u| u["amount"].as_u64().unwrap_or(0)).sum();
        let change = total.checked_sub(prop_cost).ok_or_else(|| format!(
            "your wallet ({:.4} KAS in the selected inputs) can't cover the proposal bond + fee ({:.2} KAS)", total as f64 / 1e8, prop_cost as f64 / 1e8
        ))?;
        let mut ins = vec![root_input];
        let mut ents = vec![root_entry];
        for u in utxos {
            let txid = TransactionId::from_str(u["txid"].as_str().ok_or("fundingUtxo.txid")?).map_err(|e| e.to_string())?;
            ins.push(TransactionInput::new(TransactionOutpoint::new(txid, u["index"].as_u64().ok_or("fundingUtxo.index")? as u32), vec![], 0, 1));
            ents.push(UtxoEntry { amount: u["amount"].as_u64().ok_or("fundingUtxo.amount")?, script_public_key: owner_spk.clone(), block_daa_score: 0, is_coinbase: false, covenant_id: None });
        }
        let mut outs = vec![
            TransactionOutput::with_covenant(root_amount, pay_to_script_hash_script(&root_cont), cov),
            TransactionOutput::with_covenant(ROOT_PROPOSAL_VAL, pay_to_script_hash_script(&proposal_redeem), cov),
        ];
        if change > 0 { outs.push(TransactionOutput::new(change, owner_spk)); } // owner change
        (root_amount, ins, ents, outs, utxos.len())
    } else {
        let rov = root_amount.checked_sub(prop_cost).ok_or_else(|| format!(
            "KoRoot reserve too low to propose: have {} sompi ({:.4} KAS), each proposal needs {} sompi ({:.2} KAS) from the root's operating reserve (separate from the vault balance)",
            root_amount, root_amount as f64 / 1e8, prop_cost, prop_cost as f64 / 1e8
        ))?;
        let outs = vec![
            TransactionOutput::with_covenant(rov, pay_to_script_hash_script(&root_cont), cov),
            TransactionOutput::with_covenant(ROOT_PROPOSAL_VAL, pay_to_script_hash_script(&proposal_redeem), cov),
        ];
        (rov, vec![root_input], vec![root_entry], outs, 0usize)
    };
    let _ = root_out_val;
    // optional payload: a self-describing proposal inscription (recipient address +
    // amount) so co-owners can DISCOVER + read this proposal from chain alone (the
    // committed recipientSpkHash is one-way). Covenant_id excludes the payload, and
    // the sighash includes it (we build before signing), mirroring the genesis inscription.
    let payload = j.get("payloadHex").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(hexdec).unwrap_or_default();
    let tx = Transaction::new(TX_VERSION_TOCCATA, std::mem::take(&mut inputs), std::mem::take(&mut outputs), 0, SUBNETWORK_ID_NATIVE, 0, payload);
    let mut signable = MutableTransaction::with_entries(tx, std::mem::take(&mut entries));
    // createProposal now blake2b's the ~4KB vault template twice (hash pin +
    // vaultSpkHash derivation) on top of its old work — bootstrapVault's hashing
    // runs at 40, so double it rather than discover the ceiling on a live node
    signable.tx.inputs[0].mass = ComputeBudget(80).into();
    for i in 1..=funding_count { signable.tx.inputs[i].mass = ComputeBudget(10).into(); } // P2PK funding inputs
    Ok(CpBuilt { signable, proposal_redeem, root_cont, proposal_id: new_nonce, status, bitmap, funding_count })
}

fn sighash_of(signable: &MutableTransaction<Transaction>, idx: usize) -> String {
    let reused = SigHashReusedValuesUnsync::new();
    let sh = calc_schnorr_signature_hash(&signable.as_verifiable(), idx, SIG_HASH_ALL, &reused);
    hexenc(sh.as_bytes().as_slice())
}

// Optional per-tx fee override: every builder defaults to its historical
// constant, but the UI now sizes fees from the actual tx mass (see
// borsh_masses + frontend/src/sweepPlan.js). The override MUST be passed
// identically to the Phase A sighash call and the Phase B build call — the
// sighash commits to every output value. A PRESENT but non-u64 fee is an
// error, not a silent fallback — the caller's meta.fee feeds the tracked
// values that later sighashes depend on.
fn jfee(j: &serde_json::Value, default: u64) -> Result<u64, String> {
    match j.get("fee") {
        None => Ok(default),
        Some(v) => v.as_u64().ok_or_else(|| "fee must be a non-negative integer (sompi)".to_string()),
    }
}

// ---- Owner-funded covenant-op fees ------------------------------------------
// Every covenant fee rule is a CAP (`out >= in - maxFee`), never an equality,
// so paying the network fee from EXTRA P2PK inputs the owner signs — leaving
// the covenant output at its FULL value — satisfies them trivially and removes
// the cap as a ceiling. Without this, a network feerate rise past the compiled
// 0.1 KAS cap would make approve/reject/execute/executeConfig unbuildable and
// freeze the treasury. Optional: absent `fundingUtxos` keeps the covenant-funded
// behaviour (fee deducted from the covenant value, capped).
struct Funding {
    spk: ScriptPublicKey,
    utxos: Vec<(TransactionId, u32, u64)>,
}

fn jfunding(j: &serde_json::Value) -> Result<Option<Funding>, String> {
    let arr = match j["fundingUtxos"].as_array() {
        Some(a) if !a.is_empty() => a,
        _ => return Ok(None),
    };
    let addr = Address::try_from(jstr(j, "ownerAddress")?.as_str()).map_err(|e| format!("ownerAddress: {e:?}"))?;
    let spk = pay_to_address_script(&addr);
    let mut utxos = Vec::with_capacity(arr.len());
    for u in arr {
        let txid = TransactionId::from_str(u["txid"].as_str().ok_or("fundingUtxo.txid")?).map_err(|e| e.to_string())?;
        utxos.push((txid, u["index"].as_u64().ok_or("fundingUtxo.index")? as u32, u["amount"].as_u64().ok_or("fundingUtxo.amount")?));
    }
    Ok(Some(Funding { spk, utxos }))
}

/// Append the owner's funding inputs + their change output. Returns how many
/// funding inputs were added (their sighashes follow the covenant one).
///
/// Attaches ALL of them, deliberately: how many inputs a spend may carry is a
/// property of the covenant being spent — KoVault and KoRoot both scan their
/// inputs with a bounded loop, so the compiler emits `require(tx.inputs.length
/// <= 16)` and a 17-input spend of either fails script verification — and this
/// builder does not know which covenant its caller is spending. The cap
/// therefore lives where the operation is planned: frontend/src/sweepPlan.js
/// `sizeOpFee` for approve/reject/execute/executeConfig, and `proposerFunding`
/// in frontend/src/wasmTx.js for createProposal. Both subtract the inputs the
/// covenant itself contributes and report a fragmented wallet as such.
fn attach_funding(
    inputs: &mut Vec<TransactionInput>, entries: &mut Vec<UtxoEntry>, outputs: &mut Vec<TransactionOutput>,
    f: &Funding, fee: u64,
) -> Result<usize, String> {
    let total: u64 = f.utxos.iter().map(|u| u.2).sum();
    let change = total.checked_sub(fee).ok_or_else(|| format!(
        "your wallet ({:.4} KAS in the selected inputs) can't cover the {:.4} KAS network fee",
        total as f64 / 1e8, fee as f64 / 1e8
    ))?;
    for u in &f.utxos {
        let mut inp = TransactionInput::new(TransactionOutpoint::new(u.0, u.1), vec![], 0, 1);
        inp.mass = ComputeBudget(10).into();
        inputs.push(inp);
        entries.push(UtxoEntry { amount: u.2, script_public_key: f.spk.clone(), block_daa_score: 0, is_coinbase: false, covenant_id: None });
    }
    if change > 0 { outputs.push(TransactionOutput::new(change, f.spk.clone())); }
    Ok(f.utxos.len())
}

/// Inject the owner sig at `owner_idx` plus one sig per funding input. `sig_arg`
/// is a single hex (covenant-funded) or a JSON array [ownerSig, fundingSig…].
fn split_sigs(sig_arg: &str) -> Result<Vec<String>, String> {
    if sig_arg.trim_start().starts_with('[') {
        serde_json::from_str(sig_arg).map_err(|e| e.to_string())
    } else {
        Ok(vec![sig_arg.to_string()])
    }
}

fn inject_funding_sigs(tx: &mut Transaction, first_funding_idx: usize, funding_count: usize, sigs: &[String]) -> Result<(), String> {
    for k in 0..funding_count {
        let s = sigs.get(1 + k).ok_or("missing funding signature")?;
        let mut fb = ScriptBuilder::new();
        fb.add_data(&sig65(s)).map_err(|e| e.to_string())?;
        tx.inputs[first_funding_idx + k].signature_script = fb.drain();
    }
    Ok(())
}

/// Non-contextual masses of ANY built tx (Borsh hex from a *_build export):
/// { computeMass, transientMass }. The UI prices covenant-flow fees as
/// max(compute, ceil(transient/2)) × the min relay feerate. Build the probe
/// with a dummy zero signature first — a fee change only moves fixed-width
/// output values, never the serialized size, so the measured mass stays exact
/// for the final fee.
#[wasm_bindgen]
pub fn borsh_masses(borsh_hex: &str) -> Result<String, JsError> {
    if borsh_hex.len() % 2 != 0 || !borsh_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(JsError::new("borsh_hex must be an even-length hex string"));
    }
    let tx: Transaction = borsh::from_slice(&hexdec(borsh_hex)).map_err(|e| JsError::new(&e.to_string()))?;
    let m = MassCalculator::new(1, 10, STORAGE_MASS_PARAMETER).calc_non_contextual_masses(&tx);
    Ok(serde_json::json!({ "computeMass": m.compute_mass, "transientMass": m.transient_mass }).to_string())
}

/// Phase A: proposer's sighash for create_proposal. `inputs_json` carries the
/// KoRoot script+UTXO, proposal template prefix/suffix, root state start, and
/// the proposal params (operation/recipientSpkHash/amount/maxFee/expiresAt/
/// executionDelay/proposerIndex).
#[wasm_bindgen]
pub fn create_proposal_sighash(inputs_json: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let b = cp_build(&j).map_err(|e| JsError::new(&e))?;
    Ok(sighash_of(&b.signable, 0))
}

/// Phase A (owner-funded): every sighash the proposer must sign — the KoRoot
/// covenant input (0, = proposerSig) plus each wallet funding input. JSON array.
#[wasm_bindgen]
pub fn create_proposal_sighashes(inputs_json: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let b = cp_build(&j).map_err(|e| JsError::new(&e))?;
    let shs: Vec<String> = (0..=b.funding_count).map(|i| sighash_of(&b.signable, i)).collect();
    Ok(serde_json::to_string(&shs).unwrap())
}

/// Phase B: inject the proposer's 64-byte sig and return the signed tx (Borsh
/// hex) + the new proposal/root redeem scripts and metadata (JSON).
#[wasm_bindgen]
pub fn create_proposal_build(inputs_json: &str, sig_hex: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let b = cp_build(&j).map_err(|e| JsError::new(&e))?;
    // sig_hex is either a single proposerSig (legacy) or a JSON array
    // [proposerSig, fundingSig0, …] (owner-funded).
    let sigs: Vec<String> = if sig_hex.trim_start().starts_with('[') {
        serde_json::from_str(sig_hex).map_err(|e| JsError::new(&e.to_string()))?
    } else {
        vec![sig_hex.to_string()]
    };
    let proposer_sig = sigs.first().ok_or_else(|| JsError::new("missing proposer signature"))?;
    let root_script = hexdec(&jstr(&j, "rootScript").map_err(|e| JsError::new(&e))?);
    let mut sb = ScriptBuilder::new();
    sb.add_i64(jint(&j, "proposerIndex").unwrap()).unwrap();
    sb.add_data(&sig65(proposer_sig)).unwrap();
    sb.add_i64(jint(&j, "operation").unwrap()).unwrap();
    sb.add_data(&jb32(&j, "recipientSpkHash").unwrap()).unwrap();
    sb.add_i64(jint(&j, "amount").unwrap()).unwrap();
    sb.add_i64(jint(&j, "maxFee").unwrap()).unwrap();
    sb.add_i64(jint(&j, "expiresAt").unwrap()).unwrap();
    sb.add_i64(jint(&j, "executionDelay").unwrap()).unwrap();
    // vault template reveal (hash-pinned on-chain) — KoRoot recomputes the
    // vaultSpkHash the minted proposal commits its bond-return address to
    sb.add_data(&hexdec(&jstr(&j, "vPrefix").map_err(|e| JsError::new(&e))?)).unwrap();
    sb.add_data(&hexdec(&jstr(&j, "vSuffix").map_err(|e| JsError::new(&e))?)).unwrap();
    sb.add_i64(CREATE_PROPOSAL_SELECTOR).unwrap();
    sb.add_data(&root_script).unwrap();
    let mut tx = b.signable.tx;
    tx.inputs[0].signature_script = sb.drain();
    // owner-funded P2PK inputs: unlock = push the 65-byte sig
    for i in 1..=b.funding_count {
        let s = sigs.get(i).ok_or_else(|| JsError::new("missing funding signature"))?;
        let mut fb = ScriptBuilder::new();
        fb.add_data(&sig65(s)).unwrap();
        tx.inputs[i].signature_script = fb.drain();
    }
    let borsh_hex = hexenc(&borsh::to_vec(&tx).map_err(|e| JsError::new(&e.to_string()))?);
    let out = serde_json::json!({
        "borshHex": borsh_hex,
        "txid": tx.id().to_string(),
        "proposalRedeemHex": hexenc(&b.proposal_redeem),
        "rootContHex": hexenc(&b.root_cont),
        "proposalId": b.proposal_id,
        "status": b.status,
        "approvalBitmap": b.bitmap,
    });
    Ok(out.to_string())
}

// ---- Increment 2b: approve (record one owner approval) ------------------------
// Mirrors approve.rs: overwrite the proposal's bitmap/count/status in place and
// continue the proposal UTXO; owner sig over the new tx.
const APPROVE_SELECTOR: i64 = 0;
const REJECT_SELECTOR: i64 = 3; // KoProposal abi: approve=0, execute=1, closeExpired=2, reject=3
const OFF_BITMAP: usize = 87;
const OFF_COUNT: usize = 96;
const OFF_STATUS: usize = 105;
const OFF_SNAP_THRESHOLD: usize = 114;
const OFF_OWNER_COUNT: usize = 123;
const OFF_REJECT_BITMAP: usize = 297; // after owner4 (state grew 297->315)
const OFF_REJECT_COUNT: usize = 306;
const PROP_OP_FEE: u64 = 5_000_000;

struct OpBuilt {
    signable: MutableTransaction<Transaction>,
    new_redeem: Vec<u8>,
    bitmap: i64,
    count: i64,
    status: i64,
    funding_count: usize,
}

fn ap_build(j: &serde_json::Value) -> Result<OpBuilt, String> {
    let cur = hexdec(&jstr(j, "proposalRedeem")?);
    let p = jint(j, "pStart")? as usize;
    let treasury_id = jhash(j, "treasuryId")?;
    let owner_index = jint(j, "ownerIndex")?;
    let in_val = jint(j, "propAmount")? as u64;
    let bitmap = dec_int(&cur, p + OFF_BITMAP);
    let count = dec_int(&cur, p + OFF_COUNT);
    let threshold = dec_int(&cur, p + OFF_SNAP_THRESHOLD);
    let new_bitmap = bitmap | bit_for(owner_index);
    let new_count = count + 1;
    let new_status = if new_count >= threshold { 1 } else { 0 };
    let mut new_redeem = cur.clone();
    new_redeem[p + OFF_BITMAP..p + OFF_BITMAP + 9].copy_from_slice(&enc_int(new_bitmap));
    new_redeem[p + OFF_COUNT..p + OFF_COUNT + 9].copy_from_slice(&enc_int(new_count));
    new_redeem[p + OFF_STATUS..p + OFF_STATUS + 9].copy_from_slice(&enc_int(new_status));
    let cov = Some(CovenantBinding::new(0, treasury_id));
    let fee = jfee(j, PROP_OP_FEE)?;
    let funding = jfunding(j)?;
    // owner-funded: the proposal bond stays whole and the fee comes from the
    // owner's wallet, so the covenant's `>= inVal - maxFee` cap can never bind
    let appr_val = match &funding {
        Some(_) => in_val,
        None => in_val.checked_sub(fee).ok_or_else(|| format!("proposal UTXO {} sompi too low to approve (fee {})", in_val, fee))?,
    };
    let mut outputs = vec![TransactionOutput::with_covenant(appr_val, pay_to_script_hash_script(&new_redeem), cov)];
    let txid = TransactionId::from_str(&jstr(j, "propTxid")?).map_err(|e| e.to_string())?;
    let mut inputs = vec![TransactionInput::new(TransactionOutpoint::new(txid, jint(j, "propIndex")? as u32), vec![], 0, 1)];
    let mut entries = vec![UtxoEntry { amount: in_val, script_public_key: pay_to_script_hash_script(&cur), block_daa_score: 0, is_coinbase: false, covenant_id: Some(treasury_id) }];
    let funding_count = match &funding { Some(f) => attach_funding(&mut inputs, &mut entries, &mut outputs, f, fee)?, None => 0 };
    let tx = Transaction::new(TX_VERSION_TOCCATA, inputs, outputs, 0, SUBNETWORK_ID_NATIVE, 0, vec![]);
    let mut signable = MutableTransaction::with_entries(tx, entries);
    signable.tx.inputs[0].mass = ComputeBudget(30).into();
    Ok(OpBuilt { signable, new_redeem, bitmap: new_bitmap, count: new_count, status: new_status, funding_count })
}

#[wasm_bindgen]
pub fn approve_sighash(inputs_json: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let b = ap_build(&j).map_err(|e| JsError::new(&e))?;
    Ok(sighash_of(&b.signable, 0))
}

/// Phase A (owner-funded): [ownerSighash, fundingSighash…] — JSON array.
#[wasm_bindgen]
pub fn approve_sighashes(inputs_json: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let b = ap_build(&j).map_err(|e| JsError::new(&e))?;
    let shs: Vec<String> = (0..=b.funding_count).map(|i| sighash_of(&b.signable, i)).collect();
    Ok(serde_json::to_string(&shs).unwrap())
}

#[wasm_bindgen]
pub fn approve_build(inputs_json: &str, sig_hex: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let b = ap_build(&j).map_err(|e| JsError::new(&e))?;
    let sigs = split_sigs(sig_hex).map_err(|e| JsError::new(&e))?;
    let owner_sig = sigs.first().ok_or_else(|| JsError::new("missing owner signature"))?;
    let cur = hexdec(&jstr(&j, "proposalRedeem").map_err(|e| JsError::new(&e))?);
    let mut sb = ScriptBuilder::new();
    sb.add_i64(jint(&j, "ownerIndex").unwrap()).unwrap();
    sb.add_data(&sig65(owner_sig)).unwrap();
    sb.add_i64(APPROVE_SELECTOR).unwrap();
    sb.add_data(&cur).unwrap();
    let mut tx = b.signable.tx;
    tx.inputs[0].signature_script = sb.drain();
    inject_funding_sigs(&mut tx, 1, b.funding_count, &sigs).map_err(|e| JsError::new(&e))?;
    let out = serde_json::json!({
        "borshHex": hexenc(&borsh::to_vec(&tx).map_err(|e| JsError::new(&e.to_string()))?),
        "txid": tx.id().to_string(),
        "newRedeemHex": hexenc(&b.new_redeem),
        "approvalBitmap": b.bitmap, "approvalCount": b.count, "status": b.status,
        "ownerFunded": b.funding_count > 0,
    });
    Ok(out.to_string())
}

// ---- reject (record one rejection; mirrors approve) ---------------------------
// Overwrite the proposal's rejectBitmap/rejectCount/status in place and continue
// the proposal UTXO. status -> 2 (Failed) once approval can no longer reach the
// threshold (ownerCount - rejectCount < snapThreshold). Owner sig over the new tx.
fn rj_build(j: &serde_json::Value) -> Result<OpBuilt, String> {
    let cur = hexdec(&jstr(j, "proposalRedeem")?);
    let p = jint(j, "pStart")? as usize;
    let treasury_id = jhash(j, "treasuryId")?;
    let owner_index = jint(j, "ownerIndex")?;
    let in_val = jint(j, "propAmount")? as u64;
    let reject_bitmap = dec_int(&cur, p + OFF_REJECT_BITMAP);
    let reject_count = dec_int(&cur, p + OFF_REJECT_COUNT);
    let owner_count = dec_int(&cur, p + OFF_OWNER_COUNT);
    let threshold = dec_int(&cur, p + OFF_SNAP_THRESHOLD);
    let new_reject_bitmap = reject_bitmap | bit_for(owner_index);
    let new_reject_count = reject_count + 1;
    let new_status = if owner_count - new_reject_count < threshold { 2 } else { 0 };
    let mut new_redeem = cur.clone();
    new_redeem[p + OFF_REJECT_BITMAP..p + OFF_REJECT_BITMAP + 9].copy_from_slice(&enc_int(new_reject_bitmap));
    new_redeem[p + OFF_REJECT_COUNT..p + OFF_REJECT_COUNT + 9].copy_from_slice(&enc_int(new_reject_count));
    new_redeem[p + OFF_STATUS..p + OFF_STATUS + 9].copy_from_slice(&enc_int(new_status));
    let cov = Some(CovenantBinding::new(0, treasury_id));
    let fee = jfee(j, PROP_OP_FEE)?;
    let funding = jfunding(j)?;
    let rej_val = match &funding {
        Some(_) => in_val, // owner-funded: the bond stays whole (see attach_funding)
        None => in_val.checked_sub(fee).ok_or_else(|| format!("proposal UTXO {} sompi too low to reject (fee {})", in_val, fee))?,
    };
    let mut outputs = vec![TransactionOutput::with_covenant(rej_val, pay_to_script_hash_script(&new_redeem), cov)];
    let txid = TransactionId::from_str(&jstr(j, "propTxid")?).map_err(|e| e.to_string())?;
    let mut inputs = vec![TransactionInput::new(TransactionOutpoint::new(txid, jint(j, "propIndex")? as u32), vec![], 0, 1)];
    let mut entries = vec![UtxoEntry { amount: in_val, script_public_key: pay_to_script_hash_script(&cur), block_daa_score: 0, is_coinbase: false, covenant_id: Some(treasury_id) }];
    let funding_count = match &funding { Some(f) => attach_funding(&mut inputs, &mut entries, &mut outputs, f, fee)?, None => 0 };
    let tx = Transaction::new(TX_VERSION_TOCCATA, inputs, outputs, 0, SUBNETWORK_ID_NATIVE, 0, vec![]);
    let mut signable = MutableTransaction::with_entries(tx, entries);
    signable.tx.inputs[0].mass = ComputeBudget(30).into();
    Ok(OpBuilt { signable, new_redeem, bitmap: new_reject_bitmap, count: new_reject_count, status: new_status, funding_count })
}

#[wasm_bindgen]
pub fn reject_sighash(inputs_json: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let b = rj_build(&j).map_err(|e| JsError::new(&e))?;
    Ok(sighash_of(&b.signable, 0))
}

/// Phase A (owner-funded): [ownerSighash, fundingSighash…] — JSON array.
#[wasm_bindgen]
pub fn reject_sighashes(inputs_json: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let b = rj_build(&j).map_err(|e| JsError::new(&e))?;
    let shs: Vec<String> = (0..=b.funding_count).map(|i| sighash_of(&b.signable, i)).collect();
    Ok(serde_json::to_string(&shs).unwrap())
}

#[wasm_bindgen]
pub fn reject_build(inputs_json: &str, sig_hex: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let b = rj_build(&j).map_err(|e| JsError::new(&e))?;
    let sigs = split_sigs(sig_hex).map_err(|e| JsError::new(&e))?;
    let owner_sig = sigs.first().ok_or_else(|| JsError::new("missing owner signature"))?;
    let cur = hexdec(&jstr(&j, "proposalRedeem").map_err(|e| JsError::new(&e))?);
    let mut sb = ScriptBuilder::new();
    sb.add_i64(jint(&j, "ownerIndex").unwrap()).unwrap();
    sb.add_data(&sig65(owner_sig)).unwrap();
    sb.add_i64(REJECT_SELECTOR).unwrap();
    sb.add_data(&cur).unwrap();
    let mut tx = b.signable.tx;
    tx.inputs[0].signature_script = sb.drain();
    inject_funding_sigs(&mut tx, 1, b.funding_count, &sigs).map_err(|e| JsError::new(&e))?;
    let out = serde_json::json!({
        "borshHex": hexenc(&borsh::to_vec(&tx).map_err(|e| JsError::new(&e.to_string()))?),
        "txid": tx.id().to_string(),
        "newRedeemHex": hexenc(&b.new_redeem),
        "rejectBitmap": b.bitmap, "rejectCount": b.count, "status": b.status,
        "ownerFunded": b.funding_count > 0,
    });
    Ok(out.to_string())
}

// ---- closeExpired (retire an expired proposal; permissionless) -----------------
// The one KoProposal entrypoint with no signer: it takes no arguments and checks
// no signature, so the whole witness is [SELECTOR, redeem] and there is no phase A
// — nothing is signed, so a sighash export would have nothing to return. Two
// things no other builder here needs:
//   * a non-zero lock_time. The contract gates on `tx.time >= expiresAt`, which the
//     script engine reads off the transaction's lock time (a DAA score below
//     LOCK_TIME_THRESHOLD), and the spent input's sequence must stay 0 — a
//     fully-final input (u64::MAX) disables OP_CHECKLOCKTIMEVERIFY, so the engine
//     refuses one.
//   * zero covenant outputs. The path is permissionless, so a continuation would
//     be a covenant-minting oracle; the contract pins OpCovOutputCount == 0 and the
//     bond therefore comes back as a PLAIN, unbound coin. That is also why this is
//     the only covenant op with no owner-funded variant: with no covenant output
//     there is no `>= in - maxFee` rule to satisfy, so the fee simply comes out of
//     the bond and no cap can ever bind it.
// Mirrors build_close_expired in tools/kaspa-probe/src/bin/kobridge.rs, which
// retired a real TN10 proposal (see examples/close_expired_check.rs for its bytes).
const CLOSE_EXPIRED_SELECTOR: i64 = 2; // KoProposal abi: approve=0, execute=1, closeExpired=2, reject=3

// pub so examples/close_expired_check.rs can exercise the refusals: off wasm32 a
// JsError cannot be constructed, so close_expired_build's error path panics there.
//
// The bond RETURNS TO THE VAULT now (KoProposal.closeExpired requires output 0 to
// pay `new ScriptPubKeyP2SH(vaultSpkHash)` at the full bond value — RISKS #17), so
// closing is no longer self-funding: the closer pays the network fee from their
// own wallet inputs (signed; change comes home), and the bond lands at the vault
// address as an UNBOUND stray the next sweep folds in.
pub fn ce_build(j: &serde_json::Value) -> Result<(MutableTransaction<Transaction>, u64, usize), String> {
    let cur = hexdec(&jstr(j, "proposalRedeem")?);
    let in_val = jint(j, "propAmount")? as u64;
    let fee = jfee(j, PROP_OP_FEE)?;
    let lock_time = j["lockTime"].as_u64().ok_or("lockTime must be a non-negative integer (DAA score)")?;
    // A zero lock time marks the transaction finalized, and the engine then reads
    // `tx.time` as 0 — every proposal with a real expiry would fail the compare.
    if lock_time == 0 {
        return Err("lockTime must be non-zero — pass the proposal's committed expiresAt (a DAA score the chain has already passed)".to_string());
    }
    let vault_redeem = hexdec(&jstr(j, "vaultRedeem")?);
    let funding = jfunding(j)?.ok_or(
        "closing needs fee-funding wallet inputs: the bond returns to the vault in full, so it can no longer pay the network fee",
    )?;

    let mut sb = ScriptBuilder::new();
    sb.add_i64(CLOSE_EXPIRED_SELECTOR).map_err(|e| e.to_string())?;
    sb.add_data(&cur).map_err(|e| e.to_string())?;
    let txid = TransactionId::from_str(&jstr(j, "propTxid")?).map_err(|e| e.to_string())?;
    let mut prop_input = TransactionInput::new(TransactionOutpoint::new(txid, jint(j, "propIndex")? as u32), sb.drain(), 0, 1);
    prop_input.mass = ComputeBudget(30).into(); // same budget the other proposal spends carry
    let prop_spk = pay_to_script_hash_script(&cur);
    // output 0: the bond, whole, to the vault's P2SH — deliberately UNBOUND
    // (closeExpired pins zero covenant outputs; it arrives as a stray deposit)
    let bond_out = TransactionOutput::new(in_val, pay_to_script_hash_script(&vault_redeem));
    let mut inputs = vec![prop_input];
    let mut entries = vec![UtxoEntry { amount: in_val, script_public_key: prop_spk, block_daa_score: 0, is_coinbase: false, covenant_id: None }];
    let mut outputs = vec![bond_out];
    let funding_count = attach_funding(&mut inputs, &mut entries, &mut outputs, &funding, fee)?;
    let tx = Transaction::new(TX_VERSION_TOCCATA, inputs, outputs, lock_time, SUBNETWORK_ID_NATIVE, 0, vec![]);
    let signable = MutableTransaction::with_entries(tx, entries);
    Ok((signable, in_val, funding_count))
}

/// Phase A: the sighashes the closer must sign — one per fee-funding wallet
/// input (the proposal input itself is permissionless and unsigned). JSON array.
#[wasm_bindgen]
pub fn close_expired_sighashes(inputs_json: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let (signable, _, funding_count) = ce_build(&j).map_err(|e| JsError::new(&e))?;
    let shs: Vec<String> = (1..=funding_count).map(|i| sighash_of(&signable, i)).collect();
    Ok(serde_json::to_string(&shs).unwrap())
}

/// Phase B: retire an EXPIRED proposal, returning its bond — whole — to the
/// treasury's vault address. `sigs_json` is the JSON array of 65-byte funding
/// sigs from Phase A. Returns `{ borshHex, txid, outValue }`.
/// `lockTime` must be ≥ the proposal's committed expiresAt and BELOW the chain's
/// current DAA score, or the node holds the transaction as not yet finalized.
#[wasm_bindgen]
pub fn close_expired_build(inputs_json: &str, sigs_json: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let (signable, out_val, funding_count) = ce_build(&j).map_err(|e| JsError::new(&e))?;
    let sigs: Vec<String> = serde_json::from_str(sigs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let mut tx = signable.tx;
    for k in 0..funding_count {
        let s = sigs.get(k).ok_or_else(|| JsError::new("missing funding signature"))?;
        let mut fb = ScriptBuilder::new();
        fb.add_data(&sig65(s)).map_err(|e| JsError::new(&e.to_string()))?;
        tx.inputs[1 + k].signature_script = fb.drain();
    }
    let out = serde_json::json!({
        "borshHex": hexenc(&borsh::to_vec(&tx).map_err(|e| JsError::new(&e.to_string()))?),
        "txid": tx.id().to_string(),
        "outValue": out_val,
    });
    Ok(out.to_string())
}

// ---- Increment 2c: execute a TRANSFER (vault + approved proposal) --------------
// Mirrors execute.rs: spend KoVault + KoProposal; pay the recipient, change
// back to the vault. Owner sig on the proposal input (1); vault input is covenant-
// authorized (no sig).
const EXECUTE_PROPOSAL_SELECTOR: i64 = 0; // KoVault
const EXECUTE_SELECTOR: i64 = 1; // KoProposal
const EXEC_FEE: u64 = 5_000_000;

fn ex_build(j: &serde_json::Value) -> Result<(MutableTransaction<Transaction>, u64, usize), String> {
    let treasury_id = jhash(j, "treasuryId")?;
    let vault_redeem = hexdec(&jstr(j, "vaultRedeem")?);
    let vault_in = jint(j, "vaultAmount")? as u64;
    let prop_in = jint(j, "propAmount")? as u64;
    let amount = jint(j, "amount")? as u64;
    let spk_full = hexdec(&jstr(j, "recipientSpkHex")?);
    let version = u16::from_be_bytes([spk_full[0], spk_full[1]]);
    let recipient_out = TransactionOutput::new(amount, ScriptPublicKey::from_vec(version, spk_full[2..].to_vec()));
    let vault_spk = pay_to_script_hash_script(&vault_redeem);
    let fee = jfee(j, EXEC_FEE)?;
    let funding = jfunding(j)?;
    // owner-funded: the vault keeps every sompi it isn't paying the recipient,
    // so KoVault's `>= vaultIn - amount - maxFee` cap can never bind
    let vault_change = match &funding {
        Some(_) => (vault_in + prop_in).checked_sub(amount),
        None => (vault_in + prop_in).checked_sub(amount + fee),
    }.ok_or_else(|| format!(
        "vault {} + bond {} sompi can't cover the {:.4} KAS transfer + fee", vault_in, prop_in, amount as f64 / 1e8
    ))?;
    let cov = Some(CovenantBinding::new(0, treasury_id));
    let vault_out = TransactionOutput::with_covenant(vault_change, vault_spk.clone(), cov);

    let vault_txid = TransactionId::from_str(&jstr(j, "vaultTxid")?).map_err(|e| e.to_string())?;
    let prop_txid = TransactionId::from_str(&jstr(j, "propTxid")?).map_err(|e| e.to_string())?;
    let vault_input = TransactionInput::new(TransactionOutpoint::new(vault_txid, jint(j, "vaultIndex")? as u32), vec![], 0, 1);
    let prop_input = TransactionInput::new(TransactionOutpoint::new(prop_txid, jint(j, "propIndex")? as u32), vec![], 0, 1);
    let prop_spk = pay_to_script_hash_script(&hexdec(&jstr(j, "proposalRedeem")?));
    let mut inputs = vec![vault_input, prop_input];
    let mut entries = vec![
        UtxoEntry { amount: vault_in, script_public_key: vault_spk, block_daa_score: 0, is_coinbase: false, covenant_id: Some(treasury_id) },
        UtxoEntry { amount: prop_in, script_public_key: prop_spk, block_daa_score: 0, is_coinbase: false, covenant_id: Some(treasury_id) },
    ];
    let mut outputs = vec![recipient_out, vault_out];
    let funding_count = match &funding { Some(f) => attach_funding(&mut inputs, &mut entries, &mut outputs, f, fee)?, None => 0 };
    let mut tx = Transaction::new(TX_VERSION_TOCCATA, inputs, outputs, 0, SUBNETWORK_ID_NATIVE, 0, vec![]);
    tx.inputs[0].mass = ComputeBudget(80).into();
    tx.inputs[1].mass = ComputeBudget(60).into();
    Ok((MutableTransaction::with_entries(tx, entries), vault_change, funding_count))
}

#[wasm_bindgen]
pub fn execute_sighash(inputs_json: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let (signable, ..) = ex_build(&j).map_err(|e| JsError::new(&e))?;
    Ok(sighash_of(&signable, 1)) // owner signs the proposal input
}

/// Phase A (owner-funded): [ownerSighash (proposal input 1), fundingSighash…].
#[wasm_bindgen]
pub fn execute_sighashes(inputs_json: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let (signable, _, funding_count) = ex_build(&j).map_err(|e| JsError::new(&e))?;
    let mut shs = vec![sighash_of(&signable, 1)];
    shs.extend((0..funding_count).map(|k| sighash_of(&signable, 2 + k)));
    Ok(serde_json::to_string(&shs).unwrap())
}

#[wasm_bindgen]
pub fn execute_build(inputs_json: &str, sig_hex: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let (signable, vault_change, funding_count) = ex_build(&j).map_err(|e| JsError::new(&e))?;
    let sigs = split_sigs(sig_hex).map_err(|e| JsError::new(&e))?;
    let sig_hex = sigs.first().ok_or_else(|| JsError::new("missing owner signature"))?.clone();
    let sig_hex = sig_hex.as_str();
    let vault_redeem = hexdec(&jstr(&j, "vaultRedeem").map_err(|e| JsError::new(&e))?);
    let prop_redeem = hexdec(&jstr(&j, "proposalRedeem").map_err(|e| JsError::new(&e))?);
    let recipient_spk = hexdec(&jstr(&j, "recipientSpkHex").map_err(|e| JsError::new(&e))?);
    let executor = jint(&j, "executorIndex").unwrap_or(0);
    let mut tx = signable.tx;
    // vault sigscript: executeProposal(propIdx=1, recipientOut=0, vaultChangeOut=1, recipientSpk)
    let mut vb = ScriptBuilder::new();
    vb.add_i64(1).unwrap();
    vb.add_i64(0).unwrap();
    vb.add_i64(1).unwrap();
    vb.add_data(&recipient_spk).unwrap();
    vb.add_i64(EXECUTE_PROPOSAL_SELECTOR).unwrap();
    vb.add_data(&vault_redeem).unwrap();
    tx.inputs[0].signature_script = vb.drain();
    // proposal sigscript: execute(pairedInputIndex=0, executor, sig)
    let mut pb = ScriptBuilder::new();
    pb.add_i64(0).unwrap();
    pb.add_i64(executor).unwrap();
    pb.add_data(&sig65(sig_hex)).unwrap();
    pb.add_i64(EXECUTE_SELECTOR).unwrap();
    pb.add_data(&prop_redeem).unwrap();
    tx.inputs[1].signature_script = pb.drain();
    inject_funding_sigs(&mut tx, 2, funding_count, &sigs).map_err(|e| JsError::new(&e))?;
    let out = serde_json::json!({
        "borshHex": hexenc(&borsh::to_vec(&tx).map_err(|e| JsError::new(&e.to_string()))?),
        "txid": tx.id().to_string(), "vaultChange": vault_change,
        "ownerFunded": funding_count > 0,
    });
    Ok(out.to_string())
}

// ---- Increment 2d: config change (executeConfig) ------------------------------
const EXECUTE_CONFIG_SELECTOR: i64 = 2; // KoRoot abi: createProposal=0, bootstrapVault=1, executeConfig=2

/// CONFIG proposal commitment: blake2b(newThreshold8 ‖ newOwnerCount8 ‖ owner0..4),
/// counts as 8-byte LE, owners as raw 32 bytes. `owners5_json` = 5 hex pubkeys.
#[wasm_bindgen]
pub fn config_commit(new_threshold: i64, new_owner_count: i64, owners5_json: &str) -> Result<String, JsError> {
    let owners: Vec<String> = serde_json::from_str(owners5_json).map_err(|e| JsError::new(&e.to_string()))?;
    if owners.len() != 5 {
        return Err(JsError::new("owners5 must have exactly 5 entries"));
    }
    let mut pre = Vec::with_capacity(176);
    pre.extend_from_slice(&(new_threshold as u64).to_le_bytes());
    pre.extend_from_slice(&(new_owner_count as u64).to_le_bytes());
    for o in &owners {
        pre.extend_from_slice(&hexdec(o));
    }
    Ok(hexenc(&blake2b256(&pre)))
}

fn ecfg_owners(j: &serde_json::Value) -> Result<Vec<[u8; 32]>, String> {
    let arr = j["newOwners"].as_array().ok_or("newOwners must be an array")?;
    arr.iter()
        .map(|v| {
            let d = hexdec(v.as_str().ok_or("owner not a string")?);
            let mut o = [0u8; 32];
            o.copy_from_slice(&d);
            Ok(o)
        })
        .collect()
}

fn ecfg_build(j: &serde_json::Value) -> Result<(MutableTransaction<Transaction>, Vec<u8>, usize), String> {
    let root = hexdec(&jstr(j, "rootScript")?);
    let r = jint(j, "rStart")? as usize;
    let treasury_id = jhash(j, "treasuryId")?;
    let root_in = jint(j, "rootAmount")? as u64;
    let prop_in = jint(j, "propAmount")? as u64;
    let new_threshold = jint(j, "newThreshold")?;
    let new_owner_count = jint(j, "newOwnerCount")?;
    let owners = ecfg_owners(j)?;

    // continue KoRoot with the new config (nonce preserved)
    let mut new_root = root.clone();
    new_root[r + 9..r + 18].copy_from_slice(&enc_int(new_threshold));
    new_root[r + 18..r + 27].copy_from_slice(&enc_int(new_owner_count));
    for (i, o) in owners.iter().enumerate() {
        let off = r + 27 + i * 33;
        new_root[off..off + 33].copy_from_slice(&enc_b32(o));
    }
    let cov = Some(CovenantBinding::new(0, treasury_id));
    let fee = jfee(j, PROP_OP_FEE)?;
    let funding = jfunding(j)?;
    // owner-funded: the root keeps root_in + bond in full, so KoRoot's
    // `>= rootIn - maxProposalFee` cap can never bind
    let root_out_val = match &funding {
        Some(_) => root_in + prop_in,
        None => (root_in + prop_in).checked_sub(fee).ok_or_else(|| format!(
            "root {} + bond {} sompi can't cover the config-execute fee", root_in, prop_in
        ))?,
    };
    let root_out = TransactionOutput::with_covenant(root_out_val, pay_to_script_hash_script(&new_root), cov);

    let root_txid = TransactionId::from_str(&jstr(j, "rootTxid")?).map_err(|e| e.to_string())?;
    let prop_txid = TransactionId::from_str(&jstr(j, "propTxid")?).map_err(|e| e.to_string())?;
    let root_input = TransactionInput::new(TransactionOutpoint::new(root_txid, jint(j, "rootIndex")? as u32), vec![], 0, 1);
    let prop_input = TransactionInput::new(TransactionOutpoint::new(prop_txid, jint(j, "propIndex")? as u32), vec![], 0, 1);
    let mut inputs = vec![root_input, prop_input];
    let mut entries = vec![
        UtxoEntry { amount: root_in, script_public_key: pay_to_script_hash_script(&root), block_daa_score: 0, is_coinbase: false, covenant_id: Some(treasury_id) },
        UtxoEntry { amount: prop_in, script_public_key: pay_to_script_hash_script(&hexdec(&jstr(j, "proposalRedeem")?)), block_daa_score: 0, is_coinbase: false, covenant_id: Some(treasury_id) },
    ];
    let mut outputs = vec![root_out];
    let funding_count = match &funding { Some(f) => attach_funding(&mut inputs, &mut entries, &mut outputs, f, fee)?, None => 0 };
    let mut tx = Transaction::new(TX_VERSION_TOCCATA, inputs, outputs, 0, SUBNETWORK_ID_NATIVE, 0, vec![]);
    tx.inputs[0].mass = ComputeBudget(80).into();
    tx.inputs[1].mass = ComputeBudget(60).into();
    Ok((MutableTransaction::with_entries(tx, entries), new_root, funding_count))
}

#[wasm_bindgen]
pub fn execute_config_sighash(inputs_json: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let (signable, ..) = ecfg_build(&j).map_err(|e| JsError::new(&e))?;
    Ok(sighash_of(&signable, 1))
}

/// Phase A (owner-funded): [ownerSighash (proposal input 1), fundingSighash…].
#[wasm_bindgen]
pub fn execute_config_sighashes(inputs_json: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let (signable, _, funding_count) = ecfg_build(&j).map_err(|e| JsError::new(&e))?;
    let mut shs = vec![sighash_of(&signable, 1)];
    shs.extend((0..funding_count).map(|k| sighash_of(&signable, 2 + k)));
    Ok(serde_json::to_string(&shs).unwrap())
}

#[wasm_bindgen]
pub fn execute_config_build(inputs_json: &str, sig_hex: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let (signable, new_root, funding_count) = ecfg_build(&j).map_err(|e| JsError::new(&e))?;
    let sigs = split_sigs(sig_hex).map_err(|e| JsError::new(&e))?;
    let sig_owned = sigs.first().ok_or_else(|| JsError::new("missing owner signature"))?.clone();
    let sig_hex = sig_owned.as_str();
    let root_redeem = hexdec(&jstr(&j, "rootScript").map_err(|e| JsError::new(&e))?);
    let prop_redeem = hexdec(&jstr(&j, "proposalRedeem").map_err(|e| JsError::new(&e))?);
    let owners = ecfg_owners(&j).map_err(|e| JsError::new(&e))?;
    let executor = jint(&j, "executorIndex").unwrap_or(0);
    let mut tx = signable.tx;
    // root sigscript: executeConfig(propInputIndex=1, thr8, cnt8, owner0..4)
    let mut rb = ScriptBuilder::new();
    rb.add_i64(1).unwrap();
    rb.add_data(&(jint(&j, "newThreshold").unwrap() as u64).to_le_bytes()).unwrap();
    rb.add_data(&(jint(&j, "newOwnerCount").unwrap() as u64).to_le_bytes()).unwrap();
    for o in &owners {
        rb.add_data(o).unwrap();
    }
    rb.add_i64(EXECUTE_CONFIG_SELECTOR).unwrap();
    rb.add_data(&root_redeem).unwrap();
    tx.inputs[0].signature_script = rb.drain();
    // proposal sigscript: execute(pairedInputIndex=0, executor, sig)
    let mut pb = ScriptBuilder::new();
    pb.add_i64(0).unwrap();
    pb.add_i64(executor).unwrap();
    pb.add_data(&sig65(sig_hex)).unwrap();
    pb.add_i64(EXECUTE_SELECTOR).unwrap();
    pb.add_data(&prop_redeem).unwrap();
    tx.inputs[1].signature_script = pb.drain();
    inject_funding_sigs(&mut tx, 2, funding_count, &sigs).map_err(|e| JsError::new(&e))?;
    let out = serde_json::json!({
        "borshHex": hexenc(&borsh::to_vec(&tx).map_err(|e| JsError::new(&e.to_string()))?),
        "txid": tx.id().to_string(), "newRootHex": hexenc(&new_root),
        "ownerFunded": funding_count > 0,
    });
    Ok(out.to_string())
}

// ---- Increment 2e: genesis (create treasury, part 1 of 2) ------------------------
// Mirrors genesis.rs: fund the KoRoot and bind it — and ONLY it — into a fresh
// covenant domain, so the id the network derives depends on nothing but the root.
// The vault is minted afterwards by bootstrap_* below, as a continuation of that
// id: a covenant id hashes the scriptPubKeys of its own genesis group, so a vault
// carrying the id could not be a member of the group that produced it. Output 1,
// when present, is ordinary unbound change back to the funder — it inherits
// nothing. Carries the KOSGN recovery inscription in the payload. Two-phase:
// sighashes (one per funding input) → inject the funding sigs.

/// KOSGN recovery inscription bytes (hex). Mirrors lib.rs::encode_recovery:
/// "KOSGN" | ver=1 | threshold | ownerCount | lineage[32] | realOwner[32]*count.
///
/// The 32-byte slot carries the treasury's covenant id. That makes the whole
/// record checkable: an auditor recomputes the id from the genesis transaction
/// itself (genesis_covenant_id) and compares, and the vault address follows from
/// it by derivation — so a forged inscription names a treasury that is not the one
/// whose address the money is going to.
#[wasm_bindgen]
pub fn inscription(threshold: i64, real_owners_json: &str, lineage_hex: &str) -> Result<String, JsError> {
    let owners: Vec<String> = serde_json::from_str(real_owners_json).map_err(|e| JsError::new(&e.to_string()))?;
    let mut v = Vec::new();
    v.extend_from_slice(b"KOSGN");
    v.push(1u8);
    v.push(threshold as u8);
    v.push(owners.len() as u8);
    v.extend_from_slice(&hexdec(lineage_hex));
    for o in &owners {
        v.extend_from_slice(&hexdec(o));
    }
    Ok(hexenc(&v))
}

// Genesis binds output 0 (the KoRoot) to the outpoint of funding input 0.
const ROOT_OUTPUT_INDEX: u32 = 0;

/// The covenant id a genesis WILL mint, computed from its inputs alone —
/// `{ fundingUtxos[0], rootRedeem, rootValue }` — with no transaction built and
/// nothing broadcast.
///
/// The id is a hash of the authorizing input's outpoint plus the value and
/// scriptPubKey of every output in its group, and the group is the root alone.
/// None of that depends on the payload, the change, or the fee, so this is the
/// same value gen_build reports after the fact and the same one the node will
/// derive. The browser needs it BEFORE it signs: the vault address is derived
/// from it, and the inscription carries it.
#[wasm_bindgen]
pub fn genesis_covenant_id(inputs_json: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let (outpoint, root_out) = genesis_anchor(&j).map_err(|e| JsError::new(&e))?;
    Ok(covenant_id(outpoint, std::iter::once((ROOT_OUTPUT_INDEX, &root_out))).to_string())
}

/// The two things the covenant id is derived from: the authorizing input's
/// outpoint and the root output it authorizes.
fn genesis_anchor(j: &serde_json::Value) -> Result<(TransactionOutpoint, TransactionOutput), String> {
    let u = j["fundingUtxos"].as_array().and_then(|a| a.first()).ok_or("fundingUtxos must have at least one entry")?;
    let txid = TransactionId::from_str(u["txid"].as_str().ok_or("utxo.txid")?).map_err(|e| e.to_string())?;
    let outpoint = TransactionOutpoint::new(txid, u["index"].as_u64().ok_or("utxo.index")? as u32);
    let root_out = TransactionOutput::new(jint(j, "rootValue")? as u64, pay_to_script_hash_script(&hexdec(&jstr(j, "rootRedeem")?)));
    Ok((outpoint, root_out))
}

fn gen_build(j: &serde_json::Value) -> Result<(MutableTransaction<Transaction>, Hash), String> {
    let funding_addr = Address::try_from(jstr(j, "fundingAddress")?.as_str()).map_err(|e| format!("{e:?}"))?;
    let funding_spk = pay_to_address_script(&funding_addr);
    let (_, root_out) = genesis_anchor(j)?;
    let change_i = jint(j, "change")?;
    if change_i < 0 { return Err(format!("negative change ({change_i} sompi): funding does not cover the root + fee")); }
    let change = change_i as u64;
    let mut outputs = vec![root_out];
    // a zero-value output is rejected outright (dust) — omit change when the
    // caller folds it into the fee
    if change > 0 { outputs.push(TransactionOutput::new(change, funding_spk.clone())); }
    let utxos = j["fundingUtxos"].as_array().ok_or("fundingUtxos must be an array")?;
    let mut inputs = Vec::new();
    let mut entries = Vec::new();
    for u in utxos {
        let txid = TransactionId::from_str(u["txid"].as_str().ok_or("utxo.txid")?).map_err(|e| e.to_string())?;
        let idx = u["index"].as_u64().ok_or("utxo.index")? as u32;
        let amount = u["amount"].as_u64().ok_or("utxo.amount")?;
        inputs.push(TransactionInput::new(TransactionOutpoint::new(txid, idx), vec![], 0, 1));
        entries.push(UtxoEntry { amount, script_public_key: funding_spk.clone(), block_daa_score: 0, is_coinbase: false, covenant_id: None });
    }
    let payload = hexdec(&jstr(j, "payloadHex")?);
    let mut tx = Transaction::new(TX_VERSION_TOCCATA, inputs, outputs, 0, SUBNETWORK_ID_NATIVE, 0, payload);
    // ONLY the root. Every extra member of this group would be hashed into the id,
    // and the vault has to be built AROUND the id.
    tx.populate_genesis_covenants(&[GenesisCovenantGroup { authorizing_input: 0, outputs: vec![ROOT_OUTPUT_INDEX] }]).map_err(|e| format!("{e:?}"))?;
    let treasury_id = tx.outputs[0].covenant.ok_or("no covenant on output 0")?.covenant_id;
    let mut signable = MutableTransaction::with_entries(tx, entries);
    for inp in signable.tx.inputs.iter_mut() {
        inp.mass = ComputeBudget(10).into(); // match sign(): part of the sighash
    }
    Ok((signable, treasury_id))
}

/// Phase A: one sighash per funding input (JSON array of hex), + the treasuryId.
#[wasm_bindgen]
pub fn genesis_sighashes(inputs_json: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let (signable, treasury_id) = gen_build(&j).map_err(|e| JsError::new(&e))?;
    let sighashes: Vec<String> = (0..signable.tx.inputs.len()).map(|i| sighash_of(&signable, i)).collect();
    Ok(serde_json::json!({ "sighashes": sighashes, "treasuryId": treasury_id.to_string() }).to_string())
}

/// Phase B: inject the funding sigs (JSON array of 64-byte hex). Returns the
/// signed tx Borsh + treasuryId.
#[wasm_bindgen]
pub fn genesis_build(inputs_json: &str, sigs_json: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let sigs: Vec<String> = serde_json::from_str(sigs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let (signable, treasury_id) = gen_build(&j).map_err(|e| JsError::new(&e))?;
    let mut tx = signable.tx;
    if sigs.len() != tx.inputs.len() {
        return Err(JsError::new("need one signature per funding input"));
    }
    for (i, sig) in sigs.iter().enumerate() {
        let mut b = ScriptBuilder::new();
        b.add_data(&sig65(sig)).unwrap();
        tx.inputs[i].signature_script = b.drain();
    }
    Ok(serde_json::json!({ "borshHex": hexenc(&borsh::to_vec(&tx).map_err(|e| JsError::new(&e.to_string()))?), "treasuryId": treasury_id.to_string(), "txid": tx.id().to_string() }).to_string())
}

// ---- Increment 2f: bootstrapVault (create treasury, part 2 of 2) -----------------
// Spend the KoRoot and mint the treasury's KoVault as a CONTINUATION of the root's
// own covenant id, stamping that id into the vault's state. The vault refuses to
// work under any other lineage, so its address — P2SH(prefix ‖ push32 ‖ id ‖
// suffix) — is one only this treasury can ever spend from. That is what makes an
// incoming payment to it safe, and it is why this transaction, not the genesis, is
// the moment a deposit address exists.
//
// Input 0 is the root (covenant-authorized, plus an owner signature the contract
// demands); the vault's endowment and the network fee come from the caller's own
// P2PK inputs, which the root's value floor does not touch. Output 0 continues the
// root UNCHANGED — no nonce bump — and output 1 is the new vault. Retryable: a
// second call mints another vault UTXO at the same address under the same lineage,
// which `deposit` consolidates.
const BOOTSTRAP_VAULT_SELECTOR: i64 = 1; // KoRoot abi: createProposal=0, bootstrapVault=1, executeConfig=2
const BOOTSTRAP_FEE: u64 = 10_000_000; // 0.1 KAS = maxProposalFee, the covenant-funded ceiling
// The root input runs KoRoot's heaviest path bar none: a full root continuation,
// the vault template hashed and rebuilt around the id, and the input walk behind
// the value floor. Twice createProposal's proven budget, because the vault
// template is ~2.5x the proposal template this path also stopped emitting; the
// extra allowance costs 2,000 grams, which is noise beside the endowment.
const BOOTSTRAP_ROOT_BUDGET: u16 = 40;

struct BvBuilt {
    signable: MutableTransaction<Transaction>,
    vault_redeem: Vec<u8>,
    funding_count: usize,
}

/// The vault redeem script for a lineage: the template with the id spliced into
/// its one state slot. Byte-identical to frontend/src/treasuryRebuild.js
/// rebuildVault — the address both produce is the treasury's.
fn vault_redeem_for(prefix: &[u8], lineage: &Hash, suffix: &[u8]) -> Vec<u8> {
    let mut v = prefix.to_vec();
    v.extend(enc_b32(&lineage.as_bytes()));
    v.extend_from_slice(suffix);
    v
}

fn bv_build(j: &serde_json::Value) -> Result<BvBuilt, String> {
    let root = hexdec(&jstr(j, "rootScript")?);
    let lineage = jhash(j, "treasuryId")?;
    let root_in = jint(j, "rootAmount")? as u64;
    let vault_value = jint(j, "vaultValue")? as u64;
    let vault_redeem = vault_redeem_for(&hexdec(&jstr(j, "vaultPrefix")?), &lineage, &hexdec(&jstr(j, "vaultSuffix")?));
    let fee = jfee(j, BOOTSTRAP_FEE)?;
    let funding = jfunding(j)?;

    // The value floor is `out0 + out1 >= (sum of root-address inputs) - maxProposalFee`.
    // Owner-funded, the root continues at its FULL value and the vault is pure
    // addition, so the floor cannot bind however the network reprices. Covenant-funded
    // (no fundingUtxos), the endowment and the fee both come out of the root's
    // reserve, and the floor then caps exactly the fee.
    let root_out_val = match &funding {
        Some(_) => root_in,
        None => root_in.checked_sub(vault_value + fee).ok_or_else(|| format!(
            "KoRoot reserve {} sompi ({:.4} KAS) can't fund the vault ({:.4} KAS) plus the {:.4} KAS fee — fund the bootstrap from your wallet instead",
            root_in, root_in as f64 / 1e8, vault_value as f64 / 1e8, fee as f64 / 1e8
        ))?,
    };
    let cov = Some(CovenantBinding::new(0, lineage));
    let mut outputs = vec![
        TransactionOutput::with_covenant(root_out_val, pay_to_script_hash_script(&root), cov),
        TransactionOutput::with_covenant(vault_value, pay_to_script_hash_script(&vault_redeem), cov),
    ];
    let root_txid = TransactionId::from_str(&jstr(j, "rootTxid")?).map_err(|e| e.to_string())?;
    let mut inputs = vec![TransactionInput::new(TransactionOutpoint::new(root_txid, jint(j, "rootIndex")? as u32), vec![], 0, 1)];
    let mut entries = vec![UtxoEntry {
        amount: root_in, script_public_key: pay_to_script_hash_script(&root), block_daa_score: 0, is_coinbase: false,
        covenant_id: Some(lineage),
    }];
    let funding_count = match &funding {
        Some(f) => {
            // attach_funding reports a shortfall as a fee it cannot cover; here the
            // wallet is also paying for the vault, so say which of the two is short.
            let total: u64 = f.utxos.iter().map(|u| u.2).sum();
            if total < vault_value + fee {
                return Err(format!(
                    "your wallet ({:.4} KAS in the selected inputs) can't fund the vault ({:.4} KAS) plus the {:.4} KAS network fee",
                    total as f64 / 1e8, vault_value as f64 / 1e8, fee as f64 / 1e8
                ));
            }
            attach_funding(&mut inputs, &mut entries, &mut outputs, f, vault_value + fee)?
        }
        None => 0,
    };
    let tx = Transaction::new(TX_VERSION_TOCCATA, inputs, outputs, 0, SUBNETWORK_ID_NATIVE, 0, vec![]);
    let mut signable = MutableTransaction::with_entries(tx, entries);
    signable.tx.inputs[0].mass = ComputeBudget(BOOTSTRAP_ROOT_BUDGET).into();
    Ok(BvBuilt { signable, vault_redeem, funding_count })
}

/// The vault redeem script + P2SH scriptPubKey a lineage derives, with no
/// transaction involved — so a caller can show (and verify) the deposit address
/// the bootstrap will create.
#[wasm_bindgen]
pub fn vault_for_lineage(vault_prefix_hex: &str, lineage_hex: &str, vault_suffix_hex: &str) -> Result<String, JsError> {
    let lineage = Hash::from_str(lineage_hex).map_err(|e| JsError::new(&e.to_string()))?;
    let redeem = vault_redeem_for(&hexdec(vault_prefix_hex), &lineage, &hexdec(vault_suffix_hex));
    let spk = pay_to_script_hash_script(&redeem);
    let mut spk_full = spk.version().to_be_bytes().to_vec();
    spk_full.extend_from_slice(spk.script());
    Ok(serde_json::json!({ "vaultRedeemHex": hexenc(&redeem), "vaultSpkHex": hexenc(&spk_full) }).to_string())
}

/// Phase A: every sighash the owner must sign — the KoRoot covenant input (0, the
/// signature bootstrapVault checks) plus each wallet funding input. JSON array.
#[wasm_bindgen]
pub fn bootstrap_sighashes(inputs_json: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let b = bv_build(&j).map_err(|e| JsError::new(&e))?;
    let shs: Vec<String> = (0..=b.funding_count).map(|i| sighash_of(&b.signable, i)).collect();
    Ok(serde_json::to_string(&shs).unwrap())
}

/// Phase B: inject the owner's sig (single hex, or a JSON array [ownerSig,
/// fundingSig…]) → signed tx Borsh hex + the vault redeem the treasury now has.
#[wasm_bindgen]
pub fn bootstrap_build(inputs_json: &str, sig_hex: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let b = bv_build(&j).map_err(|e| JsError::new(&e))?;
    let sigs = split_sigs(sig_hex).map_err(|e| JsError::new(&e))?;
    let owner_sig = sigs.first().ok_or_else(|| JsError::new("missing owner signature"))?;
    let root_redeem = hexdec(&jstr(&j, "rootScript").map_err(|e| JsError::new(&e))?);
    // root sigscript: bootstrapVault(ownerIndex, ownerSig, vaultTemplatePrefix,
    // vaultTemplateSuffix). The template bytes are the spender's to supply; the
    // contract pins them by hash.
    let mut sb = ScriptBuilder::new();
    sb.add_i64(jint(&j, "ownerIndex").map_err(|e| JsError::new(&e))?).unwrap();
    sb.add_data(&sig65(owner_sig)).unwrap();
    sb.add_data(&hexdec(&jstr(&j, "vaultPrefix").map_err(|e| JsError::new(&e))?)).unwrap();
    sb.add_data(&hexdec(&jstr(&j, "vaultSuffix").map_err(|e| JsError::new(&e))?)).unwrap();
    sb.add_i64(BOOTSTRAP_VAULT_SELECTOR).unwrap();
    sb.add_data(&root_redeem).unwrap();
    let mut tx = b.signable.tx;
    tx.inputs[0].signature_script = sb.drain();
    inject_funding_sigs(&mut tx, 1, b.funding_count, &sigs).map_err(|e| JsError::new(&e))?;
    let out = serde_json::json!({
        "borshHex": hexenc(&borsh::to_vec(&tx).map_err(|e| JsError::new(&e.to_string()))?),
        "txid": tx.id().to_string(),
        "vaultRedeemHex": hexenc(&b.vault_redeem),
        "ownerFunded": b.funding_count > 0,
    });
    Ok(out.to_string())
}


// ---- Increment 1: deposit/sweep (permissionless, no signature) ----------------
// Mirrors tools/kaspa-probe/src/bin/deposit.rs (sweep case): spend every UTXO at
// the fixed vault address into one consolidated vault output that keeps the
// covenant binding (so the new vault UTXO inherits treasuryId). `utxos` = (outpoint
// txid, index, amount, is_covenant). The covenant UTXO is the authorizing input.
pub fn build_sweep(vault_redeem: &[u8], treasury_id: Hash, utxos: &[(TransactionId, u32, u64, bool)], fee: u64) -> Transaction {
    let vault_spk = pay_to_script_hash_script(vault_redeem);
    let sum: u64 = utxos.iter().map(|u| u.2).sum();
    let cov_pos = utxos.iter().position(|u| u.3).expect("no covenant vault UTXO among the inputs");
    let mut inputs = Vec::with_capacity(utxos.len());
    for u in utxos {
        // vault input sigscript: deposit selector + redeem reveal (no signature)
        let mut b = ScriptBuilder::new();
        b.add_i64(DEPOSIT_SELECTOR).unwrap();
        b.add_data(vault_redeem).unwrap();
        let mut inp = TransactionInput::new(TransactionOutpoint::new(u.0, u.1), b.drain(), 0, 1);
        inp.mass = ComputeBudget(120).into();
        inputs.push(inp);
    }
    let cov = Some(CovenantBinding::new(cov_pos as u16, treasury_id));
    let out = TransactionOutput::with_covenant(sum - fee, vault_spk, cov);
    Transaction::new(TX_VERSION_TOCCATA, inputs, vec![out], 0, SUBNETWORK_ID_NATIVE, 0, vec![])
}

fn parse_utxos(utxos_json: &str) -> Result<Vec<(TransactionId, u32, u64, bool)>, String> {
    let v: serde_json::Value = serde_json::from_str(utxos_json).map_err(|e| e.to_string())?;
    let arr = v.as_array().ok_or("utxos must be a JSON array")?;
    arr.iter()
        .map(|u| {
            let txid = TransactionId::from_str(u["txid"].as_str().ok_or("utxo.txid missing")?).map_err(|e| e.to_string())?;
            Ok((
                txid,
                u["index"].as_u64().ok_or("utxo.index missing")? as u32,
                u["amount"].as_u64().ok_or("utxo.amount missing")?,
                u["covenant"].as_bool().unwrap_or(false),
            ))
        })
        .collect()
}

/// Build a sweep tx and return its TXID (hex). `utxos_json` =
/// [{"txid","index","amount","covenant"}]. Verifiable against the native tool.
#[wasm_bindgen]
pub fn build_sweep_txid(vault_redeem_hex: &str, treasury_id_hex: &str, utxos_json: &str, fee: u64) -> Result<String, JsError> {
    let redeem = hexdec(vault_redeem_hex);
    let treasury_id = Hash::from_str(treasury_id_hex).map_err(|e| JsError::new(&e.to_string()))?;
    let utxos = parse_utxos(utxos_json).map_err(|e| JsError::new(&e))?;
    Ok(build_sweep(&redeem, treasury_id, &utxos, fee).id().to_string())
}

/// Build a sweep tx and return it Borsh-serialized (hex) — the submission-ready
/// interchange for the thin relay, which Borsh-deserializes it back into a
/// consensus Transaction (-> RpcTransaction -> submitTransaction). Borsh is what
/// the consensus tx type derives, so it round-trips exactly.
// ---- Funded sweep: vault value fully preserved; the SWEEPER pays the fee ------
// KoVault.deposit now enforces output0 >= sum(all vault-address inputs), so the
// network fee must come from extra P2PK inputs the sweeper adds and signs (this
// also satisfies the legacy `>= sum - cap` vaults, so it works on every treasury).
// Two-phase like create_proposal: sighashes for the funder inputs → inject sigs.
// inputs_json: { vaultRedeem, treasuryId, vaultUtxos: [{txid,index,amount,covenant}],
//               ownerAddress, fundingUtxos: [{txid,index,amount}], fee }
// Vault deposit inputs: engine-measured execution cost is ≤5,001 script units
// even at the contract's 16-input cap (~4,000 base + 93 per extra input; salt
// length 1–75 shifts it <150). ComputeBudget(2) allows 29,999 units (~6×
// headroom) and prices each input at 200 grams instead of the old
// over-provisioned 120 (12,000 grams) — cutting per-deposit sweep fees ~7×.
// `budgetVault` in the inputs JSON overrides it (used by on-chain test probes).
const VAULT_DEPOSIT_BUDGET: u16 = 2;

fn sweep_funded_build(j: &serde_json::Value) -> Result<(MutableTransaction<Transaction>, usize, usize), String> {
    let redeem = hexdec(&jstr(j, "vaultRedeem")?);
    let treasury_id = Hash::from_str(&jstr(j, "treasuryId")?).map_err(|e| e.to_string())?;
    let vault_utxos = parse_utxos(&j["vaultUtxos"].to_string())?;
    if vault_utxos.is_empty() { return Err("no vault UTXOs to sweep".into()); }
    let budget_vault = j["budgetVault"].as_u64().map(|v| v as u16).unwrap_or(VAULT_DEPOSIT_BUDGET);
    let fee = jint(j, "fee")? as u64;
    let owner_addr = Address::try_from(jstr(j, "ownerAddress")?.as_str()).map_err(|e| format!("ownerAddress: {e:?}"))?;
    let owner_spk = pay_to_address_script(&owner_addr);
    let vault_spk = pay_to_script_hash_script(&redeem);

    let vault_sum: u64 = vault_utxos.iter().map(|u| u.2).sum();
    let cov_pos = vault_utxos.iter().position(|u| u.3).ok_or("no covenant vault UTXO among the inputs")?;

    let mut inputs = Vec::new();
    let mut entries = Vec::new();
    for u in &vault_utxos {
        let mut b = ScriptBuilder::new();
        b.add_i64(DEPOSIT_SELECTOR).unwrap();
        b.add_data(&redeem).unwrap();
        let mut inp = TransactionInput::new(TransactionOutpoint::new(u.0, u.1), b.drain(), 0, 1);
        inp.mass = ComputeBudget(budget_vault).into();
        inputs.push(inp);
        entries.push(UtxoEntry {
            amount: u.2, script_public_key: vault_spk.clone(), block_daa_score: 0, is_coinbase: false,
            covenant_id: if u.3 { Some(treasury_id) } else { None },
        });
    }
    let funders = j["fundingUtxos"].as_array().ok_or("fundingUtxos must be an array")?;
    if funders.is_empty() { return Err("the sweeper must fund the fee: no fundingUtxos given".into()); }
    let funding_total: u64 = funders.iter().map(|u| u["amount"].as_u64().unwrap_or(0)).sum();
    let change = funding_total.checked_sub(fee).ok_or_else(|| format!(
        "your wallet ({:.4} KAS in the selected inputs) can't cover the sweep fee ({:.4} KAS)",
        funding_total as f64 / 1e8, fee as f64 / 1e8
    ))?;
    let n_vault = inputs.len();
    for u in funders {
        let txid = TransactionId::from_str(u["txid"].as_str().ok_or("fundingUtxo.txid")?).map_err(|e| e.to_string())?;
        let mut inp = TransactionInput::new(TransactionOutpoint::new(txid, u["index"].as_u64().ok_or("fundingUtxo.index")? as u32), vec![], 0, 1);
        inp.mass = ComputeBudget(10).into();
        inputs.push(inp);
        entries.push(UtxoEntry { amount: u["amount"].as_u64().ok_or("fundingUtxo.amount")?, script_public_key: owner_spk.clone(), block_daa_score: 0, is_coinbase: false, covenant_id: None });
    }

    let cov = Some(CovenantBinding::new(cov_pos as u16, treasury_id));
    let mut outputs = vec![TransactionOutput::with_covenant(vault_sum, vault_spk, cov)]; // every sompi returns
    if change > 0 { outputs.push(TransactionOutput::new(change, owner_spk)); }

    let tx = Transaction::new(TX_VERSION_TOCCATA, inputs, outputs, 0, SUBNETWORK_ID_NATIVE, 0, vec![]);
    let signable = MutableTransaction::with_entries(tx, entries);
    Ok((signable, n_vault, funders.len()))
}

/// Node-side masses of the funded sweep tx: { computeMass, transientMass }.
/// Funding inputs get placeholder 65-byte signatures so the serialized size
/// matches the final signed tx. The UI sets fee ≥ max(compute, transient) ×
/// the network's minimum relay feerate (sompi/gram) — the node's mempool
/// standard check (RejectInsufficientComputeFee) prices exactly these masses.
#[wasm_bindgen]
pub fn sweep_funded_mass(inputs_json: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let (signable, n_vault, n_fund) = sweep_funded_build(&j).map_err(|e| JsError::new(&e))?;
    let mut tx = signable.tx;
    for k in 0..n_fund {
        let mut fb = ScriptBuilder::new();
        fb.add_data(&[0u8; 65]).unwrap();
        tx.inputs[n_vault + k].signature_script = fb.drain();
    }
    // mass_per_tx_byte = 1, mass_per_script_pub_key_byte = 10 on every network;
    // the storage-mass parameter only affects contextual mass (not computed here)
    let m = MassCalculator::new(1, 10, STORAGE_MASS_PARAMETER).calc_non_contextual_masses(&tx);
    Ok(serde_json::json!({ "computeMass": m.compute_mass, "transientMass": m.transient_mass }).to_string())
}

/// Phase A: sighashes the sweeper must sign — one per funding input. JSON array.
#[wasm_bindgen]
pub fn sweep_funded_sighashes(inputs_json: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let (signable, n_vault, n_fund) = sweep_funded_build(&j).map_err(|e| JsError::new(&e))?;
    let shs: Vec<String> = (n_vault..n_vault + n_fund).map(|i| sighash_of(&signable, i)).collect();
    Ok(serde_json::to_string(&shs).unwrap())
}

/// Phase B: inject the funder's 64-byte sigs (JSON array) → signed tx Borsh hex + txid.
#[wasm_bindgen]
pub fn sweep_funded_tx(inputs_json: &str, sigs_json: &str) -> Result<String, JsError> {
    let j: serde_json::Value = serde_json::from_str(inputs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let (signable, n_vault, n_fund) = sweep_funded_build(&j).map_err(|e| JsError::new(&e))?;
    let sigs: Vec<String> = serde_json::from_str(sigs_json).map_err(|e| JsError::new(&e.to_string()))?;
    let mut tx = signable.tx;
    for k in 0..n_fund {
        let s = sigs.get(k).ok_or_else(|| JsError::new("missing funding signature"))?;
        let mut fb = ScriptBuilder::new();
        fb.add_data(&sig65(s)).unwrap();
        tx.inputs[n_vault + k].signature_script = fb.drain();
    }
    let borsh_hex = hexenc(&borsh::to_vec(&tx).map_err(|e| JsError::new(&e.to_string()))?);
    Ok(serde_json::json!({ "borshHex": borsh_hex, "txid": tx.id().to_string() }).to_string())
}
