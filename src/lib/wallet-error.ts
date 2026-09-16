/**
 * P1 hardening — one normalizer for EVERY catch block that can see a wallet
 * or server error. Root cause of the "Rabby shows [object Object]" bug:
 * EIP-1193 providers (Rabby, Trust, some MetaMask builds) reject with plain
 * JSON-RPC objects, not Error instances, so `String(err)` renders
 * "[object Object]". ethers v6 additionally wraps raw provider errors and
 * buries the human message in .shortMessage / .cause / .data.
 *
 * Rules:
 *  1. errorText(e)          — extract a human string from ANY throwable shape.
 *  2. friendlyWalletError(e) — errorText + actionable guidance for known
 *                             wallet states (rejected / pending / locked /
 *                             no account / missing chain).
 *  3. withTimeout(p, ms, label) — wallets that never resolve (mobile
 *                             deep-link flows) must not hang the UI forever.
 * Pure functions, no React / no ethers — safe on client AND server.
 */

/** Walk any throwable shape and pull out the most human message available. */
export function errorText(e: unknown, depth = 0): string {
  if (e == null) return "Something went wrong.";

  // 1. plain string rejections
  if (typeof e === "string") return clean(e);

  // 2. Error instances: walk message -> shortMessage -> cause chain
  if (e instanceof Error) {
    if (e.message && e.message !== "[object Object]") return clean(e.message);
    const withShort = e as Error & { shortMessage?: string; reason?: string };
    if (withShort.shortMessage) return clean(withShort.shortMessage);
    if (withShort.reason) return clean(withShort.reason);
    if (depth < 4 && e.cause) return errorText(e.cause, depth + 1);
    return e.name ? `${e.name} (no details given)` : "Something went wrong.";
  }

  // 3. plain objects: EIP-1193 rejections, viem/ethers RPC payloads
  if (typeof e === "object") {
    const o = e as Record<string, unknown>;
    const nested =
      pick(o, "message") ??
      pick(o, "shortMessage") ??
      pick(o, "reason") ??
      pick(o, "errorText") ??
      // viem: { data: { message } } / { data: { originalError: { message } } }
      deepMessage(o.data) ??
      deepMessage(o.originalError) ??
      deepMessage(o.error) ??
      deepMessage(o.cause);
    if (nested) return clean(nested);
    // last resort: never "[object Object]" — show the JSON, capped
    try {
      return clean(JSON.stringify(o));
    } catch {
      return "Something went wrong.";
    }
  }

  // 4. numbers etc.
  return clean(String(e));
}

function deepMessage(v: unknown, depth = 0): string | null {
  if (v == null || typeof v !== "object") {
    return typeof v === "string" && v ? v : null;
  }
  if (depth > 2) return null;
  const o = v as Record<string, unknown>;
  return (
    pick(o, "message") ??
    pick(o, "shortMessage") ??
    pick(o, "reason") ??
    deepMessage(o.originalError, depth + 1) ??
    deepMessage(o.error, depth + 1) ??
    deepMessage(o.cause, depth + 1)
  );
}

function pick(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  if (typeof v === "string" && v && v !== "[object Object]") return v;
  return null;
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 240);
}

/** Extract a numeric EIP-1193 / JSON-RPC error code if present. */
export function rpcErrorCode(e: unknown): number | undefined {
  const scan = (o: unknown, d: number): number | undefined => {
    if (o == null || typeof o !== "object" || d > 3) return undefined;
    const code = (o as Record<string, unknown>).code;
    if (typeof code === "number") return code;
    return (
      scan((o as Record<string, unknown>).data, d + 1) ??
      scan((o as Record<string, unknown>).error, d + 1) ??
      scan((o as Record<string, unknown>).cause, d + 1)
    );
  };
  if (typeof e === "number") return e;
  return scan(e, 0);
}

export function isUserRejection(e: unknown): boolean {
  const code = rpcErrorCode(e);
  if (code === 4001) return true;
  const t = errorText(e).toLowerCase();
  return /user rejected|user denied|user cancelled|rejected the request|action rejected|declined/.test(t);
}

/**
 * Human, actionable copy for every wallet state we have ever seen in the
 * wild — including the raw "Unable to find any account…" text some wallets
 * surface when the vault is locked or the active account group has no
 * account available (the MetaMask "for 60…" report from manual QA).
 */
export function friendlyWalletError(e: unknown): string {
  const raw = errorText(e);
  const t = raw.toLowerCase();
  const code = rpcErrorCode(e);

  // user closed the popup / hit reject
  if (isUserRejection(e)) {
    return "Request rejected in your wallet. Approve the request (or retry) to continue.";
  }
  // a request is already waiting inside the wallet popup
  if (code === -32002 || /already pending|request.*(pending|in progress)|another request/.test(t)) {
    return "Your wallet already has a request open — open the wallet popup, complete or reject it, then try again.";
  }
  // vault locked / no accounts (covers "Unable to find any account for …")
  if (/unable to find any account|no (unlocked )?accounts?|account(s)? not (found|available)|there is no account/.test(t)) {
    return "Your wallet has no unlocked account available. Open your wallet, unlock it (create an account if it is new), then try again.";
  }
  if (/lock(ed|ing)?\b|unlock/.test(t)) {
    return "Your wallet is locked — unlock it and try again.";
  }
  // chain problems
  if (code === 4902 || /unrecognized chain|unknown chain|chain.*not.*added|add.*chain|missing chain/.test(t)) {
    return "The QIE network is not in this wallet yet. Use the Switch button to add it (Chain ID 1983).";
  }
  if (/switch|wrong network|unsupported chain/.test(t) && code !== undefined) {
    return "Your wallet is on a different network. Use the Switch button to move to the QIE network.";
  }
  // transport / connectivity
  if (/failed to fetch|network error|networkerror|connection|socket|timeout|timed out/.test(t)) {
    return "Network hiccup between the wallet, the app and the server. Check your connection and try again.";
  }
  return raw || "Something went wrong. Please try again.";
}

/** Race any wallet request against a deadline; label becomes the error copy. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} — timed out after ${Math.round(ms / 1000)}s. Check your wallet popup and try again.`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
