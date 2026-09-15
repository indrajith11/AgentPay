/**
 * P4-1 on-chain prep (testnet 1983) — idempotent, safe-retry.
 *
 *  1. Generate fresh p4agent wallet (key stays in gitignored local json)
 *  2. Fund p4agent native gas from funder1
 *  3. Deployer closes mandate 4 (recovers 0.606 WQIE — principal key held)
 *  4. p4agent registers itself on AgentRegistry
 *  5. Deployer binds itself as p4agent's principal
 *  6. Deployer creates mandate 6 (perCall 0.15 / daily 0.4 / deposit 0.45 WQIE)
 *  7. Deployer authorizes PayEndpoint as mandate caller
 *  8. Deployer lists product 2 "General Admission" $0.10 + product 3 "VIP Backstage" $0.10
 *
 * Keys NEVER printed. Re-run safe: every step checks current state first.
 */
import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "fs";

const RPC = "https://rpc1testnet.qie.digital/";
const P = new ethers.JsonRpcProvider(RPC, 1983, { staticNetwork: true });

const A = {
  WQIE: "0x5e165E6c7AC4039aEDc2a5505Ae35cb20764916c",
  AgentRegistry: "0x715f9449145C2FC74c74556154F17C522a30ED09",
  MandateVault: "0x2FEf89522b8B0a55161ed11a7CB19B57C6fF2169",
  PayEndpoint: "0x4ccdE1dD4d2c3F39dB9D2b350516070257dfb647",
};

const ROLES_LOCAL = "/home/z/my-project/agentpay/contracts/addresses/p4_roles_local.json";
const PROOF = "/home/z/my-project/research/p4_prep_proof.json";

const deployerKey = readFileSync("/home/z/my-project/agentpay/contracts/.env", "utf8").match(/DEPLOYER_PRIVATE_KEY=(0x[0-9a-fA-F]+)/)[1];
const funder1Key = JSON.parse(readFileSync("/home/z/my-project/agentpay/contracts/addresses/faucet_funder.json", "utf8")).private_key;

const deployer = new ethers.Wallet(deployerKey, P);
const funder1 = new ethers.Wallet(funder1Key, P);

// ---- roles file (local, gitignored) ----
let p4agent;
if (existsSync(ROLES_LOCAL)) {
  const j = JSON.parse(readFileSync(ROLES_LOCAL, "utf8"));
  p4agent = new ethers.Wallet(j.agentPrivateKey, P);
  console.log(`[roles] existing p4agent ${p4agent.address}`);
} else {
  p4agent = ethers.Wallet.createRandom().connect(P);
  writeFileSync(ROLES_LOCAL, JSON.stringify({ agentPrivateKey: p4agent.privateKey, agentAddress: p4agent.address, principal: deployer.address }, null, 2), { mode: 0o600 });
  console.log(`[roles] NEW p4agent ${p4agent.address} (key saved local-only)`);
}

const wq = new ethers.Contract(A.WQIE, [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
], P);
const ar = new ethers.Contract(A.AgentRegistry, [
  "function registerAgent(string) external",
  "function bindPrincipal(address agent, string qiePassId) external",
  "function getAgent(address) view returns (tuple(address agentAddr, address principal, string name, string qiePassId, bool active, uint64 registeredAt, uint64 boundAt))",
], P);
const mv = new ethers.Contract(A.MandateVault, [
  "function closeMandate(uint256) external",
  "function createMandate(address agent, address token, uint256 perCallCap, uint256 dailyCap, uint256 initialDeposit) external returns (uint256)",
  "function authorizeCaller(uint256 mandateId, address caller, bool authorized) external",
  "function mandates(uint256 id) view returns (uint256 id, address principal, address agent, address token, uint256 perCallCap, uint256 dailyCap, uint256 spentToday, uint256 currentDay, uint256 balance, bool active, uint64 createdAt)",
  "function nextMandateId() view returns (uint256)",
  "function authorizedCallers(uint256 mandateId, address caller) view returns (bool)",
], P);
const pay = new ethers.Contract(A.PayEndpoint, [
  "function addProductUsd(string name, string endpointPath, string metadataURI, uint256 priceUsd) external returns (uint256 id)",
  "function products(uint256) view returns (uint256 id, address merchant, string name, string endpointPath, string metadataURI, uint256 pricePerCall, bool active, uint256 totalCalls, uint256 grossRevenue, uint64 createdAt, bool usdPriced, uint256 priceUsd)",
  "function productCount() view returns (uint256)",
], P);

const fmt = (w) => Number(w) / 1e18;
const proof = { network: "qieTestnet 1983", at: new Date().toISOString(), steps: {} };

