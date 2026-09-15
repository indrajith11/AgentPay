"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, type ContractTransactionResponse } from "ethers";
import {
  Overview, fmtMoney, timeAgo, AGENT_META, Merchant,
} from "@/lib/agentpay";
import { toast } from "@/hooks/use-toast";
import { ACTIVE_CHAIN } from "@/lib/chains";
import { DEPLOYED } from "@/lib/deployed";
import { errorText, friendlyWalletError } from "@/lib/wallet-error";
import type { Eip1193Provider } from "@/lib/wallets";

// client-side subset of MerchantRegistry (P1 onboarding)
const REGISTRY_ABI = [
  "function registerMerchant(string name, string metadataURI)",
];
type AnnounceDetail = { info: { uuid: string; name: string }; provider: Eip1193Provider };

function useOverview(merchantId: string | undefined) {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    if (!merchantId) return;
    const res = await fetch(`/api/overview?merchantId=${merchantId}`);
    if (res.ok) setData(await res.json());
    setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!merchantId || cancelled) return;
      const res = await fetch(`/api/overview?merchantId=${merchantId}`);
      if (!cancelled && res.ok) setData(await res.json());
      if (!cancelled) setLoading(false);
    };
    run();
    const t = setInterval(run, 20000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [merchantId]);

  return { data, loading, refresh };
}

// ---------------- REAL QR Sale Dialog (auto-confirming, P2 polished) ----------------
// Master Plan F1: the QR is a real EIP-681 payment request; the matcher API
// scans new blocks for an exact payee+value transfer and flips the sale to
// PAID with ZERO merchant interaction. Manual paste-tx verification remains
// as the recovery path (plan M-06).
//
// P2 cash-register polish:
//  - live countdown (bar + mm:ss) driven by the server's expiresAt
//  - 1.2s polling with in-flight guard -> PAID flip well under 3s
//  - "confirmed in X.Xs" latency badge + haptic buzz on the PAID flip
//  - full failure states: expired, short/over payment (near-miss), RPC
//    hiccups, double-booked tx — each with a recovery action
type PriceInfo = { qieUsd: number; stale: boolean; source: string };
type SaleState = {
  saleId: string;
  uri: string;
  qieAmount: string;
  amountWei: string;
  usdCents: number;
  expiresAt: string;
  oracleStale?: boolean;
};
type NearMiss = { txHash: string; valueWei: string; valueQie: string; deltaWei: string; explorerUrl: string };
type SaleStatus = {
  status: "WAITING" | "PAID" | "EXPIRED";
  txHash?: string;
  explorerUrl?: string;
  usdCents?: number;
  qieAmount?: string;
  paidInMs?: number;
  alreadyBooked?: boolean;
  nearMiss?: NearMiss;
  note?: string;
};

const POLL_MS = 1200; // tuned: block time 1-2s -> PAID flip lands < 3s

