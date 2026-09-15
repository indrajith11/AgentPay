// P2 E2E — cash register polish, proven on live QIE testnet 1983:
//  A) SHORT payment  -> matcher must NOT book it; near-miss (underpaid)
//     failure state must surface with the actual tx
//  B) EXACT payment  -> PAID flip; we measure detection latency (target <3s)
//  C) ledger truth   -> overview feed shows the auto-confirmed booking
import { ethers } from "ethers";

const APP = "http://localhost:3000";
const RPC = "https://rpc1testnet.qie.digital/";
const FUNDER_KEY = process.env.FUNDER_KEY || process.env.DEPLOYER_PRIVATE_KEY || "";
if (!FUNDER_KEY) { console.log("Set FUNDER_KEY (testnet funder) in env to run this E2E"); process.exit(1); }

const p = new ethers.JsonRpcProvider(RPC, 1983, { staticNetwork: true });
const funder = new ethers.Wallet(FUNDER_KEY, p);
const fb = await p.getBalance(funder.address);
console.log("funder", funder.address, "balance", ethers.formatEther(fb), "QIE");

// Self-sizing: two bills are paid (60% short + exact) = 1.6 x bill. Pick the
// largest ZAR amount that fits in 85% of the remaining funder balance so the
// suite stays runnable as testnet dust runs out (gas on QIE is ~7 wei/unit,
// effectively free).
const priceRes = await fetch(APP + "/api/price").then((r) => r.json()).catch(() => null);
const qieUsd = priceRes?.qieUsd || 0.16;
const spendable = Number(ethers.formatEther(fb)) * 0.85 / 1.6;
const zarMax = (spendable * qieUsd) / 0.055;
const ZAR = Math.max(0.0001, Math.floor(zarMax * 10000) / 10000);
console.log(`oracle $${qieUsd.toFixed(4)} -> self-sized bill: ${ZAR} ZAR`);

// 1) fresh merchant wallet (no gas needed — off-chain signatures only)
const mw = ethers.Wallet.createRandom().connect(p);
const nres = await fetch(APP + "/api/auth/nonce", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ address: mw.address }),
});
const { message } = await nres.json();
const signature = await mw.signMessage(message);
const vres = await fetch(APP + "/api/auth/verify", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ address: mw.address, message, signature }),
});
const cookie = (vres.headers.get("set-cookie") || "").split(";")[0];
if (!vres.ok || !cookie) { console.log("FAIL SIWE"); process.exit(1); }
console.log("SIWE OK —", mw.address);

const mres = await fetch(APP + "/api/merchants", {
  method: "POST", headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ name: "P2 Register Test " + Date.now().toString(36), currency: "ZAR" }),
});
const { merchant, error } = await mres.json();
if (!mres.ok) { console.log("FAIL merchant:", error); process.exit(1); }
console.log("merchant", merchant.id);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

// ================= A) SHORT payment -> near-miss, never PAID =================
{
  const sres = await fetch(APP + "/api/qr-sale", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ merchantId: merchant.id, amount: String(ZAR) }),
  });
  const sj = await sres.json();
  console.log("\n[A] sale", sj.saleId, "bill", sj.qieAmount, "QIE — paying only 60% of it…");
  const shortWei = (BigInt(sj.amountWei) * 6n) / 10n;
  const pay = await funder.sendTransaction({ to: sj.payee, value: shortWei });
  await pay.wait();
  console.log("[A] short payment tx", pay.hash.slice(0, 18) + "…");

  let sawNearMiss = null, booked = false;
  for (let i = 0; i < 20; i++) { // ~24s at 1.2s cadence (past the 8s grace)
    await sleep(1200);
    const g = await (await fetch(APP + `/api/qr-sale?id=${sj.saleId}`)).json();
    if (g.status === "PAID") { booked = true; break; }
    if (g.nearMiss) { sawNearMiss = g.nearMiss; }
  }
  if (booked) { console.log("FAIL [A]: short payment was BOOKED as a full sale!"); process.exit(1); }
  if (!sawNearMiss) { console.log("FAIL [A]: near-miss never surfaced"); process.exit(1); }
  const match = sawNearMiss.txHash === pay.hash;
  console.log("[A] PASS — near-miss surfaced:", sawNearMiss.valueQie, "QIE vs", sj.qieAmount, "QIE bill, tx match:", match);
  if (!match) failures++;
}

// ================= B) EXACT payment -> PAID flip < 3s =================
let paidInfo;
{
  const sres = await fetch(APP + "/api/qr-sale", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ merchantId: merchant.id, amount: String(ZAR) }),
  });
  const sj = await sres.json();
  console.log("\n[B] sale", sj.saleId, "bill", sj.qieAmount, "QIE — paying EXACT wei…");

  const t0 = Date.now(); // payment send -> PAID flip is the judge-visible metric
  const pay = await funder.sendTransaction({ to: sj.payee, value: BigInt(sj.amountWei) });
  await pay.wait();
  const tMined = Date.now();
  console.log("[B] payment mined in", ((tMined - t0) / 1000).toFixed(2) + "s tx", pay.hash.slice(0, 18) + "…");

  let paid = null;
  for (let i = 0; i < 30; i++) { // poll at the UI's 1.2s cadence
    await sleep(1200);
    const g = await (await fetch(APP + `/api/qr-sale?id=${sj.saleId}`)).json();
    if (g.status === "PAID") { paid = g; break; }
    if (g.status === "EXPIRED") break;
  }
  const tFlip = Date.now();
  if (!paid) { console.log("FAIL [B]: never PAID"); process.exit(1); }
  const flipS = (tFlip - tMined) / 1000;      // detection latency after mining
  const totalS = (tFlip - t0) / 1000;         // pay -> PAID end to end
  console.log(`[B] PAID — flip after mine: ${flipS.toFixed(2)}s | pay->PAID total: ${totalS.toFixed(2)}s | server paidInMs: ${paid.paidInMs}ms | alreadyBooked: ${!!paid.alreadyBooked}`);
  console.log("[B] explorer:", paid.explorerUrl);
  if (flipS >= 3) failures++;
  paidInfo = { flipS, totalS, tx: paid.txHash };
}

// ================= C) ledger truth =================
{
  await sleep(1000);
  const ov = await (await fetch(APP + `/api/overview?merchantId=${merchant.id}`)).json();
  const saleEvts = (ov.events || []).filter((e) => e.title === "QR sale auto-confirmed");
  const ledger = (ov.ledger || []).filter((l) => l.kind === "SALE");
  console.log("\n[C] auto-confirmed events:", saleEvts.length, "| SALE ledger rows:", ledger.length);
  if (saleEvts.length < 1) { console.log("FAIL [C]: booking missing from feed"); failures++; }
  console.log("[C] latest:", saleEvts[0]?.detail?.slice(0, 140));
}

console.log(`\nP2 QR E2E: ${failures === 0 ? "ALL PASS" : "FAILED (" + failures + ")"} — flip ${paidInfo.flipS.toFixed(2)}s after mine, ${paidInfo.totalS.toFixed(2)}s pay->PAID`);
process.exit(failures ? 1 : 0);
