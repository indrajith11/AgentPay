import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionAddress } from "@/lib/auth";

/**
 * P1: merchants are session-scoped. The wallet that signed in owns every
 * merchant it creates — the server FORCES owner = session address, so a
 * client can never register a store for someone else's wallet.
 */

export async function GET() {
  const address = await sessionAddress();
  if (!address) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const merchants = await db.merchant.findMany({
    where: { owner: address },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ merchants });
}

export async function POST(req: NextRequest) {
  const address = await sessionAddress();
  if (!address) {
    return NextResponse.json({ error: "not authenticated — sign in with your wallet first" }, { status: 401 });
  }
  const body = await req.json();
  if (!body.name || typeof body.name !== "string" || body.name.trim().length < 2) {
    return NextResponse.json({ error: "store name (2+ chars) required" }, { status: 400 });
  }
  // optional self-custody payout address, defaults to the signed-in wallet
  const chainAddr =
    typeof body.chainAddr === "string" && /^0x[a-fA-F0-9]{40}$/.test(body.chainAddr)
      ? body.chainAddr
      : null;
  if (body.chainAddr && !chainAddr) {
    return NextResponse.json({ error: "payout address must be a valid 0x address" }, { status: 400 });
  }

  const merchant = await db.merchant.create({
    data: {
      name: body.name.trim().slice(0, 60),
      owner: address, // server-side binding: wallet IS the owner
      phone: typeof body.phone === "string" ? body.phone.slice(0, 24) : null,
      category: typeof body.category === "string" ? body.category : "retail",
      currency: typeof body.currency === "string" ? body.currency : "ZAR",
      qiePassId: null,
    },
  });
  return NextResponse.json({ merchant });
}
