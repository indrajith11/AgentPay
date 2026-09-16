/**
 * P1 finisher E2E — passkey step-up, driven by a SYNTHETIC WebAuthn
 * authenticator (pure node:crypto). This proves the server crypto end to end:
 * CBOR attestation parse, COSE->SPKI key handling, challenge/origin/rpId
 * checks, ES256 assertion verify, counter tracking, 5-min step-up cookie and
 * the 403 gate on money-moving endpoints.
 *
 * Flow:
 *  1. mint a session cookie for a synthetic wallet (dev secret, same HMAC
 *     scheme as src/lib/auth.ts)
 *  2. register: options -> build attestation (fmt=none) -> verify
 *  3. negatives: replayed challenge / wrong-key assertion must FAIL
 *  4. assertion: options -> sign -> verify -> capture agentpay_stepup cookie
 *  5. gate: PUT /api/subscriptions -> 403 without step-up, 200 with it
 */
import crypto from "node:crypto";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const SECRET = process.env.AUTH_SECRET || "agentpay-dev-secret-do-not-use-in-prod";
const ADDR = ("0x" + crypto.createHash("sha256").update("passkey-e2e-wallet").digest("hex").slice(0, 40)).toLowerCase();
const ORIGIN = BASE;
const RP_ID = new URL(BASE).hostname;

// ---------- HMAC session (mirrors src/lib/auth.ts) ----------
function sessionCookie() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = `${ADDR}|${exp}`;
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return `agentpay_session=${payload}|${sig}`;
}

// ---------- CBOR encoder (only what authenticators emit) ----------
function cborUint(n) {
  if (n < 24) return Buffer.from([n]);
  if (n <= 0xff) return Buffer.from([0x18, n]);
  if (n <= 0xffff) return Buffer.from([0x19, n >> 8, n & 0xff]);
  return Buffer.from([0x1a, n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}
function cborNint(n) { // n < 0
  const v = -1 - n;
  const u = cborUint(v);
  u[0] |= 0x20;
  return u;
}
function cborBytes(b) {
  const h = cborUint(b.length);
  h[0] |= 0x40;
  return Buffer.concat([h, b]);
}
function cborText(s) {
  const b = Buffer.from(s, "utf8");
  const h = cborUint(b.length);
  h[0] |= 0x60;
  return Buffer.concat([h, b]);
}
function cborMap(pairs) { // [ [key(int|str), value(int|str|Buffer|Cbor)] ]
  // Cbor = "already encoded, splice verbatim" (nested maps / pre-wrapped bytes)
  class Cbor { constructor(buf) { this.buf = buf; } }
  const enc = (v) => {
    if (v && v.__cbor instanceof Buffer) return v.__cbor;
    if (typeof v === "number") return v >= 0 ? cborUint(v) : cborNint(v);
    if (typeof v === "string") return cborText(v);
    if (Buffer.isBuffer(v)) return cborBytes(v);
    throw new Error("unsupported cbor value " + typeof v);
  };
  const head = cborUint(pairs.length);
  head[0] |= 0xa0;
  let out = head;
  for (const [k, v] of pairs) out = Buffer.concat([out, enc(k), enc(v)]);
  return out;
}
const rawCbor = (buf) => ({ __cbor: buf, __proto__: null });

// ---------- synthetic authenticator ----------
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pubRaw = publicKey.export({ format: "jwk" }); // { x, y }
const X = Buffer.from(pubRaw.x, "base64url");
const Y = Buffer.from(pubRaw.y, "base64url");
const CRED_ID = crypto.randomBytes(32);

function coseKey() {
  return cborMap([[1, 2], [3, -7], [-1, 1], [-2, X], [-3, Y]]);
}
function rpIdHash() {
  return crypto.createHash("sha256").update(RP_ID).digest();
}
function clientDataJson(type, challenge) {
  return JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false });
}
function b64u(buf) { return Buffer.from(buf).toString("base64url"); }

function makeAttestation(challenge) {
  const cd = clientDataJson("webauthn.create", challenge);
  const authData = Buffer.concat([
    rpIdHash(),
    Buffer.from([0x45]), // UP | UV | AT
    Buffer.from([0, 0, 0, 0]), // signCount 0
    Buffer.alloc(16), // aaguid zeros
    (() => { const h = Buffer.from([0, 2]); h.writeUInt16BE(CRED_ID.length); return h; })(), // len 0x0022
    CRED_ID,
    coseKey(),
  ]);
  const attObj = cborMap([
    ["fmt", "none"],
    ["attStmt", rawCbor(cborMap([]))],
    ["authData", rawCbor(cborBytes(authData))],
  ]);
  return { cd, attObj };
}

