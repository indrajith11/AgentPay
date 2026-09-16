import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionAddress } from "@/lib/auth";
import { claimAndVerify, extractVerification, qiePassConfigured } from "@/lib/qiepass";

/**
 * QIE Pass — step 4: claim the signed Verifiable Credential after consent_given
 * (docs: 24h window) and record the verification against the merchant.
 * The ECDSA-signed VC comes from QIE; we persist the credentialId as qiePassId.
 * Next milestone: our verifier relays this to MerchantRegistry.setVerified on-chain.
 */

export async function POST(req: NextRequest) {
  const address = await sessionAddress();
  if (!address) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  if (!qiePassConfigured()) {
    return NextResponse.json({ error: "QIE Pass not configured" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const merchantId = typeof body.merchantId === "string" ? body.merchantId : "";
  const merchant = merchantId
    ? await db.merchant.findFirst({ where: { id: merchantId, owner: address } })
    : null;
  if (!merchant?.qiePassRequestId) {
    return NextResponse.json({ error: "no QIE Pass request for this merchant" }, { status: 404 });
  }
  if (merchant.qiePassStatus !== "consent_given") {
    return NextResponse.json(
      { error: `cannot claim yet — status is ${merchant.qiePassStatus ?? "unknown"}` },
      { status: 409 }
    );
  }

  try {
    const resp = await claimAndVerify(merchant.qiePassRequestId);
    const v = extractVerification(resp);

    if (!v.kycVerified && !v.credentialId) {
      return NextResponse.json(
        { error: "claim response missing credential — raw saved to server log", resp },
        { status: 502 }
      );
    }

    const updated = await db.merchant.update({
      where: { id: merchant.id },
      data: {
        qiePassId: v.credentialId ?? merchant.qiePassRequestId,
        qiePassStatus: "verified",
        qiePassVerifiedAt: new Date(),
      },
    });

    return NextResponse.json({
      verified: true,
      credentialId: v.credentialId,
      issuer: v.issuer,
      claims: v.claims,
      merchant: updated,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "QIE Pass claim failed" },
      { status: 502 }
    );
  }
}
