"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import { Overview, fmtMoney, timeAgo, Merchant } from "@/lib/agentpay";
import { toast } from "@/hooks/use-toast";
import { useConnection } from "@/lib/wallets";
import { errorText } from "@/lib/wallet-error";
import { withStepUp } from "@/lib/passkey-client";
import { SETTLEMENT_ROUTER_ABI } from "@/lib/abis";
import { ACTIVE_CHAIN } from "@/lib/chains";

type PayoutProfileView = {
  payoutAddress: string;
  provider: string;
  fiatCurrency: string;
  rail: number;
  minThreshold: string;
  interval: number;
  lastPayoutAt: number;
  autoEnabled: boolean;
  active: boolean;
};

const statusColor: Record<string, string> = {
  SENT: "bg-stone-200 text-stone-800",
  PARTIAL: "bg-amber-100 text-amber-900",
  PAID: "bg-emerald-100 text-emerald-900",
  OVERDUE: "bg-red-100 text-red-900",
};

// ---------------- Invoices ----------------
function Invoices({ data, refresh }: { data: Overview; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ customerName: "", amount: "", dueDays: "7" });

  const create = async () => {
    const res = await fetch("/api/invoices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...form, merchantId: data.merchant.id }),
    });
    if (res.ok) {
      toast({ title: "Invoice issued", description: "Collections agent is now tracking it." });
      setOpen(false);
      setForm({ customerName: "", amount: "", dueDays: "7" });
      refresh();
    }
  };

  const pay = async (invoiceId: string, full: boolean) => {
    try {
      // withStepUp: on 403 PASSKEY_STEPUP_REQUIRED the browser asks for the
      // passkey, then retries — money movement always proves a human first
      const j = await withStepUp<{ error?: string }>(() =>
        fetch("/api/invoices", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ invoiceId, ...(full ? {} : { amount: 50 }) }),
        })
      );
      if (j.error) throw new Error(j.error);
      toast({ title: full ? "Invoice settled" : "Partial payment recorded", description: "Credit passport updated (+8 on-time)." });
      refresh();
    } catch (e) {
      toast({ title: "Could not settle invoice", description: errorText(e), variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardHeader className="p-4 pb-2 flex-col items-start justify-between space-y-2 sm:flex-row sm:items-center sm:space-y-0">
        <CardTitle className="text-sm">Invoices — collections agent tracks every one</CardTitle>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button size="sm" variant="outline">+ New invoice</Button></DialogTrigger>
          <DialogContent aria-describedby={undefined} className="sm:max-w-sm">
            <DialogHeader><DialogTitle>Issue invoice</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5"><Label>Customer</Label>
                <Input value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5"><Label>Amount ({data.merchant.currency})</Label>
                  <Input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} inputMode="decimal" /></div>
                <div className="space-y-1.5"><Label>Due in (days)</Label>
                  <Input value={form.dueDays} onChange={(e) => setForm({ ...form, dueDays: e.target.value })} inputMode="numeric" /></div>
              </div>
              <Button onClick={create} disabled={!form.customerName || !form.amount} className="w-full bg-emerald-700 hover:bg-emerald-800">
                Issue on-chain invoice
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="p-2">
        <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">Customer</TableHead>
              <TableHead className="text-xs">Progress</TableHead>
              <TableHead className="text-xs">Due</TableHead>
              <TableHead className="text-xs">Status</TableHead>
              <TableHead className="text-xs text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.invoices.map((i) => {
              const pct = Math.round((i.paidCents / i.amountCents) * 100);
              return (
                <TableRow key={i.id}>
                  <TableCell>
                    <div className="text-sm font-medium">{i.customerName}</div>
                    <div className="text-xs text-muted-foreground">{fmtMoney(i.amountCents, data.merchant.currency)}</div>
                  </TableCell>
                  <TableCell className="w-[130px]">
                    <Progress value={pct} className="h-1.5" />
                    <span className="text-[10px] text-muted-foreground">{pct}%</span>
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">{new Date(i.dueDate).toLocaleDateString()}</TableCell>
                  <TableCell><Badge className={statusColor[i.status]}>{i.status}</Badge></TableCell>
                  <TableCell className="text-right">
                    {i.status !== "PAID" && (
                      <div className="flex gap-1.5 justify-end">
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => pay(i.id, false)}>+50 {data.merchant.currency}</Button>
                        <Button size="sm" className="h-7 text-xs bg-emerald-700 hover:bg-emerald-800" onClick={() => pay(i.id, true)}>Settle</Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------- Subscriptions ----------------
function Subscriptions({ data, refresh }: { data: Overview; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ customerName: "", planName: "", amount: "", interval: "MONTHLY" });

  const create = async () => {
    const res = await fetch("/api/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...form, merchantId: data.merchant.id }),
    });
    if (res.ok) {
      toast({ title: "Recurring mandate created", description: "Agent will auto-charge when due." });
      setOpen(false);
      refresh();
    }
  };

  const charge = async (subscriptionId: string) => {
    try {
      const j = await withStepUp<{ error?: string }>(() =>
        fetch("/api/subscriptions", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subscriptionId }),
        })
      );
      if (j.error) throw new Error(j.error);
      toast({ title: "Charged", description: "RecurringMandate.chargeDue() executed — prepaid balance pulled, credit fed." });
      refresh();
    } catch (e) {
      toast({ title: "Charge failed", description: errorText(e), variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardHeader className="p-4 pb-2 flex-col items-start justify-between space-y-2 sm:flex-row sm:items-center sm:space-y-0">
        <CardTitle className="text-sm">Subscriptions — prepaid mandates, auto-charged by agents</CardTitle>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button size="sm" variant="outline">+ New plan</Button></DialogTrigger>
          <DialogContent aria-describedby={undefined} className="sm:max-w-sm">
            <DialogHeader><DialogTitle>Create subscription</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5"><Label>Customer</Label>
                <Input value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Plan name</Label>
                <Input value={form.planName} onChange={(e) => setForm({ ...form, planName: e.target.value })} placeholder="Weekly stock plan" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5"><Label>Amount ({data.merchant.currency})</Label>
                  <Input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} inputMode="decimal" /></div>
                <div className="space-y-1.5"><Label>Interval</Label>
                  <select
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                    value={form.interval}
                    onChange={(e) => setForm({ ...form, interval: e.target.value })}
                  >
                    <option>WEEKLY</option>
                    <option>MONTHLY</option>
                  </select></div>
              </div>
              <Button onClick={create} disabled={!form.customerName || !form.amount} className="w-full bg-emerald-700 hover:bg-emerald-800">
                Create mandate
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="grid gap-3 p-4 sm:grid-cols-2">
        {data.subscriptions.map((s) => (
          <div key={s.id} className="rounded-xl border p-3">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm font-semibold">{s.planName}</p>
                <p className="text-xs text-muted-foreground">{s.customerName}</p>
              </div>
              <Badge variant={s.status === "ACTIVE" ? "default" : "secondary"}
                className={s.status === "ACTIVE" ? "bg-emerald-700" : ""}>{s.status}</Badge>
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>{fmtMoney(s.amountCents, data.merchant.currency)} / {s.interval.toLowerCase()}</span>
              <span>{s.chargesCount} charges · next {new Date(s.nextChargeAt).toLocaleDateString()}</span>
            </div>
            {s.status === "ACTIVE" && (
              <Button size="sm" variant="outline" className="mt-2 h-7 w-full text-xs"
                onClick={() => charge(s.id)}>Run chargeDue() now</Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ---------------- REAL wallet + payout automation ----------------
// Connects ANY wallet via EIP-6963 (MetaMask, Trust, QIE Wallet, Rabby...),
// then drives the real SettlementRouter payout functions on-chain:
//   setPayoutProfile()  — save the bank off-ramp ONCE
//   requestWithdrawal() — sweep earnings anytime
//   executeAutoWithdraw() — anyone can trigger when threshold+interval pass
function PayoutPanel({ data }: { data: Overview }) {
  const { wallets, conn, connect, disconnect, busy, error } = useConnection();
  const [routerAddr, setRouterAddr] = useState("");
  const [tokenAddr, setTokenAddr] = useState("");
  const [profile, setProfile] = useState<PayoutProfileView | null>(null);
  const [earnings, setEarnings] = useState<string>("0");
  const [autoOk, setAutoOk] = useState<{ ok: boolean; reason: string } | null>(null);
  const [form, setForm] = useState({
    payoutAddress: "", provider: "valr", fiatCurrency: "ZAR",
    rail: "1", minThreshold: "50", intervalMin: "60", autoEnabled: true,
  });
  const [acting, setActing] = useState(false);

  const readState = useCallback(async () => {
    if (!conn || !routerAddr) return;
    const router = new ethers.Contract(routerAddr, SETTLEMENT_ROUTER_ABI, conn.provider);
    const p = await router.payoutProfileOf(conn.address);
    setProfile({
      payoutAddress: p.payoutAddress,
      provider: p.provider,
      fiatCurrency: p.fiatCurrency,
      rail: Number(p.rail),
      minThreshold: p.minThreshold.toString(),
      interval: Number(p.interval),
      lastPayoutAt: Number(p.lastPayoutAt),
      autoEnabled: p.autoEnabled,
      active: p.active,
    });
    const bal = tokenAddr
      ? await router.totalWithdrawable(conn.address, tokenAddr)
      : await router.totalWithdrawable(conn.address, ethers.ZeroAddress);
    setEarnings(Number(ethers.formatEther(bal)).toFixed(4));
    if (tokenAddr) {
      const [ok, reason] = await router.canAutoWithdraw(conn.address, tokenAddr);
      setAutoOk({ ok, reason });
    }
  }, [conn, routerAddr, tokenAddr]);

  useEffect(() => { readState().catch(() => {}); }, [readState]);

  const saveProfile = async () => {
    if (!conn) return;
    setActing(true);
    try {
      const signer = await conn.provider.getSigner();
      const router = new ethers.Contract(routerAddr, SETTLEMENT_ROUTER_ABI, signer);
      const tx = await router.setPayoutProfile({
        payoutAddress: form.payoutAddress,
        providerRef: form.rail === "1" ? ethers.id(`${form.provider}-beneficiary-saved`) : ethers.ZeroHash,
        provider: form.rail === "1" ? form.provider : "",
        fiatCurrency: form.rail === "1" ? form.fiatCurrency : "",
        rail: Number(form.rail),
        minThreshold: ethers.parseEther(form.minThreshold || "0"),
        interval: BigInt((parseInt(form.intervalMin) || 0) * 60),
        lastPayoutAt: 0,
        autoEnabled: form.autoEnabled,
        active: true,
      });
      await tx.wait();
      toast({ title: "Payout profile saved on-chain", description: "Setup once — withdrawals now run automatically." });
      await readState();
    } catch (e) {
      toast({ title: "Failed", description: errorText(e), variant: "destructive" });
    } finally {
      setActing(false);
    }
  };

  const withdrawNow = async () => {
    if (!conn || !tokenAddr) return;
    setActing(true);
    try {
      const signer = await conn.provider.getSigner();
      const router = new ethers.Contract(routerAddr, SETTLEMENT_ROUTER_ABI, signer);
      const tx = await router.requestWithdrawal(tokenAddr);
      const rec = await tx.wait();
      toast({ title: "Withdrawal executed on-chain", description: `tx ${rec?.hash?.slice(0, 12)}… — off-ramp worker pays your saved account.` });
      await readState();
    } catch (e) {
      toast({ title: "Failed", description: errorText(e), variant: "destructive" });
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* wallet connect */}
      <Card className="min-w-0">
        <CardHeader className="p-4 pb-2"><CardTitle className="text-sm">1 · Connect any wallet (EIP-6963)</CardTitle></CardHeader>
        <CardContent className="space-y-3 p-4 pt-0">
          {!conn ? (
            <>
              {wallets.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {busy ? "Scanning…" : "No injected wallets detected. Install MetaMask / Trust / QIE Wallet, or use WalletConnect below."}
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {wallets.map((w) => (
                    <button key={w.uuid} onClick={() => connect(w)} disabled={busy}
                      className="flex items-center gap-2 rounded-lg border p-2.5 text-left text-xs hover:border-emerald-400 hover:bg-emerald-50">
                      {w.icon ? <img src={w.icon} alt="" className="h-6 w-6 rounded" /> : <div className="h-6 w-6 rounded bg-stone-200" />}
                      <span className="font-medium">{w.name}</span>
                    </button>
                  ))}
                </div>
              )}
              {/* Mobile: any wallet's built-in browser injects via EIP-6963 */}
              <p className="text-[10px] text-muted-foreground">
                On mobile, open this dashboard inside your wallet app's browser
                (MetaMask / Trust / QIE Wallet) — it connects through the same
                EIP-6963 discovery above.
              </p>
              {error && <p className="text-xs text-red-700">{error}</p>}
            </>
          ) : (
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold">{conn.walletName}</p>
                  <p className="text-muted-foreground">{conn.address.slice(0, 10)}…{conn.address.slice(-6)}</p>
                </div>
                <Badge className={conn.chainId === ACTIVE_CHAIN.id ? "bg-emerald-700" : "bg-amber-500"}>
                  chain {conn.chainId}
                </Badge>
              </div>
              {conn.chainId !== ACTIVE_CHAIN.id && (
                <p className="text-amber-700">Please switch your wallet to {ACTIVE_CHAIN.name} (chain {ACTIVE_CHAIN.id}).</p>
              )}
              <div className="flex gap-2">
                <Input value={routerAddr} onChange={(e) => setRouterAddr(e.target.value)} placeholder="SettlementRouter address (0x…)" spellCheck={false} />
                <Input value={tokenAddr} onChange={(e) => setTokenAddr(e.target.value)} placeholder="Settlement token (0x…)" spellCheck={false} />
              </div>
              <Button variant="outline" size="sm" onClick={readState}>Refresh on-chain state</Button>
              <Button variant="ghost" size="sm" onClick={disconnect}>Disconnect</Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* on-chain state */}
      <Card className="min-w-0">
        <CardHeader className="p-4 pb-2"><CardTitle className="text-sm">2 · On-chain settlement state</CardTitle></CardHeader>
        <CardContent className="space-y-2 p-4 pt-0 text-xs">
          {!conn ? (
            <p className="text-muted-foreground">Connect a wallet to read your live router state.</p>
          ) : (
            <>
              <p>Withdrawable (router-held): <span className="font-bold text-emerald-900">{earnings}</span></p>
              {profile ? (
                <>
                  <p>Profile: <b>{profile.active ? "active" : "inactive"}</b> · rail {profile.rail === 1 ? `off-ramp (${profile.provider} → ${profile.fiatCurrency} bank)` : "crypto wallet"}</p>
                  <p>Auto-withdraw: <b>{profile.autoEnabled ? "enabled" : "disabled"}</b> · threshold {profile.minThreshold && ethers.formatEther(profile.minThreshold)} · every {Math.round(profile.interval / 60)}min</p>
                  {autoOk && <p>Status: {autoOk.ok ? "✓ ready to auto-sweep" : `· waiting (${autoOk.reason})`}</p>}
                </>
              ) : (
                <p className="text-muted-foreground">No payout profile saved yet — set it once on the right.</p>
              )}
              {tokenAddr && profile?.active && (
                <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800" disabled={acting} onClick={withdrawNow}>
                  {acting ? "Sending…" : "Withdraw everything now"}
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* save profile once */}
      <Card className="min-w-0 lg:col-span-2">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">3 · Set up bank payout ONCE — then it withdraws itself anytime</CardTitle>
          <p className="text-xs text-muted-foreground">
            Save your bank beneficiary at a regulated off-ramp (VALR / Luno FSCA-licensed in South Africa;
            Transak / Onramper globally). Paste the provider&apos;s crypto deposit address below — the router sweeps
            earnings there whenever your threshold is hit, and the provider pays your saved bank account. Bank
            details never touch the chain.
          </p>
        </CardHeader>
        <CardContent className="grid gap-3 p-4 pt-0 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5"><Label>Rail</Label>
            <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              value={form.rail} onChange={(e) => setForm({ ...form, rail: e.target.value })}>
              <option value="1">Off-ramp → bank account</option>
              <option value="0">Plain crypto wallet</option>
            </select></div>
          {form.rail === "1" && (
            <>
              <div className="space-y-1.5"><Label>Provider</Label>
                <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                  value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
                  <option value="valr">VALR (FSCA)</option><option value="luno">Luno (FSCA)</option>
                  <option value="transak">Transak</option><option value="onramper">Onramper</option><option value="moonpay">MoonPay</option>
                </select></div>
              <div className="space-y-1.5"><Label>Bank currency</Label>
                <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                  value={form.fiatCurrency} onChange={(e) => setForm({ ...form, fiatCurrency: e.target.value })}>
                  <option>ZAR</option><option>USD</option><option>EUR</option><option>KES</option><option>NGN</option><option>INR</option>
                </select></div>
            </>
          )}
          <div className="space-y-1.5"><Label>Deposit / payout address</Label>
            <Input value={form.payoutAddress} onChange={(e) => setForm({ ...form, payoutAddress: e.target.value })} placeholder="0x…" spellCheck={false} /></div>
          <div className="space-y-1.5"><Label>Auto-withdraw threshold</Label>
            <Input value={form.minThreshold} onChange={(e) => setForm({ ...form, minThreshold: e.target.value })} inputMode="decimal" /></div>
          <div className="space-y-1.5"><Label>Min interval (minutes)</Label>
            <Input value={form.intervalMin} onChange={(e) => setForm({ ...form, intervalMin: e.target.value })} inputMode="numeric" /></div>
          <div className="space-y-1.5"><Label>Allow permissionless auto-withdraw</Label>
            <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              value={form.autoEnabled ? "yes" : "no"} onChange={(e) => setForm({ ...form, autoEnabled: e.target.value === "yes" })}>
              <option value="yes">Yes — keepers can sweep for me</option>
              <option value="no">No — only I withdraw</option>
            </select></div>
          <div className="flex items-end">
            <Button className="w-full bg-emerald-700 hover:bg-emerald-800" disabled={acting || !conn || !form.payoutAddress.startsWith("0x")} onClick={saveProfile}>
              {acting ? "Saving on-chain…" : "Save payout profile"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export { Invoices, Subscriptions, PayoutPanel };