function makeAssertion(challenge, counter) {
  const cd = clientDataJson("webauthn.get", challenge);
  const authData = Buffer.concat([
    rpIdHash(),
    Buffer.from([0x05]), // UP | UV
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(counter); return b; })(),
  ]);
  const sig = crypto.sign("sha256", Buffer.concat([authData, crypto.createHash("sha256").update(Buffer.from(cd, "utf8")).digest()]), privateKey);
  return { cd, authData, sig };
}

// ---------- HTTP helpers ----------
async function api(path, { method = "GET", body, cookies = "", rawCookie = null } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(rawCookie ? { cookie: rawCookie } : cookies ? { cookie: cookies } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, setCookies };
}

const jar = new Map();
function storeCookies(res) {
  for (const c of res.setCookies) jar.set(c.split(";")[0].split("=")[0], c.split(";")[0]);
}
function cookieHeader() { return [...jar.values()].join("; "); }

function ok(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!cond) process.exitCode = 1;
}

// ---------- run ----------
console.log(`passkey E2E :: ${BASE} :: wallet ${ADDR.slice(0, 10)}… :: rpId ${RP_ID}`);
jar.set("agentpay_session", `agentpay_session=${sessionCookie().split("=")[1]}`);

// 0) reset any state from previous runs, then sanity: not enrolled
await api("/api/auth/passkey", { method: "DELETE", rawCookie: cookieHeader() });
let r = await api("/api/auth/passkey", { rawCookie: cookieHeader() });
ok("status: session accepted, not enrolled", r.status === 200 && r.json.enrolled === false, JSON.stringify(r.json));

// 1) registration options
r = await api("/api/auth/passkey/register", { method: "POST", body: { phase: "options" }, rawCookie: cookieHeader() });
ok("register options issued", r.status === 200 && !!r.json.challenge, `challenge ${r.json.challenge?.slice(0, 12)}…`);

// 2) build + submit attestation
const att = makeAttestation(r.json.challenge);
r = await api("/api/auth/passkey/register", {
  method: "POST",
  body: {
    phase: "verify",
    response: {
      id: b64u(CRED_ID), rawId: b64u(CRED_ID), type: "public-key",
      response: { clientDataJSON: b64u(Buffer.from(att.cd, "utf8")), attestationObject: b64u(att.attObj) },
    },
  },
  rawCookie: cookieHeader(),
});
ok("registration verified + credential stored", r.status === 200 && r.json.ok === true, JSON.stringify(r.json));
storeCookies(r);

r = await api("/api/auth/passkey", { rawCookie: cookieHeader() });
ok("status now enrolled", r.status === 200 && r.json.enrolled === true);

// 3) negative: replay the SAME registration (challenge burned) must fail
r = await api("/api/auth/passkey/register", {
  method: "POST",
  body: {
    phase: "verify",
    response: {
      id: b64u(CRED_ID), rawId: b64u(CRED_ID), type: "public-key",
      response: { clientDataJSON: b64u(Buffer.from(att.cd, "utf8")), attestationObject: b64u(att.attObj) },
    },
  },
  rawCookie: cookieHeader(),
});
ok("replay rejected (challenge single-use)", r.status === 400, r.json.error || "");

// 4) assertion options
r = await api("/api/auth/passkey/stepup", { method: "POST", body: { phase: "options" }, rawCookie: cookieHeader() });
ok("assertion options issued", r.status === 200 && !!r.json.challenge && r.json.allowCredentials?.length === 1);

// wrong-key assertion must fail
const wrongKey = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
{
  const cd = clientDataJson("webauthn.get", r.json.challenge);
  const authData = Buffer.concat([rpIdHash(), Buffer.from([0x05]), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(1); return b; })()]);
  const badSig = crypto.sign("sha256", Buffer.concat([authData, crypto.createHash("sha256").update(Buffer.from(cd, "utf8")).digest()]), wrongKey);
  const rr = await api("/api/auth/passkey/stepup", {
    method: "POST",
    body: {
      phase: "verify",
      response: {
        id: b64u(CRED_ID), rawId: b64u(CRED_ID), type: "public-key",
        response: {
          clientDataJSON: b64u(Buffer.from(cd, "utf8")),
          authenticatorData: b64u(authData),
          signature: b64u(badSig),
        },
      },
    },
    rawCookie: cookieHeader(),
  });
  ok("wrong-key assertion rejected", rr.status === 400, rr.json.error || "");
}

