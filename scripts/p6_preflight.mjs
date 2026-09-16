/**
 * P6 MAINNET PREFLIGHT (read-only, zero gas)
 * 1. RPC sanity: https://rpc1.qie.digital/ (hardhat config) vs https://rpc1mainnet.qie.digital/ (DEPLOY.md)
 * 2. Official QIE/USD AggregatorV3 feed 0x3Bc617cF…3D17 on mainnet: latestRoundData must be fresh + sane
 * 3. Testnet deploy receipts → total deploy gas → mainnet cost @ 1.125 gwei
 * 4. explorer endpoints for source verification
 */
import { ethers } from "ethers";
import { readFileSync } from "fs";
import { join } from "path";

const MAIN_CFG = "https://rpc1.qie.digital/";       // what hardhat.config.ts uses
const MAIN_DOC = "https://rpc1mainnet.qie.digital/"; // what DEPLOY.md uses
const FEED = "0x3Bc617cF3A4Bb77003e4c556B87b13D556903D17";
const V3 = [
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
];

async function rpcInfo(url) {
  try {
    const p = new ethers.JsonRpcProvider(url, 1990, { staticNetwork: true });
    const [net, head] = await Promise.all([p.getNetwork(), p.getBlockNumber()]);
    const lag = await (async () => {
      const b = await p.getBlock("latest");
      return Math.floor(Date.now() / 1000) - b.timestamp;
    })().catch(() => -1);
    return { url, ok: true, chainId: Number(net.chainId), head, headLagSec: lag };
  } catch (e) {
    return { url, ok: false, err: String(e).slice(0, 120) };
  }
}

const [cfg, doc] = await Promise.all([rpcInfo(MAIN_CFG), rpcInfo(MAIN_DOC)]);
console.log("RPC hardhat-config :", cfg);
console.log("RPC deploy-doc     :", doc);

// 2) official feed on whichever RPC answers
const P = new ethers.JsonRpcProvider((cfg.ok ? cfg : doc).url, 1990, { staticNetwork: true });
let feedReport;
try {
  const code = await P.getCode(FEED);
  const agg = new ethers.Contract(FEED, V3, P);
  const [dec, desc, data] = await Promise.all([
    agg.decimals().catch(() => -1),
    agg.description().catch(() => "(no description)"),
    agg.latestRoundData(),
  ]);
  const [, price, , updatedAt] = data;
  const age = Math.floor(Date.now() / 1000) - Number(updatedAt);
  feedReport = {
    codeSize: (code === "0x" ? 0 : code.length / 2 - 1),
    decimals: Number(dec),
    description: desc,
    priceUsd: ethers.formatUnits(price, Number(dec) < 0 ? 8 : Number(dec)),
    updatedAtAgeSec: age,
    verdict: code === "0x" ? "NO CONTRACT AT ADDRESS" : age < 86400 * 30 ? "FRESH ✓" : "STALE ⚠ (check heartbeat)",
  };
} catch (e) {
  feedReport = { err: String(e).slice(0, 200) };
}
console.log("OFFICIAL FEED      :", feedReport);

// 3) testnet deployment gas → mainnet cost estimate
const T = new ethers.JsonRpcProvider("https://rpc1testnet.qie.digital/", 1983, { staticNetwork: true });
const addr = JSON.parse(readFileSync(join(process.cwd(), "addresses", "qieTestnet.json"), "utf8"));
const deployer = new ethers.Wallet(
  readFileSync(join(process.cwd(), ".env"), "utf8").match(/DEPLOYER_PRIVATE_KEY=(0x[0-9a-fA-F]+)/)[1], T
);
// find deploy txs: scan deployer's nonce history is heavy; instead use known receipts via explorer-free method —
// contract creation txs are found by scanning the deployer's tx list from the testnet explorer API if available.
// Fallback: estimate per-contract by deploying nothing — use published testnet receipt file if present.
const receiptFile = join(process.cwd(), "addresses", "deploy_receipts_qieTestnet.json");
let totalGas = null;
try {
  const rec = JSON.parse(readFileSync(receiptFile, "utf8"));
  totalGas = rec.reduce((s, r) => s + Number(r.gasUsed), 0);
  console.log("TESTNET RECEIPTS   :", rec.length, "txs, total gasUsed", totalGas.toLocaleString());
} catch {
  console.log("TESTNET RECEIPTS   : deploy_receipts_qieTestnet.json missing — will estimate 20M gas");
  totalGas = 20_000_000;
}
const gasPrice = 1_125_000_000n; // measured 1.125 gwei
const cost = BigInt(totalGas) * gasPrice * 2n; // 2x headroom (wiring txs + feed)
console.log("COST ESTIMATE      :", ethers.formatEther(cost), "QIE at 1.125 gwei (2x headroom)");
console.log("DEPLOYER MAINNET   : funded separately; ask user for >= ", ethers.formatEther(cost), "QIE");
