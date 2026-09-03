// Route B: build covenant transactions in the BROWSER via the wasm tx-builder,
// then submit through the stateless relay. The backend only provides public data
// (compiled scripts + live UTXOs) and relays the finished tx — it never builds or
// signs. Proven end-to-end on TN10 (all flows). See tools/wasm-tx + docs/ROUTE-B.md.
import init, * as W from "./wasm/kosign_wasm_tx.js";
import wasmUrl from "./wasm/kosign_wasm_tx_bg.wasm?url";
import { sign, pubkey as signerPubkey } from "./signer.js";
import { connectWrpc } from "./wrpc.js";
import { getRpcUrl } from "./kaspaLive.js";
import { getNetwork, getNetworkId, ensureRpcUrl } from "./network.js";
import { loadState, saveState, seedFromCtx, applyUpdate, statusFromState } from "./treasuryState.js";
import { rebuildRoot, rebuildVault, proposalTemplateScript, ROOT_STATE_LAYOUT, PROPOSAL_STATE_LAYOUT } from "./treasuryRebuild.js";
import { TEMPLATES } from "./treasuryTemplates.js";
import { scanOpenProposals, walkRoot, proposalPayload } from "./proposalScan.js";
import { recoverTreasuryFromChain } from "./kaspaRest.js";
import { MIN_RELAY_FEE_RATE, DUST_FLOOR, MAX_TX_INPUTS, CHANGE_FLOOR, sizeFee, sizeOpFee, fold, perBatchCap, partitionDust, quotePlan, feeMassOf, pickFrom, fundingSlots, safeSompi, saneFeeDemand } from "./sweepPlan.js";
import { PROPOSAL_BOND, MAX_COVENANT_FEE, expiryDaa, executeWindow, DEFAULT_EXPIRY_SECS } from "./proposalPolicy.js";
import { assertSpend } from "./txGuard.js";
import { blake2b256 } from "../../packages/descriptor/src/genesis.js";

let _ready;
export function loadWasm() {
  if (!_ready) _ready = init(wasmUrl);
  return _ready;
}
export { W };

// Derive an owner's bech32 address (kaspa:/kaspatest:) from its x-only pubkey,
// client-side via wasm — no backend. Requires loadWasm() to have run.
export function pubkeyAddress(xonlyHex, network = getNetwork().wasm) {
  try { return W.pubkey_address(xonlyHex, network); } catch { return null; }
}
const p2sh = (redeemHex) => W.p2sh_address(redeemHex, getNetwork().wasm);
// Same, but safe to call before loadWasm() resolves (returns null) — used by the
// UI to compute the live-subscription watch set from redeem scripts.
export const p2shAddressSafe = (redeemHex) => { try { return redeemHex ? W.p2sh_address(redeemHex, getNetwork().wasm) : null; } catch { return null; } };

const getJson = async (url, body) => {
  const r = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const t = await r.text();
  const j = t ? JSON.parse(t) : { ok: false, stderr: `HTTP ${r.status}` };
  if (!j.ok) throw new Error(j.error || j.stderr || `HTTP ${r.status}`);
  return j;
};

// Sweep the vault entirely client-side: fetch the build context (vault redeem +
// covenant UTXO), build the sweep tx in wasm, submit node-direct. The vault
// covenant requires the consolidated output to keep EVERY sompi of the vault
// inputs, so the network fee is funded from the SWEEPER's own wallet (the
// imported key signs those fee inputs) — the vault never pays for sweeps.
// `log` is an optional (text, kind) line emitter for the terminal.
// The node's mempool rejects any tx paying under max(computeMass, transientMass)
// × the minimum relay feerate — raised network-wide to 100 sompi/gram in node
// v1.2.1-toc.3 (rusty-kaspa ab4c51a). Sweep mass GROWS with each swept deposit
// (every vault input reveals the redeem script and carries a per-input compute
// budget), and the standard cap is 500k grams per tx — so the fee is sized from
// the wasm-computed mass and large deposit sets are split into CHAINED batches
// (each spends the previous batch's covenant output straight from the mempool).
// Planning/sizing logic lives in sweepPlan.js (pure, shared with Node tests).

// Mass (grams) the node prices for one funded-sweep shape, straight from the
// wasm builder (see sweepPlan.feeMassOf for the compute/transient pricing).
// Mass depends only on the input/output SHAPE — txids and amounts don't change it.
const feeMass = (vaultRedeem, sid, vaultUtxos, ownerAddress, fundingUtxos) =>
  feeMassOf(JSON.parse(W.sweep_funded_mass(JSON.stringify({ vaultRedeem, treasuryId: sid, vaultUtxos, ownerAddress, fundingUtxos, fee: 0 }))));

// Build + sign + submit ONE sweep batch. Two safety nets: a node running a
// higher min relay feerate reports the exact fee it wants ("required amount of
// N") — re-size at its rate, re-sign, resubmit; and a chained batch can race
// its parent into the mempool — wait out orphan/missing-outpoint errors briefly.
async function submitSweepBatch(c, shape, vaultUtxos, fents, rate0, log, verbose, preSized) {
  const { vaultRedeem, sid, ownerAddress } = shape;
  const massOf = (picked) => feeMass(vaultRedeem, sid, vaultUtxos, ownerAddress, picked);
  let rate = rate0;
  let { fee, picked, sum, mass } = preSized || fold(sizeFee(massOf, fents, rate));
  const fee0 = fee; // the honest mass-priced anchor the fee-demand ceiling holds retries to
  const short = () => new Error(`your wallet ${ownerAddress.slice(0, 18)}… needs ≥ ${(fee / 1e8).toFixed(4)} KAS free to pay the sweep fee (the vault itself never pays)`);
  if (sum < fee) throw short();
  if (verbose) log(`fee ${(fee / 1e8).toFixed(4)} KAS (${mass} grams × ${rate} sompi/gram${fee > mass * rate ? ", small change folded in" : ""}) funded from your wallet — the vault keeps every sompi`);
  const base = { vaultRedeem, treasuryId: sid, vaultUtxos, ownerAddress };
  for (let feeRetries = 0, orphanWaits = 0; ; ) {
    const inputs = JSON.stringify({ ...base, fundingUtxos: picked, fee });
    const shs = JSON.parse(W.sweep_funded_sighashes(inputs));
    if (verbose && !feeRetries && !orphanWaits) log("signing the fee input locally (BIP340 Schnorr)…");
    const out = JSON.parse(W.sweep_funded_tx(inputs, JSON.stringify(shs.map((sh) => sign(sh)))));
    // Re-read the bytes before broadcasting, exactly as submitAndTrack does for
    // every covenant op — the sweep signs the operator's own wallet fee inputs with
    // SIGHASH_ALL, so a wrong or hostile builder that keeps output 0 a valid vault
    // continuation (which the covenant floor enforces) is still free to route the
    // wallet CHANGE anywhere. The covenant protects the treasury; nothing but this
    // protects the sweeper's wallet. kind:"sweep" is neither MAY_PAY_OUT nor
    // MUST_NOT_TOUCH_VAULT, so the destination rule demands every non-covenant
    // output be change home to the sweeper and every covenant output continue this
    // lineage — a diverted change is refused instead of signed-and-sent.
    assertSpend(out.borshHex, {
      kind: "sweep", lineage: sid, prefix: getNetwork().prefix, walletAddress: ownerAddress,
      vaultSpk: p2shSpkOf(vaultRedeem),
      treasuryIn: safeSompi(vaultUtxos.reduce((a, u) => a + u.amount, 0), "the swept vault total"), treasuryFee: 0,
    });
    const rpcTx = JSON.parse(W.borsh_to_rpc_json(out.borshHex));
    if (verbose) log(feeRetries || orphanWaits ? "resubmitting…" : "submitting straight to your node (no relay)…");
    try {
      const r = await c.submit(rpcTx);
      // record the wallet fee inputs as spent this session, so a follow-up op (or
      // the next chained batch) does not re-pick them before the node's utxoindex
      // catches up — the same reason every other wallet-funded submit does this.
      markSpentOutpoints(rpcTx);
      return { txid: r.transactionId, fee, picked, change: sum - fee, mass, rate };
    } catch (e) {
      const msg = String(e?.message || e);
      const want = /required amount of (\d+)/.exec(msg);
      if (want && feeRetries < 2) {
        feeRetries++;
        // fee0, not the current fee: after one retry the "honest" anchor would
        // already be the node's own number, and a two-step lie would walk past it
        const asked = saneFeeDemand(Number(want[1]), fee0);
        rate = Math.max(rate, Math.ceil(asked / mass));
        ({ fee, picked, sum, mass } = fold(sizeFee(massOf, fents, rate, asked)));
        if (sum < fee) throw short();
        // the higher fee may have pulled in extra wallet inputs — a tx past the
        // covenant's input cap would bounce with an unparseable script error
        if (vaultUtxos.length + picked.length > MAX_TX_INPUTS) {
          throw new Error(`the node's fee floor needs more fee inputs than fit the covenant's ${MAX_TX_INPUTS}-input cap — consolidate your wallet and retry`);
        }
        log(`node asks ≥ ${(fee / 1e8).toFixed(4)} KAS — rebuilding with the higher fee…`);
        continue;
      }
      if (/orphan|missing|not found|outpoint/i.test(msg) && orphanWaits < 5) {
        orphanWaits++;
        log(`parent batch still propagating — retrying (${orphanWaits}/5)…`);
        await new Promise((res) => setTimeout(res, 400));
        continue;
      }
      throw e;
    }
  }
}

