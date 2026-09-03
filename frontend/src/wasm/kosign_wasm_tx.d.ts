/* tslint:disable */
/* eslint-disable */
/**
 * Phase B: inject the proposer's 64-byte sig and return the signed tx (Borsh
 * hex) + the new proposal/root redeem scripts and metadata (JSON).
 */
export function create_proposal_build(inputs_json: string, sig_hex: string): string;
export function execute_sighash(inputs_json: string): string;
/**
 * Phase A (owner-funded): [ownerSighash, fundingSighash…] — JSON array.
 */
export function reject_sighashes(inputs_json: string): string;
/**
 * Build a covenant continuation tx (1 in / 1 out) and return its schnorr sighash.
 */
export function probe_sighash(prev_txid_hex: string, redeem_hex: string, amount: bigint, treasury_id_hex: string): string;
/**
 * Phase B: inject the funder's 64-byte sigs (JSON array) → signed tx Borsh hex + txid.
 */
export function sweep_funded_tx(inputs_json: string, sigs_json: string): string;
/**
 * Phase B: retire an EXPIRED proposal, returning its bond — whole — to the
 * treasury's vault address. `sigs_json` is the JSON array of 65-byte funding
 * sigs from Phase A. Returns `{ borshHex, txid, outValue }`.
 * `lockTime` must be ≥ the proposal's committed expiresAt and BELOW the chain's
 * current DAA score, or the node holds the transaction as not yet finalized.
 */
export function close_expired_build(inputs_json: string, sigs_json: string): string;
/**
 * Phase A (owner-funded): [ownerSighash (proposal input 1), fundingSighash…].
 */
export function execute_config_sighashes(inputs_json: string): string;
/**
 * Phase A: every sighash the owner must sign — the KoRoot covenant input (0, the
 * signature bootstrapVault checks) plus each wallet funding input. JSON array.
 */
export function bootstrap_sighashes(inputs_json: string): string;
/**
 * Phase B: inject the owner's sig (single hex, or a JSON array [ownerSig,
 * fundingSig…]) → signed tx Borsh hex + the vault redeem the treasury now has.
 */
export function bootstrap_build(inputs_json: string, sig_hex: string): string;
export function execute_build(inputs_json: string, sig_hex: string): string;
/**
 * Phase A (owner-funded): [ownerSighash, fundingSighash…] — JSON array.
 */
export function approve_sighashes(inputs_json: string): string;
export function execute_config_build(inputs_json: string, sig_hex: string): string;
export function approve_sighash(inputs_json: string): string;
/**
 * Node-side masses of the funded sweep tx: { computeMass, transientMass }.
 * Funding inputs get placeholder 65-byte signatures so the serialized size
 * matches the final signed tx. The UI sets fee ≥ max(compute, transient) ×
 * the network's minimum relay feerate (sompi/gram) — the node's mempool
 * standard check (RejectInsufficientComputeFee) prices exactly these masses.
 */
export function sweep_funded_mass(inputs_json: string): string;
/**
 * KOSGN recovery inscription bytes (hex). Mirrors lib.rs::encode_recovery:
 * "KOSGN" | ver=1 | threshold | ownerCount | lineage[32] | realOwner[32]*count.
 *
 * The 32-byte slot carries the treasury's covenant id. That makes the whole
 * record checkable: an auditor recomputes the id from the genesis transaction
 * itself (genesis_covenant_id) and compares, and the vault address follows from
 * it by derivation — so a forged inscription names a treasury that is not the one
 * whose address the money is going to.
 */
export function inscription(threshold: bigint, real_owners_json: string, lineage_hex: string): string;
/**
 * Resolve a recipient address → { spkHash (for the proposal commitment),
 * spkHex (the version-prefixed scriptPubKey, revealed at execute) }. Matches the
 * native tools' blake2b(spk_full).
 */
export function recipient_info(address: string): string;
/**
 * Non-contextual masses of ANY built tx (Borsh hex from a *_build export):
 * { computeMass, transientMass }. The UI prices covenant-flow fees as
 * max(compute, ceil(transient/2)) × the min relay feerate. Build the probe
 * with a dummy zero signature first — a fee change only moves fixed-width
 * output values, never the serialized size, so the measured mass stays exact
 * for the final fee.
 */
export function borsh_masses(borsh_hex: string): string;
/**
 * Phase A: sighashes the sweeper must sign — one per funding input. JSON array.
 */
export function sweep_funded_sighashes(inputs_json: string): string;
/**
 * Phase A: one sighash per funding input (JSON array of hex), + the treasuryId.
 */
export function genesis_sighashes(inputs_json: string): string;
/**
 * Phase A: the sighashes the closer must sign — one per fee-funding wallet
 * input (the proposal input itself is permissionless and unsigned). JSON array.
 */
export function close_expired_sighashes(inputs_json: string): string;
/**
 * Phase A: proposer's sighash for create_proposal. `inputs_json` carries the
 * KoRoot script+UTXO, proposal template prefix/suffix, root state start, and
 * the proposal params (operation/recipientSpkHash/amount/maxFee/expiresAt/
 * executionDelay/proposerIndex).
 */
export function create_proposal_sighash(inputs_json: string): string;
/**
 * Extract the x-only pubkey (hex) from a P2PK Kaspa address — used to turn
 * owner addresses into the pubkeys a CONFIG change commits.
 */
export function address_pubkey(address: string): string;
/**
 * The covenant id a genesis WILL mint, computed from its inputs alone —
 * `{ fundingUtxos[0], rootRedeem, rootValue }` — with no transaction built and
 * nothing broadcast.
 *
 * The id is a hash of the authorizing input's outpoint plus the value and
 * scriptPubKey of every output in its group, and the group is the root alone.
 * None of that depends on the payload, the change, or the fee, so this is the
 * same value gen_build reports after the fact and the same one the node will
 * derive. The browser needs it BEFORE it signs: the vault address is derived
 * from it, and the inscription carries it.
 */
export function genesis_covenant_id(inputs_json: string): string;
export function approve_build(inputs_json: string, sig_hex: string): string;
/**
 * CONFIG proposal commitment: blake2b(newThreshold8 ‖ newOwnerCount8 ‖ owner0..4),
 * counts as 8-byte LE, owners as raw 32 bytes. `owners5_json` = 5 hex pubkeys.
 */
export function config_commit(new_threshold: bigint, new_owner_count: bigint, owners5_json: string): string;
/**
 * Build a sweep tx and return its TXID (hex). `utxos_json` =
 * [{"txid","index","amount","covenant"}]. Verifiable against the native tool.
 */
