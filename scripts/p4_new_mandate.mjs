/** Create a fresh E2E mandate (idempotent): refund any open escrows from
 *  prior runs, then createMandate(deposit 0.30) + authorizeCaller. */
import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "fs";

const RPC = "https://rpc1testnet.qie.digital/";
const P = new ethers.JsonRpcProvider(RPC, 1983, { staticNetwork: true });
const A = { WQIE: "0x5e165E6c7AC4039aEDc2a5505Ae35cb20764916c", MandateVault: "0x2FEf89522b8B0a55161ed11a7CB19B57C6fF2169", PayEndpoint: "0x4ccdE1dD4d2c3F39dB9D2b350516070257dfb647", EscrowCore: "0x7566803615CB5d9Ac15f24269C3305a2738C995b" };

const deployer = new ethers.Wallet(readFileSync("/home/z/my-project/agentpay/contracts/.env", "utf8").match(/DEPLOYER_PRIVATE_KEY=(0x[0-9a-fA-F]+)/)[1], P);
const agentAddr = JSON.parse(readFileSync("/home/z/my-project/agentpay/contracts/addresses/p4_roles_local.json", "utf8")).agentAddress;

const wq = new ethers.Contract(A.WQIE, ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], P);
const pay = new ethers.Contract(A.PayEndpoint, [
  "function refundCall(uint256) external",
  "function calls(uint256) view returns (uint256 id, uint256 productId, address agent, address principal, uint256 amount, uint256 escrowId, uint64 at)",
  "function nextCallId() view returns (uint256)",
], P);
const esc = new ethers.Contract(A.EscrowCore, ["function statusOf(uint256) view returns (uint8 state, uint64 deadline, uint256 amount, address payer, address payee)"], P);
const mv = new ethers.Contract(A.MandateVault, [
  "function createMandate(address, address, uint256, uint256, uint256) external returns (uint256)",
  "function authorizeCaller(uint256, address, bool) external",
  "function mandates(uint256) view returns (uint256,address,address,address,uint256,uint256,uint256,uint256,uint256,bool,uint64)",
  "function nextMandateId() view returns (uint256)",
  "function authorizedCallers(uint256, address) view returns (bool)",
], P);

const fmt = (x) => Number(x) / 1e18;
const W = (s) => ethers.parseEther(String(s));
const now = () => Math.floor(Date.now() / 1000);
const proof = existsSync("/home/z/my-project/research/p4_recovery_proof.json")
  ? JSON.parse(readFileSync("/home/z/my-project/research/p4_recovery_proof.json", "utf8"))
  : { steps: {} };

async function send(name, fn) {
  for (let i = 1; i <= 4; i++) {
    try {
      const est = await fn().catch(() => null);
      if (!est) return null;
      const rec = await est.wait();
      if (rec && rec.status === 1) { proof.steps[name] = rec.hash; console.log(`[ok] ${name}: ${rec.hash}`); return rec; }
      console.log(`[retry] ${name}: empty revert`);
      await new Promise((r) => setTimeout(r, 2500));
    } catch (e) {
      const msg = e?.shortMessage || e?.message || "";
      if (e?.receipt?.status === 0 || /reverted/.test(msg)) {
        console.log(`[retry] ${name}: confirmed-empty revert, one block pause`);
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }
      if (/CallNotOpen|NOT_PAYER|NOT_OPEN|already/i.test(msg)) { console.log(`[skip] ${name}`); return null; }
      if (/nonce|already known|replacement/i.test(msg)) { await new Promise((r) => setTimeout(r, 1200)); continue; }
      throw e;
    }
  }
  throw new Error(`retries exhausted: ${name}`);
}

// 1. refund any still-open escrows (from crashed runs) — payer right
const nextCall = Number(await pay.nextCallId());
for (let id = 1; id < nextCall; id++) {
  try {
    const c = await pay.calls(id);
    const s = await esc.statusOf(c.escrowId);
    if (Number(s.state) === 0 && Number(s.deadline) > now() && s.payer?.toLowerCase() === deployer.address.toLowerCase()) {
      await send(`refund-call-${id}`, () => pay.connect(deployer).refundCall(id, { gasLimit: 400000n }));
    }
  } catch {}
}

// 2. fresh mandate (next id) with deposit 0.30
const nid = Number(await mv.nextMandateId());
const m = await mv.mandates(nid);
if (!m[9] && m[1] === ethers.ZeroAddress) {
  const bal = await wq.balanceOf(deployer.address);
  console.log(`[prep] deployer WQIE=${fmt(bal)} -> mandate ${nid} (0.15/0.4/0.30)`);
  await send(`approve-m${nid}`, () => wq.connect(deployer).approve(A.MandateVault, W(0.3), { gasLimit: 120000n }));
  await send(`create-mandate-${nid}`, () => mv.connect(deployer).createMandate(agentAddr, A.WQIE, W(0.15), W(0.4), W(0.3), { gasLimit: 400000n }));
} else console.log(`[skip] mandate ${nid} exists`);

if (!(await mv.authorizedCallers(nid, A.PayEndpoint))) {
  await send(`authorize-m${nid}`, () => mv.connect(deployer).authorizeCaller(nid, A.PayEndpoint, true, { gasLimit: 150000n }));
}
const fin = await mv.mandates(nid);
console.log(`\nmandate ${nid}: balance=${fmt(fin[8])} perCall=${fmt(fin[4])} daily=${fmt(fin[5])} active=${fin[9]} agent=${fin[2]}`);
console.log(`deployer WQIE: ${fmt(await wq.balanceOf(deployer.address))}`);
writeFileSync("/home/z/my-project/research/p4_recovery_proof.json", JSON.stringify(proof, null, 2));
console.log(`\nRUN E2E WITH: MANDATE_ID=${nid}`);
