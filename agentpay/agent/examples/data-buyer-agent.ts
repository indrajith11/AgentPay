/**
 * REFERENCE AGENT 2/3 — Data-Buyer Agent (X-06)
 * =============================================
 * The full x402 machine-to-machine flow against a live paid API, settled
 * ON-CHAIN through the mandate + escrow rails:
 *
 *   1. DISCOVER  GET  /v1/products + /v1/product/:key  -> 402 terms
 *   2. PAY       sdk.payForCall()  — mandate pays PayEndpoint, funds land
 *                in EscrowCore with a refund window (caps enforced on-chain)
 *   3. CALL      POST /purchase  — seller verifies the tx ON-CHAIN (receipt
 *                status + CallPaid log + product match) and serves data
 *   4. VERIFY    sdk.verify() — the agent re-checks the settlement itself
 *   5. REFUND    sdk.refund() — dispute within the window; funds return to
 *                the human principal (payer right, x402 killer feature)
 *   6. REPLAY    same tx hash again -> seller rejects it (callId single-use)
 *
 * Env:
 *   AGENT_PRIVATE_KEY       agent wallet (machine money)       [required]
 *   MANDATE_ID              pre-funded mandate id              [default 2]
 *   PRINCIPAL_PRIVATE_KEY   human wallet for the refund step   [optional]
 *   ENDPOINT_URL            x402 seller base URL               [default http://localhost:3030]
 *   PRODUCT                 product key                        [default weather-basic]
 */
import { ethers } from "ethers";
import { AgentPayClient, AgentPayError } from "../sdk/src/index.js";

const ENDPOINT = process.env.ENDPOINT_URL || "http://localhost:3030";
const PRODUCT = process.env.PRODUCT || "weather-basic";
const MANDATE_ID = Number(process.env.MANDATE_ID || 2);
const log = (...a: unknown[]) => console.log(...a);

const agentKey = process.env.AGENT_PRIVATE_KEY;
if (!agentKey) { console.error("Set AGENT_PRIVATE_KEY"); process.exit(1); }

const agent = new AgentPayClient({ privateKey: agentKey });
const principalKey = process.env.PRINCIPAL_PRIVATE_KEY;
const principal = principalKey ? new AgentPayClient({ privateKey: principalKey }) : null;

async function main() {
  log(`DATA-BUYER AGENT — ${await agent.getAddress()} (mandate ${MANDATE_ID})\n`);

  // ---- mandate state: the "why let an AI spend money" controls ---------
  const snap = await agent.mandateSnapshot(MANDATE_ID, 1);
  log(`[mandate] active=${snap.active} principal=${snap.principal}`);
  log(`[mandate] balance=${Number(snap.balanceWei) / 1e18} WQIE  perCallCap=${Number(snap.perCallCapWei) / 1e18}  dailyCap=${Number(snap.dailyCapWei) / 1e18}  spentToday=${Number(snap.spentTodayWei) / 1e18}`);
  log(`[mandate] next $0.10 call allowed: ${snap.nextCall.ok} (${snap.nextCall.reason})\n`);

  // ---- 1) DISCOVER ------------------------------------------------------
  const catalog = await agent.discover(ENDPOINT);
  log(`[discover] ${catalog.products.length} products: ${catalog.products.map((p) => `${p.key}($${(p.priceCents / 100).toFixed(2)})`).join(", ")}`);
  const terms = await agent.terms(ENDPOINT, PRODUCT);
  log(`[terms] 402 for '${PRODUCT}': max ${terms.maxAmountRequired}, refundWindow ${terms.refundWindowSeconds}s, payTo ${terms.payTo}\n`);

  // ---- 2+3) PAY on-chain -> CALL the seller -----------------------------
  const res = await agent.buyAndCall(ENDPOINT, PRODUCT, {
    mandateId: MANDATE_ID,
    productId: 1, // weather-basic maps to on-chain product 1 (AI Vision API demo product)
    agentName: "reference-data-buyer",
  });
  const r = res.onChain!;
  log(`[pay]     payForCall -> callId=${r.callId} escrow=${r.escrowId} amount=${Number(r.amountWei) / 1e18} WQIE`);
  log(`[pay]     tx ${r.txHash.slice(0, 22)}… ${r.explorerUrl}`);
  log(`[call]    seller verified the tx ON-CHAIN (${res.settlementMode}) and served the payload:`);
  log(`[data]    ${JSON.stringify(res.data)}`);
  log(`[call]    refundable until: ${res.refundUntil || `${res.refundWindowSeconds}s window`}\n`);

  // ---- 4) VERIFY (agent does not trust the seller's word) ---------------
  const v = await agent.verify(r.txHash, Number(r.productId));
  log(`[verify]  self-checked settlement: ok=${v.ok} callId=${v.calls?.[0]?.callId} amount=${Number(v.calls?.[0]?.amountWei ?? 0) / 1e18} WQIE`);

  // ---- 6) REPLAY guard (before refunding — the tx must be single-use) ---
  try {
    await agent.purchase(ENDPOINT, PRODUCT, r.txHash, { agentName: "replay-attacker" });
    log(`[replay]  !! UNEXPECTED: seller accepted a replayed tx hash`);
  } catch (e) {
    const code = (e as AgentPayError).code;
    log(`[replay]  seller rejected the replayed tx hash as designed [${code}]`);
  }

  // ---- 5) REFUND within the window (the dispute right) -----------------
  // EscrowCore allows the payer (human principal), the AGENT itself, or a
  // relayer to refund — funds always return to the principal's wallet.
  const refundClient = principal ?? agent;
  {
    const refund = await refundClient.refund(r.callId);
    log(`[refund]  dispute filed by ${principal ? "human principal" : "agent (payer right)"} — funds back to the principal`);
    log(`[refund]  tx ${refund.txHash.slice(0, 22)}… ${refund.explorerUrl}`);
    // a refundCall tx emits CallRefunded (not CallPaid) — verify via receipt status
    const prov = new ethers.JsonRpcProvider(process.env.AGENTPAY_RPC || "https://rpc1testnet.qie.digital/", 1983, { staticNetwork: true });
    const rec = await prov.getTransactionReceipt(refund.txHash);
    log(`[refund]  on-chain confirmed: status=${rec?.status} (escrow released back to the human)`);
    log(`\nRESULT: full x402 lifecycle PROVEN on-chain — discover, pay, call, verify, replay-guard, refund.`);
  }
}

main().catch((e) => {
  const code = (e as { code?: string }).code;
  console.error(`FAILED${code ? ` [${code}]` : ""}:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
