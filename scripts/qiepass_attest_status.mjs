// Read-only status check before the QIE Pass on-chain attestation.
// Usage: node scripts/qiepass_attest_status.mjs
import { readFileSync } from "fs";
import { ethers } from "ethers";

const env = readFileSync("/home/z/my-project/.env", "utf8");
const key = env.match(/DEPLOYER_PRIVATE_KEY=(0x[0-9a-fA-F]+)/)?.[1];
if (!key) { console.error("no DEPLOYER_PRIVATE_KEY"); process.exit(1); }

const RPCS = [
  "https://rpc1mainnet.qie.digital/",
  "https://rpc2mainnet.qie.digital/",
  "https://rpc3mainnet.qie.digital/",
];
let p = null;
for (const url of RPCS) {
  try {
    const cand = new ethers.JsonRpcProvider(url, 1990, { staticNetwork: true });
    const b = await cand.getBlockNumber();
    console.log(`RPC OK ${url} (block ${b})`);
    p = cand; break;
  } catch (e) { console.log(`RPC fail ${url}: ${String(e).slice(0, 60)}`); }
}
if (!p) process.exit(1);

const REG = "0x0049BA098899713C0c24C2214252e4b71D9dC7b2"; // MAINNET (chain 1990)
const USER = "0x40cBdB3aceBF0bDdfbD52a96ed6702Dcf7A96307";

const wallet = new ethers.Wallet(key, p);
const dAddr = await wallet.getAddress();
const dBal = await p.getBalance(dAddr);
const uBal = await p.getBalance(USER);
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
console.log(`DEPLOYER ${short(dAddr)} balance: ${ethers.formatEther(dBal)} QIE`);
console.log(`USER     ${short(USER)} balance: ${ethers.formatEther(uBal)} QIE`);

const abi = [
  "function verifyMerchant(address merchant, bool verified)",
  "function isVerifiedMerchant(address merchant) view returns (bool)",
  "function isMerchantActive(address merchant) view returns (bool)",
  "function verifier() view returns (address)",
  "function merchants(address) view returns (address owner, string name, string metadataURI, string qiePassId, bool verified, bool active, uint64 registeredAt)",
];
const reg = new ethers.Contract(REG, abi, p);

try { console.log("verifier():", await reg.verifier()); } catch (e) { console.log("verifier() call failed:", String(e).slice(0, 80)); }

for (const addr of [USER, dAddr]) {
  try {
    const m = await reg.merchants(addr);
    console.log(`${short(addr)} registered:`, m.owner !== ethers.ZeroAddress, `| name: ${m.name} | qiePassId: ${m.qiePassId} | verified: ${m.verified}`);
  } catch (e) { console.log(`${short(addr)} merchants() call failed: ${String(e).slice(0, 80)}`); }
  try { console.log(`${short(addr)} isVerifiedMerchant:`, await reg.isVerifiedMerchant(addr)); }
  catch (e) { console.log(`${short(addr)} isVerifiedMerchant: call failed ${String(e).slice(0, 80)}`); }
}

// Simulate verifyMerchant(USER, true) as deployer to capture the revert reason
const regAsWallet = new ethers.Contract(REG, abi, wallet);
try {
  await regAsWallet.verifyMerchant.staticCall(USER, true);
  console.log("staticCall verifyMerchant(USER,true): would SUCCEED");
} catch (e) {
  const msg = String(e?.shortMessage || e?.message || e);
  console.log("staticCall verifyMerchant(USER,true) revert:", msg.slice(0, 120));
}
