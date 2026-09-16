import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionAddress } from "@/lib/auth";
import { getRequestStatus, qiePassConfigured } from "@/lib/qiepass";

/**
 * QIE Pass — step 2/3: poll a verification request and sync the merchant row.
 * GET /api/qiepass/status/:requestId  (session-scoped)
 */

const TERMINAL = new Set(["consent_given", "consent_rejected", "expired", "failed"]);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ requestId: string }> }
) {
  const address = await sessionAddress();
  if (!address) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  if (!qiePassConfigured()) {
    return NextResponse.json({ error: "QIE Pass not configured" }, { status: 500 });
  }

  const { requestId } = await params;
  const merchant = await db.merchant.findFirst({
    where: { qiePassRequestId: requestId, owner: address },
  });
  if (!merchant) {
    return NextResponse.json({ error: "no merchant owns this request" }, { status: 404 });
  }

  try {
    const resp = await getRequestStatus(requestId);
    const data = resp?.data ?? resp ?? {};
    const status: string = data.status ?? "unknown";

    if (TERMINAL.has(status)) {
      await db.merchant.update({
        where: { id: merchant.id },
        data: { qiePassStatus: status },
      });
    }

    return NextResponse.json({
      requestId,
      status,
      terminal: TERMINAL.has(status),
      redirectUrl: data.redirectUrl ?? null,
      expiresAt: data.expiresAt ?? null,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "QIE Pass status failed" },
      { status: 502 }
    );
  }
}
