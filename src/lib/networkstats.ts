import { ethers } from "ethers";
import { QIE_CHAINS, serverRpcUrl } from "@/lib/chains";

/**
 * P5 traction: live network statistics aggregated DIRECTLY from the deployed
 * AgentPay contracts (no demo data). Every counter is an on-chain event or a
 * chain read, so the page is honest by construction and reconciles against the
 * E2E proof artifacts.
 *
 * Robustness lessons baked in (all proven on QIE live):
 *  1. eth_getLogs is hard-capped at a 10,000-block [from, to] distance.
 *  2. Some load-balanced replicas IGNORE topic filters and return every event
 *     of the address — so we scan per contract WITHOUT topic filters and
 *     classify events client-side by topic0. One pass, immune to the bug.
 *  3. Bursts get rate-limited — rotate across all official testnet RPCs and
 *     back off with jitter; unrecoverable windows are counted and surfaced.
 */

export const TESTNET_CONTRACTS = {
  WQIE: "0x5e165E6c7AC4039aEDc2a5505Ae35cb20764916c",
  MerchantRegistry: "0x7918e72d7725E87D3C09bB80873991a05BaEc9aA",
  AgentRegistry: "0x715f9449145C2FC74c74556154F17C522a30ED09",
  EscrowCore: "0x7566803615CB5d9Ac15f24269C3305a2738C995b",
  SettlementRouter: "0x1713B2fb74A3b57f55088f21743668a8Bb261523",
  CreditPassport: "0xCaecF75Eebb659148DE2d2a4a28131dF428B5cA8",
  MandateVault: "0x2FEf89522b8B0a55161ed11a7CB19B57C6fF2169",
  PayEndpoint: "0x4ccdE1dD4d2c3F39dB9D2b350516070257dfb647",
  InvoiceVault: "0xD0FF272B69FA884fd2C323ce334dC77F9243Ac0C",
  RecurringMandate: "0x0AaC5b7c0E669D3Ecae635d6820858D4ab897D8f",
} as const;

const EVENT_SETS: Record<string, string[]> = {
  MerchantRegistry: [
    "event MerchantRegistered(address indexed merchant, string name, string metadataURI)",
    "event MerchantVerified(address indexed merchant, bool verified)",
  ],
  AgentRegistry: [
    "event AgentRegistered(address indexed agent, string name)",
    "event PrincipalBound(address indexed agent, address indexed principal, string qiePassId)",
  ],
  PayEndpoint: [
    "event ProductAdded(uint256 indexed id, address indexed merchant, string name, string endpointPath, uint256 pricePerCall)",
    "event CallPaid(uint256 indexed callId, uint256 indexed productId, address indexed agent, address principal, uint256 amount, uint256 escrowId)",
    "event CallClaimed(uint256 indexed callId, uint256 netToMerchant, uint256 fee)",
    "event CallRefunded(uint256 indexed callId)",
  ],
  EscrowCore: [
    "event EscrowOpened(uint256 indexed id, address indexed payer, address indexed agent, address payee, uint256 amount, uint64 deadline)",
    "event EscrowReleased(uint256 indexed id, uint256 amount)",
    "event EscrowRefunded(uint256 indexed id, uint256 amount)",
  ],
  InvoiceVault: [
    "event InvoiceCreated(uint256 indexed id, address indexed merchant, address indexed payer, uint256 amount, uint64 dueAt, string customerRef)",
    "event InvoicePaid(uint256 indexed id, uint256 paidAmount, uint256 totalPaid, bool fullyPaid)",
  ],
  SettlementRouter: [
    "event PayoutProfileSet(address indexed merchant, address payoutAddress, uint8 rail, string provider, string fiatCurrency, uint256 minThreshold, uint64 interval, bool autoEnabled)",
  ],
};

// per-contract Interface + topic0 -> event name map
const CONTRACT_IFACE: Record<string, { iface: ethers.Interface; byTopic: Map<string, string> }> = {};
for (const [contract, frags] of Object.entries(EVENT_SETS)) {
  const iface = new ethers.Interface(frags);
  const byTopic = new Map<string, string>();
  for (const name of frags.map((f) => f.replace(/^event /, "").split("(")[0])) {
    const ev = iface.getEvent(name);
    if (ev) byTopic.set(ev.topicHash.toLowerCase(), name);
  }
  CONTRACT_IFACE[contract] = { iface, byTopic };
}

