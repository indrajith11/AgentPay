import crypto from "node:crypto";
import { cookies } from "next/headers";
import { db } from "@/lib/db";

/**
 * P1 finisher — passkey step-up (Master Plan 5.7 / ch.8).
 *
 * Zero-dependency WebAuthn implementation (ES256 / P-256 only — every
 * mainstream authenticator: Touch ID, Windows Hello, Android, YubiKey).
 * We deliberately do NOT verify vendor attestation chains: we only need
 * proof-of-possession of the credential key, which is what a step-up is.
 * What IS verified, spec-strict:
 *   - challenge (single-use, 2 min TTL, stored server-side per address)
 *   - origin  (must match the request host the dashboard is served from)
 *   - rpIdHash (sha256 of the serving hostname)
 *   - UP + UV flags (user presence + user verification = biometric/PIN)
 *   - signature over raw authenticatorData || sha256(clientDataJSON)
 *   - monotonically increasing signature counter (clone detection)
 *
 * Storage: Setting table rows (passkey:<addr>, pk-challenge:<addr>) so no
 * schema migration is needed. Step-up grants a 5-minute HMAC cookie.
 */

const CHALLENGE_TTL_S = 120;
export const STEPUP_COOKIE = "agentpay_stepup";
const STEPUP_TTL_S = 300;

// ---------- small base64url helpers ----------
export function b64u(buf: Uint8Array | Buffer): string {
  return Buffer.from(buf).toString("base64url");
}
function fromB64u(s: string): Buffer {
  return Buffer.from(s, "base64url");
}
function sha256(...parts: Uint8Array[]): Buffer {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}
function secret(): string {
  return process.env.AUTH_SECRET || "agentpay-dev-secret-do-not-use-in-prod";
}
function hmac(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("hex");
}

// ---------- minimal CBOR (decoder only — attestation objects) ----------
type CborValue = number | bigint | Uint8Array | string | CborValue[] | Map<CborValue, CborValue>;

function readHead(buf: Uint8Array, off: number): { major: number; arg: number | bigint; next: number } {
  if (off >= buf.length) throw new Error("cbor: eof");
  const ib = buf[off]!;
  const major = ib >> 5;
  const ai = ib & 0x1f;
  let arg: number | bigint;
  let next = off + 1;
  if (ai < 24) {
    arg = ai;
  } else if (ai === 24) {
    arg = buf[next]!; next += 1;
  } else if (ai === 25) {
    arg = (buf[next]! << 8) | buf[next + 1]!; next += 2;
  } else if (ai === 26) {
    arg = ((buf[next]! << 24) | (buf[next + 1]! << 16) | (buf[next + 2]! << 8) | buf[next + 3]!) >>> 0; next += 4;
  } else if (ai === 27) {
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(buf[next + i]!);
    arg = v; next += 8;
  } else {
    throw new Error(`cbor: unsupported additional info ${ai} (indefinite lengths not used by authenticators)`);
  }
  return { major, arg, next };
}

function decodeCbor(buf: Uint8Array, off: number): { value: CborValue; next: number } {
  const { major, arg, next } = readHead(buf, off);
  switch (major) {
    case 0: return { value: Number(arg), next };
    case 1: return { value: -1 - Number(arg), next };
    case 2: {
      const len = Number(arg);
      return { value: buf.slice(next, next + len), next: next + len };
    }
    case 3: {
      const len = Number(arg);
      return { value: Buffer.from(buf.slice(next, next + len)).toString("utf8"), next: next + len };
    }
    case 4: {
      const len = Number(arg);
      const arr: CborValue[] = [];
      let cur = next;
      for (let i = 0; i < len; i++) {
        const r = decodeCbor(buf, cur);
        arr.push(r.value);
        cur = r.next;
      }
      return { value: arr, next: cur };
    }
    case 5: {
      const len = Number(arg);
      const m = new Map<CborValue, CborValue>();
      let cur = next;
      for (let i = 0; i < len; i++) {
        const k = decodeCbor(buf, cur);
        const v = decodeCbor(buf, k.next);
        m.set(k.value, v.value);
        cur = v.next;
      }
      return { value: m, next: cur };
    }
    default:
      throw new Error(`cbor: major type ${major} not supported`);
  }
}

function cborMap(buf: Uint8Array, off: number): { map: Map<CborValue, CborValue>; next: number } {
  const r = decodeCbor(buf, off);
  if (!(r.value instanceof Map)) throw new Error("cbor: expected map");
  return { map: r.value as Map<CborValue, CborValue>, next: r.next };
}

