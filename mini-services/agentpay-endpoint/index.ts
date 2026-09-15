/**
 * AgentPay — x402-style Machine-Payable HTTP Endpoint
 * ====================================================
 * The HTTP leg of the on-chain PayEndpoint contract.
 *
 * Flow (exactly what an autonomous AI agent experiences):
 *   1. GET  /v1/product/:key          -> 402 Payment Required (+ terms)
 *   2. POST /v1/product/:key/purchase -> 200 (with X-PAYMENT header)
 *      - validates the machine payment (demo wallet signature mode, or
 *        mainnet tx-hash mode when CHAIN_MODE=live)
 *      - records the call (escrow refund-window id returned)
 *      - serves the paid payload
 *   3. POST /v1/call/:id/refund       -> refund within window (payer right)
 *
 * P4 — REAL-WORLD GOODS: products with kind:"ticket" are scarce, redeemable
 * items (event tickets). Purchase mints an HMAC-signed ticket bound to the
 * on-chain callId; the venue redeems it single-use at the gate. Refunding the
 * escrow voids unredeemed tickets and restocks inventory — a redeemed ticket
 * BLOCKS the refund leg (no eat-cake-and-have-it).
 *
 * In demo mode, "payment" is a signed intent header; in live mode it is a
 * QIE mainnet tx hash on the PayEndpoint contract (set CHAIN_MODE=live and
 * CONTRACT_ADDRESS after `hardhat run scripts/deploy.ts --network qieMainnet`).
 */
import { Hono } from "hono";
import { createServer } from "http";
import { randomBytes, createHmac, timingSafeEqual } from "crypto";

type Product = {
  key: string;
  onChainProductId?: number; // matches PayEndpoint.addProductUsd id on the active network
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  merchantId: string;
  schema: string;
  kind: "data" | "ticket";
  inventory?: number; // ticket products: finite supply
  event?: { name: string; venue: string; startsAt: string; gate: string };
};

type CallRecord = {
  id: string;
  productKey: string;
  agentName: string;
  agentWallet: string;
  amountCents: number;
  status: "SETTLED" | "REFUNDED";
  escrowRef: string;
  openedAt: number;
  deadline: number;
  payload: unknown;
  onChainCallId?: string; // live mode: PayEndpoint callId this sale is bound to
  ticketIds?: string[]; // ticket products: minted tickets for this call
};

type TicketRecord = {
  ticketId: string;
  productKey: string;
  callId: string; // this server's call record
  onChainCallId?: string;
  escrowRef: string;
  status: "VALID" | "REDEEMED" | "VOID";
  secretHash: string; // HMAC-SHA256(serverSecret, ticketId) — the redeem proof
  issuedAt: string;
  redeemedAt?: string;
  event: Product["event"];
};

const tickets = new Map<string, TicketRecord>();
let ticketSeq = 1;
// Redeem proof = HMAC(serverSecret, ticketId). The secret lives server-side;
// the buyer receives it once at purchase time. Rotates every boot unless
// TICKET_SECRET is pinned (live/demo determinism).
const TICKET_SECRET = process.env.TICKET_SECRET || randomBytes(32).toString("hex");

const REFUND_WINDOW_SECONDS = 600; // matches EscrowCore default

// In-memory store (demo mode). Live mode persists via Prisma/API + on-chain.
const calls = new Map<string, CallRecord>();
let callSeq = 1;

// P3 hardening (Master Plan ch.5.3): callId is SINGLE-USE. A tx hash that
// already settled a call is rejected on replay — the same payment can never
// buy a second payload. Tracked per tx hash (live) and per call record.
const usedTxHashes = new Set<string>();

const MEETUP = {
  name: "Agentic Commerce Meetup — Soweto",
  venue: "Soweto Theatre, Johannesburg",
  startsAt: "2026-09-25T18:00:00+02:00",
  gate: "main-gate",
};