export type NetworkStats = {
  network: { key: string; chainId: number; headBlock: number; rpcLatencyMs: number };
  generatedAt: string;
  cached: boolean;
  debug?: Record<string, number>;
  coverage: { fromBlock: number; toBlock: number; skippedWindows: number };
  merchants: { registered: number; verified: number };
  agents: { registered: number; principalsBound: number };
  machine: {
    products: number;
    callsPaid: number;
    grossVolumeQie: string;
    uniqueAgents: number;
    settled: number;
    refunded: number;
    protocolFeesQie: string;
    latestCallTx: { hash: string; callId: string; amountQie: string } | null;
  };
  escrow: { opened: number; released: number; refunded: number };
  invoices: { created: number; fullyPaid: number };
  payouts: { profilesSaved: number };
};

// ---- deploy block discovery (binary search on WQIE runtime code), cached per process ----
let deployBlockCache: number | null = null;
async function findDeployBlock(providers: ethers.JsonRpcProvider[]): Promise<number> {
  if (deployBlockCache !== null) return deployBlockCache;
  const p = providers[0];
  let lo = 0;
  let hi = await p.getBlockNumber();
  const codeAt = async (b: number) => {
    try { return (await p.getCode(TESTNET_CONTRACTS.WQIE, b)) !== "0x"; }
    catch { return false; }
  };
  if (!(await codeAt(hi))) { deployBlockCache = 0; return 0; }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await codeAt(mid)) hi = mid; else lo = mid + 1;
  }
  deployBlockCache = Math.max(0, lo - 1);
  return deployBlockCache;
}

type Log = { blockNumber: number; txHash: string; index: number; topics: string[]; data: string };

