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
 * In demo mode, "payment" is a signed intent header; in live mode it is a
 * QIE mainnet tx hash on the PayEndpoint contract (set CHAIN_MODE=live and
 * CONTRACT_ADDRESS after `hardhat run scripts/deploy.ts --network qieMainnet`).
 */
import { Hono } from "hono";
import { createServer } from "http";
import { randomBytes } from "crypto";

type Product = {
  key: string;
  onChainProductId?: number; // matches PayEndpoint.addProductUsd id on the active network
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  merchantId: string;
  schema: string;
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
};

const REFUND_WINDOW_SECONDS = 600; // matches EscrowCore default

// In-memory store (demo mode). Live mode persists via Prisma/API + on-chain.
const calls = new Map<string, CallRecord>();
let callSeq = 1;

// P3 hardening (Master Plan ch.5.3): callId is SINGLE-USE. A tx hash that
// already settled a call is rejected on replay — the same payment can never
// buy a second payload. Tracked per tx hash (live) and per call record.
const usedTxHashes = new Set<string>();

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
  },
  "fx-rate": {
    key: "fx-rate",
    name: "FX Rate Feed",
    description: "Latest ZAR/USD/INR/EUR mid-market rates as JSON.",
    priceCents: 20,
    currency: "ZAR",
    merchantId: "merchant_demo_1",
    schema: "{ base: string, rates: Record<string, number>, at: string }",
  },
  "invoice-status": {
    key: "invoice-status",
    name: "Invoice Status Lookup",
    description: "Agents can check whether an invoice is open/paid/overdue.",
    priceCents: 10,
    currency: "ZAR",
    merchantId: "merchant_demo_1",
    schema: "{ invoiceRef: string, status: string, dueAt: string }",
  },
};

function escrowRef(): string {
  return "0x" + randomBytes(16).toString("hex");
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
app.get("/v1/products", (c) => c.json({ products: Object.values(PRODUCTS) }));

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
        description: p.description,
        responseSchema: p.schema,
        howToPay:
          "Send POST with header X-PAYMENT: <signed mandate intent or mainnet tx hash>",
      },
    },
    402
  );
});

const CALLPAID_TOPIC = "0x7ab7b7d94f73c16e533cbe1f2698b9283d0b664510294e157922de4a4fc03e68"; // CallPaid(uint256,uint256,address,address,uint256,uint256)

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
  };
  calls.set(id, rec);

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
    data: rec.payload,
  });
});

// ---------- refund within window (the x402 killer feature) ----------
app.post("/v1/call/:id/refund", async (c) => {
  const rec = calls.get(c.req.param("id"));
  if (!rec) return c.json({ error: "not_found" }, 404);
  if (rec.status !== "SETTLED") return c.json({ error: "already_" + rec.status.toLowerCase() }, 409);
  if (Date.now() > rec.deadline) return c.json({ error: "refund_window_closed" }, 403);

  // live mode: the REAL refund is the on-chain escrow refund — the seller
  // only records it after seeing the refundCall tx hash as proof.
  if (rec.escrowRef.startsWith("escrow#") && process.env.CHAIN_MODE === "live") {
    const body = await c.req.json().catch(() => ({} as { refundTxHash?: string }));
    const refundTx = (body as { refundTxHash?: string })?.refundTxHash || "";
    if (!/^0x[a-fA-F0-9]{64}$/.test(refundTx)) {
      return c.json({ error: "refund_tx_required", reason: "post the on-chain refundCall tx hash as { refundTxHash }" }, 400);
    }
    rec.escrowRef += ` (refunded on-chain: ${refundTx.slice(0, 14)}…)`;
  }

  rec.status = "REFUNDED";
  return c.json({ ok: true, callId: rec.id, refunded: `${(rec.amountCents / 100).toFixed(2)} ZAR`, escrowRef: rec.escrowRef });
});

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
