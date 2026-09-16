// QIE Pass sandbox smoke test — proves our HMAC-SHA256 auth + connectivity.
// Run: node --env-file=.env scripts/qiepass_smoke.mjs
//
// Check 1: GET /api/v1/partners/verification-requests/available-claims (read-only, no user side-effects)
// Check 2: POST /api/v1/partners/verification-requests for our own mainnet deployer address
//          (Option 1 identifier flow — expected: 200 with pending_consent | pending_kyc,
//           or 4xx if the sandbox rejects unknown wallets; either response proves transport+auth)

import crypto from "crypto";

const BASE_URL = (process.env.QIEPASS_BASE_URL || "https://did-stapi.qie.digital").replace(/\/$/, "");
const PUBLIC_KEY = process.env.QIEPASS_PUBLIC_KEY || "";
const SECRET_KEY = process.env.QIEPASS_SECRET_KEY || "";
const IDENTIFIER = process.argv[2] || "0x33E00d801943D945DC5Ec92A2192425427023586"; // our mainnet deployer (burner)

if (!PUBLIC_KEY || !SECRET_KEY) {
  console.error("FAIL: QIEPASS_PUBLIC_KEY / QIEPASS_SECRET_KEY missing from .env");
  process.exit(1);
}

function headers() {
  const timestamp = Date.now().toString();
  const signature = crypto.createHmac("sha256", SECRET_KEY).update(PUBLIC_KEY + timestamp).digest("hex");
  return {
    "X-Public-Key": PUBLIC_KEY,
    "X-Signature": signature,
    "X-Timestamp": timestamp,
    "Content-Type": "application/json",
  };
}

let pass = 0, fail = 0;

// Check 1 — available claims (auth proof)
try {
  const res = await fetch(`${BASE_URL}/api/v1/partners/verification-requests/available-claims`, { headers: headers() });
  const json = await res.json().catch(() => ({}));
  if (res.ok) {
    pass++;
    console.log(`PASS 1/2  available-claims  ${res.status}  ->`, JSON.stringify(json).slice(0, 220));
  } else {
    fail++;
    console.log(`FAIL 1/2  available-claims  ${res.status}  ->`, JSON.stringify(json).slice(0, 220));
  }
} catch (e) {
  fail++;
  console.log("FAIL 1/2  network/auth error:", e.message);
}

// Check 2 — create verification request (Option 1, minimal claims)
try {
  const res = await fetch(`${BASE_URL}/api/v1/partners/verification-requests`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ identifier: IDENTIFIER, requestedClaims: ["documentsVerified", "livenessCompleted"] }),
  });
  const json = await res.json().catch(() => ({}));
  const data = json?.data ?? json ?? {};
  console.log(
    `${res.ok || res.status === 409 ? "PASS" : "WARN"} 2/2  create-request  ${res.status}  status=${data.status ?? "?"}  userStatus=${data.userStatus ?? "?"}  requestId=${data.requestId ?? "-"}`
  );
  console.log("       raw:", JSON.stringify(json).slice(0, 300));
  if (res.ok || res.status === 409) pass++;
  else fail++;
} catch (e) {
  fail++;
  console.log("FAIL 2/2  network/auth error:", e.message);
}

console.log(`\nRESULT: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
