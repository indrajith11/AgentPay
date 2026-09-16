// QIE Pass partner API client — SERVER-SIDE ONLY.
// The HMAC secret must never reach the browser; every route using this file runs on the server.
//
// Docs: QIEPass_Partner_Documentation_v3.1 + QIEPass_API_Reference_v3 (QIE Telegram group, Sep 2026)
// Auth: X-Public-Key / X-Signature = HMAC-SHA256(publicKey + timestampMs, secret) / X-Timestamp (ms)
//       Fresh signature per request; server clock window ±5 minutes.
// Flow: POST /api/v1/partners/verification-requests  (identifier XOR partnerUserRef — never both)
//       -> poll GET /api/v1/partners/verification-requests/:requestId
//       -> within 24h of consent_given: POST /api/v1/vc/partner/claim-and-verify
// Statuses: pending_kyc | pending_consent -> consent_given | consent_rejected | expired | failed

import crypto from "crypto";

const BASE_URL = (process.env.QIEPASS_BASE_URL || "https://did-stapi.qie.digital").replace(/\/$/, "");
const PUBLIC_KEY = process.env.QIEPASS_PUBLIC_KEY || "";
const SECRET_KEY = process.env.QIEPASS_SECRET_KEY || "";

export type QiePassStatus =
  | "pending_kyc"
  | "pending_consent"
  | "consent_given"
  | "consent_rejected"
  | "expired"
  | "failed";

export function qiePassConfigured(): boolean {
  return Boolean(PUBLIC_KEY && SECRET_KEY);
}

function authHeaders(): Record<string, string> {
  if (!qiePassConfigured()) {
    throw new Error("QIE Pass keys missing — set QIEPASS_PUBLIC_KEY / QIEPASS_SECRET_KEY in .env");
  }
  const timestamp = Date.now().toString();
  const signature = crypto
    .createHmac("sha256", SECRET_KEY)
    .update(PUBLIC_KEY + timestamp)
    .digest("hex");
  return {
    "X-Public-Key": PUBLIC_KEY,
    "X-Signature": signature,
    "X-Timestamp": timestamp,
    "Content-Type": "application/json",
  };
}

async function call(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers || {}) },
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      `QIE Pass ${res.status}: ${JSON.stringify(json).slice(0, 300)}`
    ) as Error & { status?: number; body?: unknown };
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export type CreateRequestInput = {
  /** Option 1 — user has a QIE Wallet: 0x address | @qiepass-id | name.qie */
  identifier?: string;
  /** Option 2 — brand-new user: our own stable user ref (QIE hosts web onboarding) */
  partnerUserRef?: string;
  /** Minimal claims = higher approval rates (docs best practice) */
  requestedClaims: string[];
};

/** Create a verification request. Sends exactly ONE identity field (docs rule). */
export async function createVerificationRequest(input: CreateRequestInput) {
  if (Boolean(input.identifier) === Boolean(input.partnerUserRef)) {
    throw new Error("send exactly one of identifier | partnerUserRef (docs: never both, never neither)");
  }
  const body = {
    ...(input.identifier ? { identifier: input.identifier } : { partnerUserRef: input.partnerUserRef }),
    requestedClaims: input.requestedClaims,
  };
  return call("/api/v1/partners/verification-requests", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getRequestStatus(requestId: string) {
  return call(`/api/v1/partners/verification-requests/${encodeURIComponent(requestId)}`);
}

/** Read-only sanity endpoint — used by scripts/qiepass_smoke.mjs to prove HMAC auth works. */
export async function getAvailableClaims() {
  return call("/api/v1/partners/verification-requests/available-claims");
}

/** Claim the signed Verifiable Credential — allowed within 24h after consent_given. */
export async function claimAndVerify(requestId: string) {
  return call("/api/v1/vc/partner/claim-and-verify", {
    method: "POST",
    body: JSON.stringify({ requestId }),
  });
}

/**
 * Extract the essentials from a claimed credential response.
 * Tolerant to envelope shapes: { success, data } | data | raw VC.
 */
export function extractVerification(resp: any): {
  credentialId: string | null;
  kycVerified: boolean;
  claims: Record<string, unknown>;
  issuer: string | null;
} {
  const data = resp?.data ?? resp ?? {};
  const vc = data.credential ?? data.verifiableCredential ?? data.vc ?? data;
  const credentialId =
    vc?.id ?? vc?.credentialId ?? data.credentialId ?? data.requestId ?? null;
  const claims: Record<string, unknown> =
    vc?.credentialSubject ?? data.publicClaims ?? data.claims ?? {};
  const kycVerified =
    claims.kyc_verified === true ||
    claims.kyc_verified === "true" ||
    vc?.type?.includes("KYCCredential") === true ||
    data.kyc_verified === true;
  const issuer = vc?.issuer?.id ?? vc?.issuer ?? null;
  return { credentialId, kycVerified, claims, issuer };
}
