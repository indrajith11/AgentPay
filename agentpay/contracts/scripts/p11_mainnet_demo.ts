import hre from "hardhat";
const { ethers } = hre;
import * as fs from "fs";

/**
 * P11 — MAINNET DEMO (chain 1990): judge-visible real commerce on AgentPay.
 * Adapted from e2e_live.ts (testnet) to mainnet: official QIE/USD oracle,
 * fresh roles, tight gas budget, PHASE split so the 600s escrow window
 * doesn't block one command.
 *
 *   PHASE=demo   (default) merchant+verify -> USD product -> agent+mandate
 *                -> payForCall x2 -> refundCall (dispute) -> invoice paid
 *                -> subscription created  [all tx hashes recorded]
 *   PHASE=settle            escrow claim after window -> subscription
 *                chargeDue -> keeper auto-withdraw sweep -> final state
 *
 * Run: PHASE=demo npx hardhat run scripts/p11_mainnet_demo.ts --network qieMainnet
 */

const ADDR = JSON.parse(fs.readFileSync("addresses/qieMainnet.json", "utf8"));
const WQIE = ADDR.WQIE;
const FEED = ADDR.usdFeedAddress; // OFFICIAL QIE/USD oracle — no mocks on mainnet
const ROLES_FILE = "addresses/e2e_roles_qieMainnet.json";
const PROOF_FILE = "addresses/e2e_proof_qieMainnet.json";
const PHASE = (process.env.PHASE || "demo").toLowerCase();