// opts: { includeDust, dustFloor, onProgress({batch,batches,swept,total,txid,feeTotal}),
//         shouldCancel() } — all optional; single-batch sweeps behave as before.
export async function sweepClientSide(base, treasuryId, log = () => {}, opts = {}) {
  const { includeDust = false, dustFloor = DUST_FLOOR, onProgress = () => {}, shouldCancel = () => false } = opts;
  await loadWasm();
  log("loading build context (scripts + vault UTXO)…");
  const ctx = await getCtx(base, treasuryId); // localStorage when node-direct, else backend
  if (!ctx.vault) throw new Error("no covenant vault UTXO to sweep");
  const url = getRpcUrl();
  if (!url || !ctx.vault.address) throw new Error("sweep needs a node endpoint — set one in ⚙");
  const myPk = signerPubkey();
  if (!myPk) throw new Error("connect a wallet (Manual key) first — the sweeper pays the sweep fee, so it needs your signature");
  const sweeperAddress = pubkeyAddress(myPk);
  const c = connectWrpc(url);
  await c.ready;
  try {
    log("fetching vault UTXOs straight from your node (JSON wRPC, no backend)…");
    const { entries } = await c.getUtxos([ctx.vault.address]);
    // sweep = the covenant UTXO(s) + strays (direct deposits) at the vault
    // address, consolidated into one covenant output — batched and chained when
    // they don't fit one tx's standard mass cap
    const mine = (entries || []).filter((e) => !e.utxoEntry.covenantId || e.utxoEntry.covenantId === ctx.treasuryId);
    const covEnt = mine.find((e) => e.utxoEntry.covenantId);
    if (!covEnt) throw new Error(`no covenant vault UTXO at ${ctx.vault.address}`);
    const sid = covEnt.utxoEntry.covenantId;
    const toU = (e) => ({ txid: e.outpoint.transactionId, index: e.outpoint.index, amount: safeSompi(e.utxoEntry.amount, "a deposit amount") });
    // rare: extra covenant UTXOs merge in with batch 1
    const covExtra = mine.filter((e) => e.utxoEntry.covenantId && e !== covEnt).map(toU);
    const allStrays = mine.filter((e) => !e.utxoEntry.covenantId).map(toU).sort((a, b) => b.amount - a.amount);
    const { keep, dust, dustSompi } = partitionDust(allStrays, includeDust ? 0 : dustFloor);
    if (dust.length) log(`skipping ${dust.length} dust deposit(s) totaling ${(dustSompi / 1e8).toFixed(4)} KAS — each under ${(dustFloor / 1e8).toFixed(2)} KAS costs more to sweep than most are worth (enable "include dust" to sweep them too)`);
    // Nothing sweep-worthy AND only one vault UTXO: there is nothing to consolidate,
    // so building a transaction would spend a wallet fee to re-mint the vault to
    // itself — a charge for no effect. Compaction is real only when covExtra holds a
    // second vault UTXO to merge; strays are real only when keep is non-empty. Return
    // before touching the wallet. (A sweep with only dust skipped lands here too, so
    // the button that read "Sweep 0 KAS" now does nothing instead of costing a fee.)
    if (!keep.length && !covExtra.length) {
      log(dust.length
        ? `nothing to sweep — ${dust.length} dust deposit(s) skipped and the vault is already a single UTXO (enable "include dust" to sweep them)`
        : "nothing to sweep — the vault is already a single UTXO", "ok");
      return { ok: true, noop: true, txid: null, txids: [], direct: true, feeTotal: 0, swept: 0, total: keep.length, dustSkipped: dust.length };
    }
    log(keep.length ? `sweeping ${keep.length} direct deposit(s) into the covenant…` : "no strays — compacting the covenant UTXO…");

    // the sweeper funds the fee from their own wallet (vault keeps every sompi).
    // freshUtxos, not a raw filter: the same mempool-spend bookkeeping every other
    // wallet-funded flow uses. Without it a sweep run right after a proposal/approve
    // re-picks the wallet UTXO that op just spent — the node still lists it until
    // the op confirms — and the node rejects the sweep as a double-spend.
    let fents = freshUtxos((await c.getUtxos([sweeperAddress])).entries);
    if (!fents.length) throw new Error(`your wallet ${sweeperAddress.slice(0, 18)}… has no funds to pay the sweep fee (the vault itself never pays)`);

    // batch cap from measured marginals (two probe calls) — the covenant's
    // 16-input script cap usually binds, mass only for pathological shapes
    let cov = { ...toU(covEnt), covenant: true };
    const shape = { vaultRedeem: ctx.vaultRedeem, sid, ownerAddress: sweeperAddress };
    const probeF = [fents[0]];
    const baseMass = feeMass(ctx.vaultRedeem, sid, [cov], sweeperAddress, probeF);
    const perStray = keep.length ? feeMass(ctx.vaultRedeem, sid, [cov, { ...keep[0], covenant: false }], sweeperAddress, probeF) - baseMass : 0;
    const cap = keep.length ? perBatchCap(baseMass, perStray) : 0;
    const estBatches = keep.length ? Math.ceil(keep.length / cap) : 1;
    if (estBatches > 1) log(`${keep.length} deposits exceed one tx (the covenant caps a sweep at ${MAX_TX_INPUTS} inputs) — sweeping in ~${estBatches} chained txs (≤${cap} deposits each)`);

    const queue = [...keep];
    const txids = []; let feeTotal = 0; let swept = 0; let rate = MIN_RELAY_FEE_RATE; let bi = 0;
    let extras = covExtra.map((x) => ({ ...x, covenant: true }));
    do {
      const totalEst = bi + Math.max(1, cap ? Math.ceil(queue.length / cap) : 1);
      if (shouldCancel()) {
        log(`cancelled after ${bi}/${totalEst} batches — swept deposits are final on-chain, the rest stay pending`, "err");
        return { ok: bi > 0, cancelled: true, txid: txids[txids.length - 1], txids, feeTotal, swept, total: keep.length, direct: true };
      }
      // room for deposits this round: covenant input(s) + deposits + ≥1 fee input
      const batch = queue.splice(0, Math.max(0, Math.min(cap, MAX_TX_INPUTS - 1 - extras.length - 1)));
      // size the fee, shrinking the batch when the fee needs several wallet
      // UTXOs and the total would blow the covenant's input cap
      if (!fents.length) throw new Error(`your wallet ${sweeperAddress.slice(0, 18)}… ran out of funds for the sweep fee${bi ? ` (${swept}/${keep.length} deposits already swept & final)` : ""} — the vault itself never pays`);
      let vaultUtxos, sized;
      for (;;) {
        vaultUtxos = [cov, ...extras, ...batch.map((x) => ({ ...x, covenant: false }))];
        const massOf = (picked) => feeMass(ctx.vaultRedeem, sid, vaultUtxos, sweeperAddress, picked);
        sized = fold(sizeFee(massOf, fents, rate));
        if (sized.sum < sized.fee) throw new Error(`your wallet ${sweeperAddress.slice(0, 18)}… needs ≥ ${(sized.fee / 1e8).toFixed(4)} KAS free to pay the sweep fee${bi ? ` (${swept}/${keep.length} deposits already swept & final)` : ""} — the vault itself never pays`);
        if (vaultUtxos.length + sized.picked.length <= MAX_TX_INPUTS) break;
        if (!batch.length) throw new Error(`your wallet's fee UTXOs are too fragmented to fit the covenant's ${MAX_TX_INPUTS}-input cap — consolidate your wallet and retry`);
        queue.unshift(batch.pop());
      }
      if (estBatches > 1 || bi > 0) log(`batch ${bi + 1}/${totalEst}: ${batch.length} deposit(s)…`);
      const r = await submitSweepBatch(c, shape, vaultUtxos, fents, rate, log, estBatches === 1, sized);
      rate = r.rate;
      // bookkeeping for the next chained batch: consume the picked fee UTXOs,
      // gain the change (spendable straight from the mempool), advance the
      // covenant outpoint to this batch's output 0
      const spent = new Set(r.picked.map((x) => `${x.txid}:${x.index}`));
      fents = fents.filter((x) => !spent.has(`${x.txid}:${x.index}`));
      if (r.change > 0) { fents.push({ txid: r.txid, index: 1, amount: r.change }); fents.sort((a, b) => b.amount - a.amount); }
      // Number is exact for sompi sums below 2^53 (~90M KAS) — same bound the
      // rest of the app already assumes; the sum must match lib.rs's u64
      // vault_sum exactly or the next batch's sighash won't verify
      cov = { txid: r.txid, index: 0, amount: safeSompi(vaultUtxos.reduce((a, x) => a + x.amount, 0), "the consolidated vault total"), covenant: true };
      txids.push(r.txid); feeTotal += r.fee; swept += batch.length; bi++; extras = [];
      if (estBatches > 1 || totalEst > 1) log(`batch ${bi}/${totalEst} accepted — ${r.txid.slice(0, 12)}… fee ${(r.fee / 1e8).toFixed(4)} KAS`);
      onProgress({ batch: bi, batches: totalEst, swept, total: keep.length, txid: r.txid, feeTotal });
    } while (queue.length);
    if (bi > 1) log(`all ${bi} batches accepted — ${swept} deposit(s) consolidated, total fees ${(feeTotal / 1e8).toFixed(4)} KAS`);
    return { ok: true, txid: txids[txids.length - 1], txids, direct: true, feeTotal, swept, total: keep.length, dustSkipped: dust.length };
  } finally { c.close(); }
}

// Pre-sweep quote for the Assets page: batch count + estimated total fee from
// the exact wasm mass model (two probe calls — mass depends only on tx shape).
// Node-direct only (needs the locally tracked vault redeem); returns null when
// a quote isn't possible (backend mode, wasm not ready, no usable address).
export async function quoteSweep(treasuryId, strays, { includeDust = false, dustFloor = DUST_FLOOR } = {}) {
  try {
    if (!getRpcUrl() || !treasuryId || !strays?.length) return null;
    const st = loadState(treasuryId);
    if (!st?.vaultRedeem || !st.treasuryId) return null;
    await loadWasm();
    const myPk = signerPubkey();
    const owner = (myPk && pubkeyAddress(myPk)) || st.owners?.find((o) => o.address)?.address;
    if (!owner) return null;
    const synth = (i, covenant) => ({ txid: "00".repeat(32), index: i, amount: 100_000_000, covenant });
    const probeF = [{ txid: "11".repeat(32), index: 0, amount: 500_000_000 }];
    const baseMass = feeMass(st.vaultRedeem, st.treasuryId, [synth(0, true)], owner, probeF);
    const perStray = feeMass(st.vaultRedeem, st.treasuryId, [synth(0, true), synth(1, false)], owner, probeF) - baseMass;
    const { keep, dust, dustSompi } = partitionDust(strays, includeDust ? 0 : dustFloor, (x) => x.amountSompi);
    return { ...quotePlan(keep.length, baseMass, perStray), keep: keep.length, dust: dust.length, dustSompi, rate: MIN_RELAY_FEE_RATE };
  } catch { return null; }
}

// Build context: node-direct mode (⚙ JSON wRPC set) uses the locally-tracked state
// (seeded once from the backend wasmctx); else always the backend.
async function getCtx(base, treasuryId) {
  if (getRpcUrl() && treasuryId) {
    const s = loadState(treasuryId);
    if (s && s.root?.outpoint) return await enrichVaultUtxo(s);
  }
  const ctx = await getJson(`${base}/wasmctx`);
  if (getRpcUrl() && treasuryId) saveState(treasuryId, seedFromCtx(ctx));
  return ctx;
}

// Node-direct: the localStorage state tracks the root + proposals but not the live
// vault UTXO (it moves via deposits/sweeps independently), so fetch it from the node
// now — execute(transfer) needs ctx.vault.outpoint.
async function enrichVaultUtxo(s) {
  if (!s.vaultAddress) return s;
  const c = connectWrpc(getRpcUrl());
  try {
    await c.ready;
    const ents = (await c.getUtxos([s.vaultAddress])).entries || [];
    // this lineage's bound UTXOs ONLY — an alien-lineage UTXO at the same address
    // (attacker-planted; KoVault makes it permanently unspendable) must not be
    // picked as "the vault" during node lag, or execute fails with an opaque
    // script error instead of "vault UTXO not visible yet"
    const mine = ents.filter((e) => e.utxoEntry.covenantId === s.treasuryId);
    const pick = mine.sort((a, b) => Number(b.utxoEntry.amount) - Number(a.utxoEntry.amount))[0];
    if (pick) return { ...s, vault: { address: s.vaultAddress, outpoint: { txid: pick.outpoint.transactionId, index: pick.outpoint.index }, value: safeSompi(pick.utxoEntry.amount, "the vault balance") } };
  } catch { /* leave vault unset; execute will surface a clear error */ }
  finally { c.close(); }
  return s;
}

// Split the vault address' UTXO set: the covenant-BOUND balance vs direct sends
// ("strays"), which arrive unbound (covenant id ZERO) and stay that way until a
// sweep consolidates them. Unbound is not unprotected: a stray sits at the vault's
// P2SH address, so spending it runs KoVault, and the only entrypoint a ZERO-id
// input can satisfy is `deposit` — which forces output 0 back to this same vault
// address for >= the sum of every vault-address input. Kept per-UTXO so the
// Assets page can list exactly what "Sweep any strays" will consolidate.
// getUtxosByAddresses builds a fresh HashMap per request, so its entry order is
// arbitrary AND differs between calls — sort newest-first by blockDaaScore (the
// DAA score of the block that accepted the UTXO = confirmation order), with
// outpoint as the tiebreaker for deposits that landed at the same score. Purely
// cosmetic: quoteSweep only counts, and sweepVault re-sorts by amount itself.
const vaultSplit = (entries, lineage) => {
  const strays = (entries || []).filter((e) => !e.utxoEntry.covenantId)
    .map((e) => ({ txid: e.outpoint.transactionId, index: e.outpoint.index, amountSompi: Number(e.utxoEntry.amount), daa: Number(e.utxoEntry.blockDaaScore || 0) }))
    .sort((a, b) => b.daa - a.daa || a.txid.localeCompare(b.txid) || a.index - b.index);
  return {
    // Only THIS treasury's lineage counts as balance. Consensus lets anyone bind a
    // genesis output to any scriptPubKey, so a stranger can park a covenant of his
    // own at this address; the vault script running there is ours and demands its
    // own lineage, so his UTXO is money nobody at this address can spend — showing
    // it as treasury balance would be a lie, and feeding it to a sweep would make
    // the sweep unverifiable.
    bal: (entries || []).filter((e) => e.utxoEntry.covenantId === lineage).reduce((a, e) => a + Number(e.utxoEntry.amount), 0),
    unswept: strays.reduce((a, s) => a + s.amountSompi, 0),
    strays,
  };
};

