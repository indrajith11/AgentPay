import { NextRequest, NextResponse } from "next/server";
import { createChallenge } from "@/lib/auth";
import { ACTIVE_CHAIN } from "@/lib/chains";

/** Step 1 of SIWE: issue a fresh EIP-4361 challenge with a single-use nonce. */
export async function POST(req: NextRequest) {
  const { address } = await req.json();
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: "valid address required" }, { status: 400 });
  }
  const host = req.headers.get("host") || "localhost:3000";
  const message = await createChallenge(address, ACTIVE_CHAIN.id, host.split(":")[0]);
  return NextResponse.json({ message });
}