/** Send with safe retry: status-0 receipt provably moved no money -> resend OK. */
async function send(name, fn) {
  for (let i = 1; i <= 3; i++) {
    try {
      const tx = await fn();
      const rec = await tx.wait();
      if (rec && rec.status === 1) { proof.steps[name] = rec.hash; console.log(`[ok] ${name}: ${rec.hash}`); return rec; }
      console.log(`[retry] ${name}: attempt ${i} reverted-empty (stale replica), pausing one block`);
      await new Promise((r) => setTimeout(r, 2500));
    } catch (e) {
      const msg = e?.shortMessage || e?.message || "";
      if (/nonce|already known|replacement/i.test(msg)) { await new Promise((r) => setTimeout(r, 1200)); continue; }
      throw e;
    }
  }
  throw new Error(`send failed after retries: ${name}`);
}

// 1. fund p4agent gas (0.0002 QIE — gas is 7 wei/unit, generous)
const gasBal = await P.getBalance(p4agent.address);
if (gasBal < ethers.parseEther("0.0001")) {
  await send("fund-agent-gas", () => funder1.sendTransaction({ to: p4agent.address, value: ethers.parseEther("0.0002") }));
} else console.log(`[skip] agent gas funded (${fmt(gasBal)} QIE)`);

// 2. deployer closes mandate 4 (recover 0.606 WQIE)
const m4 = await mv.mandates(4);
if (m4.active) {
  console.log(`[prep] closing mandate 4 (balance ${fmt(m4.balance)} WQIE -> deployer)`);
  await send("close-mandate-4", () => mv.connect(deployer).closeMandate(4));
} else console.log("[skip] mandate 4 already closed");

// 3. agent registers
const agentInfo = await ar.getAgent(p4agent.address);
if (agentInfo.agentAddr === ethers.ZeroAddress) {
  await send("register-agent", () => ar.connect(p4agent).registerAgent("p4-ticket-agent"));
} else console.log(`[skip] agent registered (principal=${agentInfo.principal})`);

// 4. deployer binds itself as principal
const agentInfo2 = await ar.getAgent(p4agent.address);
if (agentInfo2.principal === ethers.ZeroAddress) {
  await send("bind-principal", () => ar.connect(deployer).bindPrincipal(p4agent.address, "qie-pass-p4"));
} else console.log(`[skip] principal bound: ${agentInfo2.principal}`);

// 5. create mandate 6 (principal = deployer)
const nextId = Number(await mv.nextMandateId());
const wantDeposit = ethers.parseEther("0.45");
const mNew = await mv.mandates(nextId);
if (!mNew.active && mNew.principal === ethers.ZeroAddress) {
  const bal = await wq.balanceOf(deployer.address);
  console.log(`[prep] deployer WQIE=${fmt(bal)} -> creating mandate ${nextId} (perCall 0.15 / daily 0.4 / deposit 0.45)`);
  await send("approve-wqie", () => wq.connect(deployer).approve(A.MandateVault, wantDeposit));
  await send("create-mandate", () => mv.connect(deployer).createMandate(p4agent.address, A.WQIE, ethers.parseEther("0.15"), ethers.parseEther("0.4"), wantDeposit));
} else console.log(`[skip] mandate ${nextId}: principal=${mNew.principal} active=${mNew.active} balance=${fmt(mNew.balance)}`);

// 6. authorize PayEndpoint as caller
const mandId = nextId;
const already = await mv.authorizedCallers(mandId, A.PayEndpoint);
if (!already) await send("authorize-payendpoint", () => mv.connect(deployer).authorizeCaller(mandId, A.PayEndpoint, true));
else console.log("[skip] PayEndpoint already authorized");

// 7. products: GA (2) + VIP (3) at $0.10 each (8-dec USD)
const pc = Number(await pay.productCount());
const want = [
  { name: "General Admission — Agentic Commerce Meetup", path: "/v1/product/event-ticket", uri: "ipfs://agentpay-ticket-ga", usd: 10000000n },
  { name: "VIP Backstage — Agentic Commerce Meetup", path: "/v1/product/vip-ticket", uri: "ipfs://agentpay-ticket-vip", usd: 10000000n },
];
for (const w of want) {
  let found = null;
  for (let i = 1; i <= pc; i++) {
    const p = await pay.products(i);
    if (p.endpointPath === w.path) found = i;
  }
  if (!found) {
    const rec = await send(`addProduct:${w.path}`, () => pay.connect(deployer).addProductUsd(w.name, w.path, w.uri, w.usd));
    found = Number(await pay.productCount());
    console.log(`       -> product id ${found}`);
  } else console.log(`[skip] product exists: ${w.path} = id ${found}`);
}

// summary
const deployerW = await wq.balanceOf(deployer.address);
const m6 = await mv.mandates(mandId);
console.log(`\n=== P4 PREP SUMMARY ===`);
console.log(`p4agent:  ${p4agent.address}`);
console.log(`mandate:  ${mandId}  balance=${fmt(m6.balance)} perCall=${fmt(m6.perCallCap)} daily=${fmt(m6.dailyCap)} active=${m6.active}`);
console.log(`deployer WQIE left: ${fmt(deployerW)}`);
proof.summary = { p4agent: p4agent.address, mandateId: mandId, mandateBalance: fmt(m6.balance), deployerWQIE: fmt(deployerW) };
writeFileSync(PROOF, JSON.stringify(proof, null, 2));
console.log(`proof -> ${PROOF}`);
