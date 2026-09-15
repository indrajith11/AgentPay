// watcher.js - viem poll-based event watcher.
// Fetches ALL logs per address range, decodes with the combined ABI, ingests
// idempotently keyed by (txHash, logIndex), checkpoints per source, heartbeats.
import { createPublicClient, http, decodeEventLog } from "viem";

const MAX_RANGE = 5000; // blocks per poll batch (protects free RPCs)

function toHexQuantity(n) {
  return "0x" + n.toString(16);
}

export class Watcher {
  /**
   * @param source {name, address, rpcUrls[], startBlock}
   * @param abi    combined human ABI for decoding
   * @param ledger Ledger instance
   * @param log    logger
   */
  constructor(source, abi, ledger, log = console) {
    this.name = source.name;
    this.address = source.address;
    this.startBlock = source.startBlock ?? 0;
    this.ledger = ledger;
    this.abi = abi;
    this.log = log;
    this.client = createPublicClient({
      transport: http(source.rpcUrls[0], { timeout: 12_000, retryCount: 2 }),
    });
  }

  async head() {
    return Number(await this.client.getBlockNumber());
  }

  /**
   * One poll pass. Returns { processed, newEvents, head }.
   * Semantics: checkpoint stores the last FULLY processed block.
   */
  async pollOnce() {
    const from = Math.max(this.ledger.getCheckpoint(this.name) + 1, this.startBlock || 1);
    let head;
    try {
      head = await this.head();
    } catch (e) {
      this.ledger.heartbeat("head: " + String(e).slice(0, 140));
      return { processed: 0, newEvents: 0, head: 0, error: String(e) };
    }
    // stay 1 block behind head for safety on reorg-ish edges (1-2s finality chain)
    const to = Math.min(from + MAX_RANGE - 1, head - 1);
    let newEvents = 0;
    let processed = 0;
    if (to >= from) {
      try {
        const logs = await this.client.getLogs({
          address: this.address,
          fromBlock: BigInt(from),
          toBlock: BigInt(to),
        });
        for (const lg of logs) {
          processed++;
          newEvents += this.ingestLog(lg);
        }
        this.ledger.setCheckpoint(this.name, to);
        this.ledger.heartbeat(null);
      } catch (e) {
        this.ledger.heartbeat("logs " + from + "-" + to + ": " + String(e).slice(0, 140));
        return { processed: 0, newEvents: 0, head, error: String(e) };
      }
    } else {
      this.ledger.heartbeat(null);
    }
    return { processed, newEvents, head };
  }

  /** Decode + ingest one viem log. Returns 1 if newly stored, 0 if dup/undecodable. */
  ingestLog(lg) {
    let event = "Unknown";
    let args = {};
    try {
      const decoded = decodeEventLog({ abi: this.abi, data: lg.data, topics: lg.topics, strict: false });
      event = decoded.eventName ?? "Unknown";
      args = decoded.args ?? {};
    } catch {
      event = "Undecoded"; // still recorded: the raw log is chain truth
    }
    const pick = (k) => (args[k] !== undefined && args[k] !== null ? String(args[k]) : null);
    // best-effort projection fields per event family
    const merchant =
      pick("merchant") ?? pick("payee") ?? (event === "Transfer" ? pick("to") : null);
    const token = pick("token") ?? this.address; // WQIE Transfer: the contract IS the token
    const amount = pick("gross") ?? pick("net") ?? pick("amount") ?? pick("value") ?? pick("paidAmount");
    return this.ledger.ingest({
      txHash: lg.transactionHash,
      logIndex: Number(lg.logIndex),
      blockNumber: Number(lg.blockNumber),
      blockTime: null,
      contract: this.address,
      event,
      merchant,
      token,
      amount,
      payload: JSON.stringify({ args: serializeArgs(args) }),
    });
  }
}

/** ethers/viem args may contain bigint/Address - make JSON-safe deterministically. */
function serializeArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (typeof v === "bigint") out[k] = v.toString();
    else out[k] = v;
  }
  return out;
}