export function build_sweep_txid(vault_redeem_hex: string, treasury_id_hex: string, utxos_json: string, fee: bigint): string;
/**
 * P2SH address (bech32) for a redeem script — lets the browser derive the
 * vault/root/proposal covenant addresses from reconstructed scripts (node-direct
 * recovery), so it can query their UTXOs with no backend. prefix: "testnet"|"mainnet".
 */
export function p2sh_address(redeem_hex: string, prefix: string): string;
/**
 * Phase A (owner-funded): [ownerSighash (proposal input 1), fundingSighash…].
 */
export function execute_sighashes(inputs_json: string): string;
/**
 * The vault redeem script + P2SH scriptPubKey a lineage derives, with no
 * transaction involved — so a caller can show (and verify) the deposit address
 * the bootstrap will create.
 */
export function vault_for_lineage(vault_prefix_hex: string, lineage_hex: string, vault_suffix_hex: string): string;
export function reject_build(inputs_json: string, sig_hex: string): string;
export function reject_sighash(inputs_json: string): string;
/**
 * Phase A (owner-funded): every sighash the proposer must sign — the KoRoot
 * covenant input (0, = proposerSig) plus each wallet funding input. JSON array.
 */
export function create_proposal_sighashes(inputs_json: string): string;
/**
 * Phase B: inject the funding sigs (JSON array of 64-byte hex). Returns the
 * signed tx Borsh + treasuryId.
 */
export function genesis_build(inputs_json: string, sigs_json: string): string;
/**
 * Owner address (bech32 P2PK) for an x-only public key — lets the browser show
 * owner addresses (kaspatest:q…) with no backend, e.g. for a chain-recovered treasury
 * whose inscription stores only pubkeys. prefix: "testnet"|"mainnet".
 */
export function pubkey_address(xonly_hex: string, prefix: string): string;
export function execute_config_sighash(inputs_json: string): string;
/**
 * Convert a Borsh-serialized consensus Transaction (our *_build output) into the
 * RpcTransaction JSON the node's JSON wRPC `submitTransaction` expects — so the
 * browser can submit DIRECTLY to a node (no backend). RpcTransaction carries the
 * covenant binding + compute_budget + payload, all camelCase.
 */
export function borsh_to_rpc_json(borsh_hex: string): string;
/**
 * r" Deferred promise - an object that has `resolve()` and `reject()`
 * r" functions that can be called outside of the promise body.
 * r" WARNING: This function uses `eval` and can not be used in environments
 * r" where dynamically-created code can not be executed such as web browser
 * r" extensions.
 * r" @category General
 */
export function defer(): Promise<any>;
/**
 * Initialize Rust panic handler in console mode.
 *
 * This will output additional debug information during a panic to the console.
 * This function should be called right after loading WASM libraries.
 * @category General
 */
export function initConsolePanicHook(): void;
/**
 * Initialize Rust panic handler in browser mode.
 *
 * This will output additional debug information during a panic in the browser
 * by creating a full-screen `DIV`. This is useful on mobile devices or where
 * the user otherwise has no access to console/developer tools. Use
 * {@link presentPanicHookLogs} to activate the panic logs in the
 * browser environment.
 * @see {@link presentPanicHookLogs}
 * @category General
 */
export function initBrowserPanicHook(): void;
/**
 * Present panic logs to the user in the browser.
 *
 * This function should be called after a panic has occurred and the
 * browser-based panic hook has been activated. It will present the
 * collected panic logs in a full-screen `DIV` in the browser.
 * @see {@link initBrowserPanicHook}
 * @category General
 */
export function presentPanicHookLogs(): void;
/**
 * Configuration for the WASM32 bindings runtime interface.
 * @see {@link IWASM32BindingsConfig}
 * @category General
 */
export function initWASM32Bindings(config: IWASM32BindingsConfig): void;
/**
 * Set the logger log level using a string representation.
 * Available variants are: 'off', 'error', 'warn', 'info', 'debug', 'trace'
 * @category General
 */
export function setLogLevel(level: "off" | "error" | "warn" | "info" | "debug" | "trace"): void;
/**
 *
 *  Kaspa `Address` version (`PubKey`, `PubKey ECDSA`, `ScriptHash`)
 *
 * @category Address
 */
export enum AddressVersion {
  /**
   * PubKey addresses always have the version byte set to 0
   */
  PubKey = 0,
  /**
   * PubKey ECDSA addresses always have the version byte set to 1
   */
  PubKeyECDSA = 1,
  /**
   * ScriptHash addresses always have the version byte set to 8
   */
  ScriptHash = 8,
}
/**
 * @category Consensus
 */
export enum NetworkType {
  Mainnet = 0,
  Testnet = 1,
  Devnet = 2,
  Simnet = 3,
}
/**
 * Kaspa Transaction Script Opcodes
 * @see {@link ScriptBuilder}
 * @category Consensus
 */
