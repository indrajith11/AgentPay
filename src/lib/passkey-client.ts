"use client";

/**
 * Browser-side WebAuthn plumbing for the passkey step-up (P1 finisher).
 * base64url conversions are hand-rolled — no polyfills needed in 2026.
 */

import { errorText } from "@/lib/wallet-error";

function b64uToBuf(s: string): ArrayBuffer {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function bufToB64u(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type PasskeyErrorCode = "NO_PASSKEY" | "NOT_SUPPORTED" | "CANCELLED" | "FAILED";
export class PasskeyError extends Error {
  code: PasskeyErrorCode;
  constructor(code: PasskeyErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function webauthnAvailable(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;
}

/** Enroll a passkey for the signed-in merchant. Returns the credential id. */
export async function enrollPasskey(): Promise<string> {
  if (!webauthnAvailable()) throw new PasskeyError("NOT_SUPPORTED", "This browser has no passkey support (no WebAuthn).");
  const options = await fetch("/api/auth/passkey/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phase: "options" }),
  }).then((r) => r.json());
  if (options.error) throw new PasskeyError("FAILED", errorText(options.error));

  let cred: PublicKeyCredential;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        challenge: b64uToBuf(options.challenge),
        rp: options.rp,
        user: { ...options.user, id: b64uToBuf(options.user.id) },
        pubKeyCredParams: options.pubKeyCredParams,
        authenticatorSelection: options.authenticatorSelection,
        timeout: options.timeout,
        attestation: options.attestation,
      },
    }) as PublicKeyCredential;
  } catch (e) {
    const msg = errorText(e);
    if (/NotAllowedError/i.test(msg)) throw new PasskeyError("CANCELLED", "Passkey enrollment was cancelled or timed out.");
    throw new PasskeyError("FAILED", msg);
  }
  const resp = cred.response as AuthenticatorAttestationResponse;

  const verify = await fetch("/api/auth/passkey/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      phase: "verify",
      response: {
        id: cred.id,
        rawId: bufToB64u(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: bufToB64u(resp.clientDataJSON),
          attestationObject: bufToB64u(resp.attestationObject),
        },
      },
    }),
  }).then((r) => r.json());
  if (verify.error) throw new PasskeyError("FAILED", errorText(verify.error));
  return verify.credentialId;
}

/** The step-up itself: assert with the enrolled passkey (biometric / PIN). */
export async function runStepUp(): Promise<{ until: number }> {
  if (!webauthnAvailable()) throw new PasskeyError("NOT_SUPPORTED", "This browser has no passkey support (no WebAuthn).");
  const options = await fetch("/api/auth/passkey/stepup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phase: "options" }),
  }).then((r) => r.json());
  if (options.error) {
    if (options.code === "NO_PASSKEY") throw new PasskeyError("NO_PASSKEY", "No passkey enrolled yet — add one in the Security tab.");
    throw new PasskeyError("FAILED", errorText(options.error));
  }

  let cred: PublicKeyCredential;
  try {
    cred = await navigator.credentials.get({
      publicKey: {
        challenge: b64uToBuf(options.challenge),
        rpId: options.rpId,
        allowCredentials: options.allowCredentials,
        userVerification: options.userVerification,
        timeout: options.timeout,
      },
    }) as PublicKeyCredential;
  } catch (e) {
    const msg = errorText(e);
    if (/NotAllowedError/i.test(msg)) throw new PasskeyError("CANCELLED", "Step-up was cancelled or timed out.");
    throw new PasskeyError("FAILED", msg);
  }
  const resp = cred.response as AuthenticatorAssertionResponse;
  if (!resp.authenticatorData || !resp.signature) throw new PasskeyError("FAILED", "authenticator returned incomplete assertion");

  const verify = await fetch("/api/auth/passkey/stepup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      phase: "verify",
      response: {
        id: cred.id,
        rawId: bufToB64u(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: bufToB64u(resp.clientDataJSON),
          authenticatorData: bufToB64u(resp.authenticatorData),
          signature: bufToB64u(resp.signature),
          userHandle: resp.userHandle ? bufToB64u(resp.userHandle) : undefined,
        },
      },
    }),
  }).then((r) => r.json());
  if (verify.error) throw new PasskeyError("FAILED", errorText(verify.error));
  return { until: verify.until };
}

/**
 * Run `fn`; when the server answers 403 PASSKEY_STEPUP_REQUIRED, do the
 * passkey assertion and retry once. Keeps hot paths friction-free while
 * still proving a human is present for money-moving actions.
 */
export async function withStepUp<T>(fn: () => Promise<Response>): Promise<T> {
  let res = await fn();
  if (res.status === 403) {
    const j = await res.clone().json().catch(() => ({}));
    if (j?.code === "PASSKEY_STEPUP_REQUIRED") {
      await runStepUp();
      res = await fn();
    }
  }
  return res.json() as Promise<T>;
}
