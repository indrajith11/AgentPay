"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";

/** Refresh server-rendered network stats (bypasses the 60s cache server-side via fresh fetch). */
export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [spin, setSpin] = useState(false);

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending || spin}
      onClick={() => {
        setSpin(true);
        fetch("/api/network-stats?fresh=1").catch(() => undefined);
        startTransition(() => {
          router.refresh();
          setTimeout(() => setSpin(false), 800);
        });
      }}
    >
      {pending || spin ? "Refreshing…" : "Refresh"}
    </Button>
  );
}