export enum Opcodes {
  OpFalse = 0,
  OpData1 = 1,
  OpData2 = 2,
  OpData3 = 3,
  OpData4 = 4,
  OpData5 = 5,
  OpData6 = 6,
  OpData7 = 7,
  OpData8 = 8,
  OpData9 = 9,
  OpData10 = 10,
  OpData11 = 11,
  OpData12 = 12,
  OpData13 = 13,
  OpData14 = 14,
  OpData15 = 15,
  OpData16 = 16,
  OpData17 = 17,
  OpData18 = 18,
  OpData19 = 19,
  OpData20 = 20,
  OpData21 = 21,
  OpData22 = 22,
  OpData23 = 23,
  OpData24 = 24,
  OpData25 = 25,
  OpData26 = 26,
  OpData27 = 27,
  OpData28 = 28,
  OpData29 = 29,
  OpData30 = 30,
  OpData31 = 31,
  OpData32 = 32,
  OpData33 = 33,
  OpData34 = 34,
  OpData35 = 35,
  OpData36 = 36,
  OpData37 = 37,
  OpData38 = 38,
  OpData39 = 39,
  OpData40 = 40,
  OpData41 = 41,
  OpData42 = 42,
  OpData43 = 43,
  OpData44 = 44,
  OpData45 = 45,
  OpData46 = 46,
  OpData47 = 47,
  OpData48 = 48,
  OpData49 = 49,
  OpData50 = 50,
  OpData51 = 51,
  OpData52 = 52,
  OpData53 = 53,
  OpData54 = 54,
  OpData55 = 55,
  OpData56 = 56,
  OpData57 = 57,
  OpData58 = 58,
  OpData59 = 59,
  OpData60 = 60,
  OpData61 = 61,
  OpData62 = 62,
  OpData63 = 63,
  OpData64 = 64,
  OpData65 = 65,
  OpData66 = 66,
  OpData67 = 67,
  OpData68 = 68,
  OpData69 = 69,
  OpData70 = 70,
  OpData71 = 71,
  OpData72 = 72,
  OpData73 = 73,
  OpData74 = 74,
  OpData75 = 75,
  OpPushData1 = 76,
  OpPushData2 = 77,
  OpPushData4 = 78,
  Op1Negate = 79,
  OpReserved = 80,
  OpTrue = 81,
  Op2 = 82,
  Op3 = 83,
  Op4 = 84,
  Op5 = 85,
  Op6 = 86,
  Op7 = 87,
  Op8 = 88,
  Op9 = 89,
  Op10 = 90,
  Op11 = 91,
  Op12 = 92,
  Op13 = 93,
  Op14 = 94,
  Op15 = 95,
  Op16 = 96,
  OpNop = 97,
  OpVer = 98,
  OpIf = 99,
  OpNotIf = 100,
  OpVerIf = 101,
  OpVerNotIf = 102,
  OpElse = 103,
  OpEndIf = 104,
  OpVerify = 105,
  OpReturn = 106,
  OpToAltStack = 107,
  OpFromAltStack = 108,
  Op2Drop = 109,
  Op2Dup = 110,
  Op3Dup = 111,
  Op2Over = 112,
  Op2Rot = 113,
  Op2Swap = 114,
  OpIfDup = 115,
  OpDepth = 116,
  OpDrop = 117,
  OpDup = 118,
  OpNip = 119,
  OpOver = 120,
  OpPick = 121,
  OpRoll = 122,
  OpRot = 123,
  OpSwap = 124,
  OpTuck = 125,
  /**
   * Splice opcodes.
   */
  OpCat = 126,
  OpSubstr = 127,
  OpLeft = 128,
  OpRight = 129,
  OpSize = 130,
  /**
   * Bitwise logic opcodes.
   */
  OpInvert = 131,
  OpAnd = 132,
  OpOr = 133,
  OpXor = 134,
  OpEqual = 135,
  OpEqualVerify = 136,
  OpReserved1 = 137,
  OpReserved2 = 138,
  /**
   * Numeric related opcodes.
   */
  Op1Add = 139,
  Op1Sub = 140,
  Op2Mul = 141,
  Op2Div = 142,
  OpNegate = 143,
  OpAbs = 144,
  OpNot = 145,
  Op0NotEqual = 146,
  OpAdd = 147,
  OpSub = 148,
  OpMul = 149,
  OpDiv = 150,
  OpMod = 151,
  OpLShift = 152,
  OpRShift = 153,
  OpBoolAnd = 154,
  OpBoolOr = 155,
  OpNumEqual = 156,
  OpNumEqualVerify = 157,
  OpNumNotEqual = 158,
  OpLessThan = 159,
  OpGreaterThan = 160,
  OpLessThanOrEqual = 161,
  OpGreaterThanOrEqual = 162,
  OpMin = 163,
  OpMax = 164,
  OpWithin = 165,
  /**
   * Undefined opcodes.
   */
  OpZkPrecompile = 166,
  OpBlake2bWithKey = 167,
  /**
   * Crypto opcodes.
   */
  OpSHA256 = 168,
  OpCheckMultiSigECDSA = 169,
  OpBlake2b = 170,
  OpCheckSigECDSA = 171,
  OpCheckSig = 172,
  OpCheckSigVerify = 173,
  OpCheckMultiSig = 174,
  OpCheckMultiSigVerify = 175,
  OpCheckLockTimeVerify = 176,
  OpCheckSequenceVerify = 177,
  /**
   * Transaction introspection opcodes.
   */
  OpTxVersion = 178,
  OpTxInputCount = 179,
  OpTxOutputCount = 180,
  OpTxLockTime = 181,
  OpTxSubnetId = 182,
  OpTxGas = 183,
  OpTxPayloadSubstr = 184,
  OpTxInputIndex = 185,
  OpOutpointTxId = 186,
  OpOutpointIndex = 187,
  OpTxInputScriptSigSubstr = 188,
  OpTxInputSeq = 189,
  OpTxInputAmount = 190,
  OpTxInputSpk = 191,
  OpTxInputDaaScore = 192,
  OpTxInputIsCoinbase = 193,
  OpTxOutputAmount = 194,
  OpTxOutputSpk = 195,
  OpTxPayloadLen = 196,
  OpTxInputSpkLen = 197,
  OpTxInputSpkSubstr = 198,
  OpTxOutputSpkLen = 199,
  OpTxOutputSpkSubstr = 200,
  OpTxInputScriptSigLen = 201,
  OpUnknown202 = 202,
  OpAuthOutputCount = 203,
  OpAuthOutputIdx = 204,
  OpNum2Bin = 205,
  OpBin2Num = 206,
  OpInputCovenantId = 207,
  OpCovInputCount = 208,
  OpCovInputIdx = 209,
  OpCovOutputCount = 210,
  OpCovOutputIdx = 211,
  OpChainblockSeqCommit = 212,
  OpOutputCovenantId = 213,
  OpUnknown214 = 214,
  OpCheckSigFromStack = 215,
  OpCheckSigFromStackECDSA = 216,
  OpBlake3 = 217,
  OpBlake3WithKey = 218,
  OpUnknown219 = 219,
  OpUnknown220 = 220,
  OpUnknown221 = 221,
  OpUnknown222 = 222,
  OpUnknown223 = 223,
  OpUnknown224 = 224,
  OpUnknown225 = 225,
  OpUnknown226 = 226,
  OpUnknown227 = 227,
  OpUnknown228 = 228,
  OpUnknown229 = 229,
  OpUnknown230 = 230,
  OpUnknown231 = 231,
  OpUnknown232 = 232,
  OpUnknown233 = 233,
  OpUnknown234 = 234,
  OpUnknown235 = 235,
  OpUnknown236 = 236,
  OpUnknown237 = 237,
  OpUnknown238 = 238,
  OpUnknown239 = 239,
  OpUnknown240 = 240,
  OpUnknown241 = 241,
  OpUnknown242 = 242,
  OpUnknown243 = 243,
  OpUnknown244 = 244,
  OpUnknown245 = 245,
  OpUnknown246 = 246,
  OpUnknown247 = 247,
  OpUnknown248 = 248,
  OpUnknown249 = 249,
  OpSmallInteger = 250,
  OpPubKeys = 251,
  OpUnknown252 = 252,
  OpPubKeyHash = 253,
  OpPubKey = 254,
  OpInvalidOpCode = 255,
}
/**
 * Kaspa Sighash types allowed by consensus
 * @category Consensus
 */
