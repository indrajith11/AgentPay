// Poll QIE Pass sandbox verification request status(es).
// Usage: node scripts/qiepass_status_check.mjs [requestId ...]
// Falls back to the known smoke-test request if none given.
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

const ids = process.argv.slice(2).length ? process.argv.slice(2) : ["pvr_1789562873614_5aod0bf1i"];
for (const id of ids) {
  try {
    const res = await fetch(`${BASE}/api/v1/partners/verification-requests/${id}`, { headers: headers(), cache: "no-store" });
    const j = await res.json().catch(() => ({}));
    console.log(`\n=== ${id} (HTTP ${res.status}) ===`);
    console.log(JSON.stringify(j, null, 1).slice(0, 1200));
  } catch (e) {
    console.log(`\n=== ${id} === ERROR: ${e.message}`);
  }
}