const PRODUCTS: Record<string, Product> = {
  "weather-basic": {
    key: "weather-basic",
    onChainProductId: Number(process.env.PRODUCT_ID_WEATHER_BASIC ?? 1),
    name: "Weather Nowcast",
    description: "Current weather + 3h forecast for one city, machine-readable.",
    priceCents: 50,
    currency: "ZAR",
    merchantId: "merchant_demo_1",
    schema: "{ city: string, tempC: number, condition: string, forecast: string[] }",
    kind: "data",
  },
  "fx-rate": {
    key: "fx-rate",
    name: "FX Rate Feed",
    description: "Latest ZAR/USD/INR/EUR mid-market rates as JSON.",
    priceCents: 20,
    currency: "ZAR",
    merchantId: "merchant_demo_1",
    schema: "{ base: string, rates: Record<string, number>, at: string }",
    kind: "data",
  },
  "invoice-status": {
    key: "invoice-status",
    name: "Invoice Status Lookup",
    description: "Agents can check whether an invoice is open/paid/overdue.",
    priceCents: 10,
    currency: "ZAR",
    merchantId: "merchant_demo_1",
    schema: "{ invoiceRef: string, status: string, dueAt: string }",
    kind: "data",
  },
  // ---- P4: real-world goods (scarce + redeemable) ----
  "event-ticket": {
    key: "event-ticket",
    onChainProductId: Number(process.env.PRODUCT_ID_EVENT_TICKET ?? 2),
    name: MEETUP.name + " — General Admission",
    description: "One general-admission seat. Minted as an HMAC-signed ticket bound to the on-chain escrow; single-use redemption at the gate.",
    priceCents: 1000,
    currency: "ZAR",
    merchantId: "merchant_demo_1",
    schema: "{ ticket: { ticketId: string, secret: string, event: {...}, redeemHow: string } }",
    kind: "ticket",
    inventory: Number(process.env.EVENT_TICKET_INVENTORY ?? 50),
    event: MEETUP,
  },
  "vip-ticket": {
    key: "vip-ticket",
    onChainProductId: Number(process.env.PRODUCT_ID_VIP_TICKET ?? 3),
    name: MEETUP.name + " — VIP Backstage",
    description: "One VIP backstage pass (finite: demo sells exactly 1). Same ticket rail, scarcer inventory.",
    priceCents: 1000,
    currency: "ZAR",
    merchantId: "merchant_demo_1",
    schema: "{ ticket: { ticketId: string, secret: string, event: {...}, redeemHow: string } }",
    kind: "ticket",
    inventory: Number(process.env.VIP_TICKET_INVENTORY ?? 1),
    event: MEETUP,
  },
};

function escrowRef(): string {
  return "0x" + randomBytes(16).toString("hex");
}

function inventoryLeft(p: Product): number | null {
  return p.kind === "ticket" ? p.inventory ?? 0 : null;
}

function hmacSecret(ticketId: string): string {
  return createHmac("sha256", TICKET_SECRET).update(ticketId).digest("hex");
}

function mintTicket(p: Product, callId: string, onChainCallId: string | undefined, esc: string): TicketRecord {
  const id = `tkt_${String(ticketSeq++).padStart(5, "0")}_${randomBytes(4).toString("hex")}`;
  const t: TicketRecord = {
    ticketId: id,
    productKey: p.key,
    callId,
    onChainCallId,
    escrowRef: esc,
    status: "VALID",
    secretHash: hmacSecret(id),
    issuedAt: new Date().toISOString(),
    event: p.event,
  };
  tickets.set(id, t);
  return t;
}

function publicTicket(t: TicketRecord) {
  return { ticketId: t.ticketId, productKey: t.productKey, callId: t.callId, status: t.status, event: t.event, escrowRef: t.escrowRef, issuedAt: t.issuedAt, redeemedAt: t.redeemedAt ?? null };
}

function nowPayload(key: string): unknown {
  const at = new Date().toISOString();
  switch (key) {
    case "weather-basic":
      return {
        city: "Johannesburg",
        tempC: 22.5,
        condition: "clear",
        forecast: ["23C clear", "24C clear", "21C partly cloudy"],
        at,
      };
    case "fx-rate":
      return { base: "USD", rates: { ZAR: 17.85, INR: 84.12, EUR: 0.92 }, at };
    case "invoice-status":
      return { invoiceRef: "INV-2026-0041", status: "OVERDUE", dueAt: "2026-09-01" };
    default:
      return { error: "unknown product" };
  }
}

