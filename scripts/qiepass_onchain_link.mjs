// QIE Pass -> on-chain link (MAINNET chain 1990).
// 1) deployer funds the KYC'd user wallet with 0.1 QIE (gas for future user-side txs)
// 2) deployer (registered merchant 0x33E0…) calls setQiePassId(credentialId) on MerchantRegistry
// Usage: node scripts/qiepass_onchain_link.mjs
import { readFileSync } from "fs";
import { ethers } from "ethers";

const env = readFileSync("/home/z/my-project/.env", "utf8");
const key = env.match(/DEPLOYER_PRIVATE_KEY=(0x[0-9a-fA-F]+)/)?.[1];
if (!key) { console.error("no DEPLOYER_PRIVATE_KEY"); process.exit(1); }

const CREDENTIAL_ID = "vc:qie:472fd802ba7a1290ae3f8f8dcb5844d8";
const REG = "0x0049BA098899713C0c24C2214252e4b71D9dC7b2";
const USER = "0x40cBdB3aceBF0bDdfbD52a96ed6702Dcf7A96307";
const EXPLORER = (h) => `https://mainnet.qie.digital/tx/${h}`;

const p = new ethers.JsonRpcProvider("https://rpc1mainnet.qie.digital/", 1990, { staticNetwork: true });
const wallet = new ethers.Wallet(key, p);
const me = await wallet.getAddress();
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
console.log("deployer:", short(me), "| balance:", ethers.formatEther(await p.getBalance(me)), "QIE");

// legacy-fee helper (custom chains: avoid 1559 surprises)
async function send(txReq) {
  const [gasEst, fee, nonce] = await Promise.all([
    p.estimateGas({ ...txReq, from: me }),
    p.getFeeData(),
    p.getTransactionCount(me, "pending"),
  ]);
  return wallet.sendTransaction({
    ...txReq,
    gasLimit: (gasEst * 130n) / 100n,
    gasPrice: fee.gasPrice,
    nonce,
    type: 0,
  });
}

// --- 1) fund user wallet ---
const uBal = await p.getBalance(USER);
if (uBal < ethers.parseEther("0.001")) {
  const t1 = await send({ to: USER, value: ethers.parseEther("0.1") });
  console.log("fund tx:", t1.hash);
  const r1 = await t1.wait();
  console.log(`  mined (block ${r1.blockNumber}) -> ${EXPLORER(t1.hash)}`);
} else {
  console.log("user wallet already funded:", ethers.formatEther(uBal), "QIE");
}

// --- 2) setQiePassId on mainnet registry ---
const abi = [
  "function setQiePassId(string calldata qiePassId)",
  "function getMerchant(address merchant) view returns ((address owner, string name, string metadataURI, string qiePassId, bool verified, bool active, uint64 registeredAt))",
];
const regRW = new ethers.Contract(REG, abi, wallet);
const regRO = new ethers.Contract(REG, abi, p);

try {
  await regRW.setQiePassId.staticCall(CREDENTIAL_ID);
} catch (e) {
  console.error("setQiePassId simulation FAILED — aborting:", String(e?.shortMessage || e).slice(0, 140));
  process.exit(1);
}
const before = await regRO.getMerchant(me);
console.log("merchant before | verified:", before.verified, "| qiePassId:", JSON.stringify(before.qiePassId));

const t2 = await send({ to: REG, data: regRW.interface.encodeFunctionData("setQiePassId", [CREDENTIAL_ID]) });
console.log("setQiePassId tx:", t2.hash);
const r2 = await t2.wait();
console.log(`  mined (block ${r2.blockNumber}) -> ${EXPLORER(t2.hash)}`);

const after = await regRO.getMerchant(me);
console.log("merchant after  | verified:", after.verified, "| qiePassId:", JSON.stringify(after.qiePassId));
console.log("\nDONE — VC linked on-chain on QIE MAINNET (chain 1990)");