// 5) real assertion (fresh challenge — the wrong-key attempt burned the old one)
r = await api("/api/auth/passkey/stepup", { method: "POST", body: { phase: "options" }, rawCookie: cookieHeader() });
const asr = makeAssertion(r.json.challenge, 1);
r = await api("/api/auth/passkey/stepup", {
  method: "POST",
  body: {
    phase: "verify",
    response: {
      id: b64u(CRED_ID), rawId: b64u(CRED_ID), type: "public-key",
      response: {
        clientDataJSON: b64u(Buffer.from(asr.cd, "utf8")),
        authenticatorData: b64u(asr.authData),
        signature: b64u(asr.sig),
      },
    },
  },
  rawCookie: cookieHeader(),
});
ok("assertion verified, step-up cookie set", r.status === 200 && r.json.ok === true, `until ${r.json.until ? new Date(r.json.until * 1000).toISOString() : "?"}`);
storeCookies(r);
ok("stepup cookie present", jar.has("agentpay_stepup"));

// 6) counter / replay protection: reusing the SAME assertion must fail
r = await api("/api/auth/passkey/stepup", { method: "POST", body: { phase: "options" }, rawCookie: cookieHeader() });
r = await api("/api/auth/passkey/stepup", {
  method: "POST",
  body: {
    phase: "verify",
    response: {
      id: b64u(CRED_ID), rawId: b64u(CRED_ID), type: "public-key",
      response: {
        clientDataJSON: b64u(Buffer.from(asr.cd.replace(/"challenge":"[^"]+"/, `"challenge":"${r.json.challenge}"`), "utf8")),
        authenticatorData: b64u(asr.authData),
        signature: b64u(asr.sig),
      },
    },
  },
  rawCookie: cookieHeader(),
});
ok("signature replay rejected (counter/challenge)", r.status === 400, r.json.error || "");

// 7) enforcement: create merchant + subscription with this wallet, then PUT
r = await api("/api/merchants", { method: "POST", body: { name: "Passkey Gate Test", currency: "ZAR" }, rawCookie: cookieHeader() });
ok("merchant created for session wallet", r.status === 200 && !!r.json.merchant?.id);
const merchantId = r.json.merchant.id;

r = await api("/api/subscriptions", {
  method: "POST",
  body: { merchantId, customerName: "Gate Tester", planName: "Weekly Stock", amount: "25", interval: "WEEKLY" },
  rawCookie: cookieHeader(),
});
ok("subscription created", r.status === 200 && !!r.json.subscription?.id);
const subId = r.json.subscription.id;

// strip the step-up cookie -> gate must answer 403
const sessionOnly = [...jar.values()].filter((c) => !c.startsWith("agentpay_stepup=")).join("; ");
r = await api("/api/subscriptions", { method: "PUT", body: { subscriptionId: subId }, rawCookie: sessionOnly });
ok("PUT /api/subscriptions gated (403 without step-up)", r.status === 403 && r.json.code === "PASSKEY_STEPUP_REQUIRED", JSON.stringify(r.json));

r = await api("/api/subscriptions", { method: "PUT", body: { subscriptionId: subId }, rawCookie: cookieHeader() });
ok("PUT /api/subscriptions allowed with step-up", r.status === 200 && r.json.subscription?.chargesCount === 1, JSON.stringify(r.json?.subscription || r.json));

// 8) invoice endpoint obeys the same policy
r = await api("/api/invoices", { method: "POST", body: { merchantId, customerName: "Gate Tester", amount: "10", dueDays: 7 }, rawCookie: cookieHeader() });
const invId = r.json.invoice?.id;
r = await api("/api/invoices", { method: "PUT", body: { invoiceId: invId }, rawCookie: cookieHeader() });
ok("PUT /api/invoices allowed with step-up (5-min window)", r.status === 200 && r.json.invoice?.status === "PAID");

console.log("\nsummary: passkey step-up E2E " + (process.exitCode ? "FAILED" : "ALL PASS") + `  (${new Date().toISOString()})`);