// Submit + track state: node-direct (JSON wRPC submit + localStorage state) when a
// node endpoint is set in ⚙, else via the backend relay. Returns { ok, txid, status? }.
// `rebuild(requiredFee)` (optional) re-signs the tx at the fee a stricter node
// demands ("required amount of N" — the shape is fixed, so N is exact) and
// returns { borshHex, meta }; without it a fee rejection surfaces as an error.
// `guard` describes what the caller says this transaction does. It is checked
// against a second, independent reading of the bytes (frontend/src/txGuard.js)
// immediately before each submit — INSIDE the retry loop, not once at the top,
// because a node that asks for a higher fee sends us back through rebuild(),
// which re-signs different bytes. A guard that only inspected the first attempt
// would wave through everything that followed it.
async function submitAndTrack(base, treasuryId, borshHex, kind, meta, log = () => {}, rebuild = null, fallback = null, guard = null) {
  const url = getRpcUrl();
  if (url && treasuryId) {
    log("submitting straight to your node (JSON wRPC, no backend)…");
    const c = connectWrpc(url);
    await c.ready;
    let txid, vaultBal = null, unswept = 0, strays = [];
    const fee0 = meta?.fee || 0; // honest pre-retry anchor for the fee-demand ceiling
    try {
      for (let attempt = 0, usedFallback = false; ; attempt++) {
        if (guard) assertSpend(borshHex, { ...guard, kind });
        const rpcTx = JSON.parse(W.borsh_to_rpc_json(borshHex));
        try {
          txid = (await c.submit(rpcTx)).transactionId;
          markSpentOutpoints(rpcTx); // its wallet inputs are gone until it confirms
          break;
        } catch (e) {
          const want = /required amount of (\d+)/.exec(String(e?.message || e));
          if (want && rebuild && attempt < 2) {
            // anchored to the fee THIS client priced before any retry (fee0), not to
            // the demand itself — the owner-funded rebuild has no covenant cap and
            // the guard never sees wallet inputs, so this ceiling is all that stands
            // between a lying node and the wallet balance re-signed away as fee
            const asked = saneFeeDemand(Number(want[1]), fee0);
            log(`node asks ≥ ${(asked / 1e8).toFixed(4)} KAS fee — re-signing with the higher fee…`);
            // a re-signed transaction carries a different fee, so the conservation
            // rule has to be re-stated with it or the next pass refuses honest work
            const rb = rebuild(asked);
            borshHex = rb.borshHex; meta = rb.meta; if (rb.guard) guard = rb.guard;
            continue;
          }
          // the wallet-funded SHAPE itself was refused (storage mass, a wallet
          // UTXO already spent by an unconfirmed op, …) — rebuild with the treasury
          // paying the fee, which has a different, smaller shape
          if (fallback && !usedFallback) {
            usedFallback = true;
            log(`node refused the wallet-funded transaction (${String(e?.message || e).slice(0, 90)}…) — retrying with the treasury paying the fee`, "err");
            const fb = fallback();
            borshHex = fb.borshHex; meta = fb.meta; if (fb.guard) guard = fb.guard;
            continue;
          }
          throw e;
        }
      }
      const st0 = loadState(treasuryId);
      if (st0?.vaultAddress) {
        try {
          const { entries } = await c.getUtxos([st0.vaultAddress]);
          ({ bal: vaultBal, unswept, strays } = vaultSplit(entries, treasuryId));
        } catch { /* balance best-effort */ }
      }
    } finally { c.close(); }
    const st = loadState(treasuryId);
    let status;
    if (st) { const next = applyUpdate(st, kind, meta, txid); saveState(treasuryId, next); status = statusFromState(next, vaultBal, unswept, strays); }
    return { ok: true, txid, direct: true, status };
  }
  if (guard) assertSpend(borshHex, { ...guard, kind });
  return getJson(`${base}/relay`, { borshHex, kind, meta });
}

// Node-direct status: in ⚙ JSON wRPC mode, build the status from the locally
// tracked state + a live vault balance from the node. Returns null otherwise
// (so the caller falls back to the backend).
export async function statusDirect(treasuryId) {
  if (!getRpcUrl() || !treasuryId) return null;
  const st = loadState(treasuryId);
  if (!st?.root) return null;
  let bal = null, unswept = 0, strays = [];
  if (st.vaultAddress) {
    const c = connectWrpc(getRpcUrl());
    try {
      await c.ready;
      const { entries } = await c.getUtxos([st.vaultAddress]);
      // direct sends to the vault address are covenant-protected on arrival, but
      // not covenant-BOUND (and so not part of the balance) until swept
      ({ bal, unswept, strays } = vaultSplit(entries, st.treasuryId));
    }
    catch { /* fall back to no balance */ }
    finally { c.close(); }
  }
  return statusFromState(st, bal, unswept, strays);
}

// Seed node-direct operating state for a treasury loaded purely from the chain (no
// backend ever). Rebuilds the covenant scripts from the recovered owners/threshold
// and the lineage the chain itself reports (treasuryRebuild — no silc), then WALKS
// the KoRoot's spend history from the genesis tx — createProposal spends advance the
// nonce, executeConfig spends install the new owners/threshold carried in their
// witness — so it always lands on the CURRENT config even after signer changes.
// Writes the state to localStorage so statusDirect + the operating flows go
// node-direct. Returns { treasuryId, status } or null.
export async function seedFromChain(vaultAddress, recovered, log = () => {}) {
  if (!getRpcUrl() || !vaultAddress) return null;
  const genesisOwners = (recovered?.owners || []).map((o) => o.pubkey).filter(Boolean);
  const threshold = recovered?.threshold, genesisTxid = recovered?.genesisTxId;
  if (!genesisOwners.length || !threshold || !genesisTxid) return null;
  await loadWasm();
  const owners5 = [...genesisOwners]; while (owners5.length < 5) owners5.push(NUMS);
  const genesis = { txid: genesisTxid, threshold, ownerCount: genesisOwners.length, owners5 };
  const c = connectWrpc(getRpcUrl());
  try {
    await c.ready;
    // vault UTXOs → treasuryId (covenantId) + balance (+ unswept direct deposits).
    // The lineage IS the vault's state, so the address is a function of the id and
    // the two must agree: rebuild the vault around each candidate id and keep only
    // the ones whose address is the address we are opening. A UTXO here under any
    // other id is a covenant a stranger planted, and taking its id would build every
    // later spend around his lineage instead of the treasury's.
    let treasuryId = null, vaultBal = 0;
    const vents = (await c.getUtxos([vaultAddress])).entries || [];
    const vcov = vents.filter((e) => e.utxoEntry.covenantId && p2sh(rebuildVault(e.utxoEntry.covenantId)) === vaultAddress);
    if (vcov.length) { treasuryId = vcov[0].utxoEntry.covenantId; vaultBal = vcov.reduce((a, e) => a + Number(e.utxoEntry.amount), 0); }
    if (!treasuryId) return null;
    const vaultRedeem = rebuildVault(treasuryId);
    const { unswept, strays } = vaultSplit(vents, treasuryId);
    log("seeding from chain: walking the KoRoot history (proposals + signer changes)…");
    const getU = async (addr) => (await c.getUtxos([addr])).entries || [];
    const { live, creations } = await walkRoot({ treasuryId, genesisTxid, threshold, ownerCount: genesisOwners.length, owners5, p2sh, getUtxos: getU, log });
    if (!live) return null;
    // rebuild every proposal (open queue + executed/expired history) from chain
    let proposals = [];
    try {
      proposals = await scanOpenProposals({ treasuryId, creations, p2sh, getUtxos: getU, log });
      enrichDiscovered(proposals);
    } catch (e) { log(`proposal scan skipped: ${e}`, "err"); }
    const realOwners = live.owners5.slice(0, live.ownerCount);
    const st = {
      treasuryId, vaultRedeem, rootRedeem: live.redeem, proposalRedeem: proposalTemplateScript(),
      rootStateLayout: ROOT_STATE_LAYOUT, proposalStateLayout: PROPOSAL_STATE_LAYOUT,
      vaultAddress, genesis,
      root: { redeemHex: live.redeem, outpoint: { txid: live.outpoint.txid, index: live.outpoint.index }, value: live.value },
      proposals, history: loadState(treasuryId)?.history || [], // keep locally tracked history across re-seeds
      threshold: live.threshold, owners: realOwners.map((pk) => ({ xonly_pubkey: pk, address: pubkeyAddress(pk) })), fundingAddress: null,
    };
    saveState(treasuryId, st);
    log(`seeded node-direct: treasuryId ${treasuryId.slice(0, 12)}…  ${live.threshold}-of-${live.ownerCount}  root nonce ${live.nonce}  vault ${vaultBal / 1e8} KAS`);
    return { treasuryId, status: statusFromState(st, vaultBal, unswept, strays) };
  } finally { c.close(); }
}

// Re-sync a locally-tracked treasury from CHAIN (node-direct): walk the KoRoot from
// genesis (picking up signer changes made in OTHER browsers), rebuild the FULL
// proposal set — open queue AND executed/expired history with on-chain audit
// logs — and merge into the localStorage state. Merge rule: closed-on-chain wins;
// for open proposals the fresher side wins (more approvals/rejections — the local
// copy can be ahead of the indexer right after an op, the chain copy can be ahead
// after another owner acted); local-only proposals (indexer lag) are kept.
export async function rescanFromChain(treasuryId, log = () => {}) {
  if (!getRpcUrl() || !treasuryId) return false;
  const st = loadState(treasuryId);
  if (!st?.vaultAddress) return false;
  await loadWasm();
  // genesis info: stored at create/seed; older states recover it from the
  // vault's KOSGN inscription (REST) once and keep it
  let genesis = st.genesis;
  if (!genesis?.txid) {
    try {
      const r = await recoverTreasuryFromChain(st.vaultAddress);
      if (!r.ok) return false;
      const owners5 = r.status.owners.map((o) => o.pubkey); while (owners5.length < 5) owners5.push(NUMS);
      genesis = { txid: r.status.genesisTxId, threshold: r.status.threshold, ownerCount: r.status.owners.length, owners5 };
    } catch { return false; }
  }
  const c = connectWrpc(getRpcUrl());
  try {
    await c.ready;
    const getU = async (addr) => (await c.getUtxos([addr])).entries || [];
    const { live, creations } = await walkRoot({ treasuryId, genesisTxid: genesis.txid, threshold: genesis.threshold, ownerCount: genesis.ownerCount, owners5: genesis.owners5, p2sh, getUtxos: getU, log });
    if (!live) return false; // chain view incomplete (indexer lag) — keep local state untouched
    const scanned = await scanOpenProposals({ treasuryId, creations, p2sh, getUtxos: getU, log });
    enrichDiscovered(scanned);
    // The walk takes seconds of REST calls — a submit (propose/approve/execute)
    // can save state meanwhile, and writing a result computed from our stale
    // snapshot would clobber it (the queue badge briefly showed the new proposal,
    // then a mid-flight rescan erased it). Re-read at save time: merge against the
    // FRESH local proposals, and if the root moved mid-scan (the node accepted a
    // newer continuation the laggy REST walk can't see yet) keep the fresh root.
    const cur = loadState(treasuryId) || st;
    const local = new Map((cur.proposals || []).map((p) => [String(p.proposalId), p]));
    const ver = (x) => Number(x.approvalCount ?? 0) + Number(x.rejectCount ?? 0);
    const merged = scanned.map((p) => {
      const l = local.get(String(p.proposalId)); local.delete(String(p.proposalId));
      if (!l) return p;
      if (p.status >= 2) return p; // closed on-chain wins
      if ((l.status ?? 0) >= 2) return l; // closed locally, chain lagging
      return ver(l) > ver(p) ? { ...l, events: (l.events?.length ?? 0) >= (p.events?.length ?? 0) ? l.events : p.events } : p;
    });
    const rootMoved = cur.root?.outpoint && st.root?.outpoint &&
      (cur.root.outpoint.txid !== st.root.outpoint.txid || Number(cur.root.outpoint.index) !== Number(st.root.outpoint.index));
    const realOwners = live.owners5.slice(0, live.ownerCount);
    const next = {
      ...cur, genesis, proposals: [...merged, ...local.values()],
      rootRedeem: rootMoved ? cur.rootRedeem : live.redeem,
      root: rootMoved ? cur.root : { redeemHex: live.redeem, outpoint: { txid: live.outpoint.txid, index: live.outpoint.index }, value: live.value },
      threshold: live.threshold, owners: realOwners.map((pk) => ({ xonly_pubkey: pk, address: pubkeyAddress(pk) })),
    };
    saveState(treasuryId, next);
    return true;
  } catch { return false; }
  finally { c.close(); }
}

// ---- Creating a treasury: TWO transactions ----------------------------------
//
// 1. GENESIS mints the KoRoot and nothing else, and in doing so mints the covenant
//    id C = H(funding outpoint, [the root output]). Output 1, when there is one, is
//    ordinary change back to the funder and inherits nothing.
// 2. BOOTSTRAP spends that root and mints the KoVault as a continuation of C, with
//    C written into the vault's state.
//
// It has to be two, and the reason is the id itself: a covenant id hashes the
// scriptPubKeys of its own genesis group, so a vault built around the id could not
// be a member of the group that produced it. Splitting them is what buys the
// property the whole design rests on — the vault address is a pure FUNCTION of the
// genesis (address = P2SH(prefix ‖ push32 ‖ C ‖ suffix)), so one covenant id gives
// one vault address and no second lineage can ever transact at it.
//
// Until step 2 lands there is no vault and therefore no deposit address, and this
// module never writes one: the treasury's operating state (which is what the UI
// reads a deposit address out of) is saved only after the bootstrap is accepted.
// A genesis that lands without its bootstrap is not a dead end — the root UTXO is
// on chain and bootstrapVault can be retried against it — so it is recorded as a
// PENDING treasury that resumeBootstrap() finishes.

const PENDING_KEY = (id) => `kosign.pending.${id}`;
const savePending = (rec) => { try { localStorage.setItem(PENDING_KEY(rec.treasuryId), JSON.stringify(rec)); } catch { /* ignore */ } };
const clearPending = (id) => { try { localStorage.removeItem(PENDING_KEY(id)); } catch { /* ignore */ } };

/**
 * Treasuries whose genesis landed but whose vault was never minted, on the network
 * currently selected — a root minted on TN10 cannot be bootstrapped from a TN11
 * node, so offering it there would be an invitation to a confusing failure.
 */
