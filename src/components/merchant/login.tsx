"use client";

/**
 * P1 / F7 — Sign in with your QIE wallet. No passwords, no email, no seed
 * phrases (Master Plan ch.8). Flow: EIP-6963 wallet discovery -> connect
 * (preflight + timeout race) -> QIE chain switch/add state machine ->
 * EIP-4361 challenge -> raw personal_sign -> server verify -> httpOnly
 * session cookie. One signature.
 *
 * Judge-day hardening (manual QA on MetaMask / Rabby / Trust):
 *  - every failure is normalized by friendlyWalletError() — raw wallet
 *    objects like "[object Object]" or "Unable to find any account…"
 *    never reach the screen as-is;
 *  - wrong-chain is non-fatal and offers a one-click Switch;
 *  - a famous-wallet catalog with install links covers users who have no
 *    wallet yet, not just the ones installed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  useWallets, connectWallet, ensureQieChain, signSiwe, rawChainId,
  FAMOUS_WALLETS, famousMatch, type WalletInfo, type Connection,
} from "@/lib/wallets";
import { ACTIVE_CHAIN } from "@/lib/chains";
import { friendlyWalletError, errorText } from "@/lib/wallet-error";

export type Session = { authenticated: true; address: string };

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/session", { cache: "no-store" });
      if (res.ok) setSession(await res.json());
      else setSession(null);
    } catch {
      setSession(null);
    }
    setChecking(false);
  }, []);

  useEffect(() => {
    // defer out of the effect body (react-hooks/set-state-in-effect)
    const t = setTimeout(() => { reload(); }, 0);
    return () => clearTimeout(t);
  }, [reload]);

  return { session, checking, reload };
}

export function LoginScreen({ onAuthed }: { onAuthed: (s: Session) => void }) {
  const { wallets, scanning } = useWallets();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chainNote, setChainNote] = useState<string | null>(null);
  const connRef = useRef<Connection | null>(null);

  const retrySwitch = async () => {
    const c = connRef.current;
    if (!c) return;
    setError(null);
    setBusy(`Switching to ${ACTIVE_CHAIN.name}…`);
    try {
      await ensureQieChain(c);
      const cid = await rawChainId(c.raw);
      setChainNote(cid !== ACTIVE_CHAIN.id ? `Wallet stayed on chain ${cid ?? "?"} — switch manually in your wallet.` : null);
    } catch (e) {
      setError(friendlyWalletError(e));
    } finally {
      setBusy(null);
    }
  };

  const signIn = async (wallet: WalletInfo) => {
    setError(null);
    setChainNote(null);
    connRef.current = null;
    setBusy(`Connecting ${wallet.name}…`);
    try {
      // 1. connect (preflight + explicit request + deadline)
      const c = await connectWallet(wallet);
      connRef.current = c;

      // 2. get onto the QIE chain — rejection here is non-fatal
      setBusy(`Checking ${ACTIVE_CHAIN.name}…`);
      try {
        await ensureQieChain(c);
      } catch {
        /* banner below offers a one-click retry */
      }
      const cid = await rawChainId(c.raw);
      connRef.current = { ...c, chainId: cid ?? c.chainId };
      if (cid !== null && cid !== ACTIVE_CHAIN.id) {
        setChainNote(
          `Your wallet is on chain ${cid} — switching to ${ACTIVE_CHAIN.name} (${ACTIVE_CHAIN.id}) is recommended. You can still sign in.`,
        );
      }

      // 3. EIP-4361 challenge from the server (single-use nonce, 10 min TTL)
      setBusy("Preparing sign-in challenge…");
      const nres = await fetch("/api/auth/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: c.address }),
      });
      const nj = await nres.json().catch(() => ({}));
      if (!nres.ok) throw new Error(errorText(nj?.error) || "Could not start sign-in");

      // 4. one human signature — this IS the login
      setBusy("Waiting for your signature…");
      const signature = await signSiwe(wallet, c.address, nj.message);

      // 5. server verifies + sets the httpOnly session cookie
      setBusy("Verifying signature…");
      const vres = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: c.address, message: nj.message, signature }),
      });
      const vj = await vres.json().catch(() => ({}));
      if (!vres.ok) throw new Error(errorText(vj?.error) || "Sign-in failed");

      onAuthed({ authenticated: true, address: vj.address });
    } catch (e) {
      setError(friendlyWalletError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="p-5 pb-2 text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-700 text-lg font-black text-white">A</div>
          <CardTitle className="text-base">Sign in to AgentPay</CardTitle>
          <p className="mx-auto max-w-[300px] text-xs text-muted-foreground">
            Your wallet is your account. One signature — no password, no email,
            nothing to remember or leak.
          </p>
        </CardHeader>
        <CardContent className="space-y-2 p-5 pt-0">
          {scanning && <p className="py-4 text-center text-xs text-muted-foreground">Looking for wallets…</p>}

          {!scanning && wallets.length === 0 && (
            <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
              <p className="font-medium">No wallet found in this browser.</p>
              <p>
                Install MetaMask, Trust, Rabby or the QIE Wallet below, then
                reload this page. On mobile, open this page inside your
                wallet&apos;s built-in browser.
              </p>
            </div>
          )}

          {wallets.map((w) => (
            <Button
              key={w.uuid}
              variant="outline"
              className="h-12 w-full justify-start gap-3"
              disabled={busy !== null}
              onClick={() => signIn(w)}
            >
              {w.icon ? (
                // EIP-6963 icons are data: URIs announced by the wallet itself
                <img src={w.icon} alt="" className="h-6 w-6 rounded" />
              ) : (
                <span className="flex h-6 w-6 items-center justify-center rounded bg-emerald-100 text-[10px] font-bold text-emerald-900">
                  {w.name.slice(0, 2).toUpperCase()}
                </span>
              )}
              <span className="text-sm font-medium">{w.name}</span>
              {!famousMatch(w.rdns) && (
                <span className="rounded border px-1 text-[9px] text-muted-foreground">injected</span>
              )}
            </Button>
          ))}

          {busy && (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs font-medium text-emerald-950">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-600" />
              {busy}
            </div>
          )}

          {chainNote && !busy && (
            <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
              <p>{chainNote}</p>
              <Button size="sm" className="h-7 text-[11px]" onClick={retrySwitch}>
                Switch to {ACTIVE_CHAIN.name}
              </Button>
            </div>
          )}

          {error && !busy && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-800">
              <p className="font-semibold">Couldn&apos;t sign in</p>
              <p className="mt-0.5">{error}</p>
            </div>
          )}

          <details className="rounded-lg border px-3 py-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none text-[11px] font-medium">
              All supported wallets ({FAMOUS_WALLETS.length})
            </summary>
            <ul className="mt-2 space-y-1.5">
              {FAMOUS_WALLETS.map((f) => {
                const installed = wallets.some(
                  (w) => w.name.toLowerCase() === f.name.toLowerCase() || famousMatch(w.rdns)?.name === f.name,
                );
                return (
                  <li key={f.name} className="flex items-center justify-between gap-2">
                    <span className="truncate">{f.name}</span>
                    {installed ? (
                      <span className="shrink-0 font-medium text-emerald-700">installed ✓</span>
                    ) : (
                      <a
                        href={f.install}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 underline underline-offset-2 hover:text-foreground"
                      >
                        install ↗
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-[10px]">Any EIP-6963 wallet also works — installed wallets appear as buttons above.</p>
          </details>

          <p className="pt-1 text-center text-[10px] leading-relaxed text-muted-foreground">
            SIWE (EIP-4361) · {ACTIVE_CHAIN.name} · chain {ACTIVE_CHAIN.id} · protocol fees 0.3–0.5%
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export { short };
