"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { Merchant } from "@/lib/agentpay";

/**
 * QIE Pass — "Verify once, use everywhere" merchant KYC (P10).
 * Flow: create request (identifier = merchant wallet) -> user approves in the
 * QIE Wallet app -> poll -> claim the signed Verifiable Credential -> the
 * platform verifier countersigns verifyMerchant() on-chain. After a claim the
 * merchant can also attach the credentialId on-chain via setQiePassId.
 */

type Phase = "idle" | "requesting" | "pending_kyc" | "pending_consent" | "claiming" | "attesting" | "verified" | "error";

const SHORT_STATUS: Record<string, string> = {
  pending_kyc: "KYC needed — open QIE Wallet to verify",
  pending_consent: "Waiting for your approval in QIE Wallet",
  consent_given: "Approved — claiming your credential…",
  consent_rejected: "Request rejected in QIE Wallet",
  expired: "Request expired — start again",
  failed: "KYC failed at QIE — contact support",
};

export function QiePassCard({ merchant, onChanged }: { merchant: Merchant; onChanged?: () => void }) {
  const [phase, setPhase] = useState<Phase>(merchant.qiePassStatus === "verified" ? "verified" : "idle");
  const [detail, setDetail] = useState<string>("");
  const [requestId, setRequestId] = useState<string | null>(merchant.qiePassRequestId ?? null);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [credentialId, setCredentialId] = useState<string | null>(merchant.qiePassId ?? null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  useEffect(() => stopPoll, []);

  const startPolling = useCallback((id: string) => {
    stopPoll();
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/qiepass/status/${id}`, { cache: "no-store" });
        const j = await res.json();
        if (j.status === "consent_given") {
          stopPoll();
          setDetail("Approved in QIE Wallet — claiming credential");
          await claim(id);
        } else if (["consent_rejected", "expired", "failed"].includes(j.status)) {
          stopPoll();
          setPhase("error");
          setDetail(SHORT_STATUS[j.status] ?? j.status);
        } else if (j.status === "pending_kyc" && j.redirectUrl && !redirectUrl) {
          setRedirectUrl(j.redirectUrl);
        }
      } catch { /* transient — keep polling */ }
    }, 5000);
  }, [redirectUrl]);

  const claim = async (id: string) => {
    setPhase("claiming");
    try {
      const res = await fetch("/api/qiepass/claim", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchantId: merchant.id }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "claim failed");
      setCredentialId(j.credentialId);
      setDetail("Credential claimed — verifier attesting on-chain…");
      await attestOnChain();
    } catch (e: any) {
      setPhase("error");
      setDetail(String(e?.message ?? e).slice(0, 160));
    }
  };

  const attestOnChain = async () => {
    setPhase("attesting");
    try {
      const res = await fetch("/api/merchants/verify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchantId: merchant.id, merchantAddr: merchant.owner }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "on-chain attestation failed");
      setPhase("verified");
      setDetail(j.verifyTx ? `On-chain attestation: ${String(j.verifyTx).slice(0, 10)}…` : "Already verified on-chain");
      onChanged?.();
    } catch (e: any) {
      // VC is claimed and stored — only the chain countersign failed; allow retry
      setPhase("error");
      setDetail("QIE Pass verified (credential stored) — on-chain attestation pending: " + String(e?.message ?? e).slice(0, 120));
    }
  };

  const start = async () => {
    setPhase("requesting");
    setDetail("");
    try {
      const res = await fetch("/api/qiepass/request", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchantId: merchant.id }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "request failed");
      if (j.status === "verified") { setPhase("verified"); return; }
      if (j.status === "consent_given") { setDetail("Already approved — claiming credential"); await claim(j.requestId); return; }
      setRequestId(j.requestId);
      setRedirectUrl(j.redirectUrl ?? null);
      if (j.status === "pending_kyc") { setPhase("pending_kyc"); setDetail("KYC needed — verify inside QIE Wallet, then approve our request"); }
      else { setPhase("pending_consent"); setDetail("Open your QIE Wallet and approve the AgentPay request"); }
      if (j.requestId) startPolling(j.requestId);
    } catch (e: any) {
      setPhase("error");
      setDetail(String(e?.message ?? e).slice(0, 160));
    }
  };

  const badge =
    phase === "verified" ? (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-900">
        ✔ QIEPass Verified
      </span>
    ) : phase === "error" ? (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-900">Action needed</span>
    ) : ["pending_kyc", "pending_consent", "claiming", "attesting"].includes(phase) ? (
      <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-900">In progress…</span>
    ) : (
      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">Unverified</span>
    );

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span>QIE Pass — reusable KYC (verify once, use everywhere)</span>
          {badge}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0 space-y-2">
        {phase === "verified" ? (
          <p className="text-xs text-muted-foreground">
            Merchant identity attested by QIE Pass{credentialId ? ` · credential ${String(credentialId).slice(0, 18)}…` : ""}.
            {detail ? ` ${detail}` : ""} Agents can trust this store before paying.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {detail || "Approve one KYC request in your QIE Wallet — every AgentPay partner reuses it. We only request proof of document verification + liveness, never your personal data."}
            {redirectUrl && phase === "pending_kyc" && (
              <>
                {" "}
                <a href={redirectUrl} target="_blank" rel="noreferrer" className="font-semibold text-sky-800 underline">Open QIE verification →</a>
              </>
            )}
          </p>
        )}
        {phase !== "verified" && (
          <div className="flex gap-2">
            <Button size="sm" onClick={start} disabled={["requesting", "pending_kyc", "pending_consent", "claiming", "attesting"].includes(phase)}>
              {phase === "requesting" ? "Requesting…" : ["pending_kyc", "pending_consent", "claiming", "attesting"].includes(phase) ? "Waiting for QIE Wallet…" : "Get Verified with QIE Pass"}
            </Button>
            {phase === "error" && credentialId && (
              <Button size="sm" variant="outline" onClick={attestOnChain}>Retry on-chain attestation</Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
