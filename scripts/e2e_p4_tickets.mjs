/**
 * P4 E2E — Ticketing product type, LIVE on QIE testnet 1983.
 *
 * Starts the x402 endpoint in live mode, then drives the full real-world
 * goods loop with real on-chain money (mandate 6, products 2/3):
 *
 *   [A] catalog   — tickets advertise kind/inventoryLeft/event
 *   [B] buy GA t1 — on-chain payForCall -> seller verifies CallPaid -> mint
 *   [C] redeem    — gate GRANTED; replay -> TICKET_ALREADY_REDEEMED (409)
 *                   wrong secret on a valid ticket -> TICKET_INVALID_SECRET (403)
 *   [D] refund t2 — principal refundCall on-chain -> seller verifies
 *                   CallRefunded -> ticket VOID + inventory restored;
 *                   redeeming a voided ticket -> TICKET_VOID
 *   [E] buy VIP   — finite stock 1 -> 0
 *   [F] sold out  — fresh on-chain payment against empty stock -> 409
 *                   SOLD_OUT typed (tx NOT consumed) -> agent refunds escrow
 *   [G] daily cap — GA #3 blocked by canSpend pre-flight (typed DAILY_CAP,
 *                   zero gas burned)
 *   [H] feed      — /v1/calls shows the machine sales ledger
 *   [I] demo mode — dashboard path unbroken: signed-intent purchase of a data
 *                   product AND a ticket (no on-chain spend), redeem OK
 *
 * Keys: p4_roles_local.json (agent), contracts/.env (deployer/principal).
 * Proof: research/p4_e2e_proof.json
 */
import { ethers } from "ethers";
import { readFileSync, writeFileSync } from "fs";
import { AgentPayClient, AgentPayError } from "../agentpay/agent/sdk/src/index.js";

const RPC = "https://rpc1testnet.qie.digital/";
const A = {
  WQIE: "0x5e165E6c7AC4039aEDc2a5505Ae35cb20764916c",
  MandateVault: "0x2FEf89522b8B0a55161ed11a7CB19B57C6fF2169",
  PayEndpoint: "0x4ccdE1dD4d2c3F39dB9D2b350516070257dfb647",
};
const BASE = "http://localhost:3030";
const MANDATE_ID = Number(process.env.MANDATE_ID || 7);
const TICKET_SECRET = "p4-e2e-" + ethers.hexlify(ethers.randomBytes(24)).slice(2);

const agentKey = JSON.parse(readFileSync("/home/z/my-project/agentpay/contracts/addresses/p4_roles_local.json", "utf8")).agentPrivateKey;
const principalKey = readFileSync("/home/z/my-project/agentpay/contracts/.env", "utf8").match(/DEPLOYER_PRIVATE_KEY=(0x[0-9a-fA-F]+)/)[1];

const agent = new AgentPayClient({ privateKey: agentKey, rpcUrls: [RPC] });
const principal = new AgentPayClient({ privateKey: principalKey, rpcUrls: [RPC] }); // payer of record for refunds