export enum SighashType {
  All = 0,
  None = 1,
  Single = 2,
  AllAnyOneCanPay = 3,
  NoneAnyOneCanPay = 4,
  SingleAnyOneCanPay = 5,
}

/**
 * Interface defining the structure of a transaction.
 * 
 * @category Consensus
 */
export interface ITransaction {
    version: number;
    inputs: ITransactionInput[];
    outputs: ITransactionOutput[];
    lockTime: bigint;
    subnetworkId: HexString;
    gas: bigint;
    payload: HexString;
    /** The mass of the transaction (the mass is undefined or zero unless explicitly set or obtained from the node) */
    mass?: bigint;

    /** Optional verbose data provided by RPC */
    verboseData?: ITransactionVerboseData;
}

/**
 * Optional transaction verbose data.
 * 
 * @category Node RPC
 */
export interface ITransactionVerboseData {
    transactionId : HexString;
    hash : HexString;
    computeMass : bigint;
    blockHash : HexString;
    blockTime : bigint;
}




/**
 * Interface defines the structure of a serializable UTXO entry.
 * 
 * @see {@link ISerializableTransactionInput}, {@link ISerializableTransaction}
 * @category Wallet SDK
 */
export interface ISerializableUtxoEntry {
    address?: Address;
    amount: bigint;
    scriptPublicKey: ScriptPublicKey;
    blockDaaScore: bigint;
    isCoinbase: boolean;
}

/**
 * Interface defines the structure of a serializable transaction input.
 * 
 * @see {@link ISerializableTransaction}
 * @category Wallet SDK
 */
export interface ISerializableTransactionInput {
    transactionId : HexString;
    index: number;
    sequence: bigint;
    sigOpCount: number;
    signatureScript?: HexString;
    utxo: ISerializableUtxoEntry;
}

/**
 * Interface defines the structure of a serializable transaction output.
 * 
 * @see {@link ISerializableTransaction}
 * @category Wallet SDK
 */
export interface ISerializableTransactionOutput {
    value: bigint;
    scriptPublicKey: IScriptPublicKey;
}

/**
 * Interface defines the structure of a serializable transaction.
 * 
 * Serializable transactions can be produced using 
 * {@link Transaction.serializeToJSON},
 * {@link Transaction.serializeToSafeJSON} and 
 * {@link Transaction.serializeToObject} 
 * functions for processing (signing) in external systems.
 * 
 * Once the transaction is signed, it can be deserialized
 * into {@link Transaction} using {@link Transaction.deserializeFromJSON}
 * and {@link Transaction.deserializeFromSafeJSON} functions. 
 * 
 * @see {@link Transaction},
 * {@link ISerializableTransactionInput},
 * {@link ISerializableTransactionOutput},
 * {@link ISerializableUtxoEntry}
 * 
 * @category Wallet SDK
 */
export interface ISerializableTransaction {
    id? : HexString;
    version: number;
    inputs: ISerializableTransactionInput[];
    outputs: ISerializableTransactionOutput[];
    lockTime: bigint;
    subnetworkId: HexString;
    gas: bigint;
    payload: HexString;
}




/**
 * Interface defines the structure of a UTXO entry.
 * 
 * @category Consensus
 */
export interface IUtxoEntry {
    /** @readonly */
    address?: Address;
    /** @readonly */
    outpoint: ITransactionOutpoint;
    /** @readonly */
    amount : bigint;
    /** @readonly */
    scriptPublicKey : IScriptPublicKey;
    /** @readonly */
    blockDaaScore: bigint;
    /** @readonly */
    isCoinbase: boolean;
}




/**
 * Interface defines the structure of a transaction input.
 * 
 * @category Consensus
 */
export interface ITransactionInput {
    previousOutpoint: ITransactionOutpoint;
    signatureScript?: HexString;
    sequence: bigint;
    sigOpCount: number;
    computeBudget?: number;
    utxo?: UtxoEntryReference;

    /** Optional verbose data provided by RPC */
    verboseData?: ITransactionInputVerboseData;
}

/**
 * Option transaction input verbose data.
 * 
 * @category Node RPC
 */
export interface ITransactionInputVerboseData { }




/**
 * Interface defining the structure of a transaction output.
 * 
 * @category Consensus
 */
export interface ITransactionOutput {
    value: bigint;
    scriptPublicKey: IScriptPublicKey | HexString;

    /** Optional verbose data provided by RPC */
    verboseData?: ITransactionOutputVerboseData;
}

/**
 * TransactionOutput verbose data.
 * 
 * @category Node RPC
 */
export interface ITransactionOutputVerboseData {
    scriptPublicKeyType : string;
    scriptPublicKeyAddress : string;
}



/**
 * A genesis covenant group for bulk covenant binding population.
 *
 * @category Consensus
 */
export interface IGenesisCovenantGroup {
    authorizingInput: number;
    outputs: number[];
}



/**
 * A covenant binding binds a transaction output to the covenant and input authorizing its creation.
 *
 * @category Consensus
 */
export interface ICovenantBinding {
    authorizingInput: number;
    covenantId: HexString;
}



/**
 * Interface defines the structure of a transaction outpoint (used by transaction input).
 * 
 * @category Consensus
 */
export interface ITransactionOutpoint {
    transactionId: HexString;
    index: number;
}



/**
 * Color range configuration for Hex View.
 * 
 * @category General
 */ 
export interface IHexViewColor {
    start: number;
    end: number;
    color?: string;
    background?: string;
}

/**
 * Configuration interface for Hex View.
 * 
 * @category General
 */ 
export interface IHexViewConfig {
    offset? : number;
    replacementCharacter? : string;
    width? : number;
    colors? : IHexViewColor[];
}



/**
 * A string containing a hexadecimal representation of the data (typically representing for IDs or Hashes).
 * 
 * @category General
 */ 
export type HexString = string;



/**
 * Interface defines the structure of a Script Public Key.
 * 
 * @category Consensus
 */
export interface IScriptPublicKey {
    version : number;
    script: HexString;
}



/**
 * Interface for configuring workflow-rs WASM32 bindings.
 * 
 * @category General
 */
