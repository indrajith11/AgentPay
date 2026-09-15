import { NextResponse } from "next/server";
import { getQieUsd } from "@/lib/oracle";
import { ACTIVE_CHAIN } from "@/lib/chains";

/**
 * Live QIE/USD price from the OFFICIAL QIE Oracle (AggregatorV3).
 * On testnet the oracle lives on mainnet, so the price is read cross-chain.
 */
export async function GET() {
  try {
    const q = await getQieUsd();
    if (!q) return NextResponse.json({ error: "oracle unavailable/stale on all RPCs" }, { status: 502 });

    return NextResponse.json({
      chain: ACTIVE_CHAIN.key,
      chainId: ACTIVE_CHAIN.id,
      qieUsd: Number(q.answer) / 1e8,
      decimals: 8,
      updatedAt: q.updatedAt,
      stale: false,
      source: q.source,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `oracle unreachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }
}