function log(step: string, msg: string) { console.log(`[${step}] ${msg}`); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [deployer] = await ethers.getSigners();
  const proof: any = fs.existsSync(PROOF_FILE)
    ? JSON.parse(fs.readFileSync(PROOF_FILE, "utf8"))
    : { network: "qieMainnet", chainId: 1990, startedAt: new Date().toISOString(), steps: {}, txs: [] };
  const rec = (k: string, hash: string) => {
    proof.steps[k] = hash;
    proof.txs.push({ step: k, hash, at: new Date().toISOString() });
  };

  const wqie = await ethers.getContractAt("WQIE", WQIE);
  const merchantRegistry = await ethers.getContractAt("MerchantRegistry", ADDR.MerchantRegistry);
  const agentRegistry = await ethers.getContractAt("AgentRegistry", ADDR.AgentRegistry);
  const mandateVault = await ethers.getContractAt("MandateVault", ADDR.MandateVault);
  const payEndpoint = await ethers.getContractAt("PayEndpoint", ADDR.PayEndpoint);
  const escrow = await ethers.getContractAt("EscrowCore", ADDR.EscrowCore);
  const router = await ethers.getContractAt("SettlementRouter", ADDR.SettlementRouter);
  const invoiceVault = await ethers.getContractAt("InvoiceVault", ADDR.InvoiceVault);
  const creditPassport = await ethers.getContractAt("CreditPassport", ADDR.CreditPassport);
  const recurring = await ethers.getContractAt("RecurringMandate", ADDR.RecurringMandate);

  // ---------- roles (persisted across phases) ----------
  let roles: any;
  if (fs.existsSync(ROLES_FILE)) roles = JSON.parse(fs.readFileSync(ROLES_FILE, "utf8"));
  else {
    roles = { principal: ethers.Wallet.createRandom().privateKey, agent: ethers.Wallet.createRandom().privateKey, providerAcct: ethers.Wallet.createRandom().privateKey };
    fs.writeFileSync(ROLES_FILE, JSON.stringify(roles, null, 2));
  }
  const principal = new ethers.Wallet(roles.principal, ethers.provider);
  const agent = new ethers.Wallet(roles.agent, ethers.provider);
  const providerAcct = new ethers.Wallet(roles.providerAcct, ethers.provider);
  log("roles", `merchant=${deployer.address} principal=${principal.address} agent=${agent.address}`);

  const send = async (build: () => Promise<any>, label: string, tries = 3): Promise<any> => {
    for (let i = 0; i < tries; i++) {
      try { const tx = await build(); const rc = await tx.wait(); rec(label, tx.hash); log("tx", `${label} -> ${tx.hash}`); return rc; }
      catch (e: any) {
        const last = i === tries - 1;
        log("tx", `${label} attempt ${i + 1} ${last ? "FAILED" : "failed — retry"}`);
        if (last) throw e;
        await sleep(4000);
      }
    }
  };

  if (PHASE === "demo") {
    const depBal = await ethers.provider.getBalance(deployer.address);
    log("gas", `deployer ${ethers.formatEther(depBal)} QIE — budget: fund roles ~0.25 + tx gas << 1 QIE`);
    if (depBal < ethers.parseEther("0.5")) throw new Error("deployer low on gas — top up before demo");

    // ---------- fund roles (gas only) ----------
    const fund = async (w: any, need: string, label: string) => {
      const bal = await ethers.provider.getBalance(w.address);
      if (bal < ethers.parseEther(need)) {
        const sendv = ethers.parseEther(need) - bal + ethers.parseEther("0.02");
        await send(async () => deployer.sendTransaction({ to: w.address, value: sendv }), `fund_${label}`);
        log("fund", `${label} -> ${ethers.formatEther(await ethers.provider.getBalance(w.address))} QIE`);
      }
    };
    await fund(principal, "2.2", "principal"); // covers ~1.56 QIE wrap (2 calls @ $0.10 @ QIE≈$0.18) + invoice 0.3 + sub 0.15 + gas
    await fund(agent, "0.04", "agent");
    await fund(providerAcct, "0.01", "providerAcct");

    // ---------- 1. merchant onboarding (idempotent) ----------
    const mInfo = await merchantRegistry.getMerchant(deployer.address).catch(() => null);
    const registered = mInfo && String(mInfo[0] ?? "") !== "" && (mInfo.registered === true || Number(mInfo[0]) > 0 || String(mInfo.merchantAddr ?? "") !== "");
    if (!registered && !(await merchantRegistry.isVerifiedMerchant(deployer.address).catch(() => false))) {
      try {
        await send(async () => (merchantRegistry as any).connect(deployer).registerMerchant("AgentPay Demo Store - QIE Mainnet", "ipfs://agentpay-merchant-demo-1"), "registerMerchant");
      } catch (e: any) { if (!/already|register/i.test(e?.message ?? "")) throw e; log("merchant", "already registered"); }
    }
    if (!(await merchantRegistry.isVerifiedMerchant(deployer.address))) {
      await send(async () => (merchantRegistry as any).connect(deployer).verifyMerchant(deployer.address, true), "verifyMerchant");
    }
    log("merchant", `verified=${await merchantRegistry.isVerifiedMerchant(deployer.address)} count=${await merchantRegistry.merchantCount()}`);

    // ---------- 2. USD product ($0.10/call, OFFICIAL oracle) ----------
    const feed = new ethers.Contract(FEED, ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)"], ethers.provider);
    const [fdec, fdata] = await Promise.all([feed.decimals(), feed.latestRoundData()]);
    const px = Number(ethers.formatUnits(fdata[1], fdec));
    log("oracle", `OFFICIAL QIE/USD = $${px.toFixed(6)} (feed ${FEED})`);
    if ((await payEndpoint.nextProductId()) === 1n) {
      await send(async () => (payEndpoint as any).connect(deployer).addProductUsd("AgentPay AI Vision API", "/v1/vision", "ipfs://agentpay-product-1", 10000000n), "addProductUsd");
    }
    const quote = await payEndpoint.quoteIn(1n, WQIE);
    log("product", `product#1 $0.10/call -> ${ethers.formatEther(quote)} WQIE at official price`);

    // ---------- 3. MACHINE RAIL: agent + mandate + payForCall x2 ----------
    const agentInfo = await agentRegistry.getAgent(agent.address);
    if (agentInfo.agentAddr === ethers.ZeroAddress) await send(async () => (agentRegistry as any).connect(agent).registerAgent("AgentPay ShoppingAgent-v1"), "registerAgent");
    if ((await agentRegistry.getAgent(agent.address)).principal === ethers.ZeroAddress) await send(async () => (agentRegistry as any).connect(principal).bindPrincipal(agent.address, "qiepass:principal-demo-001"), "bindPrincipal");
    log("agent", `eligible=${await agentRegistry.isEligibleAgent(agent.address)}`);

    const needW = 2n * quote + ethers.parseEther("0.3") + ethers.parseEther("0.15");
    if ((await wqie.balanceOf(principal.address)) < needW) {
      const miss = needW - (await wqie.balanceOf(principal.address));
      await send(async () => (wqie as any).connect(principal).deposit({ value: miss }), "wrapQIE");
    }
    log("wqie", `principal WQIE=${ethers.formatEther(await wqie.balanceOf(principal.address))}`);

    let mandateId = (await mandateVault.nextMandateId()) - 1n;
    if (mandateId === 0n) {
      await send(async () => (wqie as any).connect(principal).approve(await mandateVault.getAddress(), ethers.parseEther("1.2")), "approveMandateVault");
      await send(async () => (mandateVault as any).connect(principal).createMandate(agent.address, WQIE, ethers.parseEther("0.6"), ethers.parseEther("1.5"), ethers.parseEther("1.2")), "createMandate");
      mandateId = 1n;
      log("mandate", `mandate#1 live: 1.2 WQIE prepaid, $0.60/call + $1.50/day caps`);
    }
    if (!(await mandateVault.authorizedCallers(mandateId, ADDR.PayEndpoint))) {
      await send(async () => (mandateVault as any).connect(principal).authorizeCaller(mandateId, ADDR.PayEndpoint, true), "authorizePayEndpoint");
    }

    for (const cid of [1n, 2n]) {
      if ((await payEndpoint.nextCallId()) <= cid) {
        await send(async () => (payEndpoint as any).connect(agent).payForCall(mandateId, 1n, WQIE), `payForCall#${cid}`);
      }
      const c = await payEndpoint.calls(cid);
      log("machine", `call#${cid} escrow=${c.escrowId} amount=${ethers.formatEther(c.amount ?? quote)} WQIE`);
    }

    // ---------- 4. DISPUTE RAIL: refund call#2 ----------
    const st2 = await escrow.statusOf((await payEndpoint.calls(2n)).escrowId);
    if (Number(st2[0]) === 0) {
      await send(async () => (payEndpoint as any).connect(principal).refundCall(2n), "refundCall");
      log("dispute", "call#2 refunded to principal inside 600s window — user protection PROVEN");
    } else log("dispute", `call#2 already resolved (state=${st2[0]})`);

    // ---------- 5. HUMAN RAIL: invoice -> payInvoice ----------
    if ((await invoiceVault.nextInvoiceId()) === 1n) {
      const dueAt = BigInt(Math.floor(Date.now() / 1000) + 86400);
      await send(async () => (invoiceVault as any).connect(deployer).createInvoice(WQIE, principal.address, ethers.parseEther("0.3"), dueAt, "cust-demo-001", "ipfs://agentpay-inv-demo-1"), "createInvoice");
    }
    const inv = await invoiceVault.invoices(1n);
    if (Number(inv.status) === 0) {
      const haveW = await wqie.balanceOf(principal.address);
      if (haveW < ethers.parseEther("0.3")) await send(async () => (wqie as any).connect(principal).deposit({ value: ethers.parseEther("0.3") - haveW }), "wrapQIE_invoice");
      await send(async () => (wqie as any).connect(principal).approve(await invoiceVault.getAddress(), ethers.parseEther("0.3")), "approveInvoiceVault");
      await send(async () => (invoiceVault as any).connect(principal).payInvoice(1n, ethers.parseEther("0.3")), "payInvoice");
    }
    log("invoice", `invoice#1 status=${(await invoiceVault.invoices(1n)).status} routerWithdrawable=${ethers.formatEther(await router.totalWithdrawable(deployer.address, WQIE))} WQIE`);

    // ---------- 6. SUBSCRIPTION RAIL: RecurringMandate ----------
    if ((await recurring.subCount()) === 0n) {
      await send(async () => (wqie as any).connect(principal).approve(await recurring.getAddress(), ethers.parseEther("0.15")), "approveRecurring");
      await send(async () => (recurring as any).connect(principal).createSubscription(deployer.address, WQIE, ethers.parseEther("0.05"), 120, "agentpay-pro-demo", ethers.parseEther("0.15")), "createSubscription");
      log("subs", "subscription#1: 0.05 WQIE/120s, 0.15 prepaid (due in ~2 min — PHASE=settle will charge)");
    } else log("subs", `subCount=${await recurring.subCount()} (already created)`);

    // ---------- credit readout ----------
    const cp = await creditPassport.getScore(principal.address);
    log("credit", `principal passport score=${cp[0]} onTime=${cp[1]} late=${cp[2]} — EARNED from settled payments`);
  }

  if (PHASE === "settle") {
    // ---------- 7. escrow claim after window ----------
    const call1 = await payEndpoint.calls(1n);
    const st1 = await escrow.statusOf(call1.escrowId);
    if (Number(st1[0]) === 0) {
      const waitSec = Number(st1[1]) + 10 - Math.floor(Date.now() / 1000);
      if (waitSec > 0) { log("wait", `refund window — sleeping ${waitSec}s`); await sleep(waitSec * 1000); }
      await send(async () => (payEndpoint as any).connect(deployer).claimCall(1n), "claimCall");
      log("claim", "call#1 settled to merchant — escrow completed");
    } else log("claim", `call#1 state=${st1[0]} (already resolved)`);

    // ---------- 8. subscription chargeDue ----------
    if ((await recurring.subCount()) >= 1n && (await recurring.isDue(1n))) {
      await send(async () => (recurring as any).connect(deployer).chargeDue(1n), "chargeDue");
      const s = await recurring.subs(1n);
      log("subs", `subscription#1 charged ${ethers.formatEther(s.amountPerCycle)} WQIE, charges=${s.chargesCount} — recurring revenue PROVEN`);
    } else log("subs", "sub#1 not due yet or absent");

    // ---------- 9. keeper auto-withdraw (profile FIRST, then sweep) ----------
    const prof0 = await router.payoutProfileOf(deployer.address);
    if (!prof0.active) {
      await send(async () => (router as any).connect(deployer).setPayoutProfile({
        payoutAddress: providerAcct.address, providerRef: ethers.keccak256(ethers.toUtf8Bytes("agentpay-demo-zar-001")),
        provider: "demo-offramp", fiatCurrency: "ZAR", rail: 1, minThreshold: ethers.parseEther("0.05"),
        interval: 60, lastPayoutAt: 0, autoEnabled: true, active: true,
      }), "setPayoutProfile");
    }
    if ((await router.totalWithdrawable(deployer.address, WQIE)) > 0n) {
      await send(async () => (router as any).connect(principal).executeAutoWithdraw(WQIE, deployer.address), "executeAutoWithdraw");
    }
    log("payout", `off-ramp deposit holds ${ethers.formatEther(await wqie.balanceOf((await router.payoutProfileOf(deployer.address)).payoutAddress))} WQIE (ZAR settlement profile)`);
  }

  // ---------- final state ----------
  const mandateIdNow = (await mandateVault.nextMandateId()) - 1n;
  proof.finalState = {
    merchantWQIE: ethers.formatEther(await wqie.balanceOf(deployer.address)),
    deployerQIE: ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    mandateBalance: mandateIdNow > 0n ? ethers.formatEther((await mandateVault.mandates(mandateIdNow)).balance) : "0",
    routerWithdrawable: ethers.formatEther(await router.totalWithdrawable(deployer.address, WQIE)),
    roles: { principal: principal.address, agent: agent.address, providerAcct: providerAcct.address },
    updatedAt: new Date().toISOString(),
  };
  proof.deployedContracts = ADDR;
  fs.writeFileSync(PROOF_FILE, JSON.stringify(proof, null, 2));
  console.log(`\nPROOF SAVED -> ${PROOF_FILE} (${proof.txs.length} txs recorded)`);
  console.log(JSON.stringify(proof.finalState, null, 2));
}

main().catch((e) => { console.error(e?.message?.slice(0, 500) ?? e); process.exitCode = 1; });
