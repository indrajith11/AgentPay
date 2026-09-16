"use client";

/**
 * P1 finisher — Security & Step-up card (Master Plan 5.7 / ch.8).
 * Passkeys give merchants a biometric second factor WITHOUT passwords:
 *  - enroll once per wallet (Touch ID / Windows Hello / Android / YubiKey)
 *  - money-moving endpoints then require a fresh 5-minute step-up
 *  - server verifies full WebAuthn (challenge, origin, rpId, UP+UV, counter)
 */

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { enrollPasskey, runStepUp, PasskeyError } from "@/lib/passkey-client";
import { errorText } from "@/lib/wallet-error";
import { toast } from "@/hooks/use-toast";
import { short } from "@/components/merchant/login";

export function PasskeySecurityCard({ address }: { address: string }) {
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [stepUpUntil, setStepUpUntil] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    fetch("/api/auth/passkey")
      .then((r) => (r.ok ? r.json() : { enrolled: false }))
      .then((j) => { setEnrolled(!!j.enrolled); setCreatedAt(j.createdAt || null); })
      .catch(() => setEnrolled(false));
  }, []);

  // live "step-up valid for Ns" ticker
  useEffect(() => {
    if (!stepUpUntil) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [stepUpUntil]);

  const enroll = async () => {
    setBusy(true);
    try {
      await enrollPasskey();
      setEnrolled(true);
      setCreatedAt(new Date().toISOString());
      toast({ title: "Passkey enrolled", description: "Money actions now require your biometrics/PIN for 5-minute windows." });
    } catch (e) {
      const msg = e instanceof PasskeyError ? e.message : errorText(e);
      toast({ title: "Enrollment failed", description: msg, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      await fetch("/api/auth/passkey", { method: "DELETE" });
      setEnrolled(false);
      setCreatedAt(null);
      setStepUpUntil(null);
      toast({ title: "Passkey revoked", description: "Step-up is off — wallet signatures alone remain your identity." });
    } finally {
      setBusy(false);
    }
  };

  const testStepUp = useCallback(async () => {
    setBusy(true);
    try {
      const { until } = await runStepUp();
      setStepUpUntil(until);
      toast({ title: "Step-up verified", description: `Protected actions unlocked until ${new Date(until * 1000).toLocaleTimeString()}.` });
    } catch (e) {
      const msg = e instanceof PasskeyError ? e.message : errorText(e);
      toast({ title: "Step-up failed", description: msg, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }, []);

  const stepUpLive = stepUpUntil !== null && stepUpUntil * 1000 > now;

  return (
    <Card className="min-w-0">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          Passkey step-up (no passwords, ever)
          {enrolled === true && <Badge className="bg-emerald-700 text-[10px]">armed</Badge>}
          {enrolled === false && <Badge variant="secondary" className="text-[10px]">off (opt-in)</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Your wallet is the identity (SIWE). A passkey adds a biometric confirm for
          the actions that move money — same model banks use, minus the password database.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        {enrolled === null ? (
          <p className="text-xs text-muted-foreground">Checking enrollment…</p>
        ) : enrolled ? (
          <div className="space-y-2 text-xs">
            <p>
              Enrolled <span className="text-emerald-800 font-medium">{createdAt ? new Date(createdAt).toLocaleDateString() : ""}</span>
              {" "}for <span className="font-mono">{short(address)}</span>
            </p>
            {stepUpLive && (
              <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-emerald-950">
                Step-up verified — protected actions unlocked for{" "}
                <b>{Math.max(0, Math.ceil((stepUpUntil! * 1000 - now) / 1000))}s</b>
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={testStepUp}>
                {busy ? "Waiting for authenticator…" : "Run step-up now"}
              </Button>
              <Button size="sm" variant="ghost" className="text-red-700 hover:text-red-800" disabled={busy} onClick={revoke}>
                Revoke
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2 text-xs">
            <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800" disabled={busy} onClick={enroll}>
              {busy ? "Waiting for authenticator…" : "Enroll passkey"}
            </Button>
          </div>
        )}

        <div className="rounded-lg border p-3">
          <p className="text-[11px] font-semibold text-foreground">Protected actions (once armed)</p>
          <ul className="mt-1.5 space-y-1 text-[11px] text-muted-foreground">
            <li>· Invoice settlement &amp; partial payments (credit passport writes)</li>
            <li>· Subscription due-charges (prepaid balance pulls)</li>
            <li>· Server verifies: challenge (single-use) · origin · rpId · user-presence · biometric flag · signature counter</li>
          </ul>
        </div>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Zero-dependency WebAuthn (ES256) on the server — attestation chains are not
          required by design: we bind proof-of-possession of the credential, not vendor certificates.
        </p>
      </CardContent>
    </Card>
  );
}
