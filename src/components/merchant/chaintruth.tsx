"use client";

/**
 * P1/P2 — Chain Ground Truth panel (Master Plan ch.9): the dashboard's view of
 * the P0 event indexer. Shows the indexer heartbeat, the ledger head, per-event
 * counts and the 10 most recent chain events. If the indexer process is down
 * the panel says so — judges see the data pipeline, not just the UI.
 */

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ACTIVE_CHAIN } from "@/lib/chains";

type IndexerEvent = {
  event: string;
  blockNumber: number;
  merchant: string | null;
  amount: string | null;
  txHash: string;
  contract: string;
};

type IndexerState = {
  online: boolean;
  status?: string;
  heartbeatAgeSeconds?: number;
  ledgerHead?: number;
  eventCounts?: Record<string, number>;
  events?: IndexerEvent[];
  error?: string;
};

function shortHash(h: string) {
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

function shortAddr(a: string | null) {
  if (!a) return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function ChainTruthPanel() {
  const [state, setState] = useState<IndexerState | null>(null);

  useEffect(() => {
    const tick = async () => {
      try {
        const res = await fetch("/api/indexer", { cache: "no-store" });
        setState(await res.json());
      } catch {
        setState({ online: false, error: "proxy unreachable" });
      }
    };
    tick();
    const t = setInterval(tick, 8000);
    return () => clearInterval(t);
  }, []);

  const healthy = state?.online && state.status === "ok";

  return (
    <Card className="h-full min-w-0">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <span
            className={`relative flex h-2 w-2 ${healthy ? "" : "opacity-60"}`}
          >
            {healthy && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75"></span>
            )}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${healthy ? "bg-emerald-600" : "bg-amber-500"}`}></span>
          </span>
          Chain ground truth — event indexer
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0 space-y-3">
        {!state && <p className="text-xs text-muted-foreground">Connecting to indexer…</p>}

        {state && !state.online && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
            <p className="font-medium">Indexer offline</p>
            <p className="mt-1">{state.error}</p>
          </div>
        )}

        {state?.online && (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span>
                heartbeat{" "}
                <span className={state.status === "ok" ? "font-medium text-emerald-800" : "font-medium text-amber-700"}>
                  {state.heartbeatAgeSeconds ?? "?"}s ago
                </span>
              </span>
              <span>ledger head block <span className="font-medium text-foreground">{state.ledgerHead ?? 0}</span></span>
              <span>{ACTIVE_CHAIN.name} · 10 sources</span>
            </div>

            <div className="flex flex-wrap gap-1">
              {Object.entries(state.eventCounts || {}).slice(0, 8).map(([k, n]) => (
                <Badge key={k} variant="outline" className="text-[10px] font-normal">
                  {k} · {n}
                </Badge>
              ))}
              {Object.keys(state.eventCounts || {}).length > 8 && (
                <Badge variant="outline" className="text-[10px] font-normal">
                  +{Object.keys(state.eventCounts || {}).length - 8} more
                </Badge>
              )}
            </div>

            <div className="max-h-[220px] space-y-1.5 overflow-y-auto scrollbar-thin">
              {(state.events || []).map((ev, i) => (
                <div key={`${ev.txHash}-${i}`} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 rounded-lg border px-2.5 py-1.5 text-[11px]">
                  <span className="font-medium text-emerald-900">{ev.event}</span>
                  <span className="text-muted-foreground min-w-0">
                    blk {ev.blockNumber} · {shortAddr(ev.merchant)}
                  </span>
                  <a
                    className="underline text-muted-foreground hover:text-foreground"
                    href={`${ACTIVE_CHAIN.explorer}tx/${ev.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortHash(ev.txHash)}
                  </a>
                </div>
              ))}
              {(state.events || []).length === 0 && (
                <p className="text-xs text-muted-foreground">No events yet — make a payment or register a merchant.</p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
