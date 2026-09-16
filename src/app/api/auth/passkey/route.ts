import { NextResponse } from "next/server";
import { sessionAddress } from "@/lib/auth";
import { passkeyEnrolled } from "@/lib/passkey";
import { db } from "@/lib/db";

/**
 * Passkey enrollment status + revoke.
 *   GET    -> { enrolled, createdAt? }           (requires session)
 *   DELETE -> revoke the enrolled credential      (requires session)
 */
export async function GET() {
  const address = await sessionAddress();
  if (!address) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const state = await passkeyEnrolled(address);
  return NextResponse.json(state);
}

export async function DELETE() {
  const address = await sessionAddress();
  if (!address) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  await db.setting.delete({ where: { key: `passkey:${address.toLowerCase()}` } }).catch(() => {});
  return NextResponse.json({ ok: true, enrolled: false });
}
