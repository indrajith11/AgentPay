/**
 * REFERENCE AGENT 3/3 — Ticket-Buyer Agent (X-06)
 * ===============================================
 * Proves the answer to the judge question "why would anyone let an AI
 * spend money?" — the five on-chain mandate controls:
 *
 *   1. PRINCIPAL BINDING — every call attributes credit to the human
 *   2. PREPAID BALANCE   — the AI only ever spends deposited funds
 *   3. PER-CALL CAP      — one call can never exceed the cap
 *   4. DAILY CAP         — total daily spend is hard-capped on-chain
 *   5. REFUND WINDOW     — every payment is disputable for 600s
 *
 * This agent buys "tickets" (one on-chain call each) in a loop with the
 * SDK until the DAILY CAP typed error fires — then shows how agent code
 * handles it: catch AgentPayError, branch on e.code, stop buying.
 *
 * Env:
 *   AGENT_PRIVATE_KEY   agent wallet                        [required]
 *   MANDATE_ID          pre-funded mandate                  [default 3]
 *   TICKETS             how many to TRY buying              [default 8]
 */
import { ethers } from "ethers";
import { AgentPayClient, AgentPayError } from "../sdk/src/index.js";

const MANDATE_ID = Number(process.env.MANDATE_ID || 3);
const TRY_TICKETS = Number(process.env.TICKETS || 8);
const PRODUCT_ID = Number(process.env.PRODUCT_ID || 1); // $0.10 product
const log = (...a: unknown[]) => console.log(...a);

const agentKey = process.env.AGENT_PRIVATE_KEY;
if (!agentKey) { console.error("Set AGENT_PRIVATE_KEY"); process.exit(1); }
const agent = new AgentPayClient({ privateKey: agentKey });

async function main() {
  log(`TICKET-BUYER AGENT — ${await agent.getAddress()} (mandate ${MANDATE_ID})\n`);

  const q = await agent.quote(PRODUCT_ID);
  log(`[quote] ticket price: ${q.formatted} (on-chain oracle quote)\n`);

  let bought = 0;
  for (let i = 1; i <= TRY_TICKETS; i++) {
    // the SDK pre-flights caps WITHOUT burning gas — typed errors first
    const snap = await agent.mandateSnapshot(MANDATE_ID, PRODUCT_ID);
    if (!snap.nextCall.ok) {
      log(`[preflight] ticket #${i} blocked by the mandate: ${snap.nextCall.reason}`);
      log(`[typed]    AgentPayError code=${snap.nextCall.reason === "DAILY_CAP" ? "DAILY_CAP" : snap.nextCall.reason} — agent stops cleanly, nothing reverted, no gas burned\n`);
      bought = i - 1;
      break;
    }
    try {
      const r = await agent.payForCall(MANDATE_ID, PRODUCT_ID);
      log(`[buy] ticket #${i}: callId=${r.callId} paid ${Number(r.amountWei) / 1e18} WQIE -> escrow (tx ${r.txHash.slice(0, 16)}…)`);
      await new Promise((res) => setTimeout(res, 2500)); // ~1 block between buys — keeps replicas settled
    } catch (e) {
      if (e instanceof AgentPayError && (e.code === "DAILY_CAP" || e.code === "PER_CALL_CAP" || e.code === "MANDATE_BALANCE")) {
        log(`[buy]    ticket #${i} reverted on-chain as designed [${e.code}]`);
        log(`[typed]  ${e.message}\n`);
        bought = i - 1;
        break;
      }
      throw e;
    }
  }

  const snap = await agent.mandateSnapshot(MANDATE_ID, PRODUCT_ID);
  log(`[final] tickets bought: ${bought}`);
  log(`[final] mandate state: balance=${Number(snap.balanceWei) / 1e18} WQIE  spentToday=${Number(snap.spentTodayWei) / 1e18} / cap ${Number(snap.dailyCapWei) / 1e18}`);
  log(`[final] every ticket sits in escrow with a ${600}s refund window for the human principal`);
  log(`\nRESULT: caps are NOT UI promises — they are reverts the agent physically cannot bypass.`);
}

main().catch((e) => {
  const code = (e as { code?: string }).code;
  console.error(`FAILED${code ? ` [${code}]` : ""}:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