const app = new Hono();

// ---------- discovery ----------
app.get("/v1/products", (c) =>
  c.json({
    products: Object.values(PRODUCTS).map((p) => ({
      ...p,
      inventoryLeft: inventoryLeft(p),
      event: p.kind === "ticket" ? p.event : undefined,
    })),
  })
);

// ---------- the 402 ----------
app.get("/v1/product/:key", (c) => {
  const p = PRODUCTS[c.req.param("key")];
  if (!p) return c.json({ error: "not_found" }, 404);

  return c.json(
    {
      error: "payment_required",
      x402: {
        version: 1,
        scheme: "qie.mandate-v1",
        network: process.env.CHAIN_MODE === "live" ? "qie-mainnet-1990" : "qie-demo",
        payTo: process.env.MERCHANT_WALLET || "0xMerchantWalletDemo",
        asset: process.env.QUSDC_ADDRESS || "QUSDC",
        maxAmountRequired: `${(p.priceCents / 100).toFixed(2)} ${p.currency}`,
        refundWindowSeconds: REFUND_WINDOW_SECONDS,
        escrowContract: process.env.ESCROW_ADDRESS || null,
        payEndpointContract: process.env.PAYENDPOINT_ADDRESS || null,
        onChainProductId: p.onChainProductId ?? null,
        description: p.description,
        responseSchema: p.schema,
        kind: p.kind,
        inventoryLeft: inventoryLeft(p),
        event: p.kind === "ticket" ? p.event : undefined,
        redeem: p.kind === "ticket"
          ? "POST /v1/ticket/:ticketId/redeem with { secret } — single-use, gate-verifiable"
          : undefined,
        howToPay:
          "Send POST with header X-PAYMENT: <signed mandate intent or mainnet tx hash>",
      },
    },
    402
  );
});

const CALLPAID_TOPIC = "0x7ab7b7d94f73c16e533cbe1f2698b9283d0b664510294e157922de4a4fc03e68"; // CallPaid(uint256,uint256,address,address,uint256,uint256)
const CALLREFUNDED_TOPIC = "0xc11d8d9f670964d3294fbcbe317b595e47403596b337d3abef683652a41864c5"; // CallRefunded(uint256)

async function rpcCall(rpc: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || "rpc_error");
  return j.result;
}

/**
 * REAL on-chain payment verification (live mode):
 *  1. X-PAYMENT must be a 32-byte tx hash
 *  2. receipt exists && status === 1
 *  3. receipt contains a log from the deployed PayEndpoint with topic0 CallPaid
 *  4. productId (topic2) must match the requested product's on-chain id
 * Returns { ok, info } — info carries the verified callId/principal/amount.
 */
async function verifyPayForCallTx(
  rpc: string,
  payEndpoint: string,
  payment: string,
  expectedProductId: number
): Promise<{ ok: boolean; info: Record<string, unknown> }> {
  const info: Record<string, unknown> = { verification: "live" };
  try {
    if (!payEndpoint) return { ok: false, info: { ...info, reason: "PAY_ENDPOINT_ADDRESS not configured" } };
    if (!/^0x[a-fA-F0-9]{64}$/.test(payment || "")) return { ok: false, info: { ...info, reason: "X-PAYMENT is not a tx hash" } };

    const receipt = await rpcCall(rpc, "eth_getTransactionReceipt", [payment]);
    if (!receipt) return { ok: false, info: { ...info, reason: "receipt not found (unmined?)" } };
    if (receipt.status !== "0x1") return { ok: false, info: { ...info, reason: "tx reverted on-chain" } };
    info.blockNumber = parseInt(receipt.blockNumber, 16);

    const logs = (receipt.logs || []).filter(
      (l: any) => l.address?.toLowerCase() === payEndpoint.toLowerCase() && l.topics?.[0] === CALLPAID_TOPIC
    );
    if (logs.length === 0) return { ok: false, info: { ...info, reason: "no CallPaid log from PayEndpoint in this tx" } };

    // topics: [sig, callId, productId, agent]; data: [principal, amount, escrowId]
    const log = logs[logs.length - 1];
    const callId = BigInt(log.topics[1]).toString();
    const productId = BigInt(log.topics[2]).toString();
    const agent = "0x" + log.topics[3].slice(26);
    const [principal, amount, escrowId] = log.data.slice(2).match(/.{64}/g).map((w: string) => BigInt("0x" + w));
    if (Number(productId) !== expectedProductId) {
      return { ok: false, info: { ...info, reason: `on-chain productId ${productId} != requested ${expectedProductId}` } };
    }
    Object.assign(info, { callId, productId, agent, principal: "0x" + principal.toString(16).padStart(40, "0"), amountWei: amount.toString(), escrowId: escrowId.toString() });
    return { ok: true, info };
  } catch (e: any) {
    return { ok: false, info: { ...info, reason: e?.message?.slice(0, 120) || "verification error" } };
  }
}