export function pendingBootstraps() {
  const net = getNetworkId();
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith("kosign.pending.")) continue;
      const rec = JSON.parse(localStorage.getItem(k) || "null");
      if (!rec?.treasuryId || rec.network !== net) continue;
      // a pending record whose treasury finished elsewhere in this browser is stale
      if (!loadState(rec.treasuryId)) out.push(rec);
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// The KoRoot is the only covenant input a bootstrap spends, so the wallet may add
// MAX_TX_INPUTS - 1 of its own — bootstrapVault walks the input set with the same
// bounded loop createProposal does, and one input too many fails script
// verification rather than merely costing more.
const BOOTSTRAP_COVENANT_INPUTS = 1;

// Submit one bootstrapVault transaction: input 0 = the KoRoot, the vault's
// endowment and the network fee from the owner's own inputs (so the root's value
// floor cannot bind and the root continues at full value), output 0 = the root
// unchanged, output 1 = the vault carrying the lineage. Returns the txid and the
// vault redeem it minted.
async function submitBootstrap(c, { lineage, rootRedeem, rootOutpoint, rootValue, vaultSompi, ownerIndex, ownerAddress, fundingUtxos }, log) {
  const base = {
    rootScript: rootRedeem, rootTxid: rootOutpoint.txid, rootIndex: rootOutpoint.index, rootAmount: rootValue,
    treasuryId: lineage, vaultPrefix: TEMPLATES.vault.prefix, vaultSuffix: TEMPLATES.vault.suffix,
    vaultValue: vaultSompi, ownerIndex, ownerAddress, fundingUtxos,
  };
  const dummies = JSON.stringify(Array(1 + fundingUtxos.length).fill(ZERO_SIG));
  const total = fundingUtxos.reduce((a, u) => a + u.amount, 0);
  // change too small to spend is worse than no change — fold it into the fee
  const foldF = (f) => { const change = total - vaultSompi - f; return change > 0 && change < CHANGE_FLOOR ? f + change : f; };
  const signedAt = (f) => {
    const inp = JSON.stringify({ ...base, fee: foldF(f) });
    const shs = JSON.parse(W.bootstrap_sighashes(inp));
    return JSON.parse(W.bootstrap_build(inp, JSON.stringify(shs.map((sh) => sign(sh)))));
  };
  const probe = JSON.parse(W.bootstrap_build(JSON.stringify({ ...base, fee: 0 }), dummies)).borshHex;
  let fee = priceBorsh(probe); // no cap: the wallet pays, so maxProposalFee is not a ceiling here
  const fee0 = fee; // honest pre-retry anchor for the fee-demand ceiling
  let out = signedAt(fee);
  // The address every future deposit is sent to, derived rather than accepted.
  //
  // Callers publish p2sh(vaultRedeemHex) as the treasury's deposit address, and
  // that hex is the BUILDER's own account of what it just minted. The covenant
  // pins what reaches the chain — KoRoot.bootstrapVault mints the vault under a
  // template pinned by hash, carrying the root's own id as its state — but the
  // return value is not the transaction, and a builder that puts the right vault
  // on chain while handing back a different redeem script tells a lie the node
  // never sees. The result is a correct treasury with an attacker's deposit
  // address printed under it.
  //
  // A vault address is a pure function of its lineage, which is the property the
  // whole design rests on, so the app can simply work it out: rebuildVault is the
  // same derivation seedFromChain already uses to recognise a vault UTXO. If the
  // two disagree, one of them is wrong and neither may be published.
  const derivedRedeem = rebuildVault(lineage);
  if (out.vaultRedeemHex.toLowerCase() !== derivedRedeem.toLowerCase()) {
    throw new Error(
      `internal: the builder reports a vault whose address is ${p2sh(out.vaultRedeemHex)}, but lineage ${lineage.slice(0, 16)}… derives ${p2sh(derivedRedeem)}. Refusing to publish a deposit address that does not follow from this treasury's own genesis — nothing has been submitted.`);
  }
  for (let attempt = 0; ; attempt++) {
    // Same second-reading discipline the covenant ops use: the funder signs their
    // own wallet inputs here, so a hostile builder that keeps the root/vault
    // continuations valid can still divert the change output to an attacker. The
    // derivedRedeem check above pins only the vault SCRIPT; this pins where every
    // non-covenant sompi goes — change must come home to the funder's own wallet.
    assertSpend(out.borshHex, { kind: "bootstrap", lineage, prefix: getNetwork().prefix, walletAddress: ownerAddress });
    const rpcTx = JSON.parse(W.borsh_to_rpc_json(out.borshHex));
    try {
      const txid = (await c.submit(rpcTx)).transactionId;
      // the node's utxoindex won't show these as spent until the tx is accepted;
      // without this a follow-up op could re-pick the same wallet UTXO
      markSpentOutpoints(rpcTx);
      return { txid, vaultRedeemHex: out.vaultRedeemHex, fee };
    } catch (e) {
      const want = /required amount of (\d+)/.exec(String(e?.message || e));
      if (!want || attempt >= 2) throw e;
      fee = saneFeeDemand(Number(want[1]), fee0);
      log(`node asks ≥ ${(fee / 1e8).toFixed(4)} KAS bootstrap fee — re-signing…`);
      out = signedAt(fee);
    }
  }
}

// Write the operating state for a treasury whose vault has just been minted. This
// is the first and only place a vault address is published to the rest of the app.
function saveBootstrapped({ lineage, rootRedeem, rootValue, bootstrapTxid, vaultRedeem, vaultAddress, genesisTxid, threshold, ownerCount, owners5, realOwners, ownerAddr }) {
  saveState(lineage, {
    treasuryId: lineage, vaultRedeem, rootRedeem, proposalRedeem: proposalTemplateScript(),
    rootStateLayout: ROOT_STATE_LAYOUT, proposalStateLayout: PROPOSAL_STATE_LAYOUT,
    vaultAddress,
    genesis: { txid: genesisTxid, threshold, ownerCount, owners5 }, // anchor for the chain walk
    // When this browser minted it. The genesis audit reads the chain INDEXER, which
    // trails the node by minutes, so a treasury created seconds ago cannot verify yet
    // — not because anything is wrong, but because the check has not had its data. The
    // gate uses this to tell "waiting" apart from "could not verify", instead of
    // greeting someone with a warning about the treasury they just watched succeed.
    // It never skips the audit: the deposit address stays gated either way.
    mintedAt: Date.now(),
    // the root moved: bootstrapVault continued it at output 0, nonce untouched
    root: { redeemHex: rootRedeem, outpoint: { txid: bootstrapTxid, index: 0 }, value: rootValue },
    proposals: [], history: [], threshold,
    owners: realOwners.map((pk) => ({ xonly_pubkey: pk, address: pubkeyAddress(pk) })),
    fundingAddress: ownerAddr,
  });
}

// Finish a treasury whose genesis landed but whose vault was never minted. The root
// UTXO is on chain and carries the lineage, so this is a plain retry — nothing about
// the treasury's identity changes, and the vault lands at the same address it always
// would have. Returns { treasuryId, vaultAddress, txid }.
export async function resumeBootstrap(treasuryId, log = () => {}) {
  if (!getRpcUrl()) await ensureRpcUrl(log);
  if (!getRpcUrl()) throw new Error("No node endpoint — pick Official or set a Custom node in ⚙.");
  const rec = JSON.parse(localStorage.getItem(PENDING_KEY(treasuryId)) || "null");
  if (!rec) throw new Error("no half-created treasury with that id in this browser");
  await loadWasm();
  const myPk = signerPubkey();
  if (!myPk) throw new Error("import your key first — bootstrapVault needs an owner's signature");
  const ownerIndex = rec.owners5.indexOf(myPk);
  if (ownerIndex < 0) throw new Error("the imported key is not an owner of this treasury");
  const ownerAddr = pubkeyAddress(myPk);
  const rootAddress = p2sh(rec.rootRedeem);
  const c = connectWrpc(getRpcUrl());
  try {
    await c.ready;
    // the root as the chain has it — value included, because a covenant-funded
    // retry elsewhere could have moved it
    const rents = (await c.getUtxos([rootAddress])).entries || [];
    const root = rents.find((e) => e.utxoEntry.covenantId === rec.treasuryId);
    if (!root) throw new Error(`no KoRoot UTXO under this treasury's lineage at ${rootAddress.slice(0, 20)}… yet — if the genesis is still unconfirmed, try again in a minute`);
    const fents = freshUtxos((await c.getUtxos([ownerAddr])).entries);
    const need = rec.vaultSompi + MAX_COVENANT_FEE;
    const { picked, sum, capped } = pickFrom(fents, need, fundingSlots(BOOTSTRAP_COVENANT_INPUTS));
    if (sum < need) {
      throw new Error(capped
        ? `your wallet holds more UTXOs than one bootstrap can spend (the covenant caps a spend at ${MAX_TX_INPUTS} inputs and the KoRoot takes one), so at most ${(sum / 1e8).toFixed(4)} KAS of it can fund the vault — consolidate your wallet by sending your balance to yourself in one transaction`
        : `fund ${ownerAddr.slice(0, 20)}… with ≥ ${(need / 1e8).toFixed(2)} KAS — the vault's opening balance and the fee come from your wallet (have ${(sum / 1e8).toFixed(4)})`);
    }
    log("minting the vault (bootstrapVault) — this is what creates the deposit address…");
    const bs = await submitBootstrap(c, {
      lineage: rec.treasuryId, rootRedeem: rec.rootRedeem,
      rootOutpoint: { txid: root.outpoint.transactionId, index: root.outpoint.index },
      rootValue: Number(root.utxoEntry.amount), vaultSompi: rec.vaultSompi,
      ownerIndex, ownerAddress: ownerAddr, fundingUtxos: picked,
    }, log);
    const vaultAddress = p2sh(bs.vaultRedeemHex);
    saveBootstrapped({
      lineage: rec.treasuryId, rootRedeem: rec.rootRedeem, rootValue: Number(root.utxoEntry.amount),
      bootstrapTxid: bs.txid, vaultRedeem: bs.vaultRedeemHex, vaultAddress, genesisTxid: rec.genesisTxid,
      threshold: rec.threshold, ownerCount: rec.ownerCount, owners5: rec.owners5,
      realOwners: rec.owners5.slice(0, rec.ownerCount), ownerAddr,
    });
    clearPending(rec.treasuryId);
    log(`vault minted at ${vaultAddress} — the treasury can take deposits`, "ok");
    return { treasuryId: rec.treasuryId, vaultAddress, txid: bs.txid };
  } finally { c.close(); }
}

