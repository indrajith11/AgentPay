/**
 * REFERENCE AGENT 4/4 — Ticket Agent (P4: real-world goods, X-06)
 * ================================================================
 * x402 agents buy DATA. AgentPay agents buy REAL THINGS — this one buys an
 * event ticket, holds it as a bearer secret, and walks it through the gate.
 *
 *   1. DISCOVER   the seller's catalog — tickets advertise kind:"ticket",
 *                 inventoryLeft (public scarcity) and the event metadata
 *   2. BUY        agent.buyTicket() — mandate caps pre-flight, on-chain
 *                 payForCall, seller verifies the CallPaid receipt, mints an
 *                 HMAC-signed ticket bound to the on-chain callId
 *   3. REDEEM     agent.redeemTicket() at the gate — single-use
 *   4. REPLAY     the same secret again -> typed TICKET_ALREADY_REDEEMED
 *                 (a screenshot at the gate cannot be reused by anyone)
 *   5. STATE      ticketStatus() shows VALID/REDEEMED/VOID for auditors
 *
 * The human principal keeps the whole time: prepaid balance, per-call cap,
 * daily cap, and a 600s refund window (refund voids unredeemed tickets).
 *
 * Env:
 *   AGENT_PRIVATE_KEY   agent wallet                        [required]
 *   MANDATE_ID          pre-funded mandate                  [default 6]
 *   SELLER_URL          x402 seller base URL                [default http://localhost:3030]
 *   PRODUCT_KEY         ticket product key                  [default event-ticket]
 */
import { ethers } from "ethers";
import { AgentPayClient, AgentPayError } from "../sdk/src/index.js";

const MANDATE_ID = Number(process.env.MANDATE_ID || 6);
const SELLER = process.env.SELLER_URL || "http://localhost:3030";
const PRODUCT_KEY = process.env.PRODUCT_KEY || "event-ticket";
const log = (...a: unknown[]) => console.log(...a);

const agentKey = process.env.AGENT_PRIVATE_KEY;
if (!agentKey) { console.error("Set AGENT_PRIVATE_KEY"); process.exit(1); }
const agent = new AgentPayClient({ privateKey: agentKey });

async function main() {
  log(`TICKET AGENT — ${await agent.getAddress()} (mandate ${MANDATE_ID})\n`);

  // 1. DISCOVER — find the ticket in the catalog
  const catalog = await agent.discover(SELLER);
  const t = catalog.products.find((p) => p.key === PRODUCT_KEY);
  if (!t || t.kind !== "ticket") throw new Error(`no ticket product '${PRODUCT_KEY}' at ${SELLER}`);
  log(`[discover] ${t.name}`);
  log(`           event: ${t.event?.name} @ ${t.event?.venue}`);
  log(`           starts: ${t.event?.startsAt}  inventoryLeft: ${t.inventoryLeft}\n`);

  // 2. BUY — one call pays on-chain and mints the bearer ticket
  const bought = await agent.buyTicket(SELLER, PRODUCT_KEY, {
    mandateId: MANDATE_ID,
    productId: t.onChainProductId,
    agentName: "ticket-agent",
  });
  log(`[buy]      PAID ${bought.paid} -> escrow ${bought.escrowRef} (${bought.settlementMode})`);
  if (bought.onChain) {
    log(`           on-chain: callId=${bought.onChain.callId} escrowId=${bought.onChain.escrowId}`);
    log(`           tx: ${bought.onChain.explorerUrl}`);
  }
  const ticket = bought.ticket;
  log(`[ticket]   ${ticket.ticketId} minted — the secret in this payload IS the ticket`);
  log(`           redeem at: ${ticket.redeemHow}\n`);

  // 3. REDEEM — walk through the gate
  const proof = await agent.redeemTicket(SELLER, ticket.ticketId, ticket.secret);
  log(`[redeem]   admission=${proof.admission} gate=${proof.gate} at ${proof.redeemedAt}`);
  log(`           bound to on-chain callId=${proof.onChainCallId} escrow=${proof.escrowRef}\n`);

  // 4. REPLAY — the same secret can never enter twice
  try {
    await agent.redeemTicket(SELLER, ticket.ticketId, ticket.secret);
    throw new Error("REPLAY SHOULD HAVE FAILED");
  } catch (e) {
    if (e instanceof AgentPayError && e.code === "TICKET_ALREADY_REDEEMED") {
      log(`[replay]   rejected as designed [TICKET_ALREADY_REDEEMED] — single-use enforced`);
      log(`[typed]    ${e.message}\n`);
    } else throw e;
  }

  // 5. STATE — auditors/venues see status without the secret
  const status = await agent.ticketStatus(SELLER, ticket.ticketId);
  log(`[status]   ${status.ticketId}: ${status.status} (redeemedAt=${status.redeemedAt})\n`);

  const snap = await agent.mandateSnapshot(MANDATE_ID);
  log(`[final]    mandate ${MANDATE_ID}: spentToday=${Number(snap.spentTodayWei) / 1e18}/${Number(snap.dailyCapWei) / 1e18} WQIE`);
  log(`[final]    every real-world purchase built the human principal's on-chain credit history`);
  log(`\nRESULT: an AI agent bought a REAL ticket, entered a REAL gate, and could not double-spend the secret.`);
}

main().catch((e) => {
  const code = (e as { code?: string }).code;
  console.error(`FAILED${code ? ` [${code}]` : ""}:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
