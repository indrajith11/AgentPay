// Partner-side VC claim for a consent_given verification request.
// Usage: node scripts/qiepass_vc_claim.mjs [requestId]
// Endpoint: POST /api/v1/vc/partner/claim-and-verify  (24h window after consent_given)
import crypto from "crypto";
import fs from "fs";

const BASE = (process.env.QIEPASS_BASE_URL || "https://did-stapi.qie.digital").replace(/\/$/, "");
const PK = process.env.QIEPASS_PUBLIC_KEY || "pk_test_91414f94fa9b8602b1a993cd36a04287";
let SK = process.env.QIEPASS_SECRET_KEY || "";
if (!SK) {
  for (const p of ["/tmp/my-project/.qiepass-secret.txt", "/home/z/my-project/.env"]) {
    try {
      const t = fs.readFileSync(p, "utf8");
      const m = t.match(/sk_test_[0-9a-f]+/);
      if (m) { SK = m[0]; break; }
    } catch {}
  }
}
if (!SK) { console.error("No secret found"); process.exit(1); }

function headers() {
  const ts = Date.now().toString();
  const sig = crypto.createHmac("sha256", SK).update(PK + ts).digest("hex");
  return { "X-Public-Key": PK, "X-Signature": sig, "X-Timestamp": ts, "Content-Type": "application/json" };
}

const requestId = process.argv[2] || "pvr_1789639541214_47b78jbdh";

const res = await fetch(`${BASE}/api/v1/vc/partner/claim-and-verify`, {
  method: "POST",
  headers: headers(),
  body: JSON.stringify({ requestId }),
  cache: "no-store",
});
const text = await res.text();
console.log(`HTTP ${res.status}`);
try { console.log(JSON.stringify(JSON.parse(text), null, 1).slice(0, 3000)); }
catch { console.log(text.slice(0, 1000)); }