// Create a treasury entirely client-side (node-direct, zero backend, NO silc): the
// covenant scripts are reconstructed from the fixed templates (rebuildRoot/Vault),
// both transactions are built + signed in wasm, and submitted straight to the node.
// Owner 0 (the imported key) funds and signs them. Returns { treasuryId,
// vaultAddress, txid, bootstrapTxid }.
export async function createTreasuryClientSide({ ownerPubkey, coSignerAddresses = [], threshold, rootSompi = 30_000_000, vaultSompi = 30_000_000 }, log = () => {}) {
  if (!getRpcUrl()) await ensureRpcUrl(log); // Official mode: resolve a public node first
  if (!getRpcUrl()) throw new Error("No node endpoint — pick Official or set a Custom node in ⚙.");
  await loadWasm();
  const coPubs = coSignerAddresses.map((a) => a.trim()).filter(Boolean).map((a) => W.address_pubkey(a));
  const realOwners = [ownerPubkey, ...coPubs];
  const ownerCount = realOwners.length;
  if (new Set(realOwners).size !== ownerCount) throw new Error("Owners must be distinct addresses.");
  if (threshold < 1 || threshold > ownerCount) throw new Error("Threshold must be between 1 and the owner count.");
  const owners5 = [...realOwners]; while (owners5.length < 5) owners5.push(NUMS);
  const rootRedeem = rebuildRoot(0, threshold, ownerCount, owners5);
  const ownerAddr = pubkeyAddress(ownerPubkey);
  const c = connectWrpc(getRpcUrl());
  try {
    await c.ready;
    const ents = freshUtxos((await c.getUtxos([ownerAddr])).entries);
    const FEE_CEIL = 10_000_000; // legacy fixed fee — now just the coin-selection ceiling
    // Fund BOTH transactions here. The genesis pays only the root; the vault's
    // opening balance rides along in the genesis change and is paid in by the
    // bootstrap, which spends that change as its funding input — so the two
    // transactions chain with no second wallet lookup and no wait for the node's
    // utxoindex to catch up.
    const need = rootSompi + vaultSompi + 2 * FEE_CEIL;
    const { picked, sum, capped } = pickFrom(ents, need, fundingSlots(0));
    if (sum < need) {
      throw new Error(capped
        ? `your wallet holds more UTXOs than one transaction can spend — consolidate it (send your balance to yourself in one transaction) and try again`
        : `Fund ${ownerAddr.slice(0, 20)}… with ≥ ${(need / 1e8).toFixed(2)} KAS first (have ${(sum / 1e8).toFixed(4)}).`);
    }
    // The covenant id depends on the authorizing input's outpoint and the root
    // output — not on the payload, the change or the fee — so it is known before
    // anything is signed. That is what lets the inscription CARRY it: an auditor
    // recomputes it from the genesis itself and compares.
    const anchor = { fundingAddress: ownerAddr, rootRedeem, rootValue: rootSompi, fundingUtxos: picked };
    const lineage = W.genesis_covenant_id(JSON.stringify(anchor));
    const payload = W.inscription(BigInt(threshold), JSON.stringify(realOwners), lineage);
    const mkGinp = (change) => JSON.stringify({ ...anchor, change, payloadHex: payload });
    // mass-priced genesis fee: probe with dummy sigs and any positive change (the
    // fee/change values only move fixed-width bytes — mass depends on the shape)
    const ginpFor = (fee) => {
      const change = sum - rootSompi - fee;
      if (change < vaultSompi) throw new Error(`Fund ${ownerAddr.slice(0, 20)}… with ≥ ${((rootSompi + vaultSompi + fee) / 1e8).toFixed(2)} KAS first — the network fee needs ${(fee / 1e8).toFixed(4)} KAS and the vault needs ${(vaultSompi / 1e8).toFixed(2)} KAS of its own.`);
      return { fee, ginp: mkGinp(change), change };
    };
    const probe = JSON.parse(W.genesis_build(mkGinp(sum - rootSompi - FEE_CEIL), JSON.stringify(picked.map(() => ZERO_SIG)))).borshHex;
    let { fee, ginp, change } = ginpFor(priceBorsh(probe));
    const fee0 = fee; // honest pre-retry anchor for the fee-demand ceiling
    const signed = (g) => {
      const ga = JSON.parse(W.genesis_sighashes(g));
      return JSON.parse(W.genesis_build(g, JSON.stringify(ga.sighashes.map((sh) => sign(sh)))));
    };
    log(`step 1 of 2 — genesis: minting the KoRoot and the covenant id ${lineage.slice(0, 12)}… it binds`);
    log(`signing genesis locally (BIP340)… fee ${(fee / 1e8).toFixed(4)} KAS (mass-priced)`);
    let gout = signed(ginp);
    log("submitting genesis straight to your node (no backend)…");
    // use the node-returned txid for the outpoints — it can differ from the local
    // build (mass + payload), and the covenant id stays the same either way (it is
    // derived from the FUNDING outpoint, not from this transaction's id)
    let txid;
    for (let attempt = 0; ; attempt++) {
      // The bytes about to be broadcast must mint the lineage the inscription names.
      // Checked BEFORE the irreversible submit — and on every re-signed rebuild, not
      // once at the end — so a build that diverges is refused instead of broadcast.
      // Placed after the submit (as it was) it could neither stop a bad genesis nor,
      // firing between submit and savePending, leave a recovery record for the root
      // it had already put on chain.
      if (gout.treasuryId !== lineage) throw new Error(`internal: the built genesis mints ${gout.treasuryId.slice(0, 16)}…, not the ${lineage.slice(0, 16)}… the inscription names — nothing was submitted`);
      // The treasuryId check above is the builder vouching for itself (both sides
      // come from W). This is the independent re-reading: decode the bytes and
      // require output 0 to continue this lineage and the genesis change to come
      // home to the funder's own wallet — so a builder that keeps a valid root but
      // routes the change (which carries the vault's whole opening balance) to an
      // attacker is refused before the irreversible submit, on every re-signed retry.
      assertSpend(gout.borshHex, { kind: "genesis", lineage, prefix: getNetwork().prefix, walletAddress: ownerAddr });
      const rpcTx = JSON.parse(W.borsh_to_rpc_json(gout.borshHex));
      try { txid = (await c.submit(rpcTx)).transactionId; markSpentOutpoints(rpcTx); break; }
      catch (e) {
        // a node demanding more reports the exact fee — re-sign at that fee
        const want = /required amount of (\d+)/.exec(String(e?.message || e));
        if (!want || attempt >= 2) throw e;
        ({ fee, ginp, change } = ginpFor(saneFeeDemand(Number(want[1]), fee0)));
        log(`node asks ≥ ${(fee / 1e8).toFixed(4)} KAS genesis fee — re-signing…`);
        gout = signed(ginp);
      }
    }
    // Record the half-made treasury BEFORE attempting the bootstrap: from here on
    // the root exists on chain, so a failure is resumable rather than lost.
    savePending({
      treasuryId: lineage, genesisTxid: txid, rootRedeem, rootValue: rootSompi, vaultSompi,
      threshold, ownerCount, owners5, ownerAddress: ownerAddr,
      network: getNetworkId(), createdAt: Date.now(),
    });
    log(`step 2 of 2 — bootstrap: minting the vault around ${lineage.slice(0, 12)}… (this is what creates the deposit address)`);
    let bs;
    try {
      bs = await submitBootstrap(c, {
        lineage, rootRedeem, rootOutpoint: { txid, index: 0 }, rootValue: rootSompi, vaultSompi,
        ownerIndex: 0, ownerAddress: ownerAddr,
        // the genesis change, spent straight out of the mempool
        fundingUtxos: [{ txid, index: 1, amount: change }],
      }, log);
    } catch (e) {
      throw new Error(`genesis landed (${txid.slice(0, 16)}…) but the vault was not minted: ${e.message || e}. The treasury is half-created and can be finished from the Create page — nothing is lost, and its address will be the same.`);
    }
    const vaultAddress = p2sh(bs.vaultRedeemHex);
    saveBootstrapped({
      lineage, rootRedeem, rootValue: rootSompi, bootstrapTxid: bs.txid, vaultRedeem: bs.vaultRedeemHex,
      vaultAddress, genesisTxid: txid, threshold, ownerCount, owners5, realOwners, ownerAddr,
    });
    clearPending(lineage);
    log(`vault minted at ${vaultAddress} — the treasury can take deposits`, "ok");
    return { treasuryId: lineage, vaultAddress, txid, bootstrapTxid: bs.txid };
  } finally { c.close(); }
}


// ---- Dynamic fees for the covenant flows (propose/approve/reject/execute/
// config/genesis). Every builder accepts an optional `fee` override; the fee
// is priced from the node-exact mass of a PROBE build made with dummy zero
// signatures (a fee change only moves fixed-width output values, never the
// serialized size, so the probe's mass is exact for the final fee). The
// deployed covenants cap fee leakage at 0.1 KAS (maxProposalFee /
// maxExecutionFee, and every proposal commits maxFee = 0.1 KAS), so flows that
// spend covenant value clamp against MAX_COVENANT_FEE and fail loudly if the
// network feerate ever outgrows the contracts.
const ZERO_SIG = "00".repeat(64);
const priceBorsh = (borshHex, cap) => {
  const fee = feeMassOf(JSON.parse(W.borsh_masses(borshHex))) * MIN_RELAY_FEE_RATE;
  if (cap && fee > cap) throw new Error(`network fee ${(fee / 1e8).toFixed(4)} KAS exceeds this covenant's ${(cap / 1e8).toFixed(2)} KAS fee cap — the network feerate has outgrown the deployed contract`);
  return fee;
};
// One committed int out of a proposal's state, by byte offset within it: the
// fields are fixed-width (each int is 0x08 + 8 LE bytes), so maxFee sits after
// proposalId 9 + operation 9 + spkHash 33 + amount 9, and expiresAt after it.
// null when the script doesn't carry the state we expect there.
const OFF_MAX_FEE = 60, OFF_EXPIRES_AT = 69, OFF_RECIPIENT_HASH = 18;
const stateInt = (redeemHex, pStart, field) => {
  try {
    const off = (pStart + field) * 2;
    if (redeemHex.slice(off, off + 2) !== "08") return null;
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(parseInt(redeemHex.slice(off + 2 + i * 2, off + 4 + i * 2), 16));
    return Number(v);
  } catch { return null; }
};
// One committed bytes32 out of a proposal's state (0x20 + 32 bytes), same
// addressing as stateInt. The redeem hex is anchored to the on-chain UTXO, so a
// hash read here is the covenant's own commitment, not the local record's word.
const stateBytes32 = (redeemHex, pStart, field) => {
  try {
    const off = (pStart + field) * 2;
    if (redeemHex.slice(off, off + 2) !== "20") return null;
    const h = redeemHex.slice(off + 2, off + 66).toLowerCase();
    return /^[0-9a-f]{64}$/.test(h) ? h : null;
  } catch { return null; }
};
// The covenant enforces fee leakage against the PROPOSAL's committed maxFee.
// UI-created proposals commit 0.1 KAS, but a foreign client may commit less —
// cap against the real value.
const stateMaxFee = (redeemHex, pStart) => {
  const n = stateInt(redeemHex, pStart, OFF_MAX_FEE);
  return n !== null && n > 0 && n <= MAX_COVENANT_FEE ? n : MAX_COVENANT_FEE;
};

// Single-signature flows (approve/reject/execute/config-execute) share one
// shape: probe at fee 0 (so the legacy constants never act as availability
// floors — a bond just above the real fee must still be spendable) → price →
// sign+build at that fee. mk(fee) re-signs at any fee — submitAndTrack uses it
// when a node demands more ("required amount of N" — same shape ⇒ N exact).
const feeSized = (buildFn, sighashFn, inputs0, cap = MAX_COVENANT_FEE) => {
  const probe = JSON.parse(buildFn(JSON.stringify({ ...inputs0, fee: 0 }), ZERO_SIG)).borshHex;
  const fee = priceBorsh(probe, cap);
  const mk = (f) => {
    if (cap && f > cap) {
      throw new Error(`network fee ${(f / 1e8).toFixed(4)} KAS exceeds this covenant's ${(cap / 1e8).toFixed(4)} KAS fee cap — fund your wallet with ≥ ${(f / 1e8).toFixed(2)} KAS so the fee can be paid from it instead (that path has no cap)`);
    }
    const inp = JSON.stringify({ ...inputs0, fee: f });
    return { fee: f, ownerFunded: false, out: JSON.parse(buildFn(inp, sign(sighashFn(inp)))) };
  };
  return { fee, ownerFunded: false, mk };
};

// Wallet outpoints consumed by a tx we submitted this session. getUtxosByAddresses
// is served from the node's utxoindex, which does NOT reflect mempool spends, so
// two back-to-back owner-funded ops would otherwise re-pick the same UTXO and the
// second would be rejected as a double spend.
const spentThisSession = new Set();
const outpointKey = (o) => `${o.txid}:${o.index}`;
export const markSpentOutpoints = (rpcTx) => {
  for (const i of rpcTx?.inputs || []) {
    const o = i.previousOutpoint || i.previous_outpoint;
    if (o) spentThisSession.add(`${o.transactionId ?? o.transaction_id}:${Number(o.index ?? 0)}`);
  }
};
const freshUtxos = (entries) => (entries || [])
  .filter((e) => !e.utxoEntry.covenantId)
  .map((e) => ({ txid: e.outpoint.transactionId, index: e.outpoint.index, amount: safeSompi(e.utxoEntry.amount, "a wallet UTXO amount") }))
  .filter((u) => !spentThisSession.has(outpointKey(u)))
  .sort((a, b) => b.amount - a.amount);

// The connected wallet's own P2PK address (null when no key is loaded).
const signerAddress = () => { const pk = signerPubkey(); return pk ? pubkeyAddress(pk) : null; };

// What the caller claims this operation does, handed to txGuard.js so it can be
// checked against an independent reading of the finished bytes. `vaultOutpoint`
// is here so the guard can enforce the rule no covenant states out loud: an
// approval, a rejection, a proposal and a retirement must not spend the vault.
const treasurySpend = (r, treasuryIn) => ({ treasuryIn, treasuryFee: r.ownerFunded ? 0 : r.fee });

// The scriptPubKey a P2SH redeem script pays to: OP_BLAKE2B ‖ OP_DATA_32 ‖
// blake2b256(redeem) ‖ OP_EQUAL. Hashed here with the descriptor's own blake2b
// rather than asked of the wasm builder — the guard is checking that builder's
// output, so a vault address it supplied would be the builder vouching for
// itself.
const p2shSpkOf = (redeemHex) => {
  const bytes = new Uint8Array(String(redeemHex).match(/../g).map((b) => parseInt(b, 16)));
  return `aa20${Array.from(blake2b256(bytes), (b) => b.toString(16).padStart(2, "0")).join("")}87`;
};
const guardFor = (ctx, extra = {}) => ({
  lineage: ctx.treasuryId,
  prefix: getNetwork().prefix,
  vaultOutpoint: ctx.vault?.outpoint ?? null,
  walletAddress: signerAddress(),
  ...extra,
});

// The connected owner's spendable wallet UTXOs (node-direct only, largest
// first) — the funding source for owner-paid covenant-op fees.
async function ownerFundingUtxos(log = () => {}) {
  const url = getRpcUrl();
  const addr = url ? signerAddress() : null;
  if (!addr) return { addr: null, fents: [] };
  const c = connectWrpc(url);
  try {
    await c.ready;
    return { addr, fents: freshUtxos((await c.getUtxos([addr])).entries) };
  } catch (e) {
    log(`couldn't read your wallet UTXOs (${e.message || e}) — the treasury will pay this fee instead`, "err");
    return { addr: null, fents: [] };
  } finally { c.close(); }
}

