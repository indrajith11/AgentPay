import hre from "hardhat";
const { ethers } = hre;
import * as fs from "fs";

/**
 * LIVE end-to-end proof on QIE Testnet (1983) — the "working model" evidence.
 * Idempotent across re-runs (persisted roles, on-chain counters, state checks)
 * with a retry helper for the chain's occasional transient reverts.
 *
 *   MACHINE RAIL : merchant+agent register -> principal binds agent (KYA)
 *                  -> prepaid mandate (caps) -> PayEndpoint authorized
 *                  -> USD product via oracle feed -> agent payForCall x2
 *                  -> refundCall (dispute) -> [600s window] -> claimCall
 *   HUMAN RAIL   : invoice -> payInvoice -> SettlementRouter.credit
 *   FIAT-OUT     : PayoutProfile (VALR/ZAR) -> executeAutoWithdraw (keeper)
 */

const ADDR = JSON.parse(fs.readFileSync("addresses/qieTestnet.json", "utf8"));
const WQIE = ADDR.WQIE;
const MOCKFEED = ADDR.MockAggregator;
const ROLES_FILE = `addresses/e2e_roles_${hre.network.name}.json`;
const PROOF_FILE = `addresses/e2e_proof_${hre.network.name}.json`;

function log(step: string, msg: string) {
  console.log(`[${step}] ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [deployer] = await ethers.getSigners();
  const proof: any = fs.existsSync(PROOF_FILE)
    ? JSON.parse(fs.readFileSync(PROOF_FILE, "utf8"))
    : { network: hre.network.name, chainId: 1983, startedAt: new Date().toISOString(), steps: {} };
  const rec = (k: string, v: string) => { proof.steps[k] = v; };

  // ---------- persistent roles ----------
  let roles: any;
  if (fs.existsSync(ROLES_FILE)) {
    roles = JSON.parse(fs.readFileSync(ROLES_FILE, "utf8"));
    log("roles", "loaded persisted roles");
  } else {
    roles = {
      principal: ethers.Wallet.createRandom().privateKey,
      agent: ethers.Wallet.createRandom().privateKey,
      providerAcct: ethers.Wallet.createRandom().privateKey,
    };
    fs.writeFileSync(ROLES_FILE, JSON.stringify(roles, null, 2));
  }
  const principal = new ethers.Wallet(roles.principal, ethers.provider);
  const agent = new ethers.Wallet(roles.agent, ethers.provider);
  const providerAcct = new ethers.Wallet(roles.providerAcct, ethers.provider);
  log("roles", `merchant=${deployer.address} principal=${principal.address} agent=${agent.address} providerAcct=${providerAcct.address}`);

  const wqie = await ethers.getContractAt("WQIE", WQIE);
  const mock = await ethers.getContractAt("MockAggregator", MOCKFEED);
  const merchantRegistry = await ethers.getContractAt("MerchantRegistry", ADDR.MerchantRegistry);
  const agentRegistry = await ethers.getContractAt("AgentRegistry", ADDR.AgentRegistry);
  const mandateVault = await ethers.getContractAt("MandateVault", ADDR.MandateVault);
  const payEndpoint = await ethers.getContractAt("PayEndpoint", ADDR.PayEndpoint);
  const escrow = await ethers.getContractAt("EscrowCore", ADDR.EscrowCore);
  const router = await ethers.getContractAt("SettlementRouter", ADDR.SettlementRouter);
  const invoiceVault = await ethers.getContractAt("InvoiceVault", ADDR.InvoiceVault);
  const creditPassport = await ethers.getContractAt("CreditPassport", ADDR.CreditPassport);

  // ---------- gas top-ups (gas only; WQIE handled where needed) ----------
  const fund = async (w: any, need: string, label: string) => {
    const bal = await ethers.provider.getBalance(w.address);
    if (bal < ethers.parseEther(need)) {
      const send = ethers.parseEther(need) - bal + ethers.parseEther("0.05");
      for (let i = 0; i < 3; i++) {
        try { const tx = await deployer.sendTransaction({ to: w.address, value: send }); await tx.wait(); break; }
        catch (e: any) { if (i === 2) throw e; log("fund", `${label} top-up retry ${i + 1}`); await sleep(3000); }
      }
      log("fund", `${label} -> ${ethers.formatEther(await ethers.provider.getBalance(w.address))} QIE`);
    }
  };
  await fund(principal, "0.1", "principal");
  await fund(agent, "0.05", "agent");
  await fund(providerAcct, "0.01", "providerAcct");
  await fund(deployer, "0.3", "deployer");

  // tx helper with transient-revert retry (staticCall-verified state can still
  // revert once on this chain; a fresh send succeeds)
  const send = async (build: () => Promise<any>, label: string, tries = 3): Promise<any> => {
    for (let i = 0; i < tries; i++) {
      try {
        const tx = await build();
        const rc = await tx.wait();
        if (label) rec(label, tx.hash);
        return rc;
      } catch (e: any) {
        const last = i === tries - 1;
        log("tx", `${label || "tx"} attempt ${i + 1} ${last ? "FAILED for good" : "failed — retrying"}`);
        if (last) throw e;
        await sleep(4000);
      }
    }
  };

  // ---------- 1. merchant onboarding ----------
  if (!(await merchantRegistry.isVerifiedMerchant(deployer.address))) {
    await send(async () => (merchantRegistry as any).connect(deployer).registerMerchant("Township Spaza Demo", "ipfs://merchant-spaza-1"), "registerMerchant");
    await send(async () => (merchantRegistry as any).connect(deployer).verifyMerchant(deployer.address, true), "verifyMerchant");
  }
  log("merchant", `verified: ${await merchantRegistry.isVerifiedMerchant(deployer.address)}`);

  // ---------- 2. USD product ($0.10/call, oracle quoted) ----------
  const productId = await payEndpoint.nextProductId();
  if (productId === 1n) {
    await send(async () => (payEndpoint as any).connect(deployer).addProductUsd("AI Vision API", "/v1/vision", "ipfs://product-1", 10000000n), "addProductUsd");
  }
  const quote = await payEndpoint.quoteIn(1n, WQIE);
  const rd = await mock.latestRoundData();
  log("feed", `USD feed=$${Number(ethers.formatUnits(rd[1], 8))} | product#1 $0.10 -> ${ethers.formatEther(quote)} WQIE`);

  // ---------- 3. MACHINE RAIL purchases (mandate + agent + KYA) ----------
  const nextCallId = await payEndpoint.nextCallId();
  const callId1 = 1n, callId2 = 2n;
  const callsDone = nextCallId > callId2;

  let mandateId = 0n;
  if (!callsDone) {
    // agent registers; human principal binds (KYA accountability)
    if ((await agentRegistry.getAgent(agent.address)).agentAddr === ethers.ZeroAddress) {
      await send(async () => (agentRegistry as any).connect(agent).registerAgent("ShoppingAgent-v1"), "registerAgent");
    }
    if ((await agentRegistry.getAgent(agent.address)).principal === ethers.ZeroAddress) {
      await send(async () => (agentRegistry as any).connect(principal).bindPrincipal(agent.address, "qiepass:principal-001"), "bindPrincipal");
    }
    log("agent", `eligible: ${await agentRegistry.isEligibleAgent(agent.address)}`);

    // wrap whatever principal still needs: pending calls * quote + invoice 0.3
    const remainingCalls = callId2 - (nextCallId - 1n);
    const invoiceNeeded = ethers.parseEther("0.3");
    const needW = remainingCalls * quote + invoiceNeeded;
    const haveW = await wqie.balanceOf(principal.address);
    if (haveW < needW) {
      const miss = needW - haveW;
      const qBal = await ethers.provider.getBalance(principal.address);
      if (qBal < miss + ethers.parseEther("0.03")) throw new Error("principal short for wrap — fund faucet");
      await send(async () => (wqie as any).connect(principal).deposit({ value: miss }), "wrapQIE");
    }
    log("wqie", `principal WQIE: ${ethers.formatEther(await wqie.balanceOf(principal.address))}`);

    // reuse an agent-owned active mandate with enough balance, else create
    const perCall = ethers.parseEther("0.6");
    const daily = ethers.parseEther("1.5");
    const depositAmt = ethers.parseEther("1.2");
    const totalMandates = await mandateVault.nextMandateId();
    for (let i = 1n; i < totalMandates; i++) {
      const m = await mandateVault.mandates(i);
      if (m.agent === agent.address && m.active && m.balance >= remainingCalls * quote) { mandateId = i; break; }
    }
    if (mandateId === 0n) {
      mandateId = totalMandates;
      await send(async () => (wqie as any).connect(principal).approve(await mandateVault.getAddress(), depositAmt), "approveMandateVault");
      await send(async () => (mandateVault as any).connect(principal).createMandate(agent.address, await wqie.getAddress(), perCall, daily, depositAmt), "createMandate");
      log("mandate", `created mandate ${mandateId} (1.2 WQIE prepaid, $0.60/call + $1.50/day caps)`);
    } else {
      log("mandate", `reusing mandate ${mandateId}`);
    }
    if (!(await mandateVault.authorizedCallers(mandateId, ADDR.PayEndpoint))) {
      await send(async () => (mandateVault as any).connect(principal).authorizeCaller(mandateId, ADDR.PayEndpoint, true), "authorizePayEndpoint");
      log("mandate", "PayEndpoint authorized as delegated caller");
    }
  } else {
    mandateId = (await mandateVault.nextMandateId()) - 1n;
    log("mandate", `purchases complete — latest mandate ${mandateId}`);
  }

  const ensureCall = async (expected: bigint) => {
    if ((await payEndpoint.nextCallId()) > expected) return;
    const rc = await send(async () => (payEndpoint as any).connect(agent).payForCall(mandateId, 1n, WQIE), `payForCall#${expected}`);
    log("machine", `call#${expected}: agent paid ${ethers.formatEther(quote)} WQIE via mandate ${mandateId} -> escrow (tx ${rc?.hash})`);
  };
  await ensureCall(callId1);
  await ensureCall(callId2);
  const call1 = await payEndpoint.calls(callId1);
  const call2 = await payEndpoint.calls(callId2);
  log("mandate", `post-purchase: balance=${ethers.formatEther((await mandateVault.mandates(mandateId)).balance)} spentToday=${ethers.formatEther((await mandateVault.mandates(mandateId)).spentToday)}`);

  // ---------- 4. DISPUTE RAIL: refund call#2 within window ----------
  const st2 = await escrow.statusOf(call2.escrowId);
  if (Number(st2[0]) === 0) {
    const rc = await send(async () => (payEndpoint as any).connect(principal).refundCall(callId2), "refundCall");
    log("refund", `call#2 refunded to principal within 600s window (tx ${rc?.hash})`);
  } else {
    log("refund", `call#2 escrow state=${st2[0]} (already resolved)`);
  }
  const cpArr = await creditPassport.getScore(principal.address);
  log("credit", `principal passport score=${cpArr[0].toString()} onTime=${cpArr[1].toString()} late=${cpArr[2].toString()} (refund recorded against history)`);

  // ---------- 5. HUMAN RAIL: invoice -> payInvoice -> router credit ----------
  const invoiceId = await invoiceVault.nextInvoiceId();
  if (invoiceId === 1n) {
    const dueAt = BigInt(Math.floor(Date.now() / 1000) + 86400);
    await send(async () => (invoiceVault as any).connect(deployer).createInvoice(WQIE, principal.address, ethers.parseEther("0.3"), dueAt, "cust-001", "ipfs://inv-1"), "createInvoice");
  }
  const inv = await invoiceVault.invoices(1n);
  if (Number(inv.status) === 0) {
    const haveW2 = await wqie.balanceOf(principal.address);
    if (haveW2 < ethers.parseEther("0.3")) {
      const miss = ethers.parseEther("0.3") - haveW2;
      await send(async () => (wqie as any).connect(principal).deposit({ value: miss }), "wrapQIE_invoice");
    }
    await send(async () => (wqie as any).connect(principal).approve(await invoiceVault.getAddress(), ethers.parseEther("0.3")), "approveInvoiceVault");
    const rc = await send(async () => (invoiceVault as any).connect(principal).payInvoice(1n, ethers.parseEther("0.3")), "payInvoice");
    log("invoice", `invoice#1 paid 0.3 WQIE -> router credited (tx ${rc?.hash})`);
  }
  log("invoice", `status=${(await invoiceVault.invoices(1n)).status} withdrawable=${ethers.formatEther(await router.totalWithdrawable(deployer.address, WQIE))} WQIE`);

  // ---------- 6. FIAT-OUT: bank-linked payout profile saved once ----------
  if (!(await router.payoutProfileOf(deployer.address)).active) {
    const providerRef = ethers.keccak256(ethers.toUtf8Bytes("valr-beneficiary-zar-001"));
    await send(async () => (router as any).connect(deployer).setPayoutProfile({
      payoutAddress: providerAcct.address,
      providerRef,
      provider: "valr",
      fiatCurrency: "ZAR",
      rail: 1, // OFFRAMP_PROVIDER
      minThreshold: ethers.parseEther("0.1"),
      interval: 60,
      lastPayoutAt: 0,
      autoEnabled: true,
      active: true,
    }), "setPayoutProfile");
  }
  const prof = await router.payoutProfileOf(deployer.address);
  log("payout", `profile: rail=${prof.rail} provider=${prof.provider} (${prof.fiatCurrency}) auto=${prof.autoEnabled} -> deposit ${prof.payoutAddress}`);
  log("payout", `canAutoWithdraw: ${await router.canAutoWithdraw(deployer.address, WQIE)}`);

  // ---------- 7. claim after refund window ----------
  const st1 = await escrow.statusOf(call1.escrowId);
  const windowSec = Number(await escrow.defaultRefundWindow());
  if (Number(st1[0]) === 0) {
    const waitSec = Number(st1[1]) + 10 - Math.floor(Date.now() / 1000); // deadline
    if (waitSec > 0) { log("wait", `escrow refund window — sleeping ${waitSec}s...`); await sleep(waitSec * 1000); }
    const rc = await send(async () => (payEndpoint as any).connect(deployer).claimCall(callId1), "claimCall");
    log("claim", `call#1 settled to merchant after window (tx ${rc?.hash})`);
  } else {
    log("claim", `call#1 escrow state=${st1[0]} (already resolved)`);
  }
  const extEarn = await router.externalEarnings(deployer.address, WQIE);
  log("claim", `merchant externalEarnings ledger=${ethers.formatEther(extEarn)} WQIE (escrow paid wallet direct; router records)`);

  // ---------- 8. AUTO-WITHDRAW: permissionless keeper sweep ----------
  if ((await router.totalWithdrawable(deployer.address, WQIE)) > 0n) {
    const rc = await send(async () => (router as any).connect(principal).executeAutoWithdraw(WQIE, deployer.address), "executeAutoWithdraw");
    log("autoWithdraw", `keeper swept earnings to VALR deposit address (tx ${rc?.hash})`);
  }
  const sweptBal = await wqie.balanceOf(prof.payoutAddress);
  log("autoWithdraw", `off-ramp deposit holds ${ethers.formatEther(sweptBal)} WQIE — provider settles ZAR to the saved bank account off-chain`);

  // ---------- final ----------
  proof.finishedAt = new Date().toISOString();
  proof.finalState = {
    merchantWQIE: ethers.formatEther(await wqie.balanceOf(deployer.address)),
    offrampDepositWQIE: ethers.formatEther(sweptBal),
    mandateBalance: ethers.formatEther((await mandateVault.mandates(mandateId)).balance),
    routerWithdrawable: ethers.formatEther(await router.totalWithdrawable(deployer.address, WQIE)),
    externalEarnings: ethers.formatEther(extEarn),
    roles: { principal: principal.address, agent: agent.address, providerAcct: providerAcct.address },
  };
  proof.deployedContracts = ADDR;
  fs.writeFileSync(PROOF_FILE, JSON.stringify(proof, null, 2));
  console.log(`\nE2E PROOF SAVED -> ${PROOF_FILE}`);
  console.log(JSON.stringify(proof.finalState, null, 2));
}

main().catch((e) => { console.error(e?.message?.slice(0, 400) ?? e); process.exitCode = 1; });
