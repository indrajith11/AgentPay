import { NextRequest, NextResponse } from "next/server";
import { getNetworkStats } from "@/lib/networkstats";

export const dynamic = "force-dynamic";

/** Public, auth-free network statistics — every number read live from the chain. */
export async function GET(req: NextRequest) {
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  try {
    const stats = await getNetworkStats(fresh);
    return NextResponse.json(stats, {
      headers: { "cache-control": "public, max-age=30, stale-while-revalidate=60" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: "chain_unreachable", detail: String(e).slice(0, 200) },
      { status: 503 },
    );
  }
}
