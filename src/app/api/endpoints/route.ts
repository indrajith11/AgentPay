import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

const ENDPOINT_SERVICE = process.env.ENDPOINT_SERVICE_URL || "http://localhost:3030";

/** List machine-payable products (from dashboard DB) */
export async function GET(req: NextRequest) {
  const merchantId = req.nextUrl.searchParams.get("merchantId");
  const endpoints = await db.machineEndpoint.findMany({
    where: merchantId ? { merchantId } : undefined,
    include: { calls: { orderBy: { createdAt: "desc" }, take: 5 } },
  });
  return NextResponse.json({ endpoints });
}

/** Create a machine-payable product */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const merchant = await db.merchant.findUnique({ where: { id: body.merchantId } });
  if (!merchant) return NextResponse.json({ error: "merchant not found" }, { status: 404 });

  const key = (body.productKey || body.name || "product")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const endpoint = await db.machineEndpoint.create({
    data: {
      merchantId: merchant.id,
      productKey: key,
      name: body.name,
      description: body.description || "Machine-payable API product",
      priceCents: Math.round(Number(body.price) * 100),
      currency: merchant.currency,
    },
  });

  await db.agentEvent.create({
    data: {
      merchantId: merchant.id,
      kind: "MACHINE_SALE",
      title: `Machine-payable endpoint live — ${body.name}`,
      detail: `AI agents can now buy this at GET /v1/product/${key} (HTTP 402) paying QUSDC per call through pre-funded mandates.`,
    },
  });

  return NextResponse.json({ endpoint });
}

/** Live agent purchase — proxies the real x402 mini-service flow */
export async function PUT(req: NextRequest) {
  const body = await req.json();
  const endpoint = await db.machineEndpoint.findUnique({
    where: { productKey: body.productKey },
    include: { merchant: true },
  });
  if (!endpoint) return NextResponse.json({ error: "endpoint not found" }, { status: 404 });

  // 1) the agent "discovers" the product -> gets 402 terms
  const termsRes = await fetch(`${ENDPOINT_SERVICE}/v1/product/${endpoint.productKey}`);
  const terms = await termsRes.json();

  // 2) the agent pays -> POST with X-PAYMENT
  const payRes = await fetch(`${ENDPOINT_SERVICE}/v1/product/${endpoint.productKey}/purchase`, {
    method: "POST",
    headers: {
      "X-PAYMENT": body.payment || `demo-intent-0x${Date.now().toString(16)}`,
      "X-AGENT-NAME": body.agentName || "shopper-bot",
      "X-AGENT-WALLET": body.agentWallet || "0xA77bB029C0fE6Bc81d4E5C3E2Ff31f9D0a4E8b21",
    },
  });
  const purchase = await payRes.json();

  if (!payRes.ok) {
    return NextResponse.json({ step: "payment_rejected", terms, purchase }, { status: payRes.status });
  }

  // 3) record in dashboard DB + agent feed
  await db.endpointCall.create({
    data: {
      endpointId: endpoint.id,
      agentName: body.agentName || "shopper-bot",
      agentWallet: body.agentWallet || "0xA77bB029C0fE6Bc81d4E5C3E2Ff31f9D0a4E8b21",
      amountCents: endpoint.priceCents,
      escrowRef: purchase.escrowRef,
    },
  });
  await db.machineEndpoint.update({
    where: { id: endpoint.id },
    data: { callsCount: { increment: 1 }, revenueCents: { increment: endpoint.priceCents } },
  });
  await db.agentEvent.create({
    data: {
      merchantId: endpoint.merchantId,
      kind: "MACHINE_SALE",
      title: `AI agent bought ${endpoint.name}`,
      detail: `${body.agentName || "shopper-bot"} paid ${(endpoint.priceCents / 100).toFixed(2)} ${endpoint.currency} via mandate; escrow ${purchase.escrowRef.slice(0, 10)} (refund window 10 min).`,
      amountCents: endpoint.priceCents,
    },
  });
  await db.ledgerEntry.create({
    data: {
      merchantId: endpoint.merchantId,
      kind: "SALE",
      date: new Date(),
      label: `Machine sale — ${endpoint.name} (${body.agentName || "shopper-bot"})`,
      amountCents: endpoint.priceCents,
    },
  });

  return NextResponse.json({ step: "purchased", terms, purchase });
}
