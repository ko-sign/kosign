// What the UI may let a user ASK for, and what it may TELL them happened — the
// two decisions that need the covenant's own arithmetic but none of its
// machinery. Pure: no wasm, no network, no React, so `node --test` pins it.
//
// The numbers below mirror tools/wasm-tx/src/lib.rs, which is where they are
// actually enforced. A copy that drifted from it would either refuse a transfer
// the builder would happily make or wave one through that it refuses at execute
// time — and by then the proposer has already paid the bond.

// The proposal UTXO a createProposal mints (lib.rs ROOT_PROPOSAL_VAL). It is a
// BOND, not a fee: an execute spends it alongside the vault and a retirement
// hands it back, so it is money that comes home either way.
export const PROPOSAL_BOND = 50_000_000; // 0.5 KAS

// The most any covenant spend may pay in network fees — the maxFee every
// deployed template bakes in, and the ceiling KoVault's `>= in - amount - maxFee`
// rule enforces on an execute.
export const MAX_COVENANT_FEE = 10_000_000; // 0.1 KAS

const kas = (sompi) => (Number(sompi) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 });

// The largest transfer an execute can actually pay out.
//
// ex_build (lib.rs) spends the vault UTXO *and* the proposal's bond and requires
// `vault + bond >= amount + fee`, so the ceiling sits ABOVE the vault balance,
// not at it — refusing at the balance would block a perfectly executable transfer
// of everything the vault holds. What comes off the top is the fee, and the fee
// is priced from the finished transaction's mass, which nobody knows while the
// proposal is still being typed. So reserve the covenant's own cap on it: whatever
// the mass prices out at, an execute may never spend more than maxFee, so an
// amount at or under this ceiling is one the builder can always fund.
export const maxTransferSompi = (vaultBalanceSompi) => {
  const bal = Number(vaultBalanceSompi);
  if (vaultBalanceSompi == null || !Number.isFinite(bal)) return null; // no balance in hand — nothing to judge against
  return Math.max(0, bal + PROPOSAL_BOND - MAX_COVENANT_FEE);
};

/**
 * Read a typed KAS amount against the vault. Returns { sompi, ok, error }:
 * `ok` gates the submit, `error` is non-null only when there is something to SAY —
 * an empty or half-typed field is not-ok but silent, because a user mid-keystroke
 * has not made a mistake yet.
 */
export function checkTransfer(amountText, vaultBalanceSompi) {
  const amount = Number.parseFloat(amountText);
  if (!Number.isFinite(amount) || amount <= 0) return { sompi: null, ok: false, error: null };
  const sompi = Math.round(amount * 1e8);
  if (!Number.isSafeInteger(sompi)) return { sompi: null, ok: false, error: "That amount is too large to express in sompi." };
  const max = maxTransferSompi(vaultBalanceSompi);
  if (max === null) return { sompi, ok: true, error: null }; // balance unknown (backend down) — don't invent a limit
  if (sompi > max) {
    return {
      sompi, ok: false,
      error: `More than the vault holds. This vault holds ${kas(vaultBalanceSompi)} KAS, and an execute can pay out at most `
        + `${kas(max)} KAS — it spends the vault together with this proposal's ${kas(PROPOSAL_BOND)} KAS bond, less the network fee. `
        + `Deposit first, or lower the amount.`,
    };
  }
  return { sompi, ok: true, error: null };
}

// ── What a proposal's ending was ────────────────────────────────────────────────
// A LIVE proposal's own state field only ever holds 0/1/2: execute writes no
// continuation, so no entrypoint ever stamps 3 into one. 3 is what a client writes
// once it sees the proposal SPENT by an execute — the only spend that pays anyone.
// Everything else that ends a proposal — closeExpired, or a witness we cannot read
// — closes it without moving a sompi, and must never be reported as a payout.
export const PAID_OUT = 3;

export function statusLabel(item) {
  const st = Number(item?.status ?? 0);
  if (st === PAID_OUT) return "Executed";
  if (st === 2) {
    if (item?.closedReason === "expired") return "Retired";
    if (item?.closedReason) return "Closed";
    return "Rejected";
  }
  if (st === 1) return "Approved";
  if (st === 0) return "Pending";
  return String(item?.status ?? "—");
}

// One line of plain English for a proposal that is over, or null while it is live.
export function outcomeNote(item) {
  const st = Number(item?.status ?? 0);
  if (st === PAID_OUT) return "Executed on-chain — the recipient was paid.";
  if (st !== 2) return null;
  if (item?.closedReason === "expired") return "Expired and retired — nothing was paid out, and the bond returned to the vault.";
  if (item?.closedReason) return "Closed on-chain by a transaction this scan could not read. It was not an execute, so nothing was paid out.";
  if (item?.executedTxid) return "Closed on-chain without paying out.";
  return "Rejected by enough signers that it can no longer reach threshold. It pays nobody; its bond returns to the vault when someone retires it after expiry.";
}