export interface IWASM32BindingsConfig {
    /**
     * This option can be used to disable the validation of class names
     * for instances of classes exported by Rust WASM32 when passing
     * these classes to WASM32 functions.
     * 
     * This can be useful to programmatically disable checks when using
     * a bundler that mangles class symbol names.
     */
    validateClassNames : boolean;
}



    /**
     * Generic network address representation.
     * 
     * @category General
     */
    export interface INetworkAddress {
        /**
         * IPv4 or IPv6 address.
         */
        ip: string;
        /**
         * Optional port number.
         */
        port?: number;
    }


/**
 *
 * Abortable trigger wraps an `Arc<AtomicBool>`, which can be cloned
 * to signal task terminating using an atomic bool.
 *
 * ```text
 * let abortable = Abortable::default();
 * let result = my_task(abortable).await?;
 * // ... elsewhere
 * abortable.abort();
 * ```
 *
 * @category General
 */
export class Abortable {
  free(): void;
  isAborted(): boolean;
  constructor();
  abort(): void;
  check(): void;
  reset(): void;
}
/**
 * Error emitted by [`Abortable`].
 * @category General
 */
export class Aborted {
  private constructor();
  free(): void;
}
/**
 * Kaspa [`Address`] struct that serializes to and from an address format string: `kaspa:qz0s...t8cv`.
 *
 * @category Address
 */
export class Address {
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  constructor(address: string);
  /**
   * Convert an address to a string.
   */
  toString(): string;
  static validate(address: string): boolean;
  readonly prefix: string;
  readonly payload: string;
  readonly version: string;
  set setPrefix(value: string);
}
export class CovenantBinding {
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  toJSON(): object;
  constructor(authorizing_input: number, covenant_id: Hash);
  covenantId: Hash;
  authorizingInput: number;
}
/**
 * A genesis covenant group for bulk covenant binding population.
 *
 * All listed outputs are bound to the same covenant id, derived from the
 * authorizing input outpoint and this exact ordered output list.
 * @category Consensus
 */
export class GenesisCovenantGroup {
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  toString(): string;
  toJSON(): object;
  constructor(authorizing_input: number, outputs: Array<number>);
  outputs: Array<number>;
  authorizingInput: number;
}
/**
 * @category General
 */
export class Hash {
  free(): void;
  constructor(hex_str: string);
  toString(): string;
}
/**
 *
 * NetworkId is a unique identifier for a kaspa network instance.
 * It is composed of a network type and an optional suffix.
 *
 * @category Consensus
 */
export class NetworkId {
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  toString(): string;
  addressPrefix(): string;
  constructor(value: any);
  type: NetworkType;
  get suffix(): number | undefined;
  set suffix(value: number | null | undefined);
  readonly id: string;
}
/**
 * ScriptBuilder provides a facility for building custom scripts. It allows
 * you to push opcodes, ints, and data while respecting canonical encoding. In
 * general it does not ensure the script will execute correctly, however any
 * data pushes which would exceed the maximum allowed script engine limits and
 * are therefore guaranteed not to execute will not be pushed and will result in
 * the Script function returning an error.
 * @category Consensus
 */
export class ScriptBuilder {
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  /**
   * Creates a new ScriptBuilder over an existing script.
   * Supplied script can be represented as an `Uint8Array` or a `HexString`.
   */
  static fromScript(script: HexString | Uint8Array): ScriptBuilder;
  addSequence(sequence: bigint): ScriptBuilder;
  /**
   * Get script bytes represented by a hex string.
   */
  toString(): HexString;
  addLockTime(lock_time: bigint): ScriptBuilder;
  static canonicalDataSize(data: HexString | Uint8Array): number;
  /**
   * Creates an equivalent pay-to-script-hash script.
   * Can be used to create an P2SH address.
   * @see {@link addressFromScriptPublicKey}
   */
  createPayToScriptHashScript(): ScriptPublicKey;
  /**
   * Generates a signature script that fits a pay-to-script-hash script.
   */
  encodePayToScriptHashSignatureScript(signature: HexString | Uint8Array): HexString;
  constructor();
  /**
   * Drains (empties) the script builder, returning the
   * script bytes represented by a hex string.
   */
  drain(): HexString;
  /**
   * Pushes the passed opcode to the end of the script. The script will not
   * be modified if pushing the opcode would cause the script to exceed the
   * maximum allowed script engine size.
   */
  addOp(op: number): ScriptBuilder;
  addI64(value: bigint): ScriptBuilder;
  /**
   * Adds the passed opcodes to the end of the script.
   * Supplied opcodes can be represented as an `Uint8Array` or a `HexString`.
   */
  addOps(opcodes: HexString | Uint8Array): ScriptBuilder;
  /**
   * AddData pushes the passed data to the end of the script. It automatically
   * chooses canonical opcodes depending on the length of the data.
   *
   * A zero length buffer will lead to a push of empty data onto the stack (Op0 = OpFalse)
   * and any push of data greater than [`MAX_SCRIPT_ELEMENT_SIZE`](kaspa_txscript::MAX_SCRIPT_ELEMENT_SIZE) will not modify
   * the script since that is not allowed by the script engine.
   *
   * Also, the script will not be modified if pushing the data would cause the script to
   * exceed the maximum allowed script engine size [`MAX_SCRIPTS_SIZE`](kaspa_txscript::MAX_SCRIPTS_SIZE).
   */
  addData(data: HexString | Uint8Array): ScriptBuilder;
  hexView(args?: IHexViewConfig | null): string;
}
/**
 * Represents a Kaspad ScriptPublicKey
 * @category Consensus
 */
export class ScriptPublicKey {
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  constructor(version: number, script: any);
  readonly script: string;
  version: number;
}
export class SigHashType {
  private constructor();
  free(): void;
}
/**
 * Represents a Kaspa transaction.
 * This is an artificial construct that includes additional
 * transaction-related data such as additional data from UTXOs
 * used by transaction inputs.
 * @category Consensus
 */
