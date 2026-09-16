import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
dotenv.config();

/**
 * QIE Network configuration
 * - QIE Testnet : Chain ID 1983, RPC https://rpc1testnet.qie.digital/
 * - QIE Mainnet : Chain ID 1990, RPC https://rpc1mainnet.qie.digital/
 * Faucet (testnet only): https://qie.digital/faucet
 */
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    qieTestnet: {
      chainId: 1983,
      url: process.env.QIE_TESTNET_RPC || "https://rpc1testnet.qie.digital/",
      accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
    },
    qieMainnet: {
      chainId: 1990,
      url: process.env.QIE_MAINNET_RPC || "https://rpc1mainnet.qie.digital/",
      accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
    },
  },
};

export default config;
