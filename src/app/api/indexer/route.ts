import { NextResponse } from "next/server";

/**
 * P1/P2 (Master Plan I-06 -> M-05): the dashboard proxies the P0 indexer's
 * health + latest events. The indexer is the chain-truth projection: every
 * payment/settlement event from the 10 deployed contracts, deduped on
 * (txHash, logIndex), served from its own SQLite ledger.
 */

const INDEXER = process.env.INDEXER_URL || "http://localhost:3040";

export async function GET() {
  const out: {
    online: boolean;
    status?: string;
    heartbeatAgeSeconds?: number;
    ledgerHead?: number;
    eventCounts?: Record<string, number>;
    events?: Array<{
      event: string; blockNumber: number; merchant: string | null; amount: string | null; txHash: string; contract: string;
    }>;
    error?: string;
  } = { online: false };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const h = await fetch(`${INDEXER}/health`, { signal: ctrl.signal, cache: "no-store" });
    const hj = await h.json();
    const e = await fetch(`${INDEXER}/events?limit=10`, { signal: ctrl.signal, cache: "no-store" });
    const ej = await e.json();
    clearTimeout(t);

    out.online = true;
    out.status = hj.status;
    out.heartbeatAgeSeconds = hj.heartbeatAgeSeconds;
    // indexer head = the higher of (last event block) and (furthest watcher
    // checkpoint) — events are sparse, so the checkpoint is the live position
    const ckptMax = Math.max(0, ...Object.values(hj.checkpoints || {}).map((c: { lastBlock?: number }) => Number(c?.lastBlock) || 0));
    out.ledgerHead = Math.max(Number(hj.ledgerHead) || 0, ckptMax);
    out.eventCounts = hj.eventCounts || {};
    out.events = (ej.events || []).map((ev: Record<string, unknown>) => ({
      event: String(ev.event),
      // indexer SQLite uses snake_case; accept camelCase too for robustness
      blockNumber: Number(ev.block_number ?? ev.blockNumber) || 0,
      merchant: ((ev.merchant as string) || "").toLowerCase() || null,
      amount: (ev.amount as string) || null,
      txHash: String(ev.tx_hash ?? ev.txHash ?? ""),
      contract: String(ev.contract ?? ""),
    }));
  } catch (e) {
    out.error = "indexer offline — start it with: node agentpay/indexer/index.js";
    out.error += " (" + String(e instanceof Error ? e.message : e).slice(0, 60) + ")";
  }

  return NextResponse.json(out);
}
