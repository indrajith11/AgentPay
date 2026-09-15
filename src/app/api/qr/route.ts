import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";

/** Render a payment-request QR as an SVG data URL */
export async function GET(req: NextRequest) {
  const data = req.nextUrl.searchParams.get("data") || "";
  if (!data) return NextResponse.json({ error: "data required" }, { status: 400 });

  const svg = await QRCode.toString(data, {
    type: "svg",
    margin: 1,
    width: 220,
    color: { dark: "#052e22", light: "#ffffff" },
  });

  return new NextResponse(svg, {
    headers: { "content-type": "image/svg+xml", "cache-control": "no-store" },
  });
}
