import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";

export async function GET(req: NextRequest) {
  await ensureSeed();
  const merchantId = req.nextUrl.searchParams.get("merchantId");
  if (!merchantId) return NextResponse.json({ error: "merchantId required" }, { status: 400 });

  const merchant = await db.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [invoices, subs, endpoints, events, ledger, passport, todaySales, callCount] =
    await Promise.all([
      db.invoice.findMany({ where: { merchantId }, orderBy: { createdAt: "desc" }, take: 25 }),
      db.subscription.findMany({ where: { merchantId }, orderBy: { createdAt: "desc" } }),
      db.machineEndpoint.findMany({ where: { merchantId }, include: { calls: { orderBy: { createdAt: "desc" }, take: 8 } } }),
      db.agentEvent.findMany({ where: { merchantId }, orderBy: { createdAt: "desc" }, take: 12 }),
      db.ledgerEntry.findMany({ where: { merchantId }, orderBy: [{ date: "desc" }], take: 15 }),
      db.creditPassport.findFirst({ where: { wallet: merchant.owner } }),
      db.ledgerEntry.aggregate({
        where: { merchantId, kind: "SALE", date: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
        _sum: { amountCents: true },
      }),
      db.endpointCall.count(),
    ]);

  // machine revenue KPI
  const machineRevenue = endpoints.reduce((a, e) => a + e.revenueCents, 0);
  const mrr = subs.filter((s) => s.status === "ACTIVE").reduce((a, s) => {
    const monthly = s.interval === "WEEKLY" ? s.amountCents * 4 : s.amountCents;
    return a + monthly;
  }, 0);
  const pending = invoices
    .filter((i) => i.status === "SENT" || i.status === "PARTIAL" || i.status === "OVERDUE")
    .reduce((a, i) => a + (i.amountCents - i.paidCents), 0);
  const overdueCount = invoices.filter((i) => i.status === "OVERDUE").length;

  return NextResponse.json({
    merchant,
    kpis: {
      todaySalesCents: todaySales._sum.amountCents || 0,
      mrrCents: mrr,
      pendingCents: pending,
      overdueCount,
      machineRevenueCents: machineRevenue,
      endpointCalls: callCount,
      creditScore: passport?.score ?? null,
    },
    invoices,
    subscriptions: subs,
    endpoints,
    events,
    ledger,
    passport,
  });
}