function QrSaleDialog({ merchant, onDone }: { merchant: Merchant; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState<PriceInfo | null>(null);
  const [sale, setSale] = useState<SaleState | null>(null);
  const [status, setStatus] = useState<SaleStatus | null>(null);
  const [txHash, setTxHash] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState(0); // consecutive poll failures
  const [nearMiss, setNearMiss] = useState<NearMiss | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    fetch("/api/price").then((r) => r.json()).then((j) => { if (j.qieUsd) setPrice(j); }).catch(() => {});
  }, []);

  // ticking clock for the countdown (250ms granularity, cheap)
  useEffect(() => {
    if (!sale || status?.status === "PAID" || status?.status === "EXPIRED") return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [sale, status?.status]);

  const payee = merchant.chainAddr || merchant.owner;
  const qieAmount = useMemo(() => {
    if (!price || !amount) return null;
    const fiat = parseFloat(amount);
    if (!isFinite(fiat) || fiat <= 0) return null;
    const usdRate = merchant.currency === "ZAR" ? 0.055 : merchant.currency === "INR" ? 0.012 : 1;
    const usd = fiat * usdRate;
    return usd / price.qieUsd;
  }, [amount, price, merchant.currency]);

  // ---- countdown math (server clock is authoritative via expiresAt) ----
  const expiresAtMs = sale ? Date.parse(sale.expiresAt) : 0;
  const msLeft = sale && status?.status === "WAITING" ? Math.max(0, expiresAtMs - now) : 0;
  const ttlMs = 300_000;
  const pctLeft = Math.max(0, Math.min(100, (msLeft / ttlMs) * 100));
  const secsLeft = Math.ceil(msLeft / 1000);
  const mmss = `${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, "0")}`;
  const countdownColor = pctLeft > 40 ? "bg-emerald-600" : pctLeft > 15 ? "bg-amber-500" : "bg-red-500";
  const expiredLocally = !!sale && status?.status === "WAITING" && msLeft <= 0;

  const reset = () => {
    setSale(null); setStatus(null); setNearMiss(null); setTxHash(""); setManualOpen(false); setFailures(0);
  };

  // ---- matcher polling loop: WAITING -> PAID / EXPIRED, zero interactions ----
  useEffect(() => {
    if (!sale || status?.status === "PAID" || status?.status === "EXPIRED") return;
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (cancelled || inFlight) return; // never overlap: 1.2s cadence stays clean
      inFlight = true;
      try {
        const res = await fetch(`/api/qr-sale?id=${sale.saleId}`);
        const j = await res.json();
        if (cancelled) return;
        if (!res.ok) { setFailures((f) => f + 1); return; }
        setFailures(0);
        setStatus(j);
        if (j.nearMiss) setNearMiss(j.nearMiss);
        if (j.status === "PAID") {
          if (typeof navigator !== "undefined" && "vibrate" in navigator) {
            navigator.vibrate?.(j.paidInMs && j.paidInMs < 3000 ? [40, 60, 40] : 80);
          }
          toast({
            title: "Sale confirmed automatically",
            description: `${j.qieAmount || sale.qieAmount} QIE detected on-chain${j.paidInMs != null ? ` in ${(j.paidInMs / 1000).toFixed(1)}s` : ""} and booked.`,
          });
          onDone();
        }
      } catch {
        if (!cancelled) setFailures((f) => f + 1);
      } finally {
        inFlight = false;
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [sale, status?.status]);

  const generate = async () => {
    if (!qieAmount) return;
    setBusy(true);
    try {
      const res = await fetch("/api/qr-sale", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchantId: merchant.id, amount }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "could not create sale");
      setSale(j);
      setStatus({ status: "WAITING" });
      setNearMiss(null);
      setTxHash("");
      setFailures(0);
      setNow(Date.now());
    } catch (e) {
      toast({ title: "Could not open sale", description: errorText(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const verifyManual = async (hashOverride?: string) => {
    const h = (hashOverride ?? txHash).trim();
    if (!h) return;
    setBusy(true);
    try {
      const res = await fetch("/api/verify-payment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchantId: merchant.id, txHash: h }),
      });
      const j = await res.json();
      if (res.ok && j.verified) {
        setNearMiss(null);
        setStatus({ status: "PAID", txHash: h, explorerUrl: j.explorerUrl, usdCents: j.usdCents, qieAmount: j.qieReceived });
        toast({ title: "Payment verified on-chain", description: `Booked ${j.qieReceived} QIE (block ${j.blockNumber}) by the reconciliation agent.` });
        onDone();
      } else {
        toast({ title: "Verification failed", description: j.error || "unknown error", variant: "destructive" });
      }
    } finally {
      setBusy(false);
    }
  };

  const waiting = status?.status === "WAITING" && !expiredLocally;
  const degraded = failures >= 3;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button className="bg-emerald-700 hover:bg-emerald-800">Accept QR payment</Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Accept payment — auto-confirming</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {!sale && (
            <>
              <div className="space-y-2">
                <Label>Amount ({merchant.currency})</Label>
                <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="125.00" />
                {price && (
                  <p className="text-[11px] text-muted-foreground">
                    Live QIE/USD ${price.qieUsd.toFixed(4)} · official QIE Oracle{price.stale ? " (stale)" : ""}
                  </p>
                )}
              </div>
              <Button onClick={generate} disabled={!qieAmount || busy} className="w-full bg-emerald-700 hover:bg-emerald-800">
                {busy ? "Opening sale…" : "Show QR"}
              </Button>
            </>
          )}
          {sale && (
            <div className="flex flex-col items-center gap-2.5 rounded-xl border bg-white p-4">
              <img src={`/api/qr?data=${encodeURIComponent(sale.uri)}`} alt="Payment QR" className="h-40 w-40" />
              <p className="text-[11px] text-center text-muted-foreground break-all max-w-[280px]">
                {payee} @ {ACTIVE_CHAIN.name} (chain {ACTIVE_CHAIN.id}) · ≈{sale.qieAmount} QIE
              </p>
            </div>
          )}
          {sale && waiting && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1.5 font-medium text-emerald-950">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-600" />
                  Waiting for the customer&apos;s payment…
                </span>
                <span className={`font-mono font-semibold ${pctLeft <= 15 ? "text-red-700" : pctLeft <= 40 ? "text-amber-700" : "text-emerald-800"}`}>
                  {mmss}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-200">
                <div className={`h-full rounded-full transition-all duration-300 ${countdownColor}`} style={{ width: `${pctLeft}%` }} />
              </div>
              <p className="text-[10px] text-muted-foreground">
                This sale confirms itself — no refresh, no paste, no clicking. Expires automatically at 0:00.
              </p>
            </div>
          )}
          {degraded && waiting && (
            <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-950">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
              Connection hiccup with the scanner — retrying automatically ({failures} tries)…
            </div>
          )}
          {status?.status === "PAID" && (
            <div className="space-y-1.5 rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-950">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <p className="font-semibold">PAID — {status.qieAmount || sale?.qieAmount} QIE {status.txHash ? "auto-detected" : "verified"}</p>
                {status.paidInMs != null && (
                  <Badge variant="outline" className="border-emerald-400 text-[10px] text-emerald-800">
                    confirmed in {(status.paidInMs / 1000).toFixed(1)}s
                  </Badge>
                )}
              </div>
              {status.alreadyBooked && (
                <p className="text-[11px] text-amber-800">This transaction was already booked earlier — no double entry.</p>
              )}
              {status.explorerUrl && (
                <a href={status.explorerUrl} target="_blank" rel="noreferrer" className="underline">
                  View on {ACTIVE_CHAIN.explorer.replace(/^https?:\/\//, "")}
                </a>
              )}
              <Button size="sm" className="h-7 bg-emerald-700 hover:bg-emerald-800" onClick={reset}>New sale</Button>
            </div>
          )}
          {(expiredLocally || status?.status === "EXPIRED") && (
            <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
              <p className="font-semibold">Sale window expired — no exact payment received.</p>
              {nearMiss ? (
                <div className="space-y-1.5 rounded-lg border border-amber-300 bg-white p-2">
                  <p className="font-medium">Possible short payment detected</p>
                  <p>
                    We saw <b>{nearMiss.valueQie} QIE</b> land in your wallet versus the{" "}
                    <b>{sale?.qieAmount} QIE</b> bill. Funds are already yours (self-custodial) —
                    book them at the received amount, or chase the balance separately.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" className="h-7 bg-emerald-700 hover:bg-emerald-800" disabled={busy}
                      onClick={() => verifyManual(nearMiss.txHash)}>
                      Book received amount
                    </Button>
                    <a href={nearMiss.explorerUrl} target="_blank" rel="noreferrer"
                      className="self-center text-[11px] underline">View tx</a>
                  </div>
                </div>
              ) : (
                <p className="text-[11px]">No transfers to your payee address in the window — the customer likely never paid.</p>
              )}
              <Button variant="outline" size="sm" onClick={reset}>Open new sale</Button>
            </div>
          )}
          {sale && waiting && (
            <div>
              <button className="text-[11px] text-muted-foreground underline" onClick={() => setManualOpen((v) => !v)}>
                Or verify a transaction manually (recovery path)
              </button>
              {manualOpen && (
                <div className="mt-2 space-y-2">
                  <Input value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="0x…" spellCheck={false} className="font-mono text-xs" />
                  <Button onClick={() => verifyManual()} disabled={busy || txHash.length < 10} variant="outline" className="w-full">
                    {busy ? "Verifying on-chain…" : "Verify real transaction"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- Merchant onboarding (session-bound, on-chain registered) ----------------
// P1: the owner address is the signed-in session wallet (server enforces it).
// After the DB record, the SAME wallet signs registerMerchant on the live
// MerchantRegistry contract; the platform verifier then countersigns
// verifyMerchant. Both txs are judge-checkable on the explorer.
type ChainReg = {
  state: "idle" | "signing" | "registering" | "verifying" | "done" | "failed";
  registerTx?: string;
  registerUrl?: string;
  verifyTx?: string;
  verifyUrl?: string;
  error?: string;
};

export function MerchantOnboarding({ owner, onCreated }: {
  owner: string;
  onCreated: (m: Merchant) => void;
}) {
  const [form, setForm] = useState({ name: "", currency: "ZAR", chainAddr: "", phone: "" });
  const [busy, setBusy] = useState(false);
  const [chain, setChain] = useState<ChainReg>({ state: "idle" });
  const [merchant, setMerchant] = useState<Merchant | null>(null);

  const finish = (m: Merchant) => {
    setChain((c) => ({ ...c, state: "done" }));
    onCreated(m);
  };

  const create = async () => {
    setBusy(true);
    try {
      // 1) DB record (owner is bound server-side to the session wallet)
      const res = await fetch("/api/merchants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, owner }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "could not register");
      setMerchant(j.merchant);

      // 2) on-chain registration from the merchant's own wallet
      await registerOnChain(j.merchant);
    } catch (e) {
      toast({ title: "Registration failed", description: errorText(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const registerOnChain = async (m: Merchant) => {
    setChain({ state: "signing" });
    try {
      // reconnect to the first discovered wallet (permission already granted at sign-in)
      let provider: BrowserProvider | null = null;
      for (let i = 0; i < 20 && !provider; i++) {
        const evts = await new Promise<AnnounceDetail[]>((resolve) => {
          const found: AnnounceDetail[] = [];
          const onAnnounce = (event: Event) => {
            const d = (event as CustomEvent<AnnounceDetail>).detail;
            if (d?.provider) found.push(d);
          };
          window.addEventListener("eip6963:announceProvider", onAnnounce);
          window.dispatchEvent(new Event("eip6963:requestProvider"));
          setTimeout(() => {
            window.removeEventListener("eip6963:announceProvider", onAnnounce);
            resolve(found);
          }, 250);
        });
        if (evts.length > 0) {
          provider = new BrowserProvider(evts[0].provider, "any");
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!provider) throw new Error("no wallet available for the on-chain signature");

      const signer = await provider.getSigner();
      const addr = (await signer.getAddress()).toLowerCase();
      if (addr !== owner.toLowerCase()) {
        throw new Error(`wallet account ${addr.slice(0, 6)}… is not the signed-in account — switch and retry`);
      }

      setChain({ state: "registering" });
      const reg = new Contract(DEPLOYED.MerchantRegistry, REGISTRY_ABI, signer);
      const metadataURI = `agentpay://merchant/${m.id}`;
      let tx: ContractTransactionResponse | undefined;
      try {
        tx = await reg.registerMerchant(m.name, metadataURI);
      } catch (e: unknown) {
        const msg = errorText(e);
        if (/ALREADY_REGISTERED/.test(msg)) {
          // wallet already registered on-chain (re-onboard): skip to verify
          setChain({ state: "verifying" });
        } else {
          throw e;
        }
      }
      let registerTx: string | undefined;
      let registerUrl: string | undefined;
      if (tx) {
        const rc = await tx.wait();
        registerTx = rc?.hash ?? tx.hash;
        registerUrl = `${ACTIVE_CHAIN.explorer}tx/${registerTx}`;
      }
      setChain({ state: "verifying", registerTx, registerUrl });

      // 3) platform verifier countersign
      const vres = await fetch("/api/merchants/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchantId: m.id, merchantAddr: owner }),
      });
      const vj = await vres.json();
      if (!vres.ok) throw new Error(vj.error || "platform verify failed");
      finish(m);
      setChain({
        state: "done",
        registerTx,
        registerUrl,
        verifyTx: vj.verifyTx || undefined,
        verifyUrl: vj.verifyUrl || undefined,
      });
      toast({
        title: "Store registered + verified on-chain",
        description: "MerchantRegistry updated on QIE — check the explorer links.",
      });
    } catch (e) {
      const msg = friendlyWalletError(e);
      setChain({ state: "failed", error: msg });
    }
  };

  return (
    <Card className="mx-auto max-w-lg">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm">Register your store — real chain mode</CardTitle>
        <p className="text-xs text-muted-foreground">
          Two signatures: one creates your store in the on-chain MerchantRegistry
          (yours), one verifies it (platform). No email, no password, no demo data.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        <div className="space-y-1.5"><Label>Store name</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Thato's Spaza" /></div>
        <div className="space-y-1.5"><Label>Owner wallet (signed-in session)</Label>
          <Input value={owner} readOnly disabled className="font-mono text-xs" /></div>
        <div className="space-y-1.5"><Label>Payout / receiving address on {ACTIVE_CHAIN.name} (optional)</Label>
          <Input value={form.chainAddr} onChange={(e) => setForm({ ...form, chainAddr: e.target.value })} placeholder="0x… (defaults to owner wallet)" spellCheck={false} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label>Currency</Label>
            <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              <option>ZAR</option><option>INR</option><option>USD</option><option>EUR</option><option>KES</option><option>NGN</option>
            </select></div>
          <div className="space-y-1.5"><Label>WhatsApp number (optional)</Label>
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+27…" /></div>
        </div>

        <Button onClick={create} disabled={busy || !form.name || chain.state === "registering" || chain.state === "signing" || chain.state === "verifying"}
          className="w-full bg-emerald-700 hover:bg-emerald-800">
          {busy ? "Registering…" : chain.state === "done" ? "Registered" : "Register store (2 signatures)"}
        </Button>

        {chain.state !== "idle" && chain.state !== "done" && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-2.5 text-xs text-emerald-950">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-600" />
            {chain.state === "signing" && "Waiting for wallet…"}
            {chain.state === "registering" && "Writing registerMerchant to QIE…"}
            {chain.state === "verifying" && "Platform verifier countersigning…"}
          </div>
        )}
        {chain.registerUrl && (
          <p className="text-[11px] text-muted-foreground">
            registerMerchant tx: <a className="underline" href={chain.registerUrl} target="_blank" rel="noreferrer">{chain.registerTx?.slice(0, 18)}…</a>
          </p>
        )}
        {chain.state === "done" && chain.verifyUrl && (
          <p className="text-[11px] text-muted-foreground">
            verifyMerchant tx: <a className="underline" href={chain.verifyUrl} target="_blank" rel="noreferrer">{chain.verifyTx?.slice(0, 18)}…</a>
          </p>
        )}
        {chain.state === "failed" && (
          <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-950">
            <p className="font-medium">On-chain step did not complete — {chain.error}</p>
            {merchant && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => registerOnChain(merchant)}>Retry chain step</Button>
                <Button size="sm" variant="ghost" onClick={() => finish(merchant)}>Continue without it</Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------- KPI cards ----------------
function Kpis({ data }: { data: Overview }) {
  const items = [
    { label: "Today's sales", value: fmtMoney(data.kpis.todaySalesCents, data.merchant.currency), sub: "QR + invoices + machine" },
    { label: "Recurring revenue", value: fmtMoney(data.kpis.mrrCents, data.merchant.currency), sub: "monthlyized subscriptions" },
    { label: "Pending invoices", value: fmtMoney(data.kpis.pendingCents, data.merchant.currency), sub: `${data.kpis.overdueCount} overdue — agent chasing` },
    { label: "Machine revenue", value: fmtMoney(data.kpis.machineRevenueCents, data.merchant.currency), sub: `${data.kpis.endpointCalls} agent calls served` },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map((k) => (
        <Card key={k.label}>
          <CardHeader className="pb-1 p-4">
            <CardTitle className="text-xs font-medium text-muted-foreground">{k.label}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="text-xl font-bold tracking-tight text-emerald-900">{k.value}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{k.sub}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------------- Agent activity feed ----------------
function AgentFeed({ events }: { events: Overview["events"] }) {
  return (
    <Card className="h-full min-w-0">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-600"></span>
          </span>
          AI staff activity
        </CardTitle>
      </CardHeader>
      <CardContent className="p-2">
        <div className="max-h-[380px] overflow-y-auto scrollbar-thin">
          <div className="space-y-2 p-2">
            {events.map((e) => {
              const meta = AGENT_META[e.kind];
              return (
                <div key={e.id} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant="secondary" className={meta.color}>{meta.icon} {meta.label}</Badge>
                    <span className="text-[10px] text-muted-foreground">{timeAgo(e.createdAt)}</span>
                  </div>
                  <p className="mt-1.5 text-sm font-medium">{e.title}</p>
                  <p className="text-xs text-muted-foreground">{e.detail}</p>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------- Ledger ----------------
function Ledger({ data }: { data: Overview }) {
  return (
    <Card className="h-full min-w-0 overflow-hidden">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm">Auto-generated ledger (the boring money app)</CardTitle>
      </CardHeader>
      <CardContent className="p-2">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">When</TableHead>
                <TableHead className="text-xs">Entry</TableHead>
                <TableHead className="text-xs text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.ledger.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{timeAgo(l.date)}</TableCell>
                  <TableCell className="text-xs">
                    <Badge variant="outline" className="mr-1.5 text-[10px]">{l.kind}</Badge>
                    {l.label}
                  </TableCell>
                  <TableCell className={`text-xs text-right font-medium ${l.amountCents < 0 ? "text-red-700" : "text-emerald-800"}`}>
                    {fmtMoney(l.amountCents, data.merchant.currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export {
  useOverview, QrSaleDialog, Kpis, AgentFeed, Ledger,
};
