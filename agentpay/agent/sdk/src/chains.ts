/**
 * @agentpay/sdk — network registry.
 *
 * Addresses are the LIVE deployments on QIE testnet 1983 (see
 * agentpay/contracts/addresses/qieTestnet.json). qieMainnet (1990) is the
 * P6 slot: flip `defaultNetwork` after the mainnet deploy — the SDK API
 * does not change.
 */
import type { NetworkConfig } from "./types.js";

export const NETWORKS: Record<string, NetworkConfig> = {
  qieTestnet: {
    name: "QIE Testnet",
    chainId: 1983,
    rpcUrls: [
      "https://rpc1testnet.qie.digital/",
      "https://rpc2testnet.qie.digital/",
      "https://rpc3testnet.qie.digital/",
    ],
    explorer: "https://testnet.qie.digital",
    contracts: {
      WQIE: "0x5e165E6c7AC4039aEDc2a5505Ae35cb20764916c",
      PayEndpoint: "0x4ccdE1dD4d2c3F39dB9D2b350516070257dfb647",
      EscrowCore: "0x7566803615CB5d9Ac15f24269C3305a2738C995b",
      MandateVault: "0x2FEf89522b8B0a55161ed11a7CB19B57C6fF2169",
      AgentRegistry: "0x715f9449145C2FC74c74556154F17C522a30ED09",
      MerchantRegistry: "0x7918e72d7725E87D3C09bB80873991a05BaEc9aA",
      InvoiceVault: "0xD0FF272B69FA884fd2C323ce334dC77F9243Ac0C",
      RecurringMandate: "0x0AaC5b7c0E669D3Ecae635d6820858D4ab897D8f",
      SettlementRouter: "0x1713B2fb74A3b57f55088f21743668a8Bb261523",
    },
  },
  qieMainnet: {
    name: "QIE Mainnet",
    chainId: 1990,
    rpcUrls: ["https://rpc.qie.digital/"],
    explorer: "https://mainnet.qie.digital",
    contracts: {}, // filled at P6 mainnet deploy — API unchanged
  },
};

export const defaultNetwork = process.env.AGENTPAY_NETWORK || "qieTestnet";
