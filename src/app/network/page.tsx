import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { getNetworkStats, type NetworkStats } from "@/lib/networkstats";
import { RefreshButton } from "@/components/network/refresh-button";

export const dynamic = "force-dynamic";

const EXPLORER = "https://testnet.qie.digital";

function fmtQie(v: string): string {
  const n = parseFloat(v);
  if (!isFinite(n)) return v;
  if (n === 0) return "0";
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (n >= 1) return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardDescription className="text-[11px] uppercase tracking-wide">{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}

function CounterGrid({ s }: { s: NetworkStats }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      <Stat label="Verified merchants" value={s.merchants.verified} sub={`${s.merchants.registered} registered total`} />
      <Stat label="Registered agents" value={s.agents.registered} sub={`${s.agents.principalsBound} principal-bound`} />
      <Stat label="Machine products" value={s.machine.products} sub="USD-priced, 402-negotiated" />
      <Stat label="Machine calls paid" value={s.machine.callsPaid} sub={`${s.machine.uniqueAgents} distinct agents on-chain`} />
      <Stat label="Gross machine volume" value={`${fmtQie(s.machine.grossVolumeQie)} QIE`} sub="sum of CallPaid amounts" />
      <Stat label="Escrows settled / refunded" value={`${s.escrow.released} / ${s.escrow.refunded}`} sub={`${s.escrow.opened} opened`} />
      <Stat label="Invoices fully paid" value={s.invoices.fullyPaid} sub={`${s.invoices.created} issued`} />
      <Stat label="Payout profiles saved" value={s.payouts.profilesSaved} sub="merchants with off-ramp rails" />
    </div>
  );
}

export default async function NetworkPage() {
  let s: NetworkStats | null = null;
  let error: string | null = null;
  try {
    s = await getNetworkStats();
  } catch (e) {
    error = String(e).slice(0, 160);
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">AgentPay Network Stats</h1>
          <p className="text-sm text-muted-foreground">
            Every number below is read live from the deployed AgentPay contracts on QIE — no demo data, no caching tricks.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {s ? (
            <Badge variant="outline" className="tabular-nums">
              chain 1983 · head {s.network.headBlock.toLocaleString()} · scan {(s.network.rpcLatencyMs / 1000).toFixed(1)}s{s.cached ? " · cached" : " · live"}
            </Badge>
          ) : null}
          <RefreshButton />
        </div>
      </div>

      {error || !s ? (
        <Card>
          <CardHeader>
            <CardTitle>Chain unreachable</CardTitle>
            <CardDescription>
              The QIE RPC did not answer, so live counters cannot be served right now. The page recovers automatically once the RPC is back. Detail: {error}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <CounterGrid s={s} />

          <div className="mt-6 grid gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Latest machine payment (on-chain)</CardTitle>
                <CardDescription>Pay-per-call escrowed purchase via the machine rail</CardDescription>
              </CardHeader>
              <CardContent>
                {s.machine.latestCallTx ? (
                  <div className="space-y-1 text-sm">
                    <div className="font-mono text-xs break-all">
                      <a className="underline underline-offset-2" href={`${EXPLORER}/tx/${s.machine.latestCallTx.hash}`} target="_blank" rel="noreferrer">
                        {s.machine.latestCallTx.hash}
                      </a>
                    </div>
                    <div className="text-muted-foreground">
                      call #{s.machine.latestCallTx.callId} · {fmtQie(s.machine.latestCallTx.amountQie)} QIE · settled {s.machine.settled} / refunded {s.machine.refunded} · protocol fees {fmtQie(s.machine.protocolFeesQie)} QIE
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No machine calls yet.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Verify it yourself</CardTitle>
                <CardDescription>Everything is public on the QIE explorer — judge any claim in one click.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p>Contract suite (source-verified):{" "}
                  <a className="underline underline-offset-2" href={`${EXPLORER}/address/${"0x4ccdE1dD4d2c3F39dB9D2b350516070257dfb647"}`} target="_blank" rel="noreferrer">PayEndpoint</a>,{" "}
                  <a className="underline underline-offset-2" href={`${EXPLORER}/address/${"0x7566803615CB5d9Ac15f24269C3305a2738C995b"}`} target="_blank" rel="noreferrer">EscrowCore</a>,{" "}
                  <a className="underline underline-offset-2" href={`${EXPLORER}/address/${"0x2FEf89522b8B0a55161ed11a7CB19B57C6fF2169"}`} target="_blank" rel="noreferrer">MandateVault</a>
                </p>
                <p>Open-source:{" "}
                  <a className="underline underline-offset-2" href="https://github.com/indrajith11/AgentPay" target="_blank" rel="noreferrer">github.com/indrajith11/AgentPay</a>
                </p>
                <p className="text-xs text-muted-foreground">
                  Counters aggregate events from the deployment block to head {s.network.headBlock.toLocaleString()} · generated {new Date(s.generatedAt).toISOString().replace("T", " ").slice(0, 19)}Z
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/">Merchant dashboard</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/api/network-stats">Raw JSON</Link>
            </Button>
          </div>
        </>
      )}
    </main>
  );
}