// ---------- COSE ES256 key -> SPKI (for node:crypto verify) ----------
// Verified byte-for-byte against OpenSSL: 30 59 | 30 13 | 06 07 ecPublicKey
// | 06 08 prime256v1 (2a8648ce3d030107) | 03 42 00 | uncompressed point
const P256_SPKI_PREFIX = Buffer.from(
  "3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"
);

function coseKeyToSpki(cose: Map<CborValue, CborValue>): Buffer {
  const kty = cose.get(1);
  const alg = cose.get(3);
  const crv = cose.get(-1);
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (kty !== 2 || alg !== -7 || crv !== 1) throw new Error("credential key is not ES256/P-256");
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
    throw new Error("malformed EC point in credential key");
  }
  const point = Buffer.concat([Buffer.from([0x04]), Buffer.from(x), Buffer.from(y)]);
  return Buffer.concat([P256_SPKI_PREFIX, point]);
}

/** Extract attestedCredentialData from authData. Returns null when AT flag absent. */
function parseAuthData(authDataRaw: Uint8Array): {
  rpIdHash: Buffer;
  flags: number;
  counter: number;
  aaguid?: Buffer;
  credentialId?: Buffer;
  cose?: Map<CborValue, CborValue>;
} {
  const authData = Buffer.from(authDataRaw);
  if (authData.length < 37) throw new Error("authData too short");
  const rpIdHash = Buffer.from(authData.slice(0, 32));
  const flags = authData[32]!;
  const counter = authData.readUInt32BE(33);
  const out: ReturnType<typeof parseAuthData> = { rpIdHash, flags, counter };
  if (flags & 0x40) {
    if (authData.length < 55) throw new Error("authData truncated (attested data)");
    out.aaguid = Buffer.from(authData.slice(37, 53));
    const idLen = authData.readUInt16BE(53);
    const idStart = 55;
    if (authData.length < idStart + idLen) throw new Error("authData truncated (credential id)");
    out.credentialId = Buffer.from(authData.slice(idStart, idStart + idLen));
    const r = cborMap(authData, idStart + idLen);
    out.cose = r.map;
  }
  return out;
}

// ---------- types shared with routes ----------
export type ClientDataJSON = { type: string; challenge: string; origin: string; crossOrigin?: boolean };
export type RegistrationResponse = {
  id: string; rawId: string; type: string;
  response: { clientDataJSON: string; attestationObject: string };
};
export type AssertionResponse = {
  id: string; rawId: string; type: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
};

export function clientData(raw: string): ClientDataJSON {
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Error("clientDataJSON is not valid JSON");
  }
}

async function issueChallenge(address: string): Promise<string> {
  const challenge = crypto.randomBytes(32).toString("base64url");
  const expires = Math.floor(Date.now() / 1000) + CHALLENGE_TTL_S;
  await db.setting.upsert({
    where: { key: `pk-challenge:${address.toLowerCase()}` },
    update: { value: `${challenge}|${expires}` },
    create: { key: `pk-challenge:${address.toLowerCase()}`, value: `${challenge}|${expires}` },
  });
  return challenge;
}

async function takeChallenge(address: string, got: string): Promise<void> {
  const row = await db.setting.findUnique({ where: { key: `pk-challenge:${address.toLowerCase()}` } });
  if (!row) throw new Error("no challenge issued — start from the options call");
  await db.setting.delete({ where: { key: `pk-challenge:${address.toLowerCase()}` } }).catch(() => {});
  const [nonce, expires] = row.value.split("|");
  if (Number(expires) < Math.floor(Date.now() / 1000)) throw new Error("challenge expired — try again");
  if (nonce !== got) throw new Error("challenge mismatch");
}

async function storedCredential(address: string): Promise<
  { credentialId: string; spki: Buffer; counter: number; createdAt: string } | null
> {
  const row = await db.setting.findUnique({ where: { key: `passkey:${address.toLowerCase()}` } });
  if (!row) return null;
  try {
    const j = JSON.parse(row.value) as { credentialId: string; publicKeySpkiB64: string; counter: number; createdAt: string };
    return { credentialId: j.credentialId, spki: Buffer.from(j.publicKeySpkiB64, "base64"), counter: j.counter, createdAt: j.createdAt };
  } catch {
    return null;
  }
}

export async function passkeyEnrolled(address: string): Promise<{ enrolled: boolean; createdAt?: string }> {
  const c = await storedCredential(address);
  return { enrolled: !!c, createdAt: c?.createdAt };
}

