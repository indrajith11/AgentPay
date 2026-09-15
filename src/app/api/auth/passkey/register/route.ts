import { NextRequest, NextResponse } from "next/server";
import { sessionAddress } from "@/lib/auth";
import { registrationOptions, verifyRegistration, originCandidates } from "@/lib/passkey";

/**
 * Passkey registration (enrollment), two phases in one route.
 *   POST { phase: "options" }  -> PublicKeyCredentialCreationOptions JSON
 *   POST { phase: "verify", response } -> stores the credential, { ok }
 *
 * Session-bound: the credential is scoped to the signed-in wallet address.
 * Re-enrolling replaces the stored credential (one passkey per merchant —
 * this is a step-up factor, not a multi-user directory).
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
      const options = await registrationOptions(address, hostName);
      return NextResponse.json(options);
    }
    if (phase === "verify") {
      const result = await verifyRegistration({
        address,
        response: body.response,
        expectedOrigins: hosts,
      });
      return NextResponse.json({ ok: true, credentialId: result.credentialId, counter: result.counter });
    }
    return NextResponse.json({ error: "phase must be options|verify" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