const results = [];
const proof = { network: "qieTestnet 1983", at: new Date().toISOString(), steps: {}, txs: {}, tickets: {} };
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- endpoint lifecycle ----------
let endpointProc = null;
async function startEndpoint(mode) {
  const env = {
    ...process.env,
    PORT: "3030",
    CHAIN_MODE: mode,
    QIE_RPC_URL: RPC,
    PAY_ENDPOINT_ADDRESS: A.PayEndpoint,
    PRODUCT_ID_EVENT_TICKET: "2",
    PRODUCT_ID_VIP_TICKET: "3",
    EVENT_TICKET_INVENTORY: "50",
    VIP_TICKET_INVENTORY: "1",
    TICKET_SECRET,
  };
  const { spawn } = await import("child_process");
  endpointProc = spawn("bun", ["index.ts"], { cwd: "/home/z/my-project/mini-services/agentpay-endpoint", env, stdio: ["ignore", "pipe", "pipe"], detached: false });
  endpointProc.stdout.on("data", () => {});
  endpointProc.stderr.on("data", (d) => console.error(`[endpoint:${mode}]`, d.toString().slice(0, 200)));
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/v1/products`, { signal: AbortSignal.timeout(800) });
      if (r.ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`endpoint (${mode}) did not come up on :3030`);
}
async function stopEndpoint() {
  if (endpointProc) { endpointProc.kill("SIGKILL"); endpointProc = null; await sleep(400); }
}

// ---------- helpers ----------
async function jfetch(url, opts = {}) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}
const W = (w) => Number(w) / 1e18;

// =============================================================
async function main() {
  await startEndpoint("live");
  const provider = new ethers.JsonRpcProvider(RPC, 1983, { staticNetwork: true });
  const mv = new ethers.Contract(A.MandateVault, ["function mandates(uint256) view returns (uint256,address,address,address,uint256,uint256,uint256,uint256,uint256,bool,uint64)"], provider);

  // ---------- [A] catalog ----------
  const cat = await agent.discover(BASE);
  const ga = cat.products.find((p) => p.key === "event-ticket");
  const vip = cat.products.find((p) => p.key === "vip-ticket");
  check("A1 catalog: event-ticket kind=ticket inventory=50", ga?.kind === "ticket" && ga?.inventoryLeft === 50);
  check("A2 catalog: vip kind=ticket inventory=1", vip?.kind === "ticket" && vip?.inventoryLeft === 1);
  check("A3 catalog: event metadata present", !!ga?.event?.venue && !!ga?.event?.startsAt, `${ga?.event?.venue}`);
  const gaTerms = await agent.terms(BASE, "event-ticket");
  check("A4 terms: inventory + redeem hint + onChainProductId", gaTerms.inventoryLeft === 50 && !!gaTerms.redeem && gaTerms.onChainProductId === 2);

  const mBefore = await mv.mandates(MANDATE_ID);
  console.log(`      mandate ${MANDATE_ID} before: balance=${W(mBefore[8])} spentToday=${W(mBefore[6])}/${W(mBefore[5])}`);

  // ---------- [B] buy GA ticket 1 (real on-chain payment) ----------
  const b1 = await agent.buyTicket(BASE, "event-ticket", { mandateId: MANDATE_ID, productId: 2, agentName: "p4-ticket-agent" });
  const v1 = await agent.verify(b1.onChain.txHash, 2);
  check("B1 buy GA t1: on-chain verified CallPaid(product 2)", v1.ok === true && b1.onChain.callId > 0n, `callId=${b1.onChain.callId}`);
  check("B2 t1 payload carries bearer ticket (id + secret)", !!b1.ticket.ticketId && /^[0-9a-f]{64}$/.test(b1.ticket.secret), b1.ticket.ticketId);
  check("B3 inventory decremented 50 -> 49", b1.inventoryLeft === 49);
  proof.txs.buyGA1 = b1.onChain.txHash;
  proof.tickets.t1 = b1.ticket.ticketId;
  await sleep(2000);

  // ---------- [C] redeem t1: grant + replay + wrong-secret (on t2) ----------
  const p1 = await agent.redeemTicket(BASE, b1.ticket.ticketId, b1.ticket.secret);
  check("C1 redeem t1: GRANTED at gate", p1.admission === "GRANTED" && p1.gate === "main-gate", p1.redeemedAt);
  proof.steps.redeem1 = p1;
  let replayCaught = false;
  try { await agent.redeemTicket(BASE, b1.ticket.ticketId, b1.ticket.secret); }
  catch (e) { replayCaught = e instanceof AgentPayError && e.code === "TICKET_ALREADY_REDEEMED"; }
  check("C2 replay t1 secret: typed TICKET_ALREADY_REDEEMED", replayCaught);

  // ---------- [D] buy t2 -> refund -> VOID + restock ----------
  const b2 = await agent.buyTicket(BASE, "event-ticket", { mandateId: MANDATE_ID, productId: 2, agentName: "p4-ticket-agent" });
  proof.txs.buyGA2 = b2.onChain.txHash;
  proof.tickets.t2 = b2.ticket.ticketId;
  check("D1 buy GA t2: escrowed", b2.onChain.callId > 0n, `callId=${b2.onChain.callId}`);
  await sleep(2000);

  let wrongCaught = false;
  try { await agent.redeemTicket(BASE, b2.ticket.ticketId, "0x" + "11".repeat(32)); }
  catch (e) { wrongCaught = e instanceof AgentPayError && e.code === "TICKET_INVALID_SECRET"; }
  check("D2 wrong secret on VALID t2: typed TICKET_INVALID_SECRET", wrongCaught);

  // principal refunds the escrow on-chain (payer right), then posts proof
  const refundTx = await principal.refund(b2.onChain.callId);
  proof.txs.refundGA2 = refundTx.txHash;
  await sleep(2000);
  const rec2 = await jfetch(`${BASE}/v1/call/${b2.callId}/refund`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ refundTxHash: refundTx.txHash }),
  });
  check("D3 seller accepts on-chain refund proof, voids t2", rec2.status === 200 && (rec2.j.voidedTickets || []).includes(b2.ticket.ticketId));
  const st2 = await agent.ticketStatus(BASE, b2.ticket.ticketId);
  check("D4 t2 status -> VOID", st2.status === "VOID");
  const catD = await agent.discover(BASE);
  const gaD = catD.products.find((p) => p.key === "event-ticket");
  check("D5 inventory restored (49: t1 sold+redeemed, t2 restocked)", gaD.inventoryLeft === 49);

  let voidCaught = false;
  try { await agent.redeemTicket(BASE, b2.ticket.ticketId, b2.ticket.secret); }
  catch (e) { voidCaught = e instanceof AgentPayError && e.code === "TICKET_VOID"; }
  check("D6 redeeming a VOID ticket: typed TICKET_VOID", voidCaught);

  // refund a REDEEMED ticket must be refused (anti eat-cake-and-have-it)
  const recRefund1 = await jfetch(`${BASE}/v1/call/${b1.callId}/refund`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  check("D7 refund of REDEEMED t1 refused: ticket_already_redeemed", recRefund1.status === 409 && recRefund1.j.error === "ticket_already_redeemed");

  // ---------- [E] buy VIP (stock 1 -> 0) ----------
  const b3 = await agent.buyTicket(BASE, "vip-ticket", { mandateId: MANDATE_ID, productId: 3, agentName: "p4-ticket-agent" });
  proof.txs.buyVIP = b3.onChain.txHash;
  proof.tickets.vip = b3.ticket.ticketId;
  check("E1 buy VIP: minted, stock 0", b3.onChain.callId > 0n && b3.inventoryLeft === 0, b3.ticket.ticketId);
  await sleep(2000);

  // ---------- [F] sold-out: real payment against empty stock ----------
  // NOTE (prepaid model): refundCall returns funds to the human PRINCIPAL's
  // wallet, not back into the mandate — the mandate is a prepaid budget, so
  // the principal tops it up (deposit) before the sold-out probe.
  const mvTop = new ethers.Contract(A.MandateVault, ["function deposit(uint256,uint256) external"], principal.provider);
  const wqTop = new ethers.Contract(A.WQIE, ["function approve(address,uint256) returns (bool)"], principal.provider);
  const topTx = await (wqTop.connect(principal.signer)).approve(A.MandateVault, ethers.parseEther("0.1"), { gasLimit: 150000n });
  await topTx.wait();
  const depTx = await (mvTop.connect(principal.signer)).deposit(MANDATE_ID, ethers.parseEther("0.1"), { gasLimit: 250000n });
  await depTx.wait();
  console.log(`      principal topped up mandate ${MANDATE_ID} by 0.1 WQIE (prepaid deposit model)`);

  const soldTx = await agent.payForCall(MANDATE_ID, 3); // pays on-chain, escrowed
  proof.txs.soldOutAttempt = soldTx.txHash;
  await sleep(2000);
  let soldCaught = false;
  try { await agent.purchase(BASE, "vip-ticket", soldTx.txHash, { agentName: "p4-ticket-agent" }); }
  catch (e) { soldCaught = e instanceof AgentPayError && e.code === "SOLD_OUT"; }
  check("F1 sold-out purchase: typed SOLD_OUT (409)", soldCaught);
  const back = await principal.refund(soldTx.callId); // payer-of-record recovers escrow — lands in the human's wallet
  proof.txs.soldOutRefund = back.txHash;
  check("F2 principal recovered escrow after sold-out (refundCall mined)", !!back.txHash);
  await sleep(1500);

  // ---------- [G] daily cap pre-flight on GA #3 ----------
  let capCaught = false;
  try { await agent.buyTicket(BASE, "event-ticket", { mandateId: MANDATE_ID, productId: 2, agentName: "p4-ticket-agent" }); }
  catch (e) { capCaught = e instanceof AgentPayError && e.code === "DAILY_CAP"; }
  check("G1 GA #3 blocked by mandate pre-flight: typed DAILY_CAP, zero gas", capCaught);

  // ---------- [H] machine-sales feed ----------
  const feed = await jfetch(`${BASE}/v1/calls`);
  const feedCalls = feed.j.calls || [];
  // 3 real sales (t1 SETTLED, t2 SETTLED->REFUNDED, vip SETTLED); the sold-out
  // attempt consumed nothing so it correctly NEVER appears in the ledger.
  const sig = feedCalls.map((c) => `${c.productKey}:${c.status}`).sort().join(",");
  check("H1 feed = exactly the 3 real sales (sold-out attempt absent)",
    feedCalls.length === 3 && sig === "event-ticket:REFUNDED,event-ticket:SETTLED,vip-ticket:SETTLED", sig);
  const mAfter = await mv.mandates(MANDATE_ID);
  console.log(`      mandate ${MANDATE_ID} after: balance=${W(mAfter[8])} spentToday=${W(mAfter[6])}/${W(mAfter[5])}`);
  const grossSpent = W(mAfter[6]) - W(mBefore[6]);
  // balance: 0.3 start - 0.4 gross kept/attempted + 0.1 topup = 0.0
  check("H2 on-chain accounting: gross 0.4 spent, mandate prepaid budget drained to 0", grossSpent === 0.4 && W(mAfter[8]) === 0, `gross=${grossSpent} balance=${W(mAfter[8])}`);

  await stopEndpoint();

  // ---------- [I] demo-mode smoke (dashboard path, no chain spend) ----------
  await startEndpoint(undefined); // CHAIN_MODE unset -> demo
  const demoIntent = await agent.signDemoIntent(await agent.terms(BASE, "fx-rate"));
  const demoData = await jfetch(`${BASE}/v1/product/fx-rate/purchase`, {
    method: "POST", headers: { "content-type": "application/json", "x-payment": demoIntent, "x-agent-name": "dashboard-demo" },
  });
  check("I1 demo mode: fx-rate intent purchase still 200", demoData.status === 200 && demoData.j.ok === true);
  const demoTicketTerms = await agent.terms(BASE, "event-ticket");
  const demoIntent2 = await agent.signDemoIntent(demoTicketTerms);
  const demoTicket = await jfetch(`${BASE}/v1/product/event-ticket/purchase`, {
    method: "POST", headers: { "content-type": "application/json", "x-payment": demoIntent2, "x-agent-name": "dashboard-demo" },
  });
  const dt = demoTicket.j?.data?.ticket;
  check("I2 demo mode: ticket minted without chain spend", demoTicket.status === 200 && !!dt?.ticketId && !!dt?.secret, dt?.ticketId);
  const demoRedeem = await jfetch(`${BASE}/v1/ticket/${dt.ticketId}/redeem`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: dt.secret }),
  });
  check("I3 demo mode: redeem works (GRANTED)", demoRedeem.status === 200 && demoRedeem.j.admission === "GRANTED");
  await stopEndpoint();

  // ---------- summary ----------
  proof.summary = {
    passed: results.filter((r) => r.ok).length,
    total: results.length,
    mandate: { id: MANDATE_ID, balance: W(mAfter[8]), spentToday: W(mAfter[6]), dailyCap: W(mAfter[5]) },
  };
  writeFileSync("/home/z/my-project/research/p4_e2e_proof.json", JSON.stringify(proof, null, 2));
  console.log(`\n=== P4 E2E: ${proof.summary.passed}/${proof.summary.total} PASS ===`);
  if (process.exitCode) process.exit(1);
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch(async (e) => {
    console.error("E2E FATAL:", e);
    await stopEndpoint();
    process.exit(1);
  });