// Inputs each op's own covenant UTXOs take out of the MAX_TX_INPUTS budget
// before any wallet UTXO is added: approve and reject spend the proposal;
// execute adds the vault, executeConfig the root. Mirrors tools/wasm-tx
// (ap_build / rj_build / ex_build / ecfg_build) — the funding inputs are
// appended after these. createProposal spends only the root and is capped the
// same way in proposerFunding (PROPOSAL_COVENANT_INPUTS).
const COVENANT_INPUTS = { approve: 1, reject: 1, execute: 2, executeConfig: 2 };

// Fee strategy for the four covenant ops (approve / reject / execute /
// config-execute). PREFERRED: pay from the owner's wallet — the covenant
// output then keeps its FULL value, which satisfies the `>= in - maxFee` rule
// with room to spare, so the contract's 0.1 KAS cap can never become a
// ceiling (a network repricing past it would otherwise make the treasury
// unspendable). `covenantInputs` is this op's entry in COVENANT_INPUTS: the
// wallet may only add MAX_TX_INPUTS minus that many UTXOs, because the vault's
// bounded input scan — and, since this round, KoRoot's — makes a spend past the
// ceiling fail script verification rather than merely cost more. Returns { fee, ownerFunded, mk(fee), fallback },
// where `fallback` rebuilds the same op covenant-funded (used when the wallet
// can't pay, when its UTXOs don't fit, when paying from the wallet would waste
// more than it saves, or when the node rejects the wallet-funded SHAPE — its
// extra change output raises KIP-9 storage mass, which can trip the
// standard-mass cap for tiny transfers).
async function feeSizedOp(buildFn, sighashFn, sighashesFn, inputs0, cap, covenantInputs, log) {
  const covenantFunded = () => feeSized(buildFn, sighashFn, inputs0, cap);
  const { addr, fents } = await ownerFundingUtxos(log);
  if (!addr || !fents.length) return { ...covenantFunded(), fallback: null };

  const dummy = (n) => JSON.stringify(Array(n).fill(ZERO_SIG));
  const build0 = (picked, fee) => JSON.parse(buildFn(JSON.stringify({ ...inputs0, ownerAddress: addr, fundingUtxos: picked, fee }), dummy(1 + picked.length)));
  const massOf = (picked) => feeMassOf(JSON.parse(W.borsh_masses(build0(picked, 0).borshHex)));
  // Size at the TRUE mass price, bounded by the covenant's input ceiling:
  // KoVault and KoRoot scan the input set with a loop the compiler unrolls at
  // most MAX_TX_INPUTS times and guards with `require(end - start <= MAX)`, so a
  // spend that attaches one funding UTXO too many does not merely overpay — it
  // fails script verification with an opaque error. `covenantInputs` is what
  // this op's own covenant UTXOs already take out of that budget.
  const size = (minFee = 0) => sizeOpFee(massOf, fents, covenantInputs, minFee);
  // Same ceiling, said in the imperative: what the owner can do about it.
  const fragmented = (r) => `your wallet holds more UTXOs than this operation can spend: the covenant caps a spend at ${MAX_TX_INPUTS} inputs and it already uses ${covenantInputs}, so at most ${r.slots} of your UTXOs (${(r.sum / 1e8).toFixed(4)} KAS) can pay the ${(r.fee / 1e8).toFixed(4)} KAS fee — consolidate your wallet (send your balance to yourself in one transaction), or fund the fee from a single UTXO`;
  const s = size();
  if (s.capped) {
    log(`${fragmented(s)}. The treasury will pay this fee instead (capped at ${(cap / 1e8).toFixed(2)} KAS).`, "err");
    // …unless the treasury can't either (fee over the covenant's own cap): then
    // the wallet is the only way through, and consolidating it is the fix — say
    // that, rather than surfacing the cap error as if the wallet were irrelevant.
    try { return { ...covenantFunded(), fallback: null }; }
    catch (e) { throw new Error(`${fragmented(s)}. The treasury cannot pay it either: ${e.message || e}`); }
  }
  if (s.short) {
    log(`your wallet holds ${(s.sum / 1e8).toFixed(4)} KAS — under the ${(s.fee / 1e8).toFixed(4)} KAS network fee, so the treasury will pay it (capped at ${(cap / 1e8).toFixed(2)} KAS)`, "err");
    return { ...covenantFunded(), fallback: null };
  }
  // change stuck under CHANGE_FLOOR would have to be folded into the fee (a
  // smaller change output is non-standard) — that wastes the owner's money, so
  // let the treasury pay instead whenever it still can
  if (s.sum > s.fee && s.sum - s.fee < CHANGE_FLOOR) {
    try {
      const cf = covenantFunded();
      log(`paying this fee from your wallet would waste ${((s.sum - s.fee) / 1e8).toFixed(4)} KAS as change too small to spend — the treasury pays it instead`);
      return { ...cf, fallback: null };
    } catch { /* covenant path unavailable (over its cap) — fold and keep the treasury operable */ }
  }
  const mk = (f) => {
    const r = size(f);
    // No fallback here (the caller is re-sizing at a fee the node demanded), so
    // the ceiling has to surface as an error the owner can act on rather than
    // as a script failure at submit time.
    if (r.capped) throw new Error(fragmented(r));
    if (r.short) throw new Error(`your wallet ${addr.slice(0, 18)}… needs ≥ ${(r.fee / 1e8).toFixed(4)} KAS free to pay this network fee`);
    const fee = r.sum - r.fee < CHANGE_FLOOR ? r.sum : r.fee; // fold only when unavoidable
    const inp = JSON.stringify({ ...inputs0, ownerAddress: addr, fundingUtxos: r.picked, fee });
    const shs = JSON.parse(sighashesFn(inp));
    return { fee, ownerFunded: true, out: JSON.parse(buildFn(inp, JSON.stringify(shs.map((sh) => sign(sh))))) };
  };
  log(`fee ${(s.fee / 1e8).toFixed(4)} KAS paid from your wallet — the treasury keeps its full value (no covenant fee cap applies)`);
  return { fee: s.fee, ownerFunded: true, mk, fallback: covenantFunded };
}

// helper: proposal template prefix/suffix from the script + state layout
const tpl = (ctx) => {
  const s = ctx.proposalStateLayout.start, l = ctx.proposalStateLayout.len;
  return { pPrefix: ctx.proposalRedeem.slice(0, s * 2), pSuffix: ctx.proposalRedeem.slice((s + l) * 2) };
};
const findProp = (ctx, pid) => {
  const p = (ctx.proposals || []).find((x) => String(x.proposalId) === String(pid));
  if (!p) throw new Error(`proposal ${pid} not in the live set`);
  return p;
};

// The proposal bond the PROPOSER funds from their own wallet (so the KoRoot
// value is preserved and never depletes), plus the mass-priced network fee.
// PROPOSAL_COST stays at the legacy bond + 0.1 KAS ceiling as the coin-selection
// target; the actual fee is priced from the tx mass and the surplus returns as
// owner change.
const PROPOSAL_COST = 60_000_000; // bond + fee headroom (coin-selection target)

// Owner-funded: pick the proposer's own wallet UTXOs (node-direct) to cover the
// proposal cost. Returns { ownerAddress, fundingUtxos } or null (not node-direct,
// no owner address, insufficient funds, or a wallet too fragmented to fit — the
// caller then falls back to root-funded).
//
// Capped at the covenant's input ceiling, like feeSizedOp. KoRoot.createProposal
// walks the root-input set with the same bounded loop KoVault uses, so the
// compiler emits `require(tx.inputs.length <= 16)` and a 17-input proposal spend
// fails SCRIPT VERIFICATION rather than merely costing more. The root is the only
// covenant input here, so the proposer may add MAX_TX_INPUTS - 1 wallet UTXOs —
// one more than approve/reject and two more than execute. In practice the target
// is the whole PROPOSAL_COST bond rather than a sub-cent fee, so a solvent wallet
// reaches it in one or two UTXOs and never comes near the ceiling; the cap is for
// the dust-fragmented wallet, which now falls back to the root-funded path with a
// message that says what to do instead of failing at submit time.
const PROPOSAL_COVENANT_INPUTS = 1; // the KoRoot UTXO (mirrors cp_build in tools/wasm-tx)

async function proposerFunding(ctx, proposerIndex, log) {
  if (!getRpcUrl()) return null;
  const ownerAddress = ctx.owners?.[proposerIndex]?.address
    || (ctx.owners?.[proposerIndex]?.xonly_pubkey && pubkeyAddress(ctx.owners[proposerIndex].xonly_pubkey));
  if (!ownerAddress) return null;
  const c = connectWrpc(getRpcUrl());
  try {
    await c.ready;
    const ents = freshUtxos((await c.getUtxos([ownerAddress])).entries);
    const slots = fundingSlots(PROPOSAL_COVENANT_INPUTS);
    const { picked, sum, capped } = pickFrom(ents, PROPOSAL_COST, slots);
    if (sum < PROPOSAL_COST) {
      log(capped
        ? `your wallet holds more UTXOs than one proposal can spend: the covenant caps a spend at ${MAX_TX_INPUTS} inputs and the KoRoot UTXO takes one, so at most ${slots} of yours (${(sum / 1e8).toFixed(4)} KAS) can fund the ${(PROPOSAL_COST / 1e8).toFixed(2)} KAS bond — consolidate your wallet (send your balance to yourself in one transaction), or the KoRoot reserve will pay instead`
        : `your wallet ${ownerAddress.slice(0, 18)}… has ${(sum / 1e8).toFixed(4)} KAS — need ≥ ${(PROPOSAL_COST / 1e8).toFixed(2)} KAS to fund a proposal`, "err");
      return null;
    }
    return { ownerAddress, fundingUtxos: picked };
  } catch { return null; }
  finally { c.close(); }
}

// Build a proposal, having the proposer pay the bond/fee from their own wallet when
// node-direct (so the KoRoot is preserved). Falls back to root-funded otherwise.
// The network fee is mass-priced (probe with dummy sigs → borsh_masses); owner
// change under the dust/KIP-9 window folds into the fee. Returns rebuild(f) for
// the "required amount of N" submit retry.
async function buildProposal(inputsObj, proposerIndex, ctx, log) {
  const fund = await proposerFunding(ctx, proposerIndex, log);
  const ownerFunded = !!fund;
  // the vault template reveal: KoRoot pins it by hash and recomputes the
  // vaultSpkHash the minted proposal commits its bond-return address to
  const base0 = { ...(ownerFunded ? { ...inputsObj, ...fund } : inputsObj), vPrefix: TEMPLATES.vault.prefix, vSuffix: TEMPLATES.vault.suffix };
  const total = ownerFunded ? fund.fundingUtxos.reduce((a, u) => a + u.amount, 0) : 0;
  const sigCount = ownerFunded ? 1 + fund.fundingUtxos.length : 1;
  const probe = JSON.parse(W.create_proposal_build(JSON.stringify({ ...base0, fee: 0 }),
    ownerFunded ? JSON.stringify(Array(sigCount).fill(ZERO_SIG)) : ZERO_SIG)).borshHex;
  const foldF = (f) => {
    if (!ownerFunded) return f;
    const change = total - PROPOSAL_BOND - f;
    return change > 0 && change < CHANGE_FLOOR ? f + change : f;
  };
  // Root-funded proposals spend the KoRoot reserve, and createProposal now
  // requires the root continuation + the minted proposal to together retain
  // `reserveIn - maxProposalFee` — so this path is capped like every other
  // covenant-funded op. Fail loudly here rather than build a tx the covenant
  // rejects; the owner-funded path above leaves both outputs whole and has no
  // ceiling at all.
  const propCap = ownerFunded ? 0 : MAX_COVENANT_FEE;
  const fee = foldF(priceBorsh(probe, propCap));
  const build = (f) => {
    const inputs = JSON.stringify({ ...base0, fee: f });
    if (ownerFunded) {
      const shs = JSON.parse(W.create_proposal_sighashes(inputs));
      return JSON.parse(W.create_proposal_build(inputs, JSON.stringify(shs.map((sh) => sign(sh)))));
    }
    return JSON.parse(W.create_proposal_build(inputs, sign(W.create_proposal_sighash(inputs))));
  };
  const rebuild = (f) => {
    if (propCap && f > propCap) {
      throw new Error(`network fee ${(f / 1e8).toFixed(4)} KAS exceeds this covenant's ${(propCap / 1e8).toFixed(2)} KAS fee cap — fund your wallet with ≥ ${(f / 1e8).toFixed(2)} KAS so the proposal can be paid from it instead (that path has no cap)`);
    }
    const f2 = foldF(f);
    return { fee: f2, out: build(f2) };
  };
  log(ownerFunded
    ? `you're funding this proposal from your wallet (KoRoot untouched) — ${(PROPOSAL_BOND / 1e8).toFixed(1)} KAS bond + ${(fee / 1e8).toFixed(4)} KAS fee`
    : `root-funded proposal — ${(PROPOSAL_BOND / 1e8).toFixed(1)} KAS bond + ${(fee / 1e8).toFixed(4)} KAS fee from the KoRoot reserve`);
  return { out: build(fee), ownerFunded, fee, rebuild };
}