async function scanContract(
  providers: ethers.JsonRpcProvider[],
  address: string,
  fromBlock: number,
  toBlock: number,
  skipped: { n: number },
): Promise<Log[]> {
  // One UNFILTERED pass per contract per chunk (eth_getLogs span limit 10k).
  // Rotation: chunk attempt i uses provider i % providers.length.
  const CHUNK = 9_500;
  const out: Log[] = [];
  const seen = new Set<string>();
  for (let start = fromBlock; start <= toBlock; start += CHUNK + 1) {
    const end = Math.min(start + CHUNK, toBlock);
    let done = false;
    for (let attempt = 0; attempt < providers.length + 1 && !done; attempt++) {
      const provider = providers[attempt % providers.length];
      try {
        const logs = await provider.getLogs({ address, fromBlock: start, toBlock: end });
        for (const log of logs) {
          const t = String(log.topics[0] ?? "").toLowerCase();
          if (!t) continue;
          const key = `${log.blockNumber}:${log.transactionHash}:${log.index}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            blockNumber: Number(log.blockNumber),
            txHash: log.transactionHash,
            index: log.index,
            topics: log.topics as string[],
            data: log.data,
          });
        }
        done = true;
      } catch {
        await new Promise((r) => setTimeout(r, 300 + Math.floor(Math.random() * 400) * (attempt + 1)));
      }
    }
    if (!done) skipped.n++;
  }
  return out;
}

type CacheEntry = { at: number; data: NetworkStats };
let cache: CacheEntry | null = null;
const CACHE_MS = 60_000;

export async function getNetworkStats(fresh = false): Promise<NetworkStats> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) {
    return { ...cache.data, cached: true };
  }
  const t0 = Date.now();
  const rpcs = [serverRpcUrl(), ...QIE_CHAINS.qieTestnet.rpcs.filter((r) => r !== serverRpcUrl())];
  const providers = rpcs.map((url) => new ethers.JsonRpcProvider(url, 1983, { staticNetwork: true }));
  const head = await providers[0].getBlockNumber();
  const deployBlock = await findDeployBlock(providers);
  const skipped = { n: 0 };
  const fmt = (v: bigint) => ethers.formatEther(v);

  // scan each contract once (unfiltered), classify events client-side
  const buckets: Record<string, Record<string, Log[]>> = {};
  const debug: Record<string, number> = {};
  for (const contract of Object.keys(EVENT_SETS)) {
    const logs = await scanContract(providers, TESTNET_CONTRACTS[contract as keyof typeof TESTNET_CONTRACTS], deployBlock, head, skipped);
    debug[contract] = logs.length;
    const { byTopic } = CONTRACT_IFACE[contract];
    const map: Record<string, Log[]> = {};
    for (const log of logs) {
      const name = byTopic.get(String(log.topics[0]).toLowerCase());
      if (!name) continue;
      (map[name] ??= []).push(log);
    }
    buckets[contract] = map;
  }
  const B = (c: string, e: string) => buckets[c]?.[e] ?? [];
  const parse = (c: string, log: Log) => {
    try {
      return CONTRACT_IFACE[c].iface.parseLog({ topics: log.topics, data: log.data });
    } catch { return null; }
  };

  // merchants
  const verifiedSet = new Set<string>();
  for (const log of B("MerchantRegistry", "MerchantVerified")) {
    const p = parse("MerchantRegistry", log);
    const m = String(p?.args?.merchant ?? "").toLowerCase();
    if (!m) continue;
    if (p?.args?.verified === true) verifiedSet.add(m);
    else verifiedSet.delete(m);
  }

  // machine rail
  let gross = 0n, fees = 0n;
  const agentSet = new Set<string>();
  let latest: NetworkStats["machine"]["latestCallTx"] = null;
  let latestBlock = -1;
  for (const log of B("PayEndpoint", "CallPaid")) {
    const p = parse("PayEndpoint", log);
    if (!p) continue;
    gross += p.args.amount;
    agentSet.add(String(p.args.agent).toLowerCase());
    if (log.blockNumber > latestBlock) {
      latestBlock = log.blockNumber;
      latest = { hash: log.txHash, callId: String(p.args.callId), amountQie: fmt(p.args.amount) };
    }
  }
  for (const log of B("PayEndpoint", "CallClaimed")) {
    const p = parse("PayEndpoint", log);
    if (p) fees += p.args.fee;
  }

  // invoices
  const fullyPaidIds = new Set<string>();
  for (const log of B("InvoiceVault", "InvoicePaid")) {
    const p = parse("InvoiceVault", log);
    if (p && p.args.fullyPaid === true) fullyPaidIds.add(String(p.args.id));
  }

  const data: NetworkStats = {
    network: { key: "qieTestnet", chainId: 1983, headBlock: head, rpcLatencyMs: Date.now() - t0 },
    generatedAt: new Date().toISOString(),
    cached: false,
    debug,
    coverage: { fromBlock: deployBlock, toBlock: head, skippedWindows: skipped.n },
    merchants: { registered: B("MerchantRegistry", "MerchantRegistered").length, verified: verifiedSet.size },
    agents: {
      registered: B("AgentRegistry", "AgentRegistered").length,
      principalsBound: B("AgentRegistry", "PrincipalBound").length,
    },
    machine: {
      products: B("PayEndpoint", "ProductAdded").length,
      callsPaid: B("PayEndpoint", "CallPaid").length,
      grossVolumeQie: fmt(gross),
      uniqueAgents: agentSet.size,
      settled: B("PayEndpoint", "CallClaimed").length,
      refunded: B("PayEndpoint", "CallRefunded").length,
      protocolFeesQie: fmt(fees),
      latestCallTx: latest,
    },
    escrow: {
      opened: B("EscrowCore", "EscrowOpened").length,
      released: B("EscrowCore", "EscrowReleased").length,
      refunded: B("EscrowCore", "EscrowRefunded").length,
    },
    invoices: {
      created: B("InvoiceVault", "InvoiceCreated").length,
      fullyPaid: fullyPaidIds.size,
    },
    payouts: { profilesSaved: B("SettlementRouter", "PayoutProfileSet").length },
  };
  cache = { at: Date.now(), data };
  return data;
}
