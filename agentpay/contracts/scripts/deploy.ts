import hre from "hardhat";

const { ethers } = hre;
import * as fs from "fs";
import * as path from "path";

/**
 * AgentPay x MerchantPilot — deployment script
 * Deploys all 9 contracts in dependency order and wires the recorder roles.
 * Writes an address book to addresses/<network>.json
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy.ts --network qieTestnet
 *   Optional env:
 *     SETTLEMENT_TOKEN  — ERC20 settlement asset (e.g. an on-chain stable when
 *                         one is officially available on QIE; NOT a mock on mainnet)
 *     USD_FEED_TOKEN    — token address to map to a QIE Oracle USD feed
 *     USD_FEED_ADDRESS  — official QIE Oracle AggregatorV3 feed for that token
 *                         (mainnet QIE/USD = 0x3Bc617cF3A4Bb77003e4c556B87b13D556903D17)
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const network = hre.network.name;
  console.log(`Deploying on ${network} with ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer QIE balance: ${ethers.formatEther(balance)}`);

  // 1) WQIE — wraps native QIE 1:1 so the whole stack settles in the chain asset
  const WQIE = await ethers.getContractFactory("WQIE");
  const wqie = await WQIE.deploy();
  await wqie.waitForDeployment();
  console.log("WQIE                  :", await wqie.getAddress());

  // 1) MerchantRegistry
  const MerchantRegistry = await ethers.getContractFactory("MerchantRegistry");
  const merchantRegistry = await MerchantRegistry.deploy(deployer.address);
  await merchantRegistry.waitForDeployment();
  console.log("MerchantRegistry      :", await merchantRegistry.getAddress());

  // 2) AgentRegistry
  const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
  const agentRegistry = await AgentRegistry.deploy();
  await agentRegistry.waitForDeployment();
  console.log("AgentRegistry         :", await agentRegistry.getAddress());

  // 3) EscrowCore (10 min default refund window)
  const EscrowCore = await ethers.getContractFactory("EscrowCore");
  const escrow = await EscrowCore.deploy(600);
  await escrow.waitForDeployment();
  // relayer wiring happens after PayEndpoint deploys (see below)
  console.log("EscrowCore            :", await escrow.getAddress());

  // 4) SettlementRouter
  const SettlementRouter = await ethers.getContractFactory("SettlementRouter");
  const settlementRouter = await SettlementRouter.deploy(deployer.address, deployer.address);
  await settlementRouter.waitForDeployment();
  console.log("SettlementRouter      :", await settlementRouter.getAddress());

  // 5) CreditPassport
  const CreditPassport = await ethers.getContractFactory("CreditPassport");
  const creditPassport = await CreditPassport.deploy(deployer.address);
  await creditPassport.waitForDeployment();
  console.log("CreditPassport        :", await creditPassport.getAddress());

  // 6) MandateVault
  const MandateVault = await ethers.getContractFactory("MandateVault");
  const mandateVault = await MandateVault.deploy(await agentRegistry.getAddress());
  await mandateVault.waitForDeployment();
  console.log("MandateVault          :", await mandateVault.getAddress());

  // 7) PayEndpoint
  const PayEndpoint = await ethers.getContractFactory("PayEndpoint");
  const payEndpoint = await PayEndpoint.deploy(
    await merchantRegistry.getAddress(),
    await agentRegistry.getAddress(),
    await mandateVault.getAddress(),
    await escrow.getAddress(),
    await settlementRouter.getAddress(),
    await creditPassport.getAddress()
  );
  await payEndpoint.waitForDeployment();
  console.log("PayEndpoint           :", await payEndpoint.getAddress());

  // allow PayEndpoint to relay validated refunds to the escrow
  await (await escrow.setRelayer(await payEndpoint.getAddress(), true)).wait();
  console.log("Escrow relayer set    : PayEndpoint");

  // optional: wire official QIE Oracle USD feed for a settlement asset
  const FEED_TOKEN = process.env.USD_FEED_TOKEN || (await wqie.getAddress());
  // Mainnet: official QIE/USD feed. Testnet: the oracle isn't deployed there,
  // so deploy a clearly-labelled MockAggregator stand-in ($0.18 = live mainnet price).
  let FEED_ADDR = process.env.USD_FEED_ADDRESS || "";
  if (!FEED_ADDR) {
    if (network === "qieMainnet") {
      FEED_ADDR = "0x3Bc617cF3A4Bb77003e4c556B87b13D556903D17";
      console.log("PayEndpoint USD feed : using OFFICIAL QIE Oracle (mainnet)");
    } else {
      const MockAggregator = await ethers.getContractFactory("MockAggregator");
      const mockFeed = await MockAggregator.deploy();
      await mockFeed.waitForDeployment();
      const blk = await ethers.provider.getBlock("latest");
      await (await mockFeed.setData(ethers.parseUnits("0.18", 8), blk!.timestamp)).wait();
      FEED_ADDR = await mockFeed.getAddress();
      console.log(`PayEndpoint USD feed : TESTNET MOCK aggregator at ${FEED_ADDR} ($0.18)`);
    }
  }
  await (await payEndpoint.setUsdFeed(FEED_TOKEN, FEED_ADDR)).wait();
  console.log(`PayEndpoint USD feed : ${FEED_TOKEN} -> ${FEED_ADDR}`);

  // 8) InvoiceVault
  const InvoiceVault = await ethers.getContractFactory("InvoiceVault");
  const invoiceVault = await InvoiceVault.deploy(
    await merchantRegistry.getAddress(),
    await settlementRouter.getAddress(),
    await creditPassport.getAddress()
  );
  await invoiceVault.waitForDeployment();
  console.log("InvoiceVault          :", await invoiceVault.getAddress());

  // 9) RecurringMandate
  const RecurringMandate = await ethers.getContractFactory("RecurringMandate");
  const recurringMandate = await RecurringMandate.deploy(
    await merchantRegistry.getAddress(),
    await settlementRouter.getAddress(),
    await creditPassport.getAddress()
  );
  await recurringMandate.waitForDeployment();
  console.log("RecurringMandate      :", await recurringMandate.getAddress());

  // ---- wire recorder roles ----
  console.log("\nWiring recorder roles...");
  const payAddr = await payEndpoint.getAddress();
  const invAddr = await invoiceVault.getAddress();
  const recAddr = await recurringMandate.getAddress();

  await (await settlementRouter.setRecorder(payAddr, true)).wait();
  await (await settlementRouter.setRecorder(invAddr, true)).wait();
  await (await settlementRouter.setRecorder(recAddr, true)).wait();

  await (await creditPassport.setRecorder(payAddr, true)).wait();
  await (await creditPassport.setRecorder(invAddr, true)).wait();
  await (await creditPassport.setRecorder(recAddr, true)).wait();
  console.log("Recorders wired: PayEndpoint, InvoiceVault, RecurringMandate");

  const addresses = {
    network,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    MerchantRegistry: await merchantRegistry.getAddress(),
    AgentRegistry: await agentRegistry.getAddress(),
    EscrowCore: await escrow.getAddress(),
    SettlementRouter: await settlementRouter.getAddress(),
    CreditPassport: await creditPassport.getAddress(),
    MandateVault: await mandateVault.getAddress(),
    PayEndpoint: payAddr,
    InvoiceVault: invAddr,
    RecurringMandate: recAddr,
    WQIE: await wqie.getAddress(),
    settlementToken: process.env.SETTLEMENT_TOKEN || (await wqie.getAddress()),
    qieUsdOracle: "0x3Bc617cF3A4Bb77003e4c556B87b13D556903D17", // official QIE mainnet QIE/USD feed
    usdFeedToken: FEED_TOKEN,
    usdFeedAddress: FEED_ADDR,
  };

  // ESM-safe __dirname equivalent (script may run as CJS or ESM depending on ts-node mode)
  const here = typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(new URL(import.meta.url).pathname);
  const dir = path.join(here, "..", "addresses");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network}.json`);
  fs.writeFileSync(file, JSON.stringify(addresses, null, 2));
  console.log(`\nAddress book written to ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
