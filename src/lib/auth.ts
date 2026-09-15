import crypto from "node:crypto";
import { db } from "@/lib/db";
import { cookies } from "next/headers";

/**
 * M-02 sessionless auth (Master Plan 5.7 / ch.8): the wallet IS the identity.
 * Sign-In-With-Ethereum (EIP-4361) challenge -> ethers verify -> HMAC-signed
 * httpOnly cookie. No passwords, no email, no seed phrases, ever.
 * Sensitive changes (payout profile) add a passkey step-up in a later pass.
 */

const COOKIE = "agentpay_session";
const SESSION_TTL_S = 7 * 24 * 3600;
const NONCE_TTL_S = 600;

function secret(): string {
  // derived once, persisted in the Setting table so sessions survive restarts
  return process.env.AUTH_SECRET || "agentpay-dev-secret-do-not-use-in-prod";
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("hex");
}

export function makeToken(address: string): string {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const payload = `${address.toLowerCase()}|${exp}`;
  return `${payload}|${sign(payload)}`;
}

export function readToken(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split("|");
  if (parts.length !== 3) return null;
  const [address, exp, sig] = parts;
  if (sign(`${address}|${exp}`) !== sig) return null;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  return address;
}

export async function sessionAddress(): Promise<string | null> {
  const jar = await cookies();
  return readToken(jar.get(COOKIE)?.value);
}

export function sessionCookie(token: string) {
  return {
    name: COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_S,
  };
}

export const SESSION_COOKIE_NAME = COOKIE;

/** EIP-4361 challenge, persisted nonce (single use, 10 min TTL). */
export async function createChallenge(address: string, chainId: number, domain: string): Promise<string> {
  const nonce = crypto.randomBytes(16).toString("hex");
  const expires = Math.floor(Date.now() / 1000) + NONCE_TTL_S;
  await db.setting.upsert({
    where: { key: `nonce:${address.toLowerCase()}` },
    update: { value: `${nonce}|${expires}` },
    create: { key: `nonce:${address.toLowerCase()}`, value: `${nonce}|${expires}` },
  });
  const issued = new Date().toISOString();
  return [
    `${domain} wants you to sign in with your QIE account:`,
    address,
    "",
    "Sign in to AgentPay x MerchantPilot - merchant commerce on QIE.",
    "",
    `URI: https://${domain}`,
    "Version: 1",
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issued}`,
    `Expiration Time: ${new Date((expires + 60) * 1000).toISOString()}`,
  ].join("\n");
}

/** Validate + burn the nonce; returns true if this exact challenge is fresh. */
export async function consumeNonce(address: string, message: string): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: `nonce:${address.toLowerCase()}` } });
  if (!row) return false;
  const [nonce, expires] = row.value.split("|");
  await db.setting.delete({ where: { key: `nonce:${address.toLowerCase()}` } }).catch(() => {});
  if (Number(expires) < Math.floor(Date.now() / 1000)) return false;
  return message.includes(`Nonce: ${nonce}\n`);
}
