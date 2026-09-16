import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * AgentPay x MerchantPilot - Master Plan test suite (rebuilt).
 * 9 groups / 38 cases covering the invariant list in the 10/10 Master Plan ch.6:
 * registration, mandate caps, oracle quoting, escrow lifecycle, machine payment,
 * settlement accounting, invoices, recurring, passport/WQIE/deterministic fuzz.
 */

const W = 600; // escrow refund window seconds (matches deploy)
const FEE_BPS_PAY = 50;  // PayEndpoint 0.5%
const FEE_BPS_INV = 30;  // Invoice/Recurring 0.3%

describe("AgentPay x MerchantPilot - Master Plan suite", function () {
  async function deployAll() {
    const [deployer, merchant, agent, principal, payer, stranger] =
      await ethers.getSigners();

    const MockStable = await ethers.getContractFactory("MockStable");
    const token = await MockStable.deploy("Mock USD", "MUSD");

    const merchantRegistry = await (
      await ethers.getContractFactory("MerchantRegistry")
    ).deploy(deployer.address);

    const agentRegistry = await (
      await ethers.getContractFactory("AgentRegistry")
    ).deploy();

    const escrow = await (
      await ethers.getContractFactory("EscrowCore")
    ).deploy(W);

    const router = await (
      await ethers.getContractFactory("SettlementRouter")
    ).deploy(deployer.address, deployer.address);

    const passport = await (
      await ethers.getContractFactory("CreditPassport")
    ).deploy(deployer.address);

    const mandateVault = await (
      await ethers.getContractFactory("MandateVault")
    ).deploy(await agentRegistry.getAddress());

    const payEndpoint = await (
      await ethers.getContractFactory("PayEndpoint")
    ).deploy(
      await merchantRegistry.getAddress(),
      await agentRegistry.getAddress(),
      await mandateVault.getAddress(),
      await escrow.getAddress(),
      await router.getAddress(),
      await passport.getAddress()
    );

    const invoiceVault = await (
      await ethers.getContractFactory("InvoiceVault")
    ).deploy(
      await merchantRegistry.getAddress(),
      await router.getAddress(),
      await passport.getAddress()
    );

    const recurring = await (
      await ethers.getContractFactory("RecurringMandate")
    ).deploy(
      await merchantRegistry.getAddress(),
      await router.getAddress(),
      await passport.getAddress()
    );

    // wiring (mirrors scripts/deploy.ts)
    await (await escrow.setRelayer(await payEndpoint.getAddress(), true)).wait();
    for (const r of [payEndpoint, invoiceVault, recurring]) {
      await (await router.setRecorder(await r.getAddress(), true)).wait();
      await (await passport.setRecorder(await r.getAddress(), true)).wait();
    }

    // oracle feed: $1.00 exactly, fresh
    const feed = await (await ethers.getContractFactory("MockAggregator")).deploy();
    await (await feed.setData(ethers.parseUnits("1.0", 8), await time.latest())).wait();
    await (await payEndpoint.setUsdFeed(await token.getAddress(), await feed.getAddress())).wait();

    // merchant onboarded + verified
    await (await merchantRegistry.connect(merchant).registerMerchant("Shop", "ipfs://shop")).wait();
    await (await merchantRegistry.connect(deployer).verifyMerchant(merchant.address, true)).wait();

    // agent registered + bound to principal
    await (await agentRegistry.connect(agent).registerAgent("shopping-agent")).wait();
    await (await agentRegistry.connect(principal).bindPrincipal(await agent.getAddress(), "QIEPASS-1")).wait();

    return {
      deployer, merchant, agent, principal, payer, stranger,
      token, feed, merchantRegistry, agentRegistry, escrow, router,
      passport, mandateVault, payEndpoint, invoiceVault, recurring,
    };
  }

  async function fundedMandate(fixture: any, perCall: bigint, daily: bigint, deposit: bigint) {
    const { principal, agent, token, mandateVault, payEndpoint } = fixture;
    await (await token.connect(principal).faucet()).wait();
    await (await token.connect(principal).approve(await mandateVault.getAddress(), ethers.MaxUint256)).wait();
    const tx = await mandateVault.connect(principal).createMandate(
      await agent.getAddress(), await token.getAddress(), perCall, daily, deposit
    );
    const rc = await tx.wait();
    const ev = rc.logs.map((l: any) => mandateVault.interface.parseLog(l)).find((p: any) => p && p.name === "MandateCreated");
    const mandateId = Number(ev!.args.id);
    await (await mandateVault.connect(principal).authorizeCaller(mandateId, await payEndpoint.getAddress(), true)).wait();
    return mandateId;
  }

  async function usdProduct(fixture: any, usd8: bigint) {
    const { merchant, payEndpoint } = fixture;
    const tx = await payEndpoint.connect(merchant).addProductUsd("api-call", "/v1/call", "", usd8);
    const rc = await tx.wait();
    const ev = rc.logs.map((l: any) => payEndpoint.interface.parseLog(l)).find((p: any) => p && p.name === "ProductAdded");
    return Number(ev!.args.id);
  }

  const E18 = (n: number) => ethers.parseEther(String(n));

  // ============================ 1. registration ============================
  describe("1. Registration and verification", () => {
    it("1.1 registers and verifies a merchant", async () => {
      const f = await loadFixture(deployAll);
      expect(await f.merchantRegistry.isVerifiedMerchant(f.merchant.address)).to.equal(true);
      expect(await f.merchantRegistry.merchantCount()).to.equal(1n);
    });

    it("1.2 unverified wallet cannot create machine products", async () => {
      const f = await loadFixture(deployAll);
      await expect(
        f.payEndpoint.connect(f.stranger).addProductUsd("x", "/x", "", 100n)
      ).to.be.revertedWith("NOT_VERIFIED_MERCHANT");
    });

    it("1.3 duplicate agent registration reverts", async () => {
      const f = await loadFixture(deployAll);
      await expect(f.agentRegistry.connect(f.agent).registerAgent("again")).to.be.revertedWith("ALREADY_REGISTERED");
    });

    it("1.4 agent cannot bind itself; principal binding recorded", async () => {
      const f = await loadFixture(deployAll);
      await expect(f.agentRegistry.connect(f.agent).bindPrincipal(await f.agent.getAddress(), "SELF")).to.be.revertedWith("PRINCIPAL_NOT_SELF");
      const a = await f.agentRegistry.getAgent(await f.agent.getAddress());
      expect(a.principal).to.equal(await f.principal.getAddress());
      expect(await f.agentRegistry.isEligibleAgent(await f.agent.getAddress())).to.equal(true);
    });

    it("1.5 non-verifier cannot verify merchants", async () => {
      const f = await loadFixture(deployAll);
      await expect(f.merchantRegistry.connect(f.stranger).verifyMerchant(f.stranger.address, true)).to.be.revertedWith("NOT_VERIFIER");
    });
  });

  // ============================ 2. mandate caps ============================
  describe("2. Mandate caps and windows", () => {
    it("2.1 spend above per-call cap reverts", async () => {
      const f = await loadFixture(deployAll);
      const id = await fundedMandate(f, E18(1), E18(5), E18(10));
      await expect(
        f.mandateVault.connect(f.agent).spend(id, f.merchant.address, E18(1.01), "over")
      ).to.be.revertedWithCustomError(f.mandateVault, "ExceedsPerCallCap");
    });

    it("2.2 cumulative spend above daily cap reverts", async () => {
      const f = await loadFixture(deployAll);
      const id = await fundedMandate(f, E18(2), E18(3), E18(10));
      await (await f.mandateVault.connect(f.agent).spend(id, f.merchant.address, E18(2), "a")).wait();
      await (await f.mandateVault.connect(f.agent).spend(id, f.merchant.address, E18(1), "b")).wait();
      await expect(
        f.mandateVault.connect(f.agent).spend(id, f.merchant.address, E18(0.5), "c")
      ).to.be.revertedWithCustomError(f.mandateVault, "ExceedsDailyCap");
    });

    it("2.3 daily window resets on a new UTC day", async () => {
      const f = await loadFixture(deployAll);
      const id = await fundedMandate(f, E18(3), E18(3), E18(10));
      await (await f.mandateVault.connect(f.agent).spend(id, f.merchant.address, E18(3), "day0")).wait();
      await time.increase(86401);
      await (await f.mandateVault.connect(f.agent).spend(id, f.merchant.address, E18(3), "day1")).wait();
      const m = await f.mandateVault.mandates(id);
      expect(m.spentToday).to.equal(E18(3));
    });

    it("2.4 unauthorized caller cannot spend (NotAgent)", async () => {
      const f = await loadFixture(deployAll);
      const id = await fundedMandate(f, E18(1), E18(5), E18(10));
      await expect(
        f.mandateVault.connect(f.stranger).spend(id, f.merchant.address, E18(0.1), "x")
      ).to.be.revertedWithCustomError(f.mandateVault, "NotAgent");
    });

    it("2.5 canSpend view reports exact reasons", async () => {
      const f = await loadFixture(deployAll);
      const id = await fundedMandate(f, E18(2), E18(2), E18(10));
      const [ok1, reason1] = await f.mandateVault.canSpend(id, E18(1));
      expect(ok1).to.equal(true);
      const [ok2, reason2] = await f.mandateVault.canSpend(id, E18(2.5));
      expect(ok2).to.equal(false);
      expect(reason2).to.equal("PER_CALL_CAP");
      await (await f.mandateVault.connect(f.agent).spend(id, f.merchant.address, E18(1.5), "half")).wait();
      const [ok3, reason3] = await f.mandateVault.canSpend(id, E18(1));
      expect(ok3).to.equal(false);
      expect(reason3).to.equal("DAILY_CAP");
    });

    it("2.6 closeMandate refunds remaining balance and deactivates", async () => {
      const f = await loadFixture(deployAll);
      const id = await fundedMandate(f, E18(1), E18(5), E18(4));
      await (await f.mandateVault.connect(f.agent).spend(id, f.merchant.address, E18(1), "use")).wait();
      await expect(f.mandateVault.connect(f.agent).closeMandate(id)).to.be.revertedWithCustomError(f.mandateVault, "NotPrincipal");
      const before = await f.token.balanceOf(await f.principal.getAddress());
      await (await f.mandateVault.connect(f.principal).closeMandate(id)).wait();
      const m = await f.mandateVault.mandates(id);
      expect(m.active).to.equal(false);
      expect(m.balance).to.equal(0n);
      expect((await f.token.balanceOf(await f.principal.getAddress())) - before).to.equal(E18(3));
    });
  });

  // ============================ 3. oracle quoting ============================
  describe("3. Oracle quoting", () => {
    it("3.1 quotes $0.10 as 0.1 token at $1 feed (decimal normalization)", async () => {
      const f = await loadFixture(deployAll);
      const pid = await usdProduct(f, 10_000_000n); // $0.10 x 1e8
      expect(await f.payEndpoint.quoteIn(pid, await f.token.getAddress())).to.equal(E18(0.1));
    });

    it("3.2 stale feed (older than max age) reverts", async () => {
      const f = await loadFixture(deployAll);
      const pid = await usdProduct(f, 10_000_000n);
      await time.increase(26 * 3600 + 5);
      await expect(f.payEndpoint.quoteIn(pid, await f.token.getAddress())).to.be.revertedWithCustomError(f.payEndpoint, "StaleFeed");
    });

    it("3.3 negative feed answer reverts", async () => {
      const f = await loadFixture(deployAll);
      const pid = await usdProduct(f, 10_000_000n);
      await (await f.feed.setData(-1n, await time.latest())).wait();
      await expect(f.payEndpoint.quoteIn(pid, await f.token.getAddress())).to.be.revertedWithCustomError(f.payEndpoint, "StaleFeed");
    });

    it("3.4 unknown token has no feed: NoFeed", async () => {
      const f = await loadFixture(deployAll);
      const other = await (await ethers.getContractFactory("MockStable")).deploy("Other", "OTH");
      const pid = await usdProduct(f, 10_000_000n);
      await expect(f.payEndpoint.quoteIn(pid, await other.getAddress())).to.be.revertedWithCustomError(f.payEndpoint, "NoFeed");
    });
  });

  // ============================ 4. escrow lifecycle ============================
  describe("4. Escrow lifecycle", () => {
    async function openOne(f: any, amount: bigint) {
      await (await f.token.connect(f.payer).faucet()).wait();
      await (await f.token.connect(f.payer).approve(await f.escrow.getAddress(), ethers.MaxUint256)).wait();
      const tx = await f.escrow.connect(f.payer).open(
        await f.token.getAddress(), f.payer.address, ethers.ZeroAddress, f.merchant.address, amount, W
      );
      const rc = await tx.wait();
      const ev = rc.logs.map((l: any) => f.escrow.interface.parseLog(l)).find((p: any) => p && p.name === "EscrowOpened");
      return Number(ev!.args.id);
    }

    it("4.1 payer refunds inside the window", async () => {
      const f = await loadFixture(deployAll);
      const id = await openOne(f, E18(1));
      await (await f.escrow.connect(f.payer).refund(id)).wait();
      expect((await f.escrow.statusOf(id))[0]).to.equal(2n); // Refunded
    });

    it("4.2 refund after the window reverts WindowClosed", async () => {
      const f = await loadFixture(deployAll);
      const id = await openOne(f, E18(1));
      await time.increase(W + 1);
      await expect(f.escrow.connect(f.payer).refund(id)).to.be.revertedWithCustomError(f.escrow, "WindowClosed");
    });

    it("4.3 settleExpired after the window pays the payee (permissionless)", async () => {
      const f = await loadFixture(deployAll);
      const id = await openOne(f, E18(1));
      await time.increase(W + 1);
      const before = await f.token.balanceOf(f.merchant.address);
      await (await f.escrow.connect(f.stranger).settleExpired(id)).wait();
      expect(await f.token.balanceOf(f.merchant.address)).to.equal(before + E18(1));
    });

    it("4.4 double settlement reverts NotOpen", async () => {
      const f = await loadFixture(deployAll);
      const id = await openOne(f, E18(1));
      await time.increase(W + 1);
      await (await f.escrow.connect(f.stranger).settleExpired(id)).wait();
      await expect(f.escrow.connect(f.stranger).settleExpired(id)).to.be.revertedWithCustomError(f.escrow, "NotOpen");
      await expect(f.escrow.connect(f.payer).refund(id)).to.be.revertedWithCustomError(f.escrow, "NotOpen");
    });

    it("4.5 settle before the window reverts WindowStillOpen", async () => {
      const f = await loadFixture(deployAll);
      const id = await openOne(f, E18(1));
      await expect(f.escrow.connect(f.stranger).settleExpired(id)).to.be.revertedWithCustomError(f.escrow, "WindowStillOpen");
    });

    it("4.6 open with zero amount or zero payee reverts", async () => {
      const f = await loadFixture(deployAll);
      await (await f.token.connect(f.payer).faucet()).wait();
      await (await f.token.connect(f.payer).approve(await f.escrow.getAddress(), ethers.MaxUint256)).wait();
      await expect(
        f.escrow.connect(f.payer).open(await f.token.getAddress(), f.payer.address, ethers.ZeroAddress, f.merchant.address, 0n, W)
      ).to.be.revertedWith("ZERO_AMOUNT");
      await expect(
        f.escrow.connect(f.payer).open(await f.token.getAddress(), f.payer.address, ethers.ZeroAddress, ethers.ZeroAddress, E18(1), W)
      ).to.be.revertedWith("ZERO_PAYEE");
    });
  });

  // ============================ 5. machine payment ============================
  describe("5. Machine payment end-to-end (PayEndpoint)", () => {
    async function buyCall(f: any) {
      const mandateId = await fundedMandate(f, E18(1), E18(5), E18(2));
      const productId = await usdProduct(f, 10_000_000n); // $0.10
      const tx = await f.payEndpoint.connect(f.agent).payForCall(mandateId, productId, await f.token.getAddress());
      const rc = await tx.wait();
      const ev = rc.logs.map((l: any) => f.payEndpoint.interface.parseLog(l)).find((p: any) => p && p.name === "CallPaid");
      return { mandateId, productId, callId: Number(ev!.args.callId), escrowId: Number(ev!.args.escrowId), amount: ev!.args.amount as bigint };
    }

    it("5.1 happy path: escrow funded, call recorded, principal credited 308", async () => {
      const f = await loadFixture(deployAll);
      const { callId, amount } = await buyCall(f);
      expect(callId).to.equal(1);
      expect(amount).to.equal(E18(0.1));
      const c = await f.payEndpoint.calls(callId);
      expect(c.agent).to.equal(await f.agent.getAddress());
      expect(c.principal).to.equal(await f.principal.getAddress());
      const score = (await f.passport.profiles(await f.principal.getAddress())).score;
      expect(score).to.equal(308n); // 300 floor + 8 on-time; 0.1 < 1000 volume step
      expect(await f.payEndpoint.productCount()).to.equal(1n);
    });

    it("5.2 principal who never authorized the endpoint blocks payForCall", async () => {
      const f = await loadFixture(deployAll);
      const { principal, agent, token, mandateVault, payEndpoint } = f;
      await (await token.connect(principal).faucet()).wait();
      await (await token.connect(principal).approve(await mandateVault.getAddress(), ethers.MaxUint256)).wait();
      const tx = await mandateVault.connect(principal).createMandate(
        await agent.getAddress(), await token.getAddress(), E18(1), E18(5), E18(2)
      );
      const rc = await tx.wait();
      const ev = rc.logs.map((l: any) => mandateVault.interface.parseLog(l)).find((p: any) => p && p.name === "MandateCreated");
      const mid = Number(ev!.args.id);
      const pid = await usdProduct(f, 10_000_000n);
      // no authorizeCaller for this mandate
      await expect(
        payEndpoint.connect(agent).payForCall(mid, pid, await token.getAddress())
      ).to.be.revertedWithCustomError(mandateVault, "NotAgent");
    });

    it("5.3 token mismatch with the mandate currency reverts", async () => {
      const f = await loadFixture(deployAll);
      const mandateId = await fundedMandate(f, E18(1), E18(5), E18(2));
      const other = await (await ethers.getContractFactory("MockStable")).deploy("Other", "OTH");
      const productId = await usdProduct(f, 10_000_000n);
      await expect(
        f.payEndpoint.connect(f.agent).payForCall(mandateId, productId, await other.getAddress())
      ).to.be.revertedWithCustomError(f.payEndpoint, "TokenMismatch");
    });

    it("5.4 claim after the window records net of 0.5% fee to merchant ledger", async () => {
      const f = await loadFixture(deployAll);
      const { callId, amount } = await buyCall(f);
      await time.increase(W + 1);
      await expect(f.payEndpoint.connect(f.stranger).claimCall(callId)).to.be.revertedWithCustomError(f.payEndpoint, "NotProductMerchant");
      await (await f.payEndpoint.connect(f.merchant).claimCall(callId)).wait();
      const fee = (amount * BigInt(FEE_BPS_PAY)) / 10000n;
      const net = amount - fee;
      expect(await f.router.externalEarnings(await f.merchant.getAddress(), await f.token.getAddress())).to.equal(net);
      expect(await f.router.feesOwed(await f.merchant.getAddress(), await f.token.getAddress())).to.equal(fee);
    });

    it("5.5 refundCall inside the window returns funds and marks history", async () => {
      const f = await loadFixture(deployAll);
      const { callId, escrowId, amount } = await buyCall(f);
      const escrowBefore = await f.token.balanceOf(await f.escrow.getAddress());
      await (await f.payEndpoint.connect(f.principal).refundCall(callId)).wait();
      expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(escrowBefore - amount);
      expect((await f.escrow.statusOf(escrowId))[0]).to.equal(2n); // Refunded
      const prof = await f.passport.profiles(await f.principal.getAddress());
      expect(prof.lateCount).to.equal(1n);
      expect(prof.score).to.equal(309n); // 308 after purchase, +1 late on refund
      await expect(f.payEndpoint.connect(f.principal).refundCall(callId)).to.be.revertedWithCustomError(f.payEndpoint, "CallNotOpen");
    });
  });

  // ============================ 6. settlement accounting ============================
  describe("6. Settlement accounting and payout automation", () => {
    it("6.1 credit() splits fee to treasury and net to merchant earnings", async () => {
      const f = await loadFixture(deployAll);
      const amt = E18(10);
      await (await f.token.connect(f.payer).faucet()).wait();
      await (await f.token.connect(f.payer).transfer(await f.router.getAddress(), amt)).wait();
      await (await f.router.setRecorder(await f.payer.getAddress(), true)).wait();
      const treasuryBefore = await f.token.balanceOf(await f.deployer.getAddress());
      await (await f.router.connect(f.payer).credit(await f.token.getAddress(), f.merchant.address, f.payer.address, amt, FEE_BPS_PAY)).wait();
      expect(await f.router.earnings(await f.merchant.getAddress(), await f.token.getAddress())).to.equal(amt - (amt * 50n) / 10000n);
      expect((await f.token.balanceOf(await f.deployer.getAddress())) - treasuryBefore).to.equal((amt * 50n) / 10000n); // treasury == deployer here
    });

    it("6.2 unregistered recorder credit reverts", async () => {
      const f = await loadFixture(deployAll);
      await expect(
        f.router.connect(f.stranger).credit(await f.token.getAddress(), f.merchant.address, f.stranger.address, E18(1), 0n)
      ).to.be.revertedWithCustomError(f.router, "NotAuthorized");
    });

    it("6.3 merchant withdraws router-held earnings", async () => {
      const f = await loadFixture(deployAll);
      const amt = E18(5);
      await (await f.token.connect(f.payer).faucet()).wait();
      await (await f.token.connect(f.payer).transfer(await f.router.getAddress(), amt)).wait();
      await (await f.router.setRecorder(await f.payer.getAddress(), true)).wait();
      await (await f.router.connect(f.payer).credit(await f.token.getAddress(), f.merchant.address, f.payer.address, amt, 0n)).wait();
      const before = await f.token.balanceOf(f.merchant.address);
      await (await f.router.connect(f.merchant).withdraw(await f.token.getAddress(), amt, f.merchant.address)).wait();
      expect(await f.token.balanceOf(f.merchant.address)).to.equal(before + amt);
      await expect(f.router.connect(f.merchant).withdraw(await f.token.getAddress(), 1n, f.merchant.address)).to.be.revertedWith("INSUFFICIENT");
    });

    it("6.4 auto-withdraw: profile set once, keeper sweeps when threshold met", async () => {
      const f = await loadFixture(deployAll);
      const amt = E18(2);
      await (await f.token.connect(f.payer).faucet()).wait();
      await (await f.token.connect(f.payer).transfer(await f.router.getAddress(), amt)).wait();
      await (await f.router.setRecorder(await f.payer.getAddress(), true)).wait();
      await (await f.router.connect(f.payer).credit(await f.token.getAddress(), f.merchant.address, f.payer.address, amt, 0n)).wait();

      const profile = {
        payoutAddress: f.merchant.address,
        providerRef: ethers.id("valr-beneficiary-1"),
        provider: "valr",
        fiatCurrency: "ZAR",
        rail: 1n, // OFFRAMP_PROVIDER
        minThreshold: E18(1),
        interval: 60n,
        lastPayoutAt: 0n,
        autoEnabled: true,
        active: true,
      };
      await (await f.router.connect(f.merchant).setPayoutProfile(profile)).wait();
      const [autoOk] = await f.router.canAutoWithdraw(f.merchant.address, await f.token.getAddress());
      expect(autoOk).to.equal(true);
      const swept = await f.router.connect(f.stranger).executeAutoWithdraw.staticCall(await f.token.getAddress(), f.merchant.address);
      expect(swept).to.equal(amt);
      await (await f.router.connect(f.stranger).executeAutoWithdraw(await f.token.getAddress(), f.merchant.address)).wait();
      expect(await f.token.balanceOf(f.merchant.address)).to.equal(amt);
      // second earn, then interval must block an immediate auto sweep
      await (await f.token.connect(f.payer).transfer(await f.router.getAddress(), amt)).wait();
      await (await f.router.connect(f.payer).credit(await f.token.getAddress(), f.merchant.address, f.payer.address, amt, 0n)).wait();
      await expect(
        f.router.connect(f.stranger).executeAutoWithdraw(await f.token.getAddress(), f.merchant.address)
      ).to.be.revertedWithCustomError(f.router, "IntervalNotElapsed");
    });

    it("6.5 auto-withdraw guards: threshold, disabled, inactive profile", async () => {
      const f = await loadFixture(deployAll);
      const base = {
        payoutAddress: f.merchant.address,
        providerRef: ethers.ZeroHash,
        provider: "",
        fiatCurrency: "",
        rail: 0n, // CRYPTO_WALLET
        minThreshold: E18(10),
        interval: 0n,
        lastPayoutAt: 0n,
        autoEnabled: true,
        active: true,
      };
      await (await f.router.connect(f.merchant).setPayoutProfile(base)).wait();
      await expect(
        f.router.connect(f.stranger).executeAutoWithdraw(await f.token.getAddress(), f.merchant.address)
      ).to.be.revertedWithCustomError(f.router, "ThresholdNotMet");

      const disabled = { ...base, autoEnabled: false };
      await (await f.router.connect(f.merchant).setPayoutProfile(disabled)).wait();
      await expect(
        f.router.connect(f.stranger).executeAutoWithdraw(await f.token.getAddress(), f.merchant.address)
      ).to.be.revertedWithCustomError(f.router, "AutoDisabled");

      await expect(
        f.router.connect(f.stranger).requestWithdrawal(await f.token.getAddress())
      ).to.be.revertedWithCustomError(f.router, "ProfileInactive");
    });
  });

  // ============================ 7. invoices ============================
  describe("7. Invoices", () => {
    async function makeInvoice(f: any, amount: bigint, dueIn = 86400n) {
      const dueAt = BigInt(await time.latest()) + dueIn;
      const tx = await f.invoiceVault.connect(f.merchant).createInvoice(
        await f.token.getAddress(), await f.payer.getAddress(), amount, dueAt, "CUST-1", ""
      );
      const rc = await tx.wait();
      const ev = rc.logs.map((l: any) => f.invoiceVault.interface.parseLog(l)).find((p: any) => p && p.name === "InvoiceCreated");
      return Number(ev!.args.id);
    }

    it("7.1 partial payment then full payment with 0.3% fee to router", async () => {
      const f = await loadFixture(deployAll);
      const id = await makeInvoice(f, E18(10));
      await (await f.token.connect(f.payer).faucet()).wait();
      await (await f.token.connect(f.payer).approve(await f.invoiceVault.getAddress(), ethers.MaxUint256)).wait();
      await (await f.invoiceVault.connect(f.payer).payInvoice(id, E18(4))).wait();
      let inv = await f.invoiceVault.invoices(id);
      expect(inv.paidAmount).to.equal(E18(4));
      await (await f.invoiceVault.connect(f.payer).payInvoice(id, E18(6))).wait();
      inv = await f.invoiceVault.invoices(id);
      expect(inv.status).to.equal(2n); // Paid (Open=0, Partial=1, Paid=2, Overdue=3)
      const net = E18(10) - (E18(10) * BigInt(FEE_BPS_INV)) / 10000n;
      expect(await f.router.earnings(await f.merchant.getAddress(), await f.token.getAddress())).to.equal(net);
    });

    it("7.2 overpay reverts", async () => {
      const f = await loadFixture(deployAll);
      const id = await makeInvoice(f, E18(10));
      await (await f.token.connect(f.payer).faucet()).wait();
      await (await f.token.connect(f.payer).approve(await f.invoiceVault.getAddress(), ethers.MaxUint256)).wait();
      await expect(f.invoiceVault.connect(f.payer).payInvoice(id, E18(10.01))).to.be.revertedWith("OVERPAY");
    });

    it("7.3 wrong payer reverts when an expected payer is set", async () => {
      const f = await loadFixture(deployAll);
      const id = await makeInvoice(f, E18(10));
      await (await f.token.connect(f.stranger).faucet()).wait();
      await (await f.token.connect(f.stranger).approve(await f.invoiceVault.getAddress(), ethers.MaxUint256)).wait();
      await expect(f.invoiceVault.connect(f.stranger).payInvoice(id, E18(1))).to.be.revertedWith("NOT_EXPECTED_PAYER");
    });

    it("7.4 permissionless overdue marking only after due date", async () => {
      const f = await loadFixture(deployAll);
      const id = await makeInvoice(f, E18(10));
      await expect(f.invoiceVault.connect(f.stranger).markOverdue(id)).to.be.revertedWith("NOT_DUE_YET");
      await time.increase(86401);
      expect(await f.invoiceVault.isOverdue(id)).to.equal(true); // due and unsettled
      await (await f.invoiceVault.connect(f.stranger).markOverdue(id)).wait();
      expect((await f.invoiceVault.invoices(id)).status).to.equal(3n); // Overdue
    });
  });

  // ============================ 8. recurring ============================
  describe("8. Recurring subscriptions", () => {
    async function makeSub(f: any, perCycle: bigint, deposit: bigint) {
      await (await f.token.connect(f.payer).faucet()).wait();
      await (await f.token.connect(f.payer).approve(await f.recurring.getAddress(), ethers.MaxUint256)).wait();
      const tx = await f.recurring.connect(f.payer).createSubscription(
        f.merchant.address, await f.token.getAddress(), perCycle, 3600n, "PLAN-PRO", deposit
      );
      const rc = await tx.wait();
      const ev = rc.logs.map((l: any) => f.recurring.interface.parseLog(l)).find((p: any) => p && p.name === "SubscriptionCreated");
      return Number(ev!.args.id);
    }

    it("8.1 create + deposit; chargeDue before due reverts", async () => {
      const f = await loadFixture(deployAll);
      const id = await makeSub(f, E18(1), E18(3));
      await (await f.token.connect(f.payer).faucet()).wait();
      await (await f.token.connect(f.payer).approve(await f.recurring.getAddress(), ethers.MaxUint256)).wait();
      await (await f.recurring.connect(f.payer).deposit(id, E18(2))).wait();
      await expect(f.recurring.connect(f.stranger).chargeDue(id)).to.be.revertedWithCustomError(f.recurring, "NotDueYet");
    });

    it("8.2 chargeDue after interval routes net through the router", async () => {
      const f = await loadFixture(deployAll);
      const id = await makeSub(f, E18(1), E18(3));
      await time.increase(3601);
      await (await f.recurring.connect(f.stranger).chargeDue(id)).wait();
      const net = E18(1) - (E18(1) * BigInt(FEE_BPS_INV)) / 10000n;
      expect(await f.router.earnings(await f.merchant.getAddress(), await f.token.getAddress())).to.equal(net);
      const s = await f.recurring.subs(id);
      expect(s.chargesCount).to.equal(1n);
      expect(s.balance).to.equal(E18(2));
    });

    it("8.3 lapseIfBroke only when balance cannot cover a cycle", async () => {
      const f = await loadFixture(deployAll);
      const funded = await makeSub(f, E18(5), E18(10)); // balance covers a cycle
      await time.increase(3601);
      await expect(f.recurring.connect(f.stranger).lapseIfBroke(funded)).to.be.revertedWith("CAN_STILL_PAY");
      const broke = await makeSub(f, E18(5), E18(0));
      await time.increase(3601); // its own due date is creation + 3600
      await (await f.recurring.connect(f.stranger).lapseIfBroke(broke)).wait();
      expect((await f.recurring.subs(broke)).status).to.equal(2n); // Lapsed
    });

    it("8.4 cancel refunds remaining prepaid to payer", async () => {
      const f = await loadFixture(deployAll);
      const id = await makeSub(f, E18(1), E18(3));
      await expect(f.recurring.connect(f.stranger).cancel(id)).to.be.revertedWith("NOT_PAYER");
      await (await f.recurring.connect(f.payer).cancel(id)).wait();
      const s = await f.recurring.subs(id);
      expect(s.balance).to.equal(0n);
    });
  });

  // ============================ 9. passport, WQIE, fuzz ============================
  describe("9. Credit passport, WQIE, deterministic fuzz", () => {
    it("9.1 default penalty floors at 300; unauthorized recorder reverts", async () => {
      const f = await loadFixture(deployAll);
      await (await f.passport.setRecorder(await f.payer.getAddress(), true)).wait();
      await (await f.token.connect(f.payer).faucet()).wait();
      await (await f.passport.connect(f.payer).recordPayment(f.payer.address, E18(5000), true)).wait();
      await (await f.passport.connect(f.payer).recordDefault(f.payer.address, E18(1000))).wait();
      const prof = await f.passport.profiles(f.payer.address);
      // 300 + 8 + (5000e18 / 1000e18)*2 = 318; default -120 would be 198 -> floored 300
      expect(prof.score).to.equal(300n);
      expect(prof.defaultCount).to.equal(1n);
    });

    it("9.2 score never exceeds 850 (cap check)", async () => {
      const f = await loadFixture(deployAll);
      await (await f.passport.setRecorder(await f.payer.getAddress(), true)).wait();
      await (await f.passport.connect(f.deployer).seedScore(f.payer.address, 849n, 0n)).wait();
      await (await f.token.connect(f.payer).faucet()).wait();
      await (await f.passport.connect(f.payer).recordPayment(f.payer.address, E18(100), true)).wait();
      const [capped] = await f.passport.getScore(f.payer.address);
      expect(capped).to.equal(850n);
    });

    it("9.3 WQIE deposit/withdraw conserve supply 1:1", async () => {
      const f = await loadFixture(deployAll);
      const wqie = await (await ethers.getContractFactory("WQIE")).deploy();
      await (await wqie.connect(f.payer).deposit({ value: E18(2) })).wait();
      expect(await wqie.balanceOf(f.payer.address)).to.equal(E18(2));
      expect(await wqie.totalSupply()).to.equal(E18(2));
      await (await wqie.connect(f.payer).withdraw(E18(1))).wait();
      expect(await wqie.totalSupply()).to.equal(E18(1));
      expect(await wqie.balanceOf(f.payer.address)).to.equal(E18(1));
    });

    it("9.4 FUZZ mandate: 200 random spends never breach the daily cap", async () => {
      const f = await loadFixture(deployAll);
      const id = await fundedMandate(f, E18(2), E18(6), E18(50));
      let seed = 123456789;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      let cumulative = 0n;
      const dailyCap = E18(6);
      for (let i = 0; i < 200; i++) {
        const amount = BigInt(Math.floor(rnd() * 2_000_000)) * 1_000_000_000n; // 0-2e18 range
        if (amount === 0n) continue;
        const [ok] = await f.mandateVault.canSpend(id, amount);
        if (ok) {
          await (await f.mandateVault.connect(f.agent).spend(id, f.merchant.address, amount, "fuzz-" + i)).wait();
          cumulative += amount;
          if (cumulative > dailyCap) {
            throw new Error("daily cap breached at iteration " + i + ": " + cumulative.toString());
          }
        } else {
          await expect(
            f.mandateVault.connect(f.agent).spend(id, f.merchant.address, amount, "fuzzx-" + i)
          ).to.be.reverted; // view and state agree
        }
      }
      const m = await f.mandateVault.mandates(id);
      expect(m.spentToday).to.equal(cumulative);
      if (m.spentToday > dailyCap) {
        throw new Error("final spentToday above daily cap");
      }
    });

    it("9.5 FUZZ escrow: random interleavings keep every escrow single-terminal", async () => {
      const f = await loadFixture(deployAll);
      await (await f.token.connect(f.payer).faucet()).wait();
      await (await f.token.connect(f.payer).approve(await f.escrow.getAddress(), ethers.MaxUint256)).wait();
      let seed = 987654321;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      const ids: number[] = [];
      for (let i = 0; i < 12; i++) {
        const amount = BigInt(Math.floor(rnd() * 900_000) + 100_000) * 1_000_000_000n;
        const tx = await f.escrow.connect(f.payer).open(
          await f.token.getAddress(), f.payer.address, ethers.ZeroAddress, f.merchant.address, amount, W
        );
        const rc = await tx.wait();
        const ev = rc.logs.map((l: any) => f.escrow.interface.parseLog(l)).find((p: any) => p && p.name === "EscrowOpened");
        ids.push(Number(ev!.args.id));
      }
      // interleave refunds and settlements across time jumps
      for (const id of ids) {
        if (rnd() > 0.5) {
          try { await (await f.escrow.connect(f.payer).refund(id)).wait(); } catch { /* window may be closed */ }
        }
        await time.increase(W / 4);
        if (rnd() > 0.5) {
          try { await (await f.escrow.connect(f.stranger).settleExpired(id)).wait(); } catch { /* window may still be open */ }
        }
      }
      await time.increase(W + 1);
      for (const id of ids) {
        const [state] = await f.escrow.statusOf(id);
        if (state === 0n) { // still Open -> settle now
          await (await f.escrow.connect(f.stranger).settleExpired(id)).wait();
        }
        const [finalState] = await f.escrow.statusOf(id);
        expect(finalState === 1n || finalState === 2n).to.equal(true); // Released or Refunded, never Open
      }
      const escrowBalance = await f.token.balanceOf(await f.escrow.getAddress());
      expect(escrowBalance).to.equal(0n); // terminal invariant: nothing stranded
    });

    it("9.6 FUZZ passport: scores stay inside [300, 850] under random recording", async () => {
      const f = await loadFixture(deployAll);
      await (await f.passport.setRecorder(await f.payer.getAddress(), true)).wait();
      let seed = 424242;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      for (let i = 0; i < 60; i++) {
        const amount = BigInt(Math.floor(rnd() * 5_000_000) + 1) * 1_000_000_000_000n;
        const onTime = rnd() > 0.3;
        if (rnd() > 0.8) {
          await (await f.passport.connect(f.payer).recordDefault(f.payer.address, amount)).wait();
        } else {
          await (await f.passport.connect(f.payer).recordPayment(f.payer.address, amount, onTime)).wait();
        }
        const score = await f.passport.getScore(f.payer.address);
        if (score < 300n || score > 850n) {
          throw new Error("score out of range at iteration " + i + ": " + score.toString());
        }
      }
    });
  });
});