export class Transaction {
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  constructor(js_value: ITransaction | Transaction);
  /**
   * Determines whether or not a transaction is a coinbase transaction. A coinbase
   * transaction is a special transaction created by miners that distributes fees and block subsidy
   * to the previous blocks' miners, and specifies the script_pub_key that will be used to pay the current
   * miner in future blocks.
   */
  is_coinbase(): boolean;
  /**
   * Serializes the transaction to a JSON string.
   * The schema of the JSON is defined by {@link ISerializableTransaction}.
   */
  serializeToJSON(): string;
  /**
   * Serializes the transaction to a pure JavaScript Object.
   * The schema of the JavaScript object is defined by {@link ISerializableTransaction}.
   * @see {@link ISerializableTransaction}
   */
  serializeToObject(): ISerializableTransaction;
  /**
   * Deserialize the {@link Transaction} Object from a JSON string.
   */
  static deserializeFromJSON(json: string): Transaction;
  /**
   * Serializes the transaction to a "Safe" JSON schema where it converts all `bigint` values to `string` to avoid potential client-side precision loss.
   */
  serializeToSafeJSON(): string;
  /**
   * Deserialize the {@link Transaction} Object from a pure JavaScript Object.
   */
  static deserializeFromObject(js_value: any): Transaction;
  /**
   * Deserialize the {@link Transaction} Object from a "Safe" JSON schema where all `bigint` values are represented as `string`.
   */
  static deserializeFromSafeJSON(json: string): Transaction;
  populateGenesisCovenants(groups: (IGenesisCovenantGroup | GenesisCovenantGroup)[]): void;
  /**
   * Recompute and finalize the tx id based on updated tx fields
   */
  finalize(): Hash;
  /**
   * Returns a list of unique addresses used by transaction inputs.
   * This method can be used to determine addresses used by transaction inputs
   * in order to select private keys needed for transaction signing.
   */
  addresses(network_type: NetworkType | NetworkId | string): Address[];
  version: number;
  lockTime: bigint;
  get inputs(): TransactionInput[];
  set inputs(value: (ITransactionInput | TransactionInput)[]);
  get outputs(): TransactionOutput[];
  set outputs(value: (ITransactionOutput | TransactionOutput)[]);
  get subnetworkId(): string;
  set subnetworkId(value: any);
  get payload(): string;
  set payload(value: any);
  gas: bigint;
  mass: bigint;
  /**
   * Returns the transaction ID
   */
  readonly id: string;
}
/**
 * Represents a Kaspa transaction input
 * @category Consensus
 */
export class TransactionInput {
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  constructor(value: ITransactionInput | TransactionInput);
  sequence: bigint;
  sigOpCount: number;
  computeBudget: number;
  get previousOutpoint(): TransactionOutpoint;
  set previousOutpoint(value: any);
  get signatureScript(): string | undefined;
  set signatureScript(value: any);
  readonly utxo: UtxoEntryReference | undefined;
}
/**
 * Represents a Kaspa transaction outpoint.
 * NOTE: This struct is immutable - to create a custom outpoint
 * use the `TransactionOutpoint::new` constructor. (in JavaScript
 * use `new TransactionOutpoint(transactionId, index)`).
 * @category Consensus
 */
export class TransactionOutpoint {
  private constructor();
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
}
/**
 * Represents a Kaspad transaction output
 * @category Consensus
 */
export class TransactionOutput {
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  /**
   * TransactionOutput constructor
   */
  constructor(value: bigint, script_public_key: ScriptPublicKey, covenant?: CovenantBinding | null);
  get covenant(): CovenantBinding | undefined;
  set covenant(value: CovenantBinding);
  scriptPublicKey: ScriptPublicKey;
  value: bigint;
}
/**
 * Holds details about an individual transaction output in a utxo
 * set such as whether or not it was contained in a coinbase tx, the daa
 * score of the block that accepts the tx, its public key script, and how
 * much it pays.
 * @category Consensus
 */
export class TransactionUtxoEntry {
  private constructor();
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  amount: bigint;
  scriptPublicKey: ScriptPublicKey;
  blockDaaScore: bigint;
  isCoinbase: boolean;
  get covenantId(): Hash | undefined;
  set covenantId(value: Hash | null | undefined);
}
/**
 * A simple collection of UTXO entries. This struct is used to
 * retain a set of UTXO entries in the WASM memory for faster
 * processing. This struct keeps a list of entries represented
 * by `UtxoEntryReference` struct. This data structure is used
 * internally by the framework, but is exposed for convenience.
 * Please consider using `UtxoContext` instead.
 * @category Wallet SDK
 */
export class UtxoEntries {
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  /**
   * Sort the contained entries by amount. Please note that
   * this function is not intended for use with large UTXO sets
   * as it duplicates the whole contained UTXO set while sorting.
   */
  sort(): void;
  amount(): bigint;
  /**
   * Create a new `UtxoEntries` struct with a set of entries.
   */
  constructor(js_value: any);
  items: any;
}
/**
 * [`UtxoEntry`] struct represents a client-side UTXO entry.
 *
 * @category Wallet SDK
 */
export class UtxoEntry {
  private constructor();
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  toString(): string;
  get address(): Address | undefined;
  set address(value: Address | null | undefined);
  outpoint: TransactionOutpoint;
  amount: bigint;
  scriptPublicKey: ScriptPublicKey;
  blockDaaScore: bigint;
  isCoinbase: boolean;
  get covenantId(): Hash | undefined;
  set covenantId(value: Hash | null | undefined);
}
/**
 * [`Arc`] reference to a [`UtxoEntry`] used by the wallet subsystems.
 *
 * @category Wallet SDK
 */
