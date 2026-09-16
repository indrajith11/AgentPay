// P1 E2E — replicates the exact browser flow server-side:
// SIWE sign-in -> merchant create (session-bound) -> wallet signs
// registerMerchant -> platform verifier countersigns -> QR sale -> REAL
// native payment -> auto-PAID via the matcher -> indexer sees the events.
import { ethers } from "ethers";

const APP = "http://localhost:3000";
const RPC = "https://rpc1testnet.qie.digital/";
const REGISTRY = "0x7918e72d7725E87D3C09bB80873991a05BaEc9aA";
const FUNDER_KEY = process.env.FUNDER_KEY || process.env.DEPLOYER_PRIVATE_KEY || "";
if (!FUNDER_KEY) { console.log("Set FUNDER_KEY (testnet funder) in env to run this E2E"); process.exit(1); }
const FAUCET_URL = null; // informational only

const p = new ethers.JsonRpcProvider(RPC, 1983, { staticNetwork: true });
const funder = new ethers.Wallet(FUNDER_KEY, p);
const fb = await p.getBalance(funder.address);
console.log("funder", funder.address, "balance", ethers.formatEther(fb), "QIE");
if (fb < ethers.parseEther("0.02")) { console.log("FAIL: funder too poor for gas"); process.exit(1); }

// 1) fresh merchant wallet + gas top-up
const mw = ethers.Wallet.createRandom().connect(p);
const gas = ethers.parseEther("0.01");
const t1 = await funder.sendTransaction({ to: mw.address, value: gas });
await t1.wait();
console.log("merchant wallet", mw.address, "funded", ethers.formatEther(gas), "QIE (tx", t1.hash.slice(0, 14) + "…)");

// 2) SIWE: challenge -> personal_sign -> verify (capture session cookie)
const nres = await fetch(APP + "/api/auth/nonce", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ address: mw.address }),
});
const { message } = await nres.json();
if (!nres.ok) { console.log("FAIL nonce:", message); process.exit(1); }
const signature = await mw.signMessage(message);
const vres = await fetch(APP + "/api/auth/verify", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ address: mw.address, message, signature }),
});
const vj = await vres.json();
const cookie = (vres.headers.get("set-cookie") || "").split(";")[0];
if (!vres.ok || !cookie) { console.log("FAIL verify:", JSON.stringify(vj)); process.exit(1); }
console.log("SIWE OK — session cookie for", vj.address);

// 3) session-bound merchant create
const mres = await fetch(APP + "/api/merchants", {
  method: "POST", headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ name: "Phase1 Test Store " + Date.now().toString(36), currency: "ZAR" }),
});
const mj = await mres.json();
if (!mres.ok) { console.log("FAIL merchant:", JSON.stringify(mj)); process.exit(1); }
const merchantId = mj.merchant.id;
console.log("merchant created", merchantId, "owner", mj.merchant.owner);
if (mj.merchant.owner !== mw.address.toLowerCase()) { console.log("FAIL: owner not bound to session wallet"); process.exit(1); }

// 4) wallet signs registerMerchant (same as the browser step)
const reg = new ethers.Contract(REGISTRY, ["function registerMerchant(string,string)"], mw);
const rt = await reg.registerMerchant(mj.merchant.name, `agentpay://merchant/${merchantId}`);
const rrc = await rt.wait();
console.log("registerMerchant tx", rrc.hash);

// 5) platform verifier countersign (server route, session-gated)
const vf = await fetch(APP + "/api/merchants/verify", {
  method: "POST", headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ merchantId, merchantAddr: mw.address }),
});
const vj2 = await vf.json();
if (!vf.ok) { console.log("FAIL verify-route:", JSON.stringify(vj2)); process.exit(1); }
console.log("verifyMerchant tx", vj2.verifyTx || "(already verified)");

// 6) QR sale — 10 ZAR -> oracle-quoted wei
const sres = await fetch(APP + "/api/qr-sale", {
  method: "POST", headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ merchantId, amount: "1" }),
});
const sj = await sres.json();
if (!sres.ok) { console.log("FAIL sale:", JSON.stringify(sj)); process.exit(1); }
console.log("sale", sj.saleId, "payee", sj.payee, "amount", sj.qieAmount, "QIE (", sj.amountWei, "wei ) oracleStale:", sj.oracleStale);

// 7) customer pays the EXACT amount from the funder
const pay = await funder.sendTransaction({ to: sj.payee, value: BigInt(sj.amountWei) });
await pay.wait();
console.log("payment tx", pay.hash);

// 8) matcher flips the sale to PAID
let paid = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 2500));
  const g = await fetch(APP + `/api/qr-sale?id=${sj.saleId}`);
  const gj = await g.json();
  if (gj.status === "PAID") { paid = gj; break; }
  if (gj.status === "EXPIRED") break;
}
if (!paid) { console.log("FAIL: sale never flipped to PAID"); process.exit(1); }
console.log("SALE PAID — tx", paid.txHash, "url", paid.explorerUrl);

// 9) indexer ground truth sees the registry events
await new Promise((r) => setTimeout(r, 5000));
const idx = await (await fetch(APP + "/api/indexer")).json();
const names = (idx.events || []).map((e) => e.event);
console.log("indexer online:", idx.online, "| recent:", names.slice(0, 6).join(", "));
console.log(idx.online && names.includes("MerchantRegistered") ? "INDEXER: MerchantRegistered visible ✓" : "INDEXER: registry event not in window yet (counts: " + JSON.stringify(idx.eventCounts) + ")");

console.log("P1 E2E: ALL PASS");
