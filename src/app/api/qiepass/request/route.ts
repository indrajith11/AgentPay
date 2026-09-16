import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionAddress } from "@/lib/auth";
import { createVerificationRequest, qiePassConfigured } from "@/lib/qiepass";

/**
 * QIE Pass — step 1: create a verification request for a merchant.
 * Option 1 (docs-mandatory primary path): identifier = the merchant owner's
 * wallet address. Minimal claims (docs best practice: fewer = higher approval).
 */

// Minimal claim set — proves "KYC verified" without touching PII
// (verified against the live sandbox list: these two are the KYC-proof claims).
const REQUESTED_CLAIMS = ["documentsVerified", "livenessCompleted"];

export async function POST(req: NextRequest) {
  const address = await sessionAddress();
  if (!address) {
    return NextResponse.json({ error: "not authenticated — sign in first" }, { status: 401 });
  }
  if (!qiePassConfigured()) {
    return NextResponse.json({ error: "QIE Pass not configured" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const merchantId = typeof body.merchantId === "string" ? body.merchantId : "";
  const merchant = merchantId
    ? await db.merchant.findFirst({ where: { id: merchantId, owner: address } })
    : null;
  if (!merchant) {
    return NextResponse.json({ error: "merchant not found for this wallet" }, { status: 404 });
  }

  // Already verified? Short-circuit.
  if (merchant.qiePassStatus === "verified" && merchant.qiePassId) {
    return NextResponse.json({ status: "verified", merchant });
  }

  try {
    const resp = await createVerificationRequest({
      identifier: merchant.owner, // wallet address — Option 1 flow
      requestedClaims: REQUESTED_CLAIMS,
    });
    const data = resp?.data ?? resp ?? {};
    const requestId = data.requestId ?? data.id ?? null;
    const status = data.status ?? data.userStatus ?? "pending_consent";

    const updated = await db.merchant.update({
      where: { id: merchant.id },
      data: {
        qiePassRequestId: requestId ?? merchant.qiePassRequestId,
        qiePassStatus: status,
      },
    });

    return NextResponse.json({
      requestId,
      status,
      userStatus: data.userStatus ?? null,
      // Case B (not yet KYC'd): QIE may hand back a redirect for in-wallet KYC
      redirectUrl: data.redirectUrl ?? null,
      expiresAt: data.expiresAt ?? null,
      merchant: updated,
    });
  } catch (e: any) {
    const status = e?.status ?? 502;
    // 409 = user already verified with our organization per QIE — go claim directly
    if (status === 409) {
      await db.merchant.update({
        where: { id: merchant.id },
        data: { qiePassStatus: "consent_given" },
      });
      return NextResponse.json(
        { status: "consent_given", alreadyVerified: true, note: "claim the VC now" },
        { status: 200 }
      );
    }
    return NextResponse.json(
      { error: e?.message ?? "QIE Pass request failed" },
      { status: status === 401 ? 502 : status }
    );
  }
}
