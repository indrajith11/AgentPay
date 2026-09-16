import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { consumeNonce, makeToken, sessionCookie } from "@/lib/auth";

/** Step 2 of SIWE: verify the wallet signature over the challenge, burn the
 *  nonce, issue the httpOnly session cookie. */
export async function POST(req: NextRequest) {
  const { address, message, signature } = await req.json();
  if (!address || !message || !signature) {
    return NextResponse.json({ error: "address, message, signature required" }, { status: 400 });
  }
  let signer: string;
  try {
    signer = (await ethers.verifyMessage(message, signature)).toLowerCase();
  } catch {
    return NextResponse.json({ error: "signature malformed" }, { status: 400 });
  }
  if (signer !== String(address).toLowerCase()) {
    return NextResponse.json({ error: "signature does not match address" }, { status: 401 });
  }
  const fresh = await consumeNonce(String(address), String(message));
  if (!fresh) {
    return NextResponse.json({ error: "nonce expired or already used" }, { status: 401 });
  }
  const token = makeToken(String(address));
  const res = NextResponse.json({ authenticated: true, address: signer });
  res.cookies.set(sessionCookie(token));
  return res;
}
