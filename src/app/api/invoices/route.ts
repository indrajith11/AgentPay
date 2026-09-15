import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireStepUp } from "@/lib/passkey";

/** Create an invoice */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const merchant = await db.merchant.findUnique({ where: { id: body.merchantId } });
  if (!merchant) return NextResponse.json({ error: "merchant not found" }, { status: 404 });

  const dueDate = new Date(Date.now() + Number(body.dueDays || 7) * 86400000);
  const invoice = await db.invoice.create({
    data: {
      merchantId: merchant.id,
      customerName: body.customerName,
      customerPhone: body.customerPhone || null,
      amountCents: Math.round(Number(body.amount) * 100),
      currency: merchant.currency,
      dueDate,
      notes: body.notes || null,
    },
  });

  await db.agentEvent.create({
    data: {
      merchantId: merchant.id,
      kind: "RECONCILIATION",
      title: `Invoice issued to ${body.customerName}`,
      detail: `${(invoice.amountCents / 100).toFixed(2)} ${merchant.currency}, due ${dueDate.toISOString().slice(0, 10)}. Collections agent will track it.`,
      amountCents: invoice.amountCents,
    },
  });

  return NextResponse.json({ invoice });
}

/** Simulate a payment against an invoice (demo of payInvoice flow incl. credit feed) */
export async function PUT(req: NextRequest) {
  const body = await req.json();
  const invoice = await db.invoice.findUnique({ where: { id: body.invoiceId }, include: { merchant: true } });
  if (!invoice) return NextResponse.json({ error: "invoice not found" }, { status: 404 });

  // passkey step-up gate: once the owner enrolls a passkey, money-moving
  // actions require a fresh (5 min) biometric/PIN confirmation
  try {
    await requireStepUp(invoice.merchant.owner);
  } catch (e) {
    const code = (e as { code?: string }).code;
    return NextResponse.json({ error: "passkey step-up required", code }, { status: 403 });
  }

  const remaining = invoice.amountCents - invoice.paidCents;
  const payCents = body.amount ? Math.round(Number(body.amount) * 100) : remaining;
  const newPaid = Math.min(invoice.paidCents + payCents, invoice.amountCents);
  const fullyPaid = newPaid >= invoice.amountCents;

  const updated = await db.invoice.update({
    where: { id: invoice.id },
    data: { paidCents: newPaid, status: fullyPaid ? "PAID" : "PARTIAL", paidAt: fullyPaid ? new Date() : null },
  });

  const fee = Math.round(payCents * 0.003);
  await db.ledgerEntry.createMany({
    data: [
      { merchantId: invoice.merchantId, date: new Date(), kind: "SALE", label: `Invoice payment — ${invoice.customerName}`, amountCents: payCents },
      { merchantId: invoice.merchantId, date: new Date(), kind: "FEE", label: "AgentPay fee 0.3%", amountCents: -fee },
    ],
  });

  await db.agentEvent.create({
    data: {
      merchantId: invoice.merchantId,
      kind: "RECONCILIATION",
      title: fullyPaid ? `Invoice settled — ${invoice.customerName}` : `Partial payment — ${invoice.customerName}`,
      detail: `${(payCents / 100).toFixed(2)} ${invoice.merchant.currency} received on-chain (1.4s finality). Books updated automatically; fee ${(fee / 100).toFixed(2)}.`,
      amountCents: payCents,
    },
  });

  // bump owner's credit passport (on-time repayment)
  const passport = await db.creditPassport.findUnique({ where: { wallet: invoice.merchant.owner } });
  if (passport) {
    const score = Math.min(850, passport.score + 8);
    await db.creditPassport.update({
      where: { id: passport.id },
      data: { score, onTimeCount: { increment: 1 }, volumeCents: { increment: payCents } },
    });
    await db.agentEvent.create({
      data: {
        merchantId: invoice.merchantId,
        kind: "CREDIT",
        title: "Credit score up +8",
        detail: `On-time repayment recorded on-chain. Score ${passport.score} -> ${score}. Lending tier unlocks at 600.`,
      },
    });
  }

  return NextResponse.json({ invoice: updated });
}
