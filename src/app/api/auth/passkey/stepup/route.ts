import { NextRequest, NextResponse } from "next/server";
import { sessionAddress, sessionCookie, makeToken } from "@/lib/auth";
import { assertionOptions, verifyAssertion, originCandidates, stepUpCookie } from "@/lib/passkey";

/**
 * Passkey assertion = the step-up itself.
 *   POST { phase: "options" }  -> assertion options (challenge + credential id)
 *   POST { phase: "verify", response } -> verifies UV+signature+counter and
 *       sets the 5-minute httpOnly `agentpay_stepup` cookie that money-moving
 *       endpoints (/api/invoices PUT, /api/subscriptions PUT) require once a
 *       passkey is enrolled. Also refreshes the main session cookie so the
 *       step-up doubles as a lightweight re-login.
 */
export async function POST(req: NextRequest) {
  const address = await sessionAddress();
  if (!address) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const phase = body.phase || "options";
  const hosts = originCandidates(req);

  try {
    if (phase === "options") {
      const hostName = new URL(req.headers.get("origin") || hosts[hosts.length - 1]!).hostname;
      const options = await assertionOptions(address, hostName);
      return NextResponse.json(options);
    }
    if (phase === "verify") {
      const result = await verifyAssertion({ address, response: body.response, expectedOrigins: hosts });
      const res = NextResponse.json({ ok: true, until: result.until });
      res.cookies.set(stepUpCookie(result.stepUpToken));
      // refresh the session too (proves the human is present, extends life)
      res.cookies.set(sessionCookie(makeToken(address)));
      return res;
    }
    return NextResponse.json({ error: "phase must be options|verify" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg === "NO_PASSKEY" ? 409 : 400;
    return NextResponse.json({ error: msg, code: msg === "NO_PASSKEY" ? "NO_PASSKEY" : undefined }, { status });
  }
}
