import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireStepUp } from "@/lib/passkey";

/** Create a subscription */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const merchant = await db.merchant.findUnique({ where: { id: body.merchantId } });
  if (!merchant) return NextResponse.json({ error: "merchant not found" }, { status: 404 });

  const sub = await db.subscription.create({
    data: {
      merchantId: merchant.id,
      customerName: body.customerName,
      planName: body.planName,
      amountCents: Math.round(Number(body.amount) * 100),
      interval: body.interval || "MONTHLY",
      nextChargeAt: new Date(Date.now() + Number(body.intervalDays || 30) * 86400000),
      currency: merchant.currency,
    },
  });

  await db.agentEvent.create({
    data: {
      merchantId: merchant.id,
      kind: "RECONCILIATION",
      title: `Recurring mandate created — ${body.customerName}`,
      detail: `${body.planName}: ${(sub.amountCents / 100).toFixed(2)} ${merchant.currency} / ${sub.interval.toLowerCase()}. Agent charges automatically when due.`,
    },
  });

  return NextResponse.json({ subscription: sub });
}

/** Simulate a due charge (RecurringMandate.chargeDue flow) */
export async function PUT(req: NextRequest) {
  const body = await req.json();
  const sub = await db.subscription.findUnique({ where: { id: body.subscriptionId }, include: { merchant: true } });
  if (!sub) return NextResponse.json({ error: "subscription not found" }, { status: 404 });

  // passkey step-up gate (same policy as invoice settlement)
  try {
    await requireStepUp(sub.merchant.owner);
  } catch (e) {
    const code = (e as { code?: string }).code;
    return NextResponse.json({ error: "passkey step-up required", code }, { status: 403 });
  }

  const updated = await db.subscription.update({
    where: { id: sub.id },
    data: { chargesCount: { increment: 1 }, nextChargeAt: new Date(Date.now() + (sub.interval === "WEEKLY" ? 7 : 30) * 86400000) },
  });

  const fee = Math.round(sub.amountCents * 0.003);
  await db.ledgerEntry.createMany({
    data: [
      { merchantId: sub.merchantId, kind: "SALE", date: new Date(), label: `Subscription charge — ${sub.planName}`, amountCents: sub.amountCents },
      { merchantId: sub.merchantId, kind: "FEE", date: new Date(), label: "AgentPay fee 0.3%", amountCents: -fee },
    ],
  });

  await db.agentEvent.create({
    data: {
      merchantId: sub.merchantId,
      kind: "RECONCILIATION",
      title: `Subscription charged — ${sub.customerName}`,
      detail: `${(sub.amountCents / 100).toFixed(2)} ${sub.merchant.currency} pulled from prepaid balance. Next due ${updated.nextChargeAt.toISOString().slice(0, 10)}.`,
      amountCents: sub.amountCents,
    },
  });

  return NextResponse.json({ subscription: updated });
}
