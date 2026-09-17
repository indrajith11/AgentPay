"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  useOverview, QrSaleDialog, Kpis, AgentFeed, Ledger, MerchantOnboarding,
} from "@/components/merchant/panels";
import { Invoices, Subscriptions, PayoutPanel } from "@/components/merchant/ops";
import { PasskeySecurityCard } from "@/components/merchant/security";
import { MachinePaywall, CreditPassportCard, ChainSetup } from "@/components/merchant/machine";
import { LoginScreen, useSession, short } from "@/components/merchant/login";
import { ChainTruthPanel } from "@/components/merchant/chaintruth";
import { QiePassCard } from "@/components/merchant/qiepass";
import type { Merchant } from "@/lib/agentpay";

export default function Home() {
  const { session, checking, reload: reloadSession } = useSession();
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [merchantId, setMerchantId] = useState<string | undefined>(undefined);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const loadMerchants = useCallback(async () => {
    if (!session) return;
    const res = await fetch("/api/merchants", { cache: "no-store" });
    if (!res.ok) return;
    const j = await res.json();
    setMerchants(j.merchants || []);
    if (j.merchants?.length) setMerchantId(j.merchants[0].id);
    setLoadedFor(session.address);
  }, [session]);

  useEffect(() => {
    const t = setTimeout(() => { loadMerchants(); }, 0);
    return () => clearTimeout(t);
  }, [loadMerchants]);

  const { data, loading, refresh } = useOverview(merchantId);

  const logout = async () => {
    await fetch("/api/auth/session", { method: "DELETE" });
    setMerchants([]);
    setMerchantId(undefined);
    setLoadedFor(null);
    reloadSession();
  };

  // ---- Gate 1: still checking the session cookie ----
  if (checking) {
    return (
      <ShellChrome>
        <div className="flex h-[60vh] items-center justify-center text-sm text-muted-foreground">
          Checking session…
        </div>
      </ShellChrome>
    );
  }

  // ---- Gate 2: no session -> wallet sign-in (SIWE) ----
  if (!session) {
    return (
      <ShellChrome badge="Sign-in required — wallet is the identity">
        <LoginScreen onAuthed={() => reloadSession()} />
      </ShellChrome>
    );
  }

  // ---- Gate 3: signed in but no merchant yet -> real onboarding ----
  if (merchants.length === 0) {
    return (
      <ShellChrome badge={`Signed in as ${short(session.address)}`} session={session} onLogout={logout}>
        <div className="space-y-3">
          <div className="mx-auto max-w-lg rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-950">
            Signed in with <span className="font-semibold">{short(session.address)}</span>.
            Register your store to start accepting verified on-chain payments — the
            registration is also written to the MerchantRegistry contract on QIE.
          </div>
          <MerchantOnboarding owner={session.address} onCreated={(m) => {
            setMerchants([m]);
            setMerchantId(m.id);
          }} />
        </div>
      </ShellChrome>
    );
  }

  // ---- Dashboard ----
  return (
    <ShellChrome session={session} onLogout={logout} merchants={merchants} merchantId={merchantId} setMerchantId={setMerchantId} data={data} onQrDone={refresh}>
      {loading || !data ? (
        <div className="flex h-[60vh] items-center justify-center text-sm text-muted-foreground">
          Loading merchant data…
        </div>
      ) : (
        <div className="space-y-5">
          {/* Merchant strip */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{data.merchant.name}</span>
            <span>QIE Pass: {data.merchant.qiePassId || "—"}</span>
            <span>Wallet: {data.merchant.owner.slice(0, 8)}…{data.merchant.owner.slice(-6)}</span>
            <span className="text-emerald-800 font-medium">
              Credit score: {data.kpis.creditScore ?? "—"}
            </span>
          </div>

          <Kpis data={data} />

          {/* QIE Pass — reusable KYC (P10): one approval in QIE Wallet, on-chain attestation */}
          <QiePassCard merchant={data.merchant} onChanged={refresh} />

          <Tabs defaultValue="overview">
            <TabsList className="flex flex-wrap h-auto gap-1">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="invoices">Invoices</TabsTrigger>
              <TabsTrigger value="subs">Subscriptions</TabsTrigger>
              <TabsTrigger value="machine">Machine Paywall</TabsTrigger>
              <TabsTrigger value="payout">Payout & Wallet</TabsTrigger>
              <TabsTrigger value="security">Security</TabsTrigger>
              <TabsTrigger value="credit">Credit Passport</TabsTrigger>
              <TabsTrigger value="chain">Chain Setup</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="mt-4">
              <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                <AgentFeed events={data.events} />
                <Ledger data={data} />
                <div className="lg:col-span-2">
                  <ChainTruthPanel />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="invoices" className="mt-4">
              <Invoices data={data} refresh={refresh} />
            </TabsContent>

            <TabsContent value="subs" className="mt-4">
              <Subscriptions data={data} refresh={refresh} />
            </TabsContent>

            <TabsContent value="machine" className="mt-4">
              <MachinePaywall data={data} refresh={refresh} />
            </TabsContent>

            <TabsContent value="payout" className="mt-4">
              <PayoutPanel data={data} />
            </TabsContent>

            <TabsContent value="security" className="mt-4">
              <PasskeySecurityCard address={session.address} />
            </TabsContent>

            <TabsContent value="credit" className="mt-4">
              <CreditPassportCard data={data} />
            </TabsContent>

            <TabsContent value="chain" className="mt-4">
              <ChainSetup data={data} />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </ShellChrome>
  );
}

// ---------- page chrome (header + footer shared across gates) ----------
function ShellChrome({
  children, badge, session, onLogout, merchants, merchantId, setMerchantId, data, onQrDone,
}: {
  children: React.ReactNode;
  badge?: string;
  session?: { address: string } | null;
  onLogout?: () => void;
  merchants?: Merchant[];
  merchantId?: string;
  setMerchantId?: (id: string) => void;
  data?: { merchant: Merchant } | null;
  onQrDone?: () => void;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-stone-50">
      {/* Header */}
      <header className="border-b bg-white">
        <div className="mx-auto max-w-6xl px-4 py-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-700 text-white font-black">A</div>
            <div>
              <h1 className="text-sm font-bold leading-tight text-emerald-950">AgentPay</h1>
              <p className="text-[10px] text-muted-foreground leading-tight">The QIE Agent Commerce Protocol · Merchant OS · Track 04</p>
            </div>
          </div>

          <div className="ml-auto flex flex-wrap justify-end items-center gap-2">
            <Badge variant="outline" className="text-[10px] border-emerald-300 text-emerald-800">
              {badge || "QIE Mainnet Edition · 1–2s finality · 0.3% fee"}
            </Badge>
            {merchants && merchantId && setMerchantId && merchants.length > 0 && (
              <Select value={merchantId} onValueChange={setMerchantId}>
                <SelectTrigger className="h-8 w-[220px] text-xs">
                  <SelectValue placeholder="Choose merchant" />
                </SelectTrigger>
                <SelectContent>
                  {merchants.map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.name} ({m.currency})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {data && onQrDone && <QrSaleDialog merchant={data.merchant} onDone={onQrDone} />}
            {session && (
              <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={onLogout}>
                Sign out
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Body */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5">{children}</main>

      {/* Footer */}
      <footer className="mt-auto border-t bg-white">
        <div className="mx-auto max-w-6xl px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>AgentPay × MerchantPilot — built for QIE Hackathon 3.0 (Mainnet Edition, Aug 1 – Dec 10, 2026)</span>
          <span>SIWE sign-in · 11 contracts live · event indexer · x402 machine commerce · CreditPassport</span>
        </div>
      </footer>
    </div>
  );
}