// ---------- purchase ----------
app.post("/v1/product/:key/purchase", async (c) => {
  const key = c.req.param("key");
  const p = PRODUCTS[key];
  if (!p) return c.json({ error: "not_found" }, 404);

  // P4: scarcity check BEFORE touching payment — a sold-out good never
  // consumes a tx hash, so the agent can recover its escrow via refundCall.
  if (p.kind === "ticket" && (p.inventory ?? 0) <= 0) {
    return c.json(
      {
        error: "sold_out",
        reason: "inventory exhausted — your escrowed payment is refundable on-chain (refundCall) — nothing was consumed",
        inventoryLeft: 0,
      },
      409
    );
  }

  const payment = c.req.header("X-PAYMENT");
  if (!payment) {
    return c.json({ error: "payment_required", retry: "GET /v1/product/:key for terms" }, 402);
  }

  const agentName = c.req.header("X-AGENT-NAME") || "unnamed-agent";
  const agentWallet = c.req.header("X-AGENT-WALLET") || "0xAgentWalletDemo";

  // Demo mode: accept the signed intent. Live mode: verify the real tx hash
  // against the QIE RPC: receipt must exist, status === 1, and carry a
  // CallPaid(uint256,uint256,address,address,uint256,uint256) log emitted by
  // the deployed PayEndpoint for THIS product.
  let verified = true;
  let mode = "demo";
  let onchain: Record<string, unknown> | null = null;
  if (process.env.CHAIN_MODE === "live") {
    mode = "live";
    if (usedTxHashes.has(payment.toLowerCase())) {
      return c.json({ error: "tx_already_used", reason: "callId is single-use — replaying a settled tx buys nothing" }, 402);
    }
    const rpc = process.env.QIE_RPC_URL || "https://rpc1testnet.qie.digital/";
    const payEndpoint = process.env.PAY_ENDPOINT_ADDRESS || "";
    const result = await verifyPayForCallTx(rpc, payEndpoint, payment, p.onChainProductId ?? 1);
    verified = result.ok;
    onchain = result.info;
    if (verified) usedTxHashes.add(payment.toLowerCase());
  }

  if (!verified) return c.json({ error: "invalid_payment", onchain }, 402);

  const id = `call_${String(callSeq++).padStart(6, "0")}`;
  const onChainCallId = typeof onchain?.callId === "string" ? onchain.callId : undefined;
  const rec: CallRecord = {
    id,
    productKey: key,
    agentName,
    agentWallet: typeof onchain?.agent === "string" ? onchain.agent : agentWallet,
    amountCents: p.priceCents,
    status: "SETTLED",
    escrowRef: typeof onchain?.escrowId === "string" ? `escrow#${onchain.escrowId}` : escrowRef(),
    openedAt: Date.now(),
    deadline: Date.now() + REFUND_WINDOW_SECONDS * 1000,
    payload: nowPayload(key),
    onChainCallId,
  };
  calls.set(id, rec);

  // P4: mint the redeemable good for ticket products — the payload the agent
  // receives IS the ticket (id + one-time secret), bound to the on-chain call.
  if (p.kind === "ticket") {
    p.inventory = (p.inventory ?? 0) - 1;
    const t = mintTicket(p, id, onChainCallId, rec.escrowRef);
    rec.ticketIds = [t.ticketId];
    rec.payload = {
      ticket: {
        ticketId: t.ticketId,
        secret: t.secretHash, // the buyer's one-time redeem proof
        event: t.event,
        escrowRef: rec.escrowRef,
        redeemHow: `POST /v1/ticket/${t.ticketId}/redeem with {"secret":"<secret>"}`,
        note: "single-use — the gate rejects replays; refunding the escrow voids this ticket",
      },
    };
  }

  // notify the dashboard (optional webhook)
  if (process.env.DASHBOARD_WEBHOOK) {
    fetch(process.env.DASHBOARD_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "MACHINE_SALE", call: rec }),
    }).catch(() => {});
  }

  return c.json({
    ok: true,
    callId: id,
    escrowRef: rec.escrowRef,
    refundWindowSeconds: REFUND_WINDOW_SECONDS,
    refundUntil: new Date(rec.deadline).toISOString(),
    settlementMode: mode,
    paid: `${(p.priceCents / 100).toFixed(2)} ${p.currency}`,
    kind: p.kind,
    inventoryLeft: inventoryLeft(p),
    data: rec.payload,
  });
});

