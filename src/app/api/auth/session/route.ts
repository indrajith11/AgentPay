import { NextResponse } from "next/server";
import { sessionAddress, SESSION_COOKIE_NAME } from "@/lib/auth";

/** Who am I? Returns the session address or 401 (client uses this to gate UI). */
export async function GET() {
  const address = await sessionAddress();
  if (!address) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  return NextResponse.json({ authenticated: true, address });
}

/** Logout: clear the cookie. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set({ name: SESSION_COOKIE_NAME, value: "", path: "/", maxAge: 0 });
  return res;
}