export class UtxoEntryReference {
  private constructor();
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  toString(): string;
  readonly isCoinbase: boolean;
  readonly blockDaaScore: bigint;
  readonly scriptPublicKey: ScriptPublicKey;
  readonly entry: UtxoEntry;
  readonly amount: bigint;
  readonly address: Address | undefined;
  readonly outpoint: TransactionOutpoint;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly address_pubkey: (a: number, b: number, c: number) => void;
  readonly approve_build: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly approve_sighash: (a: number, b: number, c: number) => void;
  readonly approve_sighashes: (a: number, b: number, c: number) => void;
  readonly bootstrap_build: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly bootstrap_sighashes: (a: number, b: number, c: number) => void;
  readonly borsh_masses: (a: number, b: number, c: number) => void;
  readonly borsh_to_rpc_json: (a: number, b: number, c: number) => void;
  readonly build_sweep_txid: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint) => void;
  readonly close_expired_build: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly close_expired_sighashes: (a: number, b: number, c: number) => void;
  readonly config_commit: (a: number, b: bigint, c: bigint, d: number, e: number) => void;
  readonly create_proposal_build: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly create_proposal_sighash: (a: number, b: number, c: number) => void;
  readonly create_proposal_sighashes: (a: number, b: number, c: number) => void;
  readonly execute_build: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly execute_config_build: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly execute_config_sighash: (a: number, b: number, c: number) => void;
  readonly execute_config_sighashes: (a: number, b: number, c: number) => void;
  readonly execute_sighash: (a: number, b: number, c: number) => void;
  readonly execute_sighashes: (a: number, b: number, c: number) => void;
  readonly genesis_build: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly genesis_covenant_id: (a: number, b: number, c: number) => void;
  readonly genesis_sighashes: (a: number, b: number, c: number) => void;
  readonly inscription: (a: number, b: bigint, c: number, d: number, e: number, f: number) => void;
  readonly p2sh_address: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly probe_sighash: (a: number, b: number, c: number, d: number, e: number, f: bigint, g: number, h: number) => void;
  readonly pubkey_address: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly recipient_info: (a: number, b: number, c: number) => void;
  readonly reject_build: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly reject_sighash: (a: number, b: number, c: number) => void;
  readonly reject_sighashes: (a: number, b: number, c: number) => void;
  readonly sweep_funded_mass: (a: number, b: number, c: number) => void;
  readonly sweep_funded_sighashes: (a: number, b: number, c: number) => void;
  readonly sweep_funded_tx: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly vault_for_lineage: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly __wbg_covenantbinding_free: (a: number, b: number) => void;
  readonly __wbg_genesiscovenantgroup_free: (a: number, b: number) => void;
  readonly __wbg_get_utxoentry_address: (a: number) => number;
  readonly __wbg_get_utxoentry_amount: (a: number) => bigint;
  readonly __wbg_get_utxoentry_blockDaaScore: (a: number) => bigint;
  readonly __wbg_get_utxoentry_covenantId: (a: number) => number;
  readonly __wbg_get_utxoentry_isCoinbase: (a: number) => number;
  readonly __wbg_get_utxoentry_outpoint: (a: number) => number;
  readonly __wbg_get_utxoentry_scriptPublicKey: (a: number) => number;
  readonly __wbg_set_utxoentry_address: (a: number, b: number) => void;
  readonly __wbg_set_utxoentry_amount: (a: number, b: bigint) => void;
  readonly __wbg_set_utxoentry_blockDaaScore: (a: number, b: bigint) => void;
  readonly __wbg_set_utxoentry_covenantId: (a: number, b: number) => void;
  readonly __wbg_set_utxoentry_isCoinbase: (a: number, b: number) => void;
  readonly __wbg_set_utxoentry_outpoint: (a: number, b: number) => void;
  readonly __wbg_set_utxoentry_scriptPublicKey: (a: number, b: number) => void;
  readonly __wbg_transaction_free: (a: number, b: number) => void;
  readonly __wbg_transactioninput_free: (a: number, b: number) => void;
  readonly __wbg_transactionoutpoint_free: (a: number, b: number) => void;
  readonly __wbg_transactionoutput_free: (a: number, b: number) => void;
  readonly __wbg_utxoentries_free: (a: number, b: number) => void;
  readonly __wbg_utxoentry_free: (a: number, b: number) => void;
  readonly __wbg_utxoentryreference_free: (a: number, b: number) => void;
  readonly covenantbinding_authorizingInput: (a: number) => number;
  readonly covenantbinding_covenantId: (a: number) => number;
  readonly covenantbinding_new: (a: number, b: number) => number;
  readonly covenantbinding_set_authorizingInput: (a: number, b: number) => void;
  readonly covenantbinding_set_covenantId: (a: number, b: number) => void;
  readonly covenantbinding_toJSON: (a: number, b: number) => void;
  readonly genesiscovenantgroup_authorizingInput: (a: number) => number;
  readonly genesiscovenantgroup_ctor: (a: number, b: number, c: number) => void;
  readonly genesiscovenantgroup_outputs: (a: number) => number;
  readonly genesiscovenantgroup_set_authorizingInput: (a: number, b: number) => void;
  readonly genesiscovenantgroup_set_outputs: (a: number, b: number, c: number) => void;
  readonly genesiscovenantgroup_toJSON: (a: number, b: number) => void;
  readonly genesiscovenantgroup_toString: (a: number, b: number) => void;
  readonly transaction_addresses: (a: number, b: number, c: number) => void;
  readonly transaction_constructor: (a: number, b: number) => void;
  readonly transaction_deserializeFromJSON: (a: number, b: number, c: number) => void;
  readonly transaction_deserializeFromObject: (a: number, b: number) => void;
  readonly transaction_deserializeFromSafeJSON: (a: number, b: number, c: number) => void;
  readonly transaction_finalize: (a: number, b: number) => void;
  readonly transaction_gas: (a: number) => bigint;
  readonly transaction_get_inputs_as_js_array: (a: number) => number;
  readonly transaction_get_mass: (a: number) => bigint;
  readonly transaction_get_outputs_as_js_array: (a: number) => number;
  readonly transaction_get_payload_as_hex_string: (a: number, b: number) => void;
  readonly transaction_get_subnetwork_id_as_hex: (a: number, b: number) => void;
  readonly transaction_id: (a: number, b: number) => void;
  readonly transaction_is_coinbase: (a: number) => number;
  readonly transaction_lockTime: (a: number) => bigint;
  readonly transaction_populateGenesisCovenants: (a: number, b: number, c: number) => void;
  readonly transaction_serializeToJSON: (a: number, b: number) => void;
  readonly transaction_serializeToObject: (a: number, b: number) => void;
  readonly transaction_serializeToSafeJSON: (a: number, b: number) => void;
  readonly transaction_set_gas: (a: number, b: bigint) => void;
  readonly transaction_set_inputs_from_js_array: (a: number, b: number) => void;
  readonly transaction_set_lockTime: (a: number, b: bigint) => void;
  readonly transaction_set_mass: (a: number, b: bigint) => void;
  readonly transaction_set_outputs_from_js_array: (a: number, b: number) => void;
  readonly transaction_set_payload_from_js_value: (a: number, b: number) => void;
  readonly transaction_set_subnetwork_id_from_js_value: (a: number, b: number) => void;
  readonly transaction_set_version: (a: number, b: number) => void;
  readonly transaction_version: (a: number) => number;
  readonly transactioninput_constructor: (a: number, b: number) => void;
  readonly transactioninput_get_compute_budget: (a: number) => number;
  readonly transactioninput_get_previous_outpoint: (a: number) => number;
  readonly transactioninput_get_sequence: (a: number) => bigint;
  readonly transactioninput_get_sig_op_count: (a: number) => number;
  readonly transactioninput_get_signature_script_as_hex: (a: number, b: number) => void;
  readonly transactioninput_get_utxo: (a: number) => number;
  readonly transactioninput_set_compute_budget: (a: number, b: number) => void;
  readonly transactioninput_set_previous_outpoint: (a: number, b: number, c: number) => void;
  readonly transactioninput_set_sequence: (a: number, b: bigint) => void;
  readonly transactioninput_set_sig_op_count: (a: number, b: number) => void;
  readonly transactioninput_set_signature_script_from_js_value: (a: number, b: number, c: number) => void;
  readonly transactionoutput_covenant: (a: number) => number;
  readonly transactionoutput_ctor: (a: bigint, b: number, c: number) => number;
  readonly transactionoutput_scriptPublicKey: (a: number) => number;
  readonly transactionoutput_set_covenant: (a: number, b: number) => void;
  readonly transactionoutput_set_scriptPublicKey: (a: number, b: number) => void;
  readonly transactionoutput_set_value: (a: number, b: bigint) => void;
  readonly transactionoutput_value: (a: number) => bigint;
  readonly utxoentries_amount: (a: number) => bigint;
  readonly utxoentries_get_items_as_js_array: (a: number) => number;
  readonly utxoentries_js_ctor: (a: number, b: number) => void;
  readonly utxoentries_set_items_from_js_array: (a: number, b: number) => void;
  readonly utxoentries_sort: (a: number) => void;
  readonly utxoentry_toString: (a: number, b: number) => void;
  readonly utxoentryreference_address: (a: number) => number;
  readonly utxoentryreference_amount: (a: number) => bigint;
  readonly utxoentryreference_blockDaaScore: (a: number) => bigint;
  readonly utxoentryreference_entry: (a: number) => number;
  readonly utxoentryreference_isCoinbase: (a: number) => number;
  readonly utxoentryreference_outpoint: (a: number) => number;
  readonly utxoentryreference_scriptPublicKey: (a: number) => number;
  readonly utxoentryreference_toString: (a: number, b: number) => void;
  readonly __wbg_scriptbuilder_free: (a: number, b: number) => void;
  readonly scriptbuilder_addData: (a: number, b: number, c: number) => void;
  readonly scriptbuilder_addI64: (a: number, b: number, c: bigint) => void;
  readonly scriptbuilder_addLockTime: (a: number, b: number, c: bigint) => void;
  readonly scriptbuilder_addOp: (a: number, b: number, c: number) => void;
  readonly scriptbuilder_addOps: (a: number, b: number, c: number) => void;
  readonly scriptbuilder_canonicalDataSize: (a: number, b: number) => void;
  readonly scriptbuilder_createPayToScriptHashScript: (a: number) => number;
  readonly scriptbuilder_drain: (a: number) => number;
  readonly scriptbuilder_encodePayToScriptHashSignatureScript: (a: number, b: number, c: number) => void;
  readonly scriptbuilder_fromScript: (a: number, b: number) => void;
  readonly scriptbuilder_hexView: (a: number, b: number, c: number) => void;
  readonly scriptbuilder_new: () => number;
  readonly scriptbuilder_toString: (a: number) => number;
  readonly scriptbuilder_addSequence: (a: number, b: number, c: bigint) => void;
  readonly __wbg_get_networkid_suffix: (a: number) => number;
  readonly __wbg_get_networkid_type: (a: number) => number;
  readonly __wbg_get_scriptpublickey_version: (a: number) => number;
  readonly __wbg_get_transactionutxoentry_amount: (a: number) => bigint;
  readonly __wbg_get_transactionutxoentry_blockDaaScore: (a: number) => bigint;
  readonly __wbg_get_transactionutxoentry_covenantId: (a: number) => number;
  readonly __wbg_get_transactionutxoentry_isCoinbase: (a: number) => number;
  readonly __wbg_get_transactionutxoentry_scriptPublicKey: (a: number) => number;
  readonly __wbg_networkid_free: (a: number, b: number) => void;
  readonly __wbg_scriptpublickey_free: (a: number, b: number) => void;
  readonly __wbg_set_networkid_suffix: (a: number, b: number) => void;
  readonly __wbg_set_networkid_type: (a: number, b: number) => void;
  readonly __wbg_set_scriptpublickey_version: (a: number, b: number) => void;
  readonly __wbg_set_transactionutxoentry_amount: (a: number, b: bigint) => void;
  readonly __wbg_set_transactionutxoentry_blockDaaScore: (a: number, b: bigint) => void;
  readonly __wbg_set_transactionutxoentry_covenantId: (a: number, b: number) => void;
  readonly __wbg_set_transactionutxoentry_isCoinbase: (a: number, b: number) => void;
  readonly __wbg_set_transactionutxoentry_scriptPublicKey: (a: number, b: number) => void;
  readonly __wbg_sighashtype_free: (a: number, b: number) => void;
  readonly __wbg_transactionutxoentry_free: (a: number, b: number) => void;
  readonly networkid_addressPrefix: (a: number, b: number) => void;
  readonly networkid_ctor: (a: number, b: number) => void;
  readonly networkid_id: (a: number, b: number) => void;
  readonly scriptpublickey_constructor: (a: number, b: number, c: number) => void;
  readonly scriptpublickey_script_as_hex: (a: number, b: number) => void;
  readonly networkid_toString: (a: number, b: number) => void;
  readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
  readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
  readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
  readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
  readonly __wbg_address_free: (a: number, b: number) => void;
  readonly address_constructor: (a: number, b: number) => number;
  readonly address_payload: (a: number, b: number) => void;
  readonly address_prefix: (a: number, b: number) => void;
  readonly address_set_setPrefix: (a: number, b: number, c: number) => void;
  readonly address_toString: (a: number, b: number) => void;
  readonly address_validate: (a: number, b: number) => number;
  readonly address_version: (a: number, b: number) => void;
  readonly __wbg_hash_free: (a: number, b: number) => void;
  readonly hash_constructor: (a: number, b: number) => number;
  readonly hash_toString: (a: number, b: number) => void;
  readonly defer: () => number;
  readonly initBrowserPanicHook: () => void;
  readonly initConsolePanicHook: () => void;
  readonly initWASM32Bindings: (a: number, b: number) => void;
  readonly presentPanicHookLogs: () => void;
  readonly __wbg_abortable_free: (a: number, b: number) => void;
  readonly __wbg_aborted_free: (a: number, b: number) => void;
  readonly abortable_abort: (a: number) => void;
  readonly abortable_check: (a: number, b: number) => void;
  readonly abortable_isAborted: (a: number) => number;
  readonly abortable_new: () => number;
  readonly abortable_reset: (a: number) => void;
  readonly setLogLevel: (a: number) => void;
  readonly __wbindgen_export_0: (a: number) => void;
  readonly __wbindgen_export_1: (a: number, b: number, c: number) => void;
  readonly __wbindgen_export_2: (a: number, b: number) => number;
  readonly __wbindgen_export_3: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