// ---------- P4: ticket redemption (the gate leg) ----------
app.post("/v1/ticket/:id/redeem", async (c) => {
  const t = tickets.get(c.req.param("id"));
  if (!t) return c.json({ error: "ticket_not_found" }, 404);
  const body = await c.req.json().catch(() => ({} as { secret?: string }));
  const given = (body as { secret?: string })?.secret || "";
  // constant-time compare of the presented secret against the mint HMAC
  const expected = Buffer.from(hmacSecret(t.ticketId), "hex");
  const presented = /^[0-9a-f]{64}$/.test(given) ? Buffer.from(given, "hex") : Buffer.alloc(0);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return c.json({ error: "invalid_secret", reason: "ticket secret mismatch — the holder cannot redeem" }, 403);
  }
  if (t.status === "REDEEMED") {
    return c.json(
      { error: "already_redeemed", reason: "single-use ticket — this was already scanned at the gate", redeemedAt: t.redeemedAt },
      409
    );
  }
  if (t.status === "VOID") {
    return c.json({ error: "ticket_void", reason: "the escrow payment for this ticket was refunded" }, 409);
  }
  t.status = "REDEEMED";
  t.redeemedAt = new Date().toISOString();
  return c.json({
    ok: true,
    admission: "GRANTED",
    ticketId: t.ticketId,
    event: t.event,
    gate: t.event?.gate || "main-gate",
    redeemedAt: t.redeemedAt,
    boundCall: t.callId,
    onChainCallId: t.onChainCallId ?? null,
    escrowRef: t.escrowRef,
  });
});

// ---------- P4: ticket status (venue/agent check, no secret exposed) ----------
app.get("/v1/ticket/:id", (c) => {
  const t = tickets.get(c.req.param("id"));
  if (!t) return c.json({ error: "ticket_not_found" }, 404);
  return c.json({ ticket: publicTicket(t) });
});

