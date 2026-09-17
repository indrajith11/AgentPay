// RESTORE SCRIPT — run after any workspace reset.
// Rebuilds root .env + agentpay/contracts/.env from the /tmp deployer backup.
// Never prints secrets. Usage: node scripts/restore_after_reset.mjs

import fs from "fs";
import path from "path";
import { ethers } from "ethers"; // resolved from root node_modules

const ROOT = "/home/z/my-project";
const BACKUP = "/tmp/my-project/.mainnet-deployer.json";
const EXPECTED = "0x33e00d801943d945dc5ec92a2192425427023586";

if (!fs.existsSync(BACKUP)) {
  console.error("FATAL: /tmp backup missing. Ask Indrajith for the deployer key he saved in chat.");
  process.exit(1);
}
const { address, privateKey } = JSON.parse(fs.readFileSync(BACKUP, "utf8"));
const wallet = new ethers.Wallet(privateKey);
if (wallet.address.toLowerCase() !== EXPECTED) {
  console.error(`FATAL: backup key derives to ${wallet.address}, expected ${EXPECTED}`);
  process.exit(1);
}
console.log("deployer key verified ->", wallet.address, "(matches mainnet deployer)");

// 1) root .env (dashboard)
const rootEnv = [
  "# AgentPay dashboard env (auto-restored by scripts/restore_after_reset.mjs)",
  "# NEVER commit this file (gitignored).",
  "",
  'DATABASE_URL="file:./db/custom.db"',
  "",
  "# Mainnet burner deployer (synced from /tmp backup, verified derivation)",
  `DEPLOYER_PRIVATE_KEY=${privateKey}`,
  "",
  "# QIE network the dashboard targets",
  "NEXT_PUBLIC_QIE_NETWORK=qieMainnet",
  "",
  "# QIE Pass partner API (sandbox) — regenerate anytime at dev-qiepass.qie.digital",
  "QIEPASS_BASE_URL=https://did-stapi.qie.digital",
  "QIEPASS_PUBLIC_KEY=pk_test_91414f94fa9b8602b1a993cd36a04287",
  "QIEPASS_SECRET_KEY=REDACTED_ROTATE_AT_DEV-QIEPASS",
  "",
].join("\n");
fs.writeFileSync(path.join(ROOT, ".env"), rootEnv);
console.log("root .env restored");

// 2) contracts .env (hardhat)
const contractsEnv = [
  "# agentpay/contracts env (auto-restored by scripts/restore_after_reset.mjs)",
  `DEPLOYER_PRIVATE_KEY=${privateKey}`,
  "",
].join("\n");
fs.writeFileSync(path.join(ROOT, "agentpay/contracts/.env"), contractsEnv);
console.log("agentpay/contracts/.env restored");

// 3) keep a fresh copy of the backup outside /tmp too (survives tmp cleanup)
fs.mkdirSync(path.join(ROOT, "scripts"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "scripts/.mainnet-deployer-backup.json"),
  JSON.stringify({ address, privateKey }, null, 2)
);
fs.chmodSync(path.join(ROOT, "scripts/.mainnet-deployer-backup.json"), 0o600);
console.log("backup copied to scripts/.mainnet-deployer-backup.json (chmod 600, gitignored via dotfile?)");

// ensure gitignore covers it in agentpay repo context — it lives in root scripts/, root has own git
console.log("DONE — next: cd agentpay/contracts && npm ci");