// Propose a TRANSFER, built + signed in the browser.
export async function proposeClientSide(base, treasuryId, { amountSompi, recipient, proposerIndex, expirySecs = DEFAULT_EXPIRY_SECS }, log = () => {}) {
  await loadWasm();
  const ctx = await getCtx(base, treasuryId);
  if (!ctx.root?.outpoint) throw new Error("no KoRoot UTXO (unfunded / unconfirmed)");
  const rinfo = JSON.parse(W.recipient_info(recipient));
  const { pPrefix, pSuffix } = tpl(ctx);
  const expiresAt = expiryDaa(await currentDaaScore(), expirySecs); // bounded, real — never the old 11-year constant
  log(`building proposal in your browser (wasm)… expires in ${(expirySecs / 86400).toFixed(expirySecs < 86400 ? 2 : 0)} day(s) (DAA ${expiresAt})`);
  const { out, ownerFunded, fee, rebuild } = await buildProposal({
    rootScript: ctx.root.redeemHex, rootTxid: ctx.root.outpoint.txid, rootIndex: ctx.root.outpoint.index, rootAmount: ctx.root.value,
    treasuryId: ctx.treasuryId, pPrefix, pSuffix, rStart: ctx.rootStateLayout.start,
    operation: 1, recipientSpkHash: rinfo.spkHash, amount: amountSompi, maxFee: 10_000_000, expiresAt, executionDelay: 0,
    proposerIndex, payloadHex: proposalPayload(1, amountSompi, recipient), // self-describing → co-owners discover it
  }, proposerIndex, ctx, log);
  const meta = (f, o) => ({
    proposalId: o.proposalId, operation: 1, amount: amountSompi, recipientAddress: recipient, recipientSpkHex: rinfo.spkHex,
    proposalRedeemHex: o.proposalRedeemHex, rootContHex: o.rootContHex, approvalBitmap: o.approvalBitmap, status: o.status, proposerIndex, ownerFunded, fee: f,
  });
  const gd = (r) => guardFor(ctx, treasurySpend(r, ctx.root.value));
  return submitAndTrack(base, treasuryId, out.borshHex, "propose", meta(fee, out), log,
    (f) => { const r = rebuild(f); return { borshHex: r.out.borshHex, meta: meta(r.fee, r.out), guard: gd(r) }; },
    null, gd({ fee, ownerFunded }));
}

const NUMS = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";

// Enrich chain-discovered proposals with the executable data carried in their
// self-describing payload, VERIFIED against the on-chain commitment so a forged
// payload is ignored: transfers get recipientSpkHex (blake2b(spk) must equal the
// committed recipientSpkHash); signer changes get the full config (threshold +
// owners — config_commit must equal the committed hash), making them displayable
// AND applicable by any co-owner. Legacy label-only config payloads stay
// view/approve-only.
function enrichDiscovered(proposals) {
  for (const p of proposals || []) {
    if (!p.recipientAddress) continue;
    if (p.operation === 2) {
      if (p.config) continue;
      try {
        const cfg = JSON.parse(p.recipientAddress);
        const clean = (cfg.o || []).map((a) => String(a).trim()).filter(Boolean);
        const pubkeys = clean.map((a) => W.address_pubkey(a));
        if (!pubkeys.length) continue;
        const owners5 = [...pubkeys, ...Array(5 - pubkeys.length).fill(NUMS)];
        const commit = W.config_commit(BigInt(cfg.t), BigInt(pubkeys.length), JSON.stringify(owners5));
        if (commit !== p.recipientSpkHash) continue; // payload doesn't match the committed config
        p.config = { newThreshold: cfg.t, newOwnerCount: pubkeys.length, newOwners: owners5 };
        p.configThreshold = cfg.t;
        p.configOwners = [
          ...clean.map((a, i) => ({ address: a, xonly_pubkey: pubkeys[i] })),
          ...Array(5 - pubkeys.length).fill(0).map(() => ({ xonly_pubkey: NUMS, padding: true })),
        ];
        p.recipientAddress = `CONFIG → ${cfg.t}-of-${pubkeys.length}`;
      } catch { /* legacy "CONFIG N-of-M" label — view/approve only */ }
    } else if (!p.recipientSpkHex) {
      // The displayed recipient comes from the create-tx payload (an untrusted REST
      // inscription); the committed recipientSpkHash is node-anchored (it lives in
      // the proposal redeem the live UTXO proves). Trust the shown address ONLY when
      // it hashes to that commitment. A mismatch means a hostile proposer/indexer is
      // showing an address the owner never actually authorises — the execute pays the
      // committed hash, not what is on screen — so flag it loudly instead of leaving
      // the misleading label to be approved. (Absent recipientSpkHex + set mismatch
      // = the gate the UI uses to refuse approval.)
      try {
        const ri = JSON.parse(W.recipient_info(p.recipientAddress));
        if (ri.spkHash === p.recipientSpkHash) p.recipientSpkHex = ri.spkHex;
        else p.recipientMismatch = true;
      } catch { p.recipientMismatch = true; }
    }
  }
}

// Propose a CONFIG change (new owner addresses + threshold), built + signed in the
// browser. Owner addresses are resolved to pubkeys via the wasm helper.
export async function configProposeClientSide(base, treasuryId, { addresses, threshold, proposerIndex, expirySecs = DEFAULT_EXPIRY_SECS }, log = () => {}) {
  await loadWasm();
  const ctx = await getCtx(base, treasuryId);
  if (!ctx.root?.outpoint) throw new Error("no KoRoot UTXO");
  const clean = (addresses || []).map((a) => a.trim()).filter(Boolean);
  const pubkeys = clean.map((a) => W.address_pubkey(a));
  const realCount = pubkeys.length;
  // Refuse a config KoRoot.executeConfig would refuse at execute time. Without this the
  // proposal builds and co-owners can approve it, but executeConfig enforces the same
  // 1..5 / distinctness bounds and always rejects — stranding the 0.5 KAS bond until the
  // proposal expires and is retired. createTreasuryClientSide already validates the genesis
  // owner set this way; the two entry points must agree.
  if (new Set(pubkeys).size !== realCount) throw new Error("Signers must be distinct addresses.");
  if (realCount < 1 || realCount > 5) throw new Error("A treasury has between 1 and 5 signers.");
  if (threshold < 1 || threshold > realCount) throw new Error("Threshold must be between 1 and the signer count.");
  const owners5 = [...pubkeys, ...Array(5 - realCount).fill(NUMS)];
  const configOwners = [
    ...clean.map((a, i) => ({ address: a, xonly_pubkey: pubkeys[i] })),
    ...Array(5 - realCount).fill(0).map(() => ({ xonly_pubkey: NUMS, padding: true })),
  ];
  const commit = W.config_commit(BigInt(threshold), BigInt(realCount), JSON.stringify(owners5));
  const { pPrefix, pSuffix } = tpl(ctx);
  const expiresAt = expiryDaa(await currentDaaScore(), expirySecs);
  log("building signer-change proposal (wasm)…");
  const { out, ownerFunded, fee, rebuild } = await buildProposal({
    rootScript: ctx.root.redeemHex, rootTxid: ctx.root.outpoint.txid, rootIndex: ctx.root.outpoint.index, rootAmount: ctx.root.value,
    treasuryId: ctx.treasuryId, pPrefix, pSuffix, rStart: ctx.rootStateLayout.start,
    operation: 2, recipientSpkHash: commit, amount: 1, maxFee: 10_000_000, expiresAt, executionDelay: 0, proposerIndex,
    // self-describing payload carries the FULL config (threshold + owner addresses)
    // so any co-owner can display AND apply it — verified against the on-chain
    // commit hash on discovery, so it can't be forged
    payloadHex: proposalPayload(2, 1, JSON.stringify({ t: threshold, o: clean })),
  }, proposerIndex, ctx, log);
  const meta = (f, o) => ({
    proposalId: o.proposalId, operation: 2, amount: 1, recipientAddress: `CONFIG → ${threshold}-of-${realCount}`,
    proposalRedeemHex: o.proposalRedeemHex, rootContHex: o.rootContHex, approvalBitmap: o.approvalBitmap, status: o.status, proposerIndex, ownerFunded, fee: f,
    config: { newThreshold: threshold, newOwnerCount: realCount, newOwners: owners5 }, configOwners, configThreshold: threshold,
  });
  const gd = (r) => guardFor(ctx, treasurySpend(r, ctx.root.value));
  return submitAndTrack(base, treasuryId, out.borshHex, "propose", meta(fee, out), log,
    (f) => { const r = rebuild(f); return { borshHex: r.out.borshHex, meta: meta(r.fee, r.out), guard: gd(r) }; },
    null, gd({ fee, ownerFunded }));
}

// Approve any proposal, built + signed in the browser. Fee: mass-priced, paid
// from the proposal bond (covenant caps leakage at the committed maxFee).
export async function approveClientSide(base, treasuryId, { proposalId, ownerIndex }, log = () => {}) {
  await loadWasm();
  const ctx = await getCtx(base, treasuryId);
  const p = findProp(ctx, proposalId);
  const inputs0 = {
    proposalRedeem: p.proposalRedeemHex, propTxid: p.proposalOutpoint.txid, propIndex: p.proposalOutpoint.index, propAmount: p.proposalValue,
    treasuryId: ctx.treasuryId, pStart: ctx.proposalStateLayout.start, ownerIndex,
  };
  const { fee, mk, fallback } = await feeSizedOp(W.approve_build, W.approve_sighash, W.approve_sighashes, inputs0, stateMaxFee(p.proposalRedeemHex, ctx.proposalStateLayout.start), COVENANT_INPUTS.approve, log);
  log("building approval (wasm)…");
  const meta = (r) => ({
    proposalId, ownerIndex, fee: r.fee, ownerFunded: r.ownerFunded,
    newRedeemHex: r.out.newRedeemHex, approvalBitmap: r.out.approvalBitmap, approvalCount: r.out.approvalCount, status: r.out.status,
  });
  const r0 = mk(fee);
  const gd = (r) => guardFor(ctx, treasurySpend(r, p.proposalValue));
  return submitAndTrack(base, treasuryId, r0.out.borshHex, "approve", meta(r0), log,
    (f) => { const r = mk(f); return { borshHex: r.out.borshHex, meta: meta(r), guard: gd(r) }; },
    fallback && (() => { const cf = fallback(); const r = cf.mk(cf.fee); return { borshHex: r.out.borshHex, meta: meta(r), guard: gd(r) }; }),
    gd(r0));
}

// Reject any pending proposal, built + signed in the browser. Enough rejections
// (ownerCount - rejectCount < threshold) Fail the proposal (status 2).
export async function rejectClientSide(base, treasuryId, { proposalId, ownerIndex }, log = () => {}) {
  await loadWasm();
  const ctx = await getCtx(base, treasuryId);
  const p = findProp(ctx, proposalId);
  const inputs0 = {
    proposalRedeem: p.proposalRedeemHex, propTxid: p.proposalOutpoint.txid, propIndex: p.proposalOutpoint.index, propAmount: p.proposalValue,
    treasuryId: ctx.treasuryId, pStart: ctx.proposalStateLayout.start, ownerIndex,
  };
  const { fee, mk, fallback } = await feeSizedOp(W.reject_build, W.reject_sighash, W.reject_sighashes, inputs0, stateMaxFee(p.proposalRedeemHex, ctx.proposalStateLayout.start), COVENANT_INPUTS.reject, log);
  log("building rejection (wasm)…");
  const meta = (r) => ({
    proposalId, ownerIndex, fee: r.fee, ownerFunded: r.ownerFunded,
    newRedeemHex: r.out.newRedeemHex, rejectBitmap: r.out.rejectBitmap, rejectCount: r.out.rejectCount, status: r.out.status,
  });
  const r0 = mk(fee);
  const gd = (r) => guardFor(ctx, treasurySpend(r, p.proposalValue));
  return submitAndTrack(base, treasuryId, r0.out.borshHex, "reject", meta(r0), log,
    (f) => { const r = mk(f); return { borshHex: r.out.borshHex, meta: meta(r), guard: gd(r) }; },
    fallback && (() => { const cf = fallback(); const r = cf.mk(cf.fee); return { borshHex: r.out.borshHex, meta: meta(r), guard: gd(r) }; }),
    gd(r0));
}