// ── Retiring an expired proposal ────────────────────────────────────────────────
// KoProposal.closeExpired takes no owner index and checks no signature, so ANYONE
// may call it — but only on a proposal that (a) still has a UTXO to spend, (b) was
// never executed, and (c) has an expiry the chain's DAA score has already passed.
// The score is the clock the contract compares against, so without a node to read
// it we cannot say the action would succeed, and an action that cannot be shown to
// succeed is not offered.
export function retireState(item, daaScore) {
  if (!item || Number(item.status) === PAID_OUT || item.executedTxid) return { state: "closed" };
  if (!item.proposalOutpoint?.txid) return { state: "no-utxo" };
  const expiresAt = Number(item.expiresAtDaa ?? 0);
  if (!(expiresAt > 0)) return { state: "no-expiry" };
  if (daaScore == null) return { state: "no-clock", expiresAt };
  // closeExpiredClientSide refuses at daa <= expiresAt: the node only relays a
  // transaction whose lock time the virtual DAA score has already passed.
  if (Number(daaScore) > expiresAt) return { state: "retirable", expiresAt, daaScore: Number(daaScore) };
  return { state: "waiting", expiresAt, daaScore: Number(daaScore), blocks: expiresAt - Number(daaScore) };
}

export const canRetire = (item, daaScore) => retireState(item, daaScore).state === "retirable";

// ── How long a proposal may live ────────────────────────────────────────────────
// expiresAt used to be hard-coded to DAA 4,000,000,000 — eleven years out. That
// default quietly made every Approved proposal a decade-lived standing
// authorization (rotation does not revoke it: approve/execute check the
// proposal's SNAPSHOT owner set), and stranded every Rejected proposal's 0.5 KAS
// bond for as long (closeExpired is the only path that frees it, and it requires
// expiry). A proposal now commits to a real, bounded lifetime chosen at creation.
//
// The bounds are policy, not covenant: KoRoot.createProposal accepts any expiry
// (the proposer is owner-signed, so on-chain bounds would only defend against an
// owner's own client). The floor keeps a proposal alive long enough for
// co-signers in other time zones to see it; the ceiling keeps "I forgot about
// it" from meaning "it can still fire in 2035".
export const DAA_PER_SECOND = 10; // the network targets 10 blocks a second
export const MIN_EXPIRY_SECS = 3600; // 1 hour
export const MAX_EXPIRY_SECS = 365 * 86400; // 1 year
export const DEFAULT_EXPIRY_SECS = 30 * 86400; // 30 days

/** The DAA score a proposal created now should commit to expire at. */
export function expiryDaa(daaScore, seconds = DEFAULT_EXPIRY_SECS) {
  const daa = Number(daaScore), secs = Number(seconds);
  if (!Number.isFinite(daa) || daa <= 0) throw new Error("no DAA score to anchor the expiry to — a proposal needs the chain's clock to commit to a lifetime");
  if (!Number.isFinite(secs) || secs < MIN_EXPIRY_SECS || secs > MAX_EXPIRY_SECS) {
    throw new Error(`a proposal must live between ${MIN_EXPIRY_SECS / 3600} hour(s) and ${MAX_EXPIRY_SECS / 86400} days — ${secs} seconds is outside that`);
  }
  return Math.round(daa + secs * DAA_PER_SECOND);
}

// ── Executing near or past the expiry ───────────────────────────────────────────
// The contract cannot forbid a post-expiry execute (tx.time is a LOWER bound, so
// "now < expiresAt" is unprovable on-chain — RISKS #3), which leaves an expired
// Approved proposal in a race: closeExpired is PERMISSIONLESS and pays the bond
// to whoever runs it, so a stranger sniping the close profits from destroying
// the transfer. The client refuses to enter that race: an expired proposal is
// for retiring (or re-proposing), not executing, and one inside the final hour
// gets a warning instead of a surprise.
export function executeWindow(expiresAt, daaScore) {
  const exp = Number(expiresAt), daa = Number(daaScore);
  if (!(exp > 0) || !Number.isFinite(daa) || daa <= 0) return { state: "no-clock" };
  if (daa >= exp) return { state: "expired", expiresAt: exp, daaScore: daa };
  const blocks = exp - daa;
  if (blocks <= 3600 * DAA_PER_SECOND) return { state: "closing", blocks, eta: daaEta(blocks) };
  return { state: "open", blocks };
}

// Kaspa targets 10 blocks a second, so a gap in DAA score is a gap in wall time.
export function daaEta(blocks) {
  const secs = Math.max(0, Number(blocks)) / 10;
  if (secs < 90) return `~${Math.ceil(secs)}s`;
  if (secs < 5400) return `~${Math.ceil(secs / 60)} min`;
  if (secs < 172800) return `~${Math.round(secs / 3600)} h`;
  const days = secs / 86400;
  if (days < 730) return `~${Math.round(days)} days`;
  return `~${(days / 365).toFixed(1)} years`;
}
