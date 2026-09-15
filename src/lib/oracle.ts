import { ethers } from "ethers";
import { QIE_CHAINS, ACTIVE_CHAIN, serverRpcUrl } from "@/lib/chains";
import { ORACLE_ABI } from "@/lib/abis";

/**
 * Read the OFFICIAL QIE Oracle QIE/USD feed. The oracle contracts are
 * deployed on QIE MAINNET (see docs.qie.digital/qie-oracle/deployed-contracts),
 * so on testnet we read the price cross-chain via the mainnet public RPC —
 * a USD price is chain-agnostic. NOTE: the QIE Oracle updates prices roughly
 * DAILY, so accept quotes up to ~26h old (verified live 2026-09-15).
 */
export type OracleQuote = {
  answer: bigint; // 8-decimal USD
  updatedAt: number;
  source: string;
};

export async function getQieUsd(maxAgeSeconds = 26 * 3600): Promise<OracleQuote | null> {
  // 1) try the active chain's own feed
  const attempts: Array<{ rpc: string; feed: string; source: string }> = [
    {
      rpc: serverRpcUrl(),
      feed: ACTIVE_CHAIN.oracle.qieUsd,
      source: `official QIE Oracle @ ${ACTIVE_CHAIN.name}`,
    },
  ];
  // 2) fall back to mainnet feed (where the oracle actually lives)
  if (ACTIVE_CHAIN.key !== "qieMainnet") {
    attempts.push({
      rpc: QIE_CHAINS.qieMainnet.rpcs[0],
      feed: QIE_CHAINS.qieMainnet.oracle.qieUsd,
      source: "official QIE Oracle @ QIE Mainnet (cross-chain read)",
    });
  }

  for (const a of attempts) {
    try {
      const provider = new ethers.JsonRpcProvider(a.rpc);
      const feed = new ethers.Contract(a.feed, ORACLE_ABI, provider);
      const [ , answer, , updatedAt ] = await feed.latestRoundData();
      if (answer > 0n && Number(updatedAt) > Date.now() / 1000 - maxAgeSeconds) {
        return { answer, updatedAt: Number(updatedAt), source: a.source };
      }
    } catch {
      continue;
    }
  }
  return null;
}