// ---------- registration ----------
export async function registrationOptions(address: string, hostName: string) {
  const challenge = await issueChallenge(address);
  return {
    challenge,
    rp: { name: "AgentPay × MerchantPilot", id: hostName },
    user: { id: b64u(Buffer.from(address.toLowerCase(), "utf8")), name: address.toLowerCase(), displayName: "Merchant (wallet-bound)" },
    pubKeyCredParams: [{ type: "public-key" as const, alg: -7 }],
    authenticatorSelection: { userVerification: "required" as const, residentKey: "preferred" as const },
    timeout: 120_000,
    attestation: "none" as const,
  };
}

export async function verifyRegistration(params: {
  address: string;
  response: RegistrationResponse;
  expectedOrigins: string[];
}): Promise<{ credentialId: string; spki: Buffer; counter: number }> {
  const { address, response, expectedOrigins } = params;
  if (response.type !== "public-key") throw new Error("unexpected credential type");
  const cd = clientData(response.response.clientDataJSON);
  if (cd.type !== "webauthn.create") throw new Error("clientData type is not webauthn.create");
  await takeChallenge(address, cd.challenge);

  const origin = matchOrigin(cd.origin, expectedOrigins);
  const rpId = new URL(origin).hostname;

  const attObj = fromB64u(response.response.attestationObject);
  const { map } = cborMap(attObj, 0);
  const fmt = map.get("fmt");
  const authDataRaw = map.get("authData");
  if (!authDataRaw || !(authDataRaw instanceof Uint8Array)) throw new Error("attestationObject missing authData");
  const ad = parseAuthData(authDataRaw);

  if (!ad.credentialId || !ad.cose) throw new Error("no attested credential data (AT flag unset)");
  if (!(ad.flags & 0x01)) throw new Error("user presence flag not set");
  if (!(ad.flags & 0x04)) throw new Error("user verification required — unlock with biometrics/PIN");
  if (!ad.rpIdHash.equals(sha256(Buffer.from(rpId, "utf8")))) throw new Error("rpIdHash mismatch — credential not scoped to this host");

  // attStmt handling: "none" has none; "packed" self-attestation is verified
  // when possible; vendor certs (x5c) are accepted WITHOUT chain validation
  // (documented: possession proof only, no enterprise attestation policy).
  if (fmt === "packed") {
    const attStmt = map.get("attStmt");
    if (attStmt instanceof Map && !attStmt.has("x5c")) {
      const sig = attStmt.get("sig");
      const alg = attStmt.get("alg");
      if (sig instanceof Uint8Array && alg === -7) {
        const ok = crypto.verify(
          "sha256",
          Buffer.concat([Buffer.from(authDataRaw), sha256(Buffer.from(response.response.clientDataJSON, "base64url"))]),
          crypto.createPublicKey({ key: coseKeyToSpki(ad.cose), format: "der", type: "spki" }),
          Buffer.from(sig)
        );
        if (!ok) throw new Error("packed self-attestation signature invalid");
      }
    }
  } else if (fmt !== "none" && fmt !== "fido-u2f" && fmt !== "android-key") {
    throw new Error(`unsupported attestation format: ${String(fmt)}`);
  }

  const spki = coseKeyToSpki(ad.cose);
  const credentialId = response.id || b64u(ad.credentialId);
  if (!credentialId) throw new Error("credential id missing");

  const record = {
    credentialId,
    publicKeySpkiB64: spki.toString("base64"),
    counter: ad.counter,
    createdAt: new Date().toISOString(),
    origin,
    rpId,
    aaguid: ad.aaguid?.toString("hex") ?? "",
  };
  await db.setting.upsert({
    where: { key: `passkey:${address.toLowerCase()}` },
    update: { value: JSON.stringify(record) },
    create: { key: `passkey:${address.toLowerCase()}`, value: JSON.stringify(record) },
  });
  return { credentialId, spki, counter: ad.counter };
}

// ---------- assertion (the actual step-up) ----------
export async function assertionOptions(address: string, hostName: string) {
  const cred = await storedCredential(address);
  if (!cred) throw new Error("NO_PASSKEY");
  const challenge = await issueChallenge(address);
  return {
    challenge,
    rpId: hostName,
    allowCredentials: [{ type: "public-key" as const, id: cred.credentialId }],
    userVerification: "required" as const,
    timeout: 120_000,
  };
}