// ---------- refund within window (the x402 killer feature) ----------
app.post("/v1/call/:id/refund", async (c) => {
  const rec = calls.get(c.req.param("id"));
  if (!rec) return c.json({ error: "not_found" }, 404);
  if (rec.status !== "SETTLED") return c.json({ error: "already_" + rec.status.toLowerCase() }, 409);
  if (Date.now() > rec.deadline) return c.json({ error: "refund_window_closed" }, 403);

  // P4 anti-fraud: a REDEEMED ticket means the good was consumed — the
  // seller refuses the refund leg (on-chain escrow remains the arbiter, but
  // we never cooperate with redeem-then-refund).
  const redeemed = (rec.ticketIds || []).some((id) => tickets.get(id)?.status === "REDEEMED");
  if (redeemed) {
    return c.json(
      { error: "ticket_already_redeemed", reason: "goods consumed — refund denied by the seller (flagged for review)" },
      409
    );
  }

  // live mode: the REAL refund is the on-chain escrow refund — the seller
  // only records it after seeing the refundCall tx hash as proof.
  if (rec.escrowRef.startsWith("escrow#") && process.env.CHAIN_MODE === "live") {
    const body = await c.req.json().catch(() => ({} as { refundTxHash?: string }));
    const refundTx = (body as { refundTxHash?: string })?.refundTxHash || "";
    if (!/^0x[a-fA-F0-9]{64}$/.test(refundTx)) {
      return c.json({ error: "refund_tx_required", reason: "post the on-chain refundCall tx hash as { refundTxHash }" }, 400);
    }
    // P4: verify the proof on-chain — the tx must carry a CallRefunded log
    // from the PayEndpoint for THIS call (symmetric to purchase verification).
    const proof = await verifyRefundTx(
      process.env.QIE_RPC_URL || "https://rpc1testnet.qie.digital/",
      process.env.PAY_ENDPOINT_ADDRESS || "",
      refundTx,
      rec.onChainCallId
    );
    if (!proof.ok) return c.json({ error: "invalid_refund_proof", onchain: proof.info }, 402);
    rec.escrowRef += ` (refunded on-chain: ${refundTx.slice(0, 14)}…)`;
  }

  rec.status = "REFUNDED";
  // P4: refund voids the tickets and restocks inventory (goods never consumed).
  for (const tid of rec.ticketIds || []) {
    const t = tickets.get(tid);
    if (t && t.status === "VALID") {
      t.status = "VOID";
      const p = PRODUCTS[t.productKey];
      if (p?.kind === "ticket") p.inventory = (p.inventory ?? 0) + 1;
    }
  }
  return c.json({ ok: true, callId: rec.id, refunded: `${(rec.amountCents / 100).toFixed(2)} ZAR`, escrowRef: rec.escrowRef, voidedTickets: rec.ticketIds || [] });
});

/** P4: verify a refundCall tx on-chain (status 1 + CallRefunded log for callId). */
async function verifyRefundTx(
  rpc: string,
  payEndpoint: string,
  txHash: string,
  expectedCallId?: string
): Promise<{ ok: boolean; info: Record<string, unknown> }> {
  const info: Record<string, unknown> = { verification: "live" };
  try {
    if (!payEndpoint) return { ok: false, info: { ...info, reason: "PAY_ENDPOINT_ADDRESS not configured" } };
    const receipt = await rpcCall(rpc, "eth_getTransactionReceipt", [txHash]);
    if (!receipt) return { ok: false, info: { ...info, reason: "receipt not found (unmined?)" } };
    if (receipt.status !== "0x1") return { ok: false, info: { ...info, reason: "tx reverted on-chain" } };
    const logs = (receipt.logs || []).filter(
      (l: any) => l.address?.toLowerCase() === payEndpoint.toLowerCase() && l.topics?.[0] === CALLREFUNDED_TOPIC
    );
    if (logs.length === 0) return { ok: false, info: { ...info, reason: "no CallRefunded log from PayEndpoint in this tx" } };
    const callId = BigInt(logs[logs.length - 1].topics[1]).toString();
    if (expectedCallId && callId !== expectedCallId) {
      return { ok: false, info: { ...info, reason: `refunded callId ${callId} != sale callId ${expectedCallId}` } };
    }
    return { ok: true, info: { ...info, callId } };
  } catch (e: any) {
    return { ok: false, info: { ...info, reason: e?.message?.slice(0, 120) || "verification error" } };
  }
}

// ---------- merchant dashboard feed ----------
app.get("/v1/calls", (c) =>
  c.json({ calls: [...calls.values()].sort((a, b) => b.openedAt - a.openedAt).slice(0, 100) })
);

const port = Number(process.env.PORT || 3030);
createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const body = req.method === "POST" ? await readBody(req) : undefined;
    const headers = new Headers(req.headers as Record<string, string>);
    const response = await app.request(
      new Request(`http://localhost${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: body as string | undefined,
      })
    );
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "internal" }));
  }
}).listen(port, () => console.log(`AgentPay x402 endpoint on :${port}`));

function readBody(req: import("http").IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data || undefined));
  });
}
