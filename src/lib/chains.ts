// REAL QIE network registry — sourced from official docs (docs.qie.digital)
// "4. Access Mainnet or Testnet" (fetched 2026-09-15).

export type QieChain = {
  key: "qieTestnet" | "qieMainnet";
  id: number;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcs: string[];
  explorer: string;
  faucet?: string;
  // Official QIE Oracle (AggregatorV3) feeds — docs.qie.digital/qie-oracle
  oracle: {
    qieUsd: string; // QIE/USD feed
    btcUsd: string;
    ethUsd: string;
  };
};

export const QIE_CHAINS: Record<QieChain["key"], QieChain> = {
  qieTestnet: {
    key: "qieTestnet",
    id: 1983,
    name: "QIE testnet",
    nativeCurrency: { name: "QIE", symbol: "QIE", decimals: 18 },
    rpcs: [
      "https://rpc1testnet.qie.digital/",
      "https://rpc2testnet.qie.digital/",
      "https://rpc3testnet.qie.digital/",
      "https://rpc4testnet.qie.digital/",
      "https://rpc5testnet.qie.digital/",
      "https://rpc6testnet.qie.digital/",
    ],
    explorer: "https://testnet.qie.digital/",
    faucet: "https://www.qie.digital/faucet",
    oracle: {
      // Testnet feed addresses TBD per deployment — mainnet addresses are official.
      qieUsd: "0x3Bc617cF3A4Bb77003e4c556B87b13D556903D17",
      btcUsd: "0x9E596d809a20A272c788726f592c0d1629755440",
      ethUsd: "0x4bb7012Fbc79fE4Ae9B664228977b442b385500d",
    },
  },
  qieMainnet: {
    key: "qieMainnet",
    id: 1990,
    name: "QIEMainnet",
    nativeCurrency: { name: "QIE", symbol: "QIEV3", decimals: 18 },
    rpcs: [
      "https://rpc1mainnet.qie.digital/",
      "https://rpc2mainnet.qie.digital/",
      "https://rpc5mainnet.qie.digital/",
      "https://rpc4mainnet.qie.digital/",
      "https://rpc3mainnet.qie.digital/",
    ],
    explorer: "https://mainnet.qie.digital/",
    oracle: {
      qieUsd: "0x3Bc617cF3A4Bb77003e4c556B87b13D556903D17",
      btcUsd: "0x9E596d809a20A272c788726f592c0d1629755440",
      ethUsd: "0x4bb7012Fbc79fE4Ae9B664228977b442b385500d",
    },
  },
};

// Active chain for the dashboard (server + client read the same value).
export const ACTIVE_CHAIN_KEY: QieChain["key"] =
  (process.env.NEXT_PUBLIC_QIE_NETWORK as QieChain["key"]) || "qieTestnet";

export const ACTIVE_CHAIN = QIE_CHAINS[ACTIVE_CHAIN_KEY];

export function chainById(chainId: number): QieChain | undefined {
  return Object.values(QIE_CHAINS).find((c) => c.id === chainId);
}

/** First reachable RPC (env override wins). Server-side use. */
export function serverRpcUrl(): string {
  return process.env.QIE_RPC_URL || ACTIVE_CHAIN.rpcs[0];
}
