// Create a fresh QIE Pass sandbox verification request for the demo merchant.
// Usage: node scripts/qiepass_new_request.mjs [identifier]
// identifier = 0x address | @qiepass-id | name.qie  (user has QIE Wallet -> wallet flow)
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

const identifier = process.argv[2] || "0x33E00d801943D945DC5Ec92A2192425427023586";
const body = {
  identifier,
  requestedClaims: ["documentsVerified", "livenessCompleted"],
};

const res = await fetch(`${BASE}/api/v1/partners/verification-requests`, {
  method: "POST",
  headers: headers(),
  body: JSON.stringify(body),
  cache: "no-store",
});
const j = await res.json().catch(() => ({}));
console.log(`HTTP ${res.status}`);
console.log(JSON.stringify(j, null, 1).slice(0, 2000));

const rid = j?.data?.requestId;
if (rid) {
  fs.appendFileSync("/tmp/my-project/.qiepass-active-request.txt", `${new Date().toISOString()} ${rid}\n`);
  console.log(`\n>>> REQUEST CREATED: ${rid}`);
  console.log(">>> NEXT: approve in QIE Wallet within 1 hour, then: node scripts/qiepass_status_check.mjs " + rid);
}
