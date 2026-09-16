import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { db } from "@/lib/db";
import { sessionAddress } from "@/lib/auth";
import { serverRpcUrl, ACTIVE_CHAIN } from "@/lib/chains";
import { DEPLOYED, explorerTx } from "@/lib/deployed";

/**
 * P1: after the merchant registers on-chain themselves (registerMerchant from
 * their own wallet), the PLATFORM VERIFIER countersigns verifyMerchant(addr, true).
 * This is the KYC-lite hook: the wallet signed in (proof of key custody), the
 * store exists on-chain (MerchantRegistered event -> indexer), and now the
 * platform marks it verified so PayEndpoint/quote paths can trust it.
 *
 * The verifier key lives only server-side and is never exposed to the client.
 */

const REGISTRY_ABI = [
  "function verifyMerchant(address merchant, bool verified)",
  "function isVerifiedMerchant(address merchant) view returns (bool)",
];

export async function POST(req: NextRequest) {
  const session = await sessionAddress();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { merchantId, merchantAddr } = await req.json();
  if (!merchantId || !merchantAddr || !/^0x[a-fA-F0-9]{40}$/.test(merchantAddr)) {
    return NextResponse.json({ error: "merchantId and merchantAddr required" }, { status: 400 });
  }
  const merchant = await db.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant || merchant.owner !== session) {
    return NextResponse.json({ error: "merchant not found for this session" }, { status: 404 });
  }

  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) {
    return NextResponse.json({ error: "verifier not configured on server" }, { status: 503 });
  }

  try {
    const p = new ethers.JsonRpcProvider(serverRpcUrl(), ACTIVE_CHAIN.id, { staticNetwork: true });
    const wallet = new ethers.Wallet(key, p);
    const reg = new ethers.Contract(DEPLOYED.MerchantRegistry, REGISTRY_ABI, wallet);

    const already = await reg.isVerifiedMerchant(merchantAddr);
    let verifyTx: string | null = null;
    if (!already) {
      try {
        const tx = await reg.verifyMerchant(merchantAddr, true);
        const rc = await tx.wait();
        verifyTx = rc?.hash ?? tx.hash;
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        if (/NOT_REGISTERED/.test(msg)) {
          return NextResponse.json(
            { error: "merchant not registered on-chain yet — finish the wallet signature step first" },
            { status: 409 }
          );
        }
        throw err;
      }
    }

    const payload = {
      registered: true,
      verified: true,
      verifyTx,
      verifyUrl: verifyTx ? explorerTx(ACTIVE_CHAIN.key, verifyTx) : null,
      verifiedAt: new Date().toISOString(),
    };
    await db.setting.upsert({
      where: { key: `chainreg:${merchantId}` },
      update: { value: JSON.stringify(payload) },
      create: { key: `chainreg:${merchantId}`, value: JSON.stringify(payload) },
    });
    return NextResponse.json(payload);
  } catch (e) {
    return NextResponse.json(
      { error: "verify failed: " + String(e instanceof Error ? e.message : e).slice(0, 140) },
      { status: 502 }
    );
  }
}
