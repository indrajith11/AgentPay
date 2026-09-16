// Generates the NEW mainnet deployer wallet (old 0xe91d…3dBc key destroyed by sandbox reset).
// DURABILITY: key is written to (1) contracts/.env [gitignored], (2) /tmp/my-project snapshot dir,
// (3) printed to the user in chat as last-resort backup (throwaway gas wallet, holds < $1).
const { ethers } = require("ethers");
const fs = require("fs");

const wallet = ethers.Wallet.createRandom();
const addr = wallet.address;
const pk = wallet.privateKey;

const block =
  "=============================================\n" +
  "NEW MAINNET DEPLOYER (generated " + new Date().toISOString() + ")\n" +
  "ADDRESS:      " + addr + "\n" +
  "PRIVATE KEY:  " + pk + "\n" +
  "MNEMONIC:     " + wallet.mnemonic.phrase + "\n" +
  "CHAIN:        QIE mainnet 1990 (rpc1mainnet.qie.digital)\n" +
  "OLD WALLET 0xe91d9ddad8B1d13038aBe8A91F2573bF92583dBc IS DEAD — NEVER FUND IT\n" +
  "=============================================\n";

// 1. contracts/.env (gitignored — where hardhat reads DEPLOYER_PRIVATE_KEY)
const envPath = __dirname + "/../agentpay/contracts/.env";
let env = "";
try { env = fs.readFileSync(envPath, "utf8"); } catch {}
env = env.replace(/^DEPLOYER_PRIVATE_KEY=.*$/m, "").replace(/\n{3,}/g, "\n\n");
fs.writeFileSync(envPath, env.trimEnd() + "\n\n# NEW mainnet deployer (old key destroyed — never fund 0xe91d…3dBc)\nDEPLOYER_PRIVATE_KEY=" + pk + "\n");

// 2. /tmp snapshot dir (survived 1 of 2 resets)
try {
  fs.mkdirSync("/tmp/my-project", { recursive: true });
  fs.writeFileSync("/tmp/my-project/.mainnet-deployer.json", JSON.stringify({ address: addr, privateKey: pk, created: new Date().toISOString() }, null, 2));
} catch (e) { console.error("tmp backup failed:", e.message); }

console.log("ADDRESS: " + addr);
console.log(block);
