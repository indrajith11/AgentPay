import { ethers } from "ethers";
import { readFileSync } from "fs";

// mainnet RPC reachability
const MAIN = "https://rpc1mainnet.qie.digital/";
const P = new ethers.JsonRpcProvider(MAIN, 1990, { staticNetwork: true });
const [net, bn, gas] = await Promise.all([
  P.getNetwork().catch(e => ({ err: String(e).slice(0,80) })),
  P.getBlockNumber().catch(e => ({ err: String(e).slice(0,80) })),
  P.getFeeData().catch(e => ({ err: String(e).slice(0,80) })),
]);
console.log("MAINNET chainId:", net.chainId ?? net.err, "| head:", bn, "| gasPrice:", gas.gasPrice?.toString() ?? gas.err);

// deployer balance on mainnet
const key = readFileSync("/home/z/my-project/agentpay/contracts/.env","utf8").match(/DEPLOYER_PRIVATE_KEY=(0x[0-9a-fA-F]+)/)[1];
const w = new ethers.Wallet(key, P);
const bal = await P.getBalance(w.address);
console.log("deployer:", w.address, "| mainnet QIE:", ethers.formatEther(bal));