export async function verifyAssertion(params: {
  address: string;
  response: AssertionResponse;
  expectedOrigins: string[];
}): Promise<{ stepUpToken: string; until: number }> {
  const { address, response, expectedOrigins } = params;
  const cred = await storedCredential(address);
  if (!cred) throw new Error("NO_PASSKEY");
  if (response.id !== cred.credentialId && response.rawId !== cred.credentialId) {
    throw new Error("unknown credential — enroll this passkey first");
  }

  const cd = clientData(response.response.clientDataJSON);
  if (cd.type !== "webauthn.get") throw new Error("clientData type is not webauthn.get");
  await takeChallenge(address, cd.challenge);
  const origin = matchOrigin(cd.origin, expectedOrigins);
  const rpId = new URL(origin).hostname;

  const authData = fromB64u(response.response.authenticatorData);
  const ad = parseAuthData(authData);
  if (!(ad.flags & 0x01)) throw new Error("user presence flag not set");
  if (!(ad.flags & 0x04)) throw new Error("user verification required — unlock with biometrics/PIN");
  if (!ad.rpIdHash.equals(sha256(Buffer.from(rpId, "utf8")))) throw new Error("rpIdHash mismatch");

  // counter / clone detection (spec 6.1.1: both-zero authenticators exempt)
  if (!(ad.counter === 0 && cred.counter === 0) && ad.counter <= cred.counter) {
    throw new Error("signature counter did not increase — possible cloned authenticator");
  }

  const sig = fromB64u(response.response.signature);
  const signed = Buffer.concat([Buffer.from(authData), sha256(Buffer.from(response.response.clientDataJSON, "base64url"))]);
  const ok = crypto.verify("sha256", signed, crypto.createPublicKey({ key: cred.spki, format: "der", type: "spki" }), sig);
  if (!ok) throw new Error("assertion signature invalid");

  await db.setting.update({
    where: { key: `passkey:${address.toLowerCase()}` },
    data: { value: JSON.stringify({
      credentialId: cred.credentialId,
      publicKeySpkiB64: cred.spki.toString("base64"),
      counter: ad.counter,
      createdAt: new Date().toISOString(),
    }) },
  }).catch(async () => {
    await db.setting.upsert({
      where: { key: `passkey:${address.toLowerCase()}` },
      update: { value: JSON.stringify({
        credentialId: cred.credentialId,
        publicKeySpkiB64: cred.spki.toString("base64"),
        counter: ad.counter,
        createdAt: new Date().toISOString(),
      }) },
      create: { key: `passkey:${address.toLowerCase()}`, value: JSON.stringify({
        credentialId: cred.credentialId,
        publicKeySpkiB64: cred.spki.toString("base64"),
        counter: ad.counter,
        createdAt: new Date().toISOString(),
      }) },
    });
  });

  const until = Math.floor(Date.now() / 1000) + STEPUP_TTL_S;
  const payload = `stepup|${address.toLowerCase()}|${until}`;
  return { stepUpToken: `${payload}|${hmac(payload)}`, until };
}

// ---------- step-up cookie helpers ----------
export function stepUpCookie(token: string) {
  return {
    name: STEPUP_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: STEPUP_TTL_S,
  };
}

export async function stepUpSatisfied(address: string): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(STEPUP_COOKIE)?.value;
  if (!token) return false;
  const parts = token.split("|");
  if (parts.length !== 4) return false;
  const [kind, addr, exp, sig] = parts;
  if (kind !== "stepup" || addr !== address.toLowerCase()) return false;
  if (hmac(`${kind}|${addr}|${exp}`) !== sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  return true;
}

/** Route guard: throws a tagged error the route maps to 403. */
export async function requireStepUp(address: string): Promise<void> {
  const { enrolled } = await passkeyEnrolled(address);
  if (!enrolled) return; // opt-in: nothing to step up with yet
  if (await stepUpSatisfied(address)) return;
  const err = new Error("PASSKEY_STEPUP_REQUIRED") as Error & { code?: string };
  err.code = "PASSKEY_STEPUP_REQUIRED";
  throw err;
}

export function matchOrigin(got: string, candidates: string[]): string {
  if (candidates.includes(got)) return got;
  throw new Error(`origin mismatch: ${got} not in [${candidates.join(", ")}]`);
}

/** Build the origin candidates a request is allowed to come from. */
export function originCandidates(req: { nextUrl: { origin: string }; headers: { get(n: string): string | null } }): string[] {
  const host = req.headers.get("host") || new URL(req.nextUrl.origin).host;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const set = new Set<string>([
    req.nextUrl.origin,
    proto ? `${proto}://${host}` : "",
    `https://${host}`,
    `http://${host}`,
  ].filter(Boolean) as string[]);
  return [...set];
}
