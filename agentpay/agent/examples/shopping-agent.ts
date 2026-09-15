/**
 * REFERENCE AGENT 1/3 — Shopping Agent (X-06)
 * ===========================================
 * An autonomous agent buying goods at a QR store — the P2 cash-register
 * flow driven entirely by machine money:
 *
 *   1. SELLER: opens a store + a self-sized QR sale on the AgentPay app
 *      (SIWE session, no human in the loop)
 *   2. AGENT:  reads the EIP-681 payment terms (payee + exact wei), pays
 *      the EXACT amount in one native transfer, and NOTHING else —
 *      over/under payment never books
 *   3. MATCHER: detects the payment in blocks, flips the sale to PAID,
 *      books SALE + FEE ledger rows automatically
 *
 * Env:
 *   AGENT_PRIVATE_KEY   payer wallet (agent money)          [required]
 *   SELLER_PRIVATE_KEY  store wallet (session only, no gas) [optional — random seller]
 *   APP_URL             AgentPay dashboard base             [default http://localhost:3000]
 *   ZAR_AMOUNT          bill size in ZAR                    [default: self-sized to balance]
 */
import { ethers } from "ethers";
import { AgentPayClient, AgentPayError } from "../sdk/src/index.js";

const RPC = process.env.AGENTPAY_RPC || "https://rpc1testnet.qie.digital/";
const APP = process.env.APP_URL || "http://localhost:3000";
const log = (...a: unknown[]) => console.log(...a);

const agentKey = process.env.AGENT_PRIVATE_KEY;
if (!agentKey) { console.error("Set AGENT_PRIVATE_KEY (the machine wallet that pays)"); process.exit(1); }

const provider = new ethers.JsonRpcProvider(RPC, 1983, { staticNetwork: true });
const agent = new ethers.Wallet(agentKey, provider);
const sdk = new AgentPayClient({ privateKey: agentKey });
const seller = new ethers.Wallet(process.env.SELLER_PRIVATE_KEY || ethers.Wallet.createRandom().privateKey, provider);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sellerSession(): Promise<string> {
  const nonce = await (await fetch(`${APP}/api/auth/nonce`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: seller.address }),
  })).json();
  const signature = await seller.signMessage(nonce.message);
  const res = await fetch(`${APP}/api/auth/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: seller.address, message: nonce.message, signature }),
  });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  if (!res.ok || !cookie) throw new Error("seller SIWE failed");
  return cookie;
}

async function main() {
  log(`SHOPPING AGENT — ${agent.address}`);
  log(`  balance: ${ethers.formatEther(await provider.getBalance(agent.address))} QIE (gas on QIE ≈ free)\n`);

  // ---- 1) the seller opens a store + a QR sale -------------------------
  const cookie = await sellerSession();
  const { merchant } = await (await fetch(`${APP}/api/merchants`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Agent Shop (reference)", currency: "ZAR" }),
  })).json();
  log(`[seller] store open: ${merchant.id}`);

  // self-size the bill to the agent's balance so the demo always runs
  const price = await (await fetch(`${APP}/api/price`)).json();
  const bal = Number(ethers.formatEther(await provider.getBalance(agent.address)));
  const zarMax = ((bal * 0.5) * (price.qieUsd || 0.16)) / 0.055; // pay <=50% of balance
  const zar = process.env.ZAR_AMOUNT || String(Math.max(0.0001, Math.floor(zarMax * 10000) / 10000));
  const sale = await (await fetch(`${APP}/api/qr-sale`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ merchantId: merchant.id, amount: zar }),
  })).json();
  log(`[seller] sale ${sale.saleId}: ${zar} ZAR = ${sale.qieAmount} QIE (payee ${sale.payee})`);
  log(`[seller] EIP-681 terms: ${sale.uri.slice(0, 72)}…\n`);

  // ---- 2) the agent reads the terms and pays the EXACT amount ----------
  const terms = decodeEip681(sale.uri);
  log(`[agent] parsed terms: pay ${ethers.formatEther(terms.valueWei)} QIE -> ${terms.payee} @ chain ${terms.chainId}`);
  if (terms.chainId !== 1983) throw new AgentPayError("RPC_ERROR", `sale is on chain ${terms.chainId}, agent is on 1983`);
  const t0 = Date.now();
  const tx = await agent.sendTransaction({ to: terms.payee, value: terms.valueWei });
  const rec = await tx.wait();
  log(`[agent] paid EXACT amount — tx ${rec!.hash.slice(0, 22)}… (mined ${(Date.now() - t0) / 1000}s)`);
  log(`[agent] explorer: https://testnet.qie.digital/tx/${rec!.hash}\n`);

  // ---- 3) matcher auto-confirms; agent polls like any customer app -----
  for (let i = 0; i < 30; i++) {
    await sleep(1200);
    const s = await (await fetch(`${APP}/api/qr-sale?id=${sale.saleId}`)).json();
    if (s.status === "PAID") {
      log(`[matcher] PAID in ${(Date.now() - t0) / 1000}s — ${s.qieAmount} QIE booked automatically`);
      log(`[matcher] ledger: SALE + 0.3% FEE rows written, zero merchant interaction`);
      log(`\nRESULT: agent purchased ${zar} ZAR of goods — human scanned nothing, pasted nothing.`);
      return;
    }
    if (s.status === "EXPIRED") throw new AgentPayError("TIMEOUT", "sale expired before payment detected");
  }
  throw new AgentPayError("TIMEOUT", "matcher did not confirm within 36s");
}

function decodeEip681(uri: string): { payee: string; valueWei: bigint; chainId: number } {
  const u = new URL(uri.replace(/^ethereum:/, "https://x/"));
  const payee = u.pathname.split("@")[0].replace(/^\//, "");
  const chainId = Number(u.pathname.split("@")[1]);
  return { payee, chainId, valueWei: BigInt(u.searchParams.get("value")!) };
}

main().catch((e) => {
  const code = (e as { code?: string }).code;
  console.error(`FAILED${code ? ` [${code}]` : ""}:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
