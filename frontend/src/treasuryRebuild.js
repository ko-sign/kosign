// Rebuild a treasury's covenant redeem scripts from chain-recovered data, with NO
// backend and NO silc. The contracts' script LOGIC is owner/threshold/lineage-agnostic
// (owners, threshold and the proposal nonce live in KoRoot's UTXO STATE; the treasury's
// covenant lineage lives in KoVault's), so every treasury shares the fixed prefix/
// suffix in treasuryTemplates.js. We splice the recovered STATE back in to get the exact
// redeem scripts byte-for-byte. Verified rebuilt == manifest for all three scripts.
import { TEMPLATES } from "./treasuryTemplates.js";

/** @param {string} h */
const PAD = (h) => h.padStart(2, "0");
// state encoders mirror Silverscript: int = OP_PUSHBYTES_8(0x08) + 8 LE bytes;
// bytes32 = OP_PUSHBYTES_32(0x20) + 32 bytes.
/** @param {number|bigint} v */
const encInt = (v) => {
  let n = BigInt(v), h = "08";
  for (let i = 0; i < 8; i++) { h += PAD((Number(n & 0xffn)).toString(16)); n >>= 8n; }
  return h;
};
/** @param {string} hex */
const encB32 = (hex) => {
  if (hex.length !== 64) throw new Error(`bytes32 must be 32 bytes, got ${hex.length / 2}`);
  return "20" + hex;
};

// ROOT state = proposalNonce, threshold, ownerCount, owner0..4 (5 slots, padded).
/**
 * @param {number} nonce @param {number} threshold @param {number} ownerCount
 * @param {string[]} owners5
 */
export function encodeRootState(nonce, threshold, ownerCount, owners5) {
  if (owners5.length !== 5) throw new Error("rootState needs 5 owner slots");
  return encInt(nonce) + encInt(threshold) + encInt(ownerCount) + owners5.map(encB32).join("");
}

/**
 * @param {number} nonce @param {number} threshold @param {number} ownerCount
 * @param {string[]} owners5
 */
export function rebuildRoot(nonce, threshold, ownerCount, owners5) {
  return TEMPLATES.root.prefix + encodeRootState(nonce, threshold, ownerCount, owners5) + TEMPLATES.root.suffix;
}

// Vault redeem = prefix ‖ OP_PUSHBYTES_32 ‖ lineage ‖ suffix. The lineage is the
// treasury's covenant id and it is the vault's STATE, not decoration: the vault
// releases and absorbs funds under that id and no other. That is also what makes
// this address unique per treasury — two treasuries with identical owners are born
// from different funding outpoints, so their ids, and therefore their vault
// addresses, differ. Uniqueness alone would not be worth having here: an address
// that committed to nothing but itself could be claimed by a stranger's covenant,
// which would then capture the payments arriving there unbound.
/** @param {string} lineageHex — the treasury's 32-byte covenant id, hex */
export function rebuildVault(lineageHex) {
  return TEMPLATES.vault.prefix + encB32(lineageHex) + TEMPLATES.vault.suffix;
}

// A proposal-template redeem script: the state region is irrelevant here (callers
// only slice out prefix/suffix via the state layout to build/track proposals).
export function proposalTemplateScript() {
  return TEMPLATES.proposal.prefix + "00".repeat(TEMPLATES.proposal.stateLen) + TEMPLATES.proposal.suffix;
}

export const ROOT_STATE_LAYOUT = { start: TEMPLATES.root.stateStart, len: TEMPLATES.root.stateLen };
export const PROPOSAL_STATE_LAYOUT = { start: TEMPLATES.proposal.stateStart, len: TEMPLATES.proposal.stateLen };
export const VAULT_STATE_LAYOUT = { start: TEMPLATES.vault.stateStart, len: TEMPLATES.vault.stateLen };