// Execute an approved proposal — routes to a transfer or a config change.
export async function executeClientSide(base, treasuryId, { proposalId, ownerIndex, recipientAddress }, log = () => {}) {
  await loadWasm();
  const ctx = await getCtx(base, treasuryId);
  const p = findProp(ctx, proposalId);
  // The covenant cannot forbid a post-expiry execute (tx.time is a lower bound —
  // RISKS #3), but the client can decline to enter the race it creates:
  // closeExpired is permissionless and pays the bond to whoever runs it, so
  // executing an EXPIRED proposal races bond snipers with the treasury's transfer
  // as the stake. Expired means retire or re-propose, not execute.
  {
    const committedExpiry = stateInt(p.proposalRedeemHex, ctx.proposalStateLayout.start, OFF_EXPIRES_AT) ?? p.expiresAtDaa;
    const w = executeWindow(committedExpiry, await currentDaaScore());
    if (w.state === "expired") {
      throw new Error(`this proposal expired at DAA ${w.expiresAt} (chain is at ${w.daaScore}) — executing now races anyone retiring it for the bond. Retire it and propose again.`);
    }
    if (w.state === "closing") log(`⚠ this proposal expires in ${w.eta} — after that, anyone can retire it for its bond`, "err");
  }
  if (p.operation === 2) {
    const cfg = p.config || {};
    const inputs0 = {
      rootScript: ctx.root.redeemHex, rootTxid: ctx.root.outpoint.txid, rootIndex: ctx.root.outpoint.index, rootAmount: ctx.root.value,
      proposalRedeem: p.proposalRedeemHex, propTxid: p.proposalOutpoint.txid, propIndex: p.proposalOutpoint.index, propAmount: p.proposalValue,
      treasuryId: ctx.treasuryId, rStart: ctx.rootStateLayout.start,
      newThreshold: cfg.newThreshold, newOwnerCount: cfg.newOwnerCount, newOwners: cfg.newOwners, executorIndex: ownerIndex,
    };
    const { fee, mk, fallback } = await feeSizedOp(W.execute_config_build, W.execute_config_sighash, W.execute_config_sighashes, inputs0, MAX_COVENANT_FEE, COVENANT_INPUTS.executeConfig, log);
    log("applying signer change (wasm)…");
    const meta = (r) => ({ proposalId, fee: r.fee, ownerFunded: r.ownerFunded, newRootHex: r.out.newRootHex, configOwners: p.configOwners, configThreshold: p.configThreshold });
    const r0 = mk(fee);
    const gd = (r) => guardFor(ctx, treasurySpend(r, ctx.root.value + p.proposalValue));
    return submitAndTrack(base, treasuryId, r0.out.borshHex, "config-execute", meta(r0), log,
      (f) => { const r = mk(f); return { borshHex: r.out.borshHex, meta: meta(r), guard: gd(r) }; },
      fallback && (() => { const cf = fallback(); const r = cf.mk(cf.fee); return { borshHex: r.out.borshHex, meta: meta(r), guard: gd(r) }; }),
      gd(r0));
  }
  // recipientSpkHex preimage: from the proposal (proposer/payload), or — for a
  // proposal discovered from chain without a published recipient — supplied now and
  // verified against the committed one-way hash.
  let recipientSpkHex = p.recipientSpkHex;
  if (!recipientSpkHex) {
    if (!recipientAddress) throw new Error("This proposal's recipient wasn't published on-chain (created before recipient publishing). Enter the recipient address to execute, or have the proposer execute it.");
    // verify against the hash the COVENANT commits to (read out of the anchored
    // redeem script), not the local record's copy: a record with the field
    // stripped must not turn "verified against the commitment" into "taken at
    // your word". Consensus would reject a wrong preimage anyway — this refuses
    // before signing, with a reason a person can act on.
    const committed = stateBytes32(p.proposalRedeemHex, ctx.proposalStateLayout.start, OFF_RECIPIENT_HASH) ?? p.recipientSpkHash ?? null;
    if (!committed) throw new Error("this proposal's committed recipient hash can't be read from its script — refusing to sign a payout against an unverifiable recipient");
    const ri = JSON.parse(W.recipient_info(recipientAddress));
    if (String(ri.spkHash).toLowerCase() !== String(committed).toLowerCase()) throw new Error("That address doesn't match this proposal's committed recipient.");
    recipientSpkHex = ri.spkHex;
  }
  const inputs0 = {
    treasuryId: ctx.treasuryId, vaultRedeem: ctx.vaultRedeem, vaultTxid: ctx.vault.outpoint.txid, vaultIndex: ctx.vault.outpoint.index, vaultAmount: ctx.vault.value,
    proposalRedeem: p.proposalRedeemHex, propTxid: p.proposalOutpoint.txid, propIndex: p.proposalOutpoint.index, propAmount: p.proposalValue,
    recipientSpkHex, amount: p.amount, executorIndex: ownerIndex,
  };
  const { fee, mk, fallback } = await feeSizedOp(W.execute_build, W.execute_sighash, W.execute_sighashes, inputs0, stateMaxFee(p.proposalRedeemHex, ctx.proposalStateLayout.start), COVENANT_INPUTS.execute, log);
  log("building execution (wasm)…");
  const r0 = mk(fee);
  const exMeta = (r) => ({ proposalId, fee: r.fee, ownerFunded: r.ownerFunded });
  // vaultSpk is supplied here and nowhere else: this is the only operation that
  // spends the vault, so it is the only one where "the treasury's money came
  // back" has an address it must have come back TO.
  const gd = (r) => guardFor(ctx, {
    recipientSpkHex, amount: p.amount, vaultSpk: p2shSpkOf(ctx.vaultRedeem),
    ...treasurySpend(r, ctx.vault.value + p.proposalValue),
  });
  return submitAndTrack(base, treasuryId, r0.out.borshHex, "execute", exMeta(r0), log,
    (f) => { const r = mk(f); return { borshHex: r.out.borshHex, meta: exMeta(r), guard: gd(r) }; },
    fallback && (() => { const cf = fallback(); const r = cf.mk(cf.fee); return { borshHex: r.out.borshHex, meta: exMeta(r), guard: gd(r) }; }),
    gd(r0));
}

// ---- Retiring an expired proposal ---------------------------------------------
// A proposal's 0.5 KAS bond sits in the proposal UTXO until the proposal is
// executed or retired, and a proposal the owners stop voting on is retired by
// KoProposal.closeExpired — the one entrypoint that takes no owner index and
// checks no signature, so ANYONE may call it once the chain's DAA score passes
// the expiry the proposal committed to. Nothing else can spend such a proposal,
// so without this the bond is locked for good.

// The chain's current DAA score — the clock the committed expiry is measured in.
// null without a node in ⚙ (the REST indexer doesn't publish it), in which case
// the retirement is still buildable: the expiry alone decides whether the node
// relays it.
export const currentDaaScore = async () => {
  const url = getRpcUrl();
  if (!url) return null;
  const c = connectWrpc(url);
  try { await c.ready; return Number((await c.call("getBlockDagInfo", {})).virtualDaaScore); }
  finally { c.close(); }
};

// A retirement ENDS a proposal rather than continuing it, so it is recorded here
// rather than in applyUpdate (which tracks the ops that write a new proposal
// UTXO). Shaped exactly as the chain scan reads the same spend back — status 2,
// closedReason "expired" — so the local view and the next rescan agree instead of
// overwriting each other.
const retireLocally = (treasuryId, proposalId, txid) => {
  const st = loadState(treasuryId);
  if (!st) return null;
  const at = Date.now();
  const next = { ...st, proposals: (st.proposals || []).map((p) => (String(p.proposalId) === String(proposalId)
    ? { ...p, status: 2, closedReason: "expired", executedTxid: txid, executedAt: at, events: [...(p.events || []), { type: "closed", owner: null, at }] }
    : p)) };
  saveState(treasuryId, next);
  return next;
};

/**
 * Retire an expired proposal. The bond returns — WHOLE — to the treasury's own
 * vault address (KoProposal.closeExpired requires it: output 0 must pay the
 * vaultSpkHash the proposal committed at mint, at least the full bond, as an
 * unbound stray the next sweep folds in — RISKS #17). Closing therefore pays
 * the closer nothing, and the network fee comes from the closer's own wallet:
 * an imported key is needed to sign the fee inputs, not to authorize the close
 * (the entrypoint itself stays permissionless).
 */
export async function closeExpiredClientSide(base, treasuryId, { proposalId } = {}, log = () => {}) {
  await loadWasm();
  const ctx = await getCtx(base, treasuryId);
  const p = findProp(ctx, proposalId);
  if (p.executedTxid) throw new Error("this proposal is already closed on chain");
  if (!ctx.vaultRedeem) throw new Error("this treasury's vault script is not in the local state — rescan from chain first");
  // The lock time IS the committed expiry: the contract requires tx.time >= expiresAt
  // while the node relays only a transaction whose lock time the DAA score has already
  // passed, so the expiry is the one value that satisfies both the moment the proposal
  // becomes retirable. The score is read for the same reason it is read nowhere else —
  // a too-early attempt otherwise comes back from the node as an opaque "not finalized".
  const expiresAt = stateInt(p.proposalRedeemHex, ctx.proposalStateLayout.start, OFF_EXPIRES_AT) ?? p.expiresAtDaa ?? null;
  if (expiresAt === null) throw new Error("this proposal's committed expiry can't be read from its script — nothing safe to lock the retirement to");
  const daa = await currentDaaScore();
  if (daa === null) log("no node in ⚙ to read the chain's DAA score — the node you relay through decides whether this proposal has expired");
  if (daa !== null && daa <= expiresAt) {
    const secs = (expiresAt - daa) / 10; // the network runs at 10 blocks a second, so the score advances ~10 a second
    throw new Error(`this proposal isn't expired yet — it expires at DAA score ${expiresAt}, the chain is at ${daa} (~${secs < 90 ? `${Math.ceil(secs)} seconds` : `${Math.ceil(secs / 60)} minutes`} away)`);
  }
  const inputs0 = {
    proposalRedeem: p.proposalRedeemHex, propTxid: p.proposalOutpoint.txid, propIndex: p.proposalOutpoint.index,
    propAmount: p.proposalValue, vaultRedeem: ctx.vaultRedeem,
    lockTime: Math.max(expiresAt, 1), // zero reads as "finalized" and the engine refuses the expiry check
  };
  // The bond may no longer pay the fee (it returns to the vault in full), so the
  // closer's wallet does — sized at true mass like every owner-funded op. One
  // covenant input (the proposal) counts against the 16-input window.
  const { addr, fents } = await ownerFundingUtxos(log);
  if (!addr || !fents.length) throw new Error("retiring needs a funded wallet: the bond returns to the vault in full, so the network fee comes from your wallet — import a key with some KAS on it");
  const build0 = (picked, fee) => JSON.parse(W.close_expired_build(
    JSON.stringify({ ...inputs0, ownerAddress: addr, fundingUtxos: picked, fee }),
    JSON.stringify(picked.map(() => ZERO_SIG))));
  const massOf = (picked) => feeMassOf(JSON.parse(W.borsh_masses(build0(picked, 0).borshHex)));
  const size = (minFee = 0) => sizeOpFee(massOf, fents, 1, minFee);
  const mk = (f) => {
    const r = size(f);
    if (r.short || r.capped) throw new Error(`your wallet ${addr.slice(0, 18)}… needs ≥ ${(r.fee / 1e8).toFixed(4)} KAS free to pay the retirement fee (the bond itself returns to the vault)`);
    const fee = r.sum - r.fee < CHANGE_FLOOR ? r.sum : r.fee; // fold unspendable change
    const inp = JSON.stringify({ ...inputs0, ownerAddress: addr, fundingUtxos: r.picked, fee });
    const shs = JSON.parse(W.close_expired_sighashes(inp));
    return { fee, ownerFunded: true, out: JSON.parse(W.close_expired_build(inp, JSON.stringify(shs.map((sh) => sign(sh))))) };
  };
  log("building the retirement in your browser (wasm) — your wallet signs only the fee inputs…");
  const meta = (r) => ({ proposalId, fee: r.fee, outValue: r.out.outValue, bondToVault: true });
  const r0 = mk(0);
  log(`retiring proposal ${proposalId}: the full ${(p.proposalValue / 1e8).toFixed(2)} KAS bond returns to the vault ${ctx.vaultAddress ? ctx.vaultAddress.slice(0, 20) + "…" : ""} (fee ${(r0.fee / 1e8).toFixed(4)} KAS from your wallet)`);
  // The guard reads the finished bytes: the one declared payment is the vault's
  // own P2SH at exactly the bond value, change comes home, and the treasury
  // loses zero (treasuryFee 0 — the closer pays).
  const gd = (r) => guardFor(ctx, { recipientSpkHex: p2shSpkOf(ctx.vaultRedeem), amount: p.proposalValue, ...treasurySpend(r, p.proposalValue) });
  const res = await submitAndTrack(base, treasuryId, r0.out.borshHex, "close-expired", meta(r0), log,
    (f) => { const r = mk(f); return { borshHex: r.out.borshHex, meta: meta(r), guard: gd(r) }; },
    null, gd(r0));
  if (res?.ok && res.direct && res.txid) {
    const next = retireLocally(treasuryId, proposalId, res.txid);
    if (next) res.status = statusFromState(next, res.status?.vault?.balanceSompi ?? null, res.status?.vault?.unsweptSompi ?? 0, res.status?.vault?.strays ?? []);
  }
  return res;
}
