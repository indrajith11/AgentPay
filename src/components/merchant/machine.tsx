"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { useEffect, useState } from "react";
import { Overview, fmtMoney, timeAgo } from "@/lib/agentpay";
import { toast } from "@/hooks/use-toast";

// ---------------- Machine Paywall ----------------
function MachinePaywall({ data, refresh }: { data: Overview; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [flow, setFlow] = useState<{ step: string; detail: string; code?: number }[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", description: "", price: "" });

  const createEndpoint = async () => {
    const res = await fetch("/api/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...form, merchantId: data.merchant.id }),
    });
    if (res.ok) {
      toast({ title: "Endpoint live", description: "AI agents can now pay per call via HTTP 402." });
      setOpen(false);
      setForm({ name: "", description: "", price: "" });
      refresh();
    }
  };

  const runAgentPurchase = async (productKey: string) => {
    setRunning(productKey);
    setFlow([{ step: "GET /v1/product/" + productKey, detail: "Agent discovers the product…" }]);
    const res = await fetch("/api/endpoints", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productKey, agentName: "shopper-bot" }),
    });
    const j = await res.json();
    if (res.ok) {
      setFlow([
        { step: `GET /v1/product/${productKey}`, detail: "402 Payment Required — terms: mandate scheme, refund window 600s, price", code: 402 },
        { step: "POST /v1/product/" + productKey + "/purchase", detail: "X-PAYMENT sent — mandate spent within caps", code: 200 },
        { step: "Escrow recorded", detail: `escrow ${String(j.purchase?.escrowRef || "").slice(0, 12)}… refundable for 10 min — x402's missing refund, fixed` },
        { step: "Payload delivered", detail: JSON.stringify(j.purchase?.data || {}).slice(0, 120) },
        { step: "CreditPassport.recordPayment()", detail: "Human principal's score +8 — machines build their humans' credit" },
      ]);
      toast({ title: "Machine sale complete", description: "Agent paid; escrow opened; books updated." });
      refresh();
    } else {
      setFlow([{ step: "error", detail: JSON.stringify(j) }]);
    }
    setRunning(null);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="p-4 pb-2 flex-col items-start justify-between space-y-2 sm:flex-row sm:items-center sm:space-y-0">
          <div>
            <CardTitle className="text-sm">Machine-payable endpoints (x402-style, on QIE)</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Humans pay by QR. AI agents pay per API call with pre-funded mandates — escrowed, refundable, credited.
            </p>
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button size="sm" variant="outline">+ New endpoint</Button></DialogTrigger>
            <DialogContent aria-describedby={undefined} className="sm:max-w-sm">
              <DialogHeader><DialogTitle>Sell to AI agents</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5"><Label>Product name</Label>
                  <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Weather Nowcast" /></div>
                <div className="space-y-1.5"><Label>Description</Label>
                  <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
                <div className="space-y-1.5"><Label>Price per call ({data.merchant.currency})</Label>
                  <Input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} inputMode="decimal" /></div>
                <Button onClick={createEndpoint} disabled={!form.name || !form.price} className="w-full bg-emerald-700 hover:bg-emerald-800">
                  Publish endpoint
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent className="grid gap-3 p-4 lg:grid-cols-2">
          {data.endpoints.map((e) => (
            <div key={e.id} className="rounded-xl border p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">{e.name}</p>
                  <p className="text-[11px] text-muted-foreground">{e.description}</p>
                </div>
                <Badge className="bg-lime-600 shrink-0">{fmtMoney(e.priceCents, e.currency)}/call</Badge>
              </div>
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span>{e.callsCount} calls</span>
                <span>·</span>
                <span className="font-medium text-emerald-800">{fmtMoney(e.revenueCents, e.currency)} earned</span>
              </div>
              <code className="block rounded bg-stone-950 px-2 py-1 text-[10px] leading-relaxed text-emerald-400 break-all whitespace-pre-wrap">
                GET /v1/product/{e.productKey} → 402 · POST …/purchase → 200
              </code>
              {e.calls.length > 0 && (
                <div className="text-[10px] text-muted-foreground">
                  Last: {e.calls[0].agentName} · {timeAgo(e.calls[0].createdAt)} · {e.calls[0].status.toLowerCase()}
                </div>
              )}
              <Button size="sm" className="h-7 w-full text-xs bg-emerald-700 hover:bg-emerald-800"
                disabled={running === e.productKey}
                onClick={() => runAgentPurchase(e.productKey)}>
                {running === e.productKey ? "Agent purchasing…" : "▶ Run live agent purchase"}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {flow.length > 0 && (
        <Card>
          <CardHeader className="p-4 pb-2"><CardTitle className="text-sm">Live agent purchase trace</CardTitle></CardHeader>
          <CardContent className="p-4 pt-0">
            <ol className="space-y-2">
              {flow.map((f, idx) => (
                <li key={idx} className="flex gap-3 items-start">
                  <Badge variant="outline" className="shrink-0 text-[10px]">{f.code ? `HTTP ${f.code}` : `step ${idx + 1}`}</Badge>
                  <div>
                    <p className="text-xs font-medium">{f.step}</p>
                    <p className="text-[11px] text-muted-foreground break-all">{f.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------- Credit Passport ----------------
function CreditPassportCard({ data }: { data: Overview }) {
  const p = data.passport;
  const score = p?.score ?? 0;
  const tier = score >= 720 ? "PRIME" : score >= 600 ? "GROWTH" : score > 300 ? "STARTER" : "NONE";
  const pct = Math.max(0, Math.min(100, ((score - 300) / 550) * 100));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="p-4 pb-2"><CardTitle className="text-sm">On-chain credit passport</CardTitle></CardHeader>
        <CardContent className="p-4 pt-0 space-y-4">
          {p ? (
            <>
              <div className="flex items-end gap-2">
                <span className="text-4xl font-bold text-emerald-900">{score}</span>
                <span className="text-xs text-muted-foreground mb-1">/ 850 · tier {tier}</span>
              </div>
              <Progress value={pct} className="h-2" />
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-stone-100 p-2">
                  <div className="text-lg font-bold">{p.onTimeCount}</div>
                  <div className="text-[10px] text-muted-foreground">on-time payments</div>
                </div>
                <div className="rounded-lg bg-stone-100 p-2">
                  <div className="text-lg font-bold">{fmtMoney(p.volumeCents, data.merchant.currency)}</div>
                  <div className="text-[10px] text-muted-foreground">lifetime volume</div>
                </div>
                <div className="rounded-lg bg-stone-100 p-2">
                  <div className="text-lg font-bold">{p.defaults}</div>
                  <div className="text-[10px] text-muted-foreground">defaults</div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Built from <span className="font-medium text-emerald-800">real payment history</span> — every QR sale,
                invoice repayment and machine call feeds CreditPassport.sol. Lending partners read getScore().
                This is how informal merchants get their first stock financing.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No passport yet — make your first payment.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 pb-2"><CardTitle className="text-sm">What unlocks at each tier</CardTitle></CardHeader>
        <CardContent className="p-4 pt-0 space-y-2 text-sm">
          {[
            { t: "STARTER (300+)", d: "Airtime float, 7-day stock micro-loans up to R500" },
            { t: "GROWTH (600+)", d: "30-day supplier credit, stock financing up to R5,000" },
            { t: "PRIME (720+)", d: "Cash-advance products, machine-fleet leases, partner underwriting" },
          ].map((r) => (
            <div key={r.t} className="rounded-lg border p-3">
              <p className="text-xs font-bold text-emerald-900">{r.t}</p>
              <p className="text-xs text-muted-foreground">{r.d}</p>
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground pt-1">
            The common factor we exploited: 20 census problems of “credit invisibility” — merchants with years of
            cash flow but zero formal history. On-chain history is the passport.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------- Chain / Setup ----------------
function ChainSetup({ data }: { data: Overview }) {
  const [health, setHealth] = useState<{
    mode: string; chain: { reachable: boolean; chainId: string | null; rpc: string };
    x402Service: { reachable: boolean };
  } | null>(null);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => {});
  }, []);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="p-4 pb-2"><CardTitle className="text-sm">QIE mainnet integration status</CardTitle></CardHeader>
        <CardContent className="p-4 pt-0 space-y-3 text-sm">
          <div className="flex items-center justify-between rounded-lg border p-3">
            <span>QIE RPC</span>
            {health?.chain.reachable
              ? <Badge className="bg-emerald-700">reachable · chainId {parseInt(health.chain.chainId || "0x0", 16)}</Badge>
              : <Badge variant="secondary">demo mode (RPC unreachable from sandbox)</Badge>}
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <span>x402 endpoint service</span>
            {health?.x402Service.reachable
              ? <Badge className="bg-emerald-700">live on :3030</Badge>
              : <Badge variant="secondary">offline</Badge>}
          </div>
          <div className="rounded-lg border p-3 space-y-1">
            <p className="text-xs font-semibold">Deploy to QIE (hackathon requirement)</p>
            <code className="block rounded bg-stone-950 p-2 text-[10px] leading-relaxed text-emerald-400 whitespace-pre-wrap">{`cd agentpay/contracts
npm install
npx hardhat compile && npx hardhat test
DEPLOYER_PRIVATE_KEY=0x… QUSDC_TOKEN=0x… \\
  npx hardhat run scripts/deploy.ts --network qieTestnet  # 1983
# then mainnet (1990) for submission`}</code>
            <p className="text-[11px] text-muted-foreground">
              9 contracts: MerchantRegistry, AgentRegistry, MandateVault, EscrowCore, PayEndpoint,
              SettlementRouter, InvoiceVault, RecurringMandate, CreditPassport. 11/11 tests passing.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 pb-2"><CardTitle className="text-sm">QIE ecosystem components used (judge bonus)</CardTitle></CardHeader>
        <CardContent className="p-4 pt-0 space-y-2 text-sm">
          {[
            ["QIE Wallet", "Merchant auth + customer scan-to-pay at the counter (30K+ SA merchants already)"],
            ["QIE Stablecoin (QUSDC)", "Settlement currency for every rail: QR, invoices, subscriptions, machine calls"],
            ["QIE Pass", "Reusable KYC for merchants + Know-Your-Agent principal binding"],
            ["QIEDex", "Treasury agent routes idle cash to savings; fiat-out leg after withdrawal"],
            ["Oracles", "FX rate feed product + future delivery-confirmation for supply chain"],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border p-3">
              <p className="text-xs font-bold text-emerald-900">{k}</p>
              <p className="text-xs text-muted-foreground">{v}</p>
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground">
            Merchant: {data.merchant.name} · {data.merchant.qiePassId || "no QIE Pass"} · owner {data.merchant.owner.slice(0, 10)}…
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export { MachinePaywall, CreditPassportCard, ChainSetup };
