"use client";

// P1 hardened multi-wallet layer.
//
// Detection: EIP-6963 "Multi Injected Provider Discovery" (MetaMask, Rabby,
// Trust, Coinbase, OKX, Bitget, Brave, Phantom, ... all announce) + a legacy
// window.ethereum merge that also unwraps multi-provider bundles
// (window.ethereum.providers[]) so NO installed wallet is ever hidden.
//
// Connection order matters (learned from judge-day manual QA):
//   1. silent eth_accounts preflight   -> no popup if already authorized
//   2. eth_requestAccounts + timeout   -> handles locked / pending wallets
//   3. eth_chainId                      -> decimal chain id
//   4. switch -> add -> re-check -> re-switch (QIE 1983)
//   5. raw personal_sign for SIWE (bypasses ethers error wrapping so real
//      wallet messages reach the user — no more "[object Object]").

import { useEffect, useState, useCallback } from "react";
import { BrowserProvider, hexlify, toUtf8Bytes } from "ethers";
import { ACTIVE_CHAIN } from "@/lib/chains";
import { friendlyWalletError, errorText, withTimeout, rpcErrorCode } from "@/lib/wallet-error";

export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  // provider self-identification flags (legacy wallets)
  isMetaMask?: boolean;
  isRabby?: boolean;
  isTrust?: boolean;
  isTrustWallet?: boolean;
  isCoinbaseWallet?: boolean;
  isBraveWallet?: boolean;
  isPhantom?: boolean;
  isOkxWallet?: boolean;
  isBitKeep?: boolean;
  providers?: Eip1193Provider[];
};

export type WalletInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
  provider: Eip1193Provider;
};

type Eip6963Detail = {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193Provider;
};

const ANNOUNCE = "eip6963:announceProvider";
const REQUEST = "eip6963:requestProvider";

/** Famous wallets we explicitly support — shown even when not installed,
 *  with official install links (rdns lists follow EIP-6963 conventions). */
export const FAMOUS_WALLETS: { name: string; rdns: string[]; install: string }[] = [
  { name: "MetaMask", rdns: ["io.metamask", "io.metamask.flask"], install: "https://metamask.io/download/" },
  { name: "Rabby", rdns: ["io.rabby"], install: "https://rabby.io/" },
  { name: "Trust Wallet", rdns: ["com.trustwallet.app"], install: "https://trustwallet.com/download" },
  { name: "Coinbase Wallet", rdns: ["com.coinbase.wallet"], install: "https://www.coinbase.com/wallet/downloads" },
  { name: "OKX Wallet", rdns: ["com.okex.wallet"], install: "https://www.okx.com/web3" },
  { name: "Bitget Wallet", rdns: ["com.bitget.web3"], install: "https://web3.bitget.com/" },
  { name: "Binance Web3 Wallet", rdns: ["com.binance.wallet"], install: "https://www.binance.com/en/web3wallet" },
  { name: "Brave Wallet", rdns: ["com.brave.wallet"], install: "https://brave.com/wallet/" },
  { name: "Phantom", rdns: ["app.phantom"], install: "https://phantom.app/" },
  { name: "Rainbow", rdns: ["me.rainbow"], install: "https://rainbow.me/" },
  { name: "Zerion", rdns: ["io.zerion.wallet"], install: "https://zerion.io/download" },
  { name: "QIE Wallet", rdns: ["qie"], install: "https://www.qie.digital/" },
];

export function famousMatch(rdns: string): { name: string; install: string } | null {
  const r = (rdns || "").toLowerCase();
  if (!r) return null;
  for (const f of FAMOUS_WALLETS) {
    if (f.rdns.some((x) => r.includes(x))) return { name: f.name, install: f.install };
  }
  return null;
}

function guessLegacyName(p: Eip1193Provider): string {
  if (p.isRabby) return "Rabby";
  if (p.isTrust || p.isTrustWallet) return "Trust Wallet";
  if (p.isCoinbaseWallet) return "Coinbase Wallet";
  if (p.isBraveWallet) return "Brave Wallet";
  if (p.isPhantom) return "Phantom";
  if (p.isOkxWallet) return "OKX Wallet";
  if (p.isBitKeep) return "Bitget Wallet";
  if (p.isMetaMask) return "MetaMask";
  return "Browser wallet";
}

/** Discover all injected wallets. EIP-6963 first, legacy merged after. */
export function useWallets() {
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [scanning, setScanning] = useState(true);

  useEffect(() => {
    const found: WalletInfo[] = [];
    const push = (w: WalletInfo) => {
      // de-dupe by rdns AND by provider identity
      if (found.some((x) => (w.rdns && x.rdns === w.rdns) || x.provider === w.provider)) return;
      found.push(w);
      setWallets([...found]);
    };

    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963Detail>).detail;
      if (!detail?.info || !detail.provider) return;
      push({
        uuid: detail.info.uuid,
        name: detail.info.name,
        icon: detail.info.icon,
        rdns: detail.info.rdns,
        provider: detail.provider,
      });
    };

    window.addEventListener(ANNOUNCE, onAnnounce as EventListener);
    window.dispatchEvent(new Event(REQUEST));
    // wallets announce synchronously on the request event, but re-ask once
    // for extensions that initialize lazily
    const reAsk = setTimeout(() => window.dispatchEvent(new Event(REQUEST)), 300);

    const t = setTimeout(() => {
      // Legacy merge: window.ethereum AND any bundled providers[] — a wallet
      // that only injects the legacy key (or is hidden behind another
      // wallet's provider) is still discoverable.
      const win = window as unknown as { ethereum?: Eip1193Provider };
      const eth = win.ethereum;
      if (eth) {
        const candidates = Array.isArray(eth.providers) && eth.providers.length ? eth.providers : [eth];
        for (const c of candidates) {
          if (!c) continue;
          push({
            uuid: `legacy:${guessLegacyName(c)}`,
            name: guessLegacyName(c),
            icon: "",
            rdns: "",
            provider: c,
          });
        }
      }
      setScanning(false);
    }, 700);

    return () => {
      window.removeEventListener(ANNOUNCE, onAnnounce as EventListener);
      clearTimeout(reAsk);
      clearTimeout(t);
    };
  }, []);

  return { wallets, scanning };
}

export type Connection = {
  address: string;
  chainId: number;
  walletName: string;
  provider: BrowserProvider; // ethers v6 wrapper
  raw: Eip1193Provider; // raw EIP-1193 (chain ops + personal_sign)
};

async function rawChainId(p: Eip1193Provider): Promise<number | null> {
  try {
    const hex = (await withTimeout(p.request({ method: "eth_chainId" }), 15000, "Reading chain")) as string;
    return parseInt(String(hex), 16);
  } catch {
    return null;
  }
}
export { rawChainId };

/** Connect to a specific wallet: preflight -> request -> chain id. */
export async function connectWallet(wallet: WalletInfo): Promise<Connection> {
  const eth = wallet.provider;

  // 1. silent preflight — already-authorized sessions must not popup again
  let accounts: string[] = [];
  try {
    accounts = (await withTimeout(eth.request({ method: "eth_accounts" }), 15000, "Reading accounts")) as string[];
  } catch {
    /* locked wallets can throw here — fall through to the explicit request */
  }

  // 2. explicit authorization with a deadline (mobile deep links can hang)
  if (!accounts?.length) {
    try {
      accounts = (await withTimeout(
        eth.request({ method: "eth_requestAccounts" }),
        180000,
        `Connecting ${wallet.name}`,
      )) as string[];
    } catch (err) {
      throw new Error(friendlyWalletError(err));
    }
  }
  if (!accounts?.length) {
    throw new Error("Your wallet returned no accounts. Unlock it (create an account if it is new), then try again.");
  }

  const chainId = (await rawChainId(eth)) ?? 0;
  return {
    address: accounts[0],
    chainId,
    walletName: wallet.name,
    provider: new BrowserProvider(eth, "any"),
    raw: eth,
  };
}

/**
 * Make sure the wallet is on the active QIE chain: switch -> (if missing)
 * add -> re-check -> re-switch. Precise error routing: only genuinely
 * "chain missing" failures trigger addEthereumChain — everything else is
 * surfaced as friendly guidance instead of raw wallet internals.
 */
export async function ensureQieChain(conn: Connection): Promise<void> {
  const raw = conn.raw;
  if ((await rawChainId(raw)) === ACTIVE_CHAIN.id) return;

  const chainIdHex = "0x" + ACTIVE_CHAIN.id.toString(16);
  const addParams = {
    chainId: chainIdHex,
    chainName: ACTIVE_CHAIN.name,
    nativeCurrency: ACTIVE_CHAIN.nativeCurrency,
    rpcUrls: ACTIVE_CHAIN.rpcs,
    blockExplorerUrls: [ACTIVE_CHAIN.explorer],
  };

  try {
    await withTimeout(
      raw.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] }),
      60000,
      "Switching network",
    );
  } catch (err) {
    const code = rpcErrorCode(err);
    const msg = errorText(err).toLowerCase();
    const missing =
      code === 4902 ||
      (code === -32603 && /unrecognized|unknown|not added|missing|add.*chain/.test(msg)) ||
      /unrecognized chain|unknown chain|chain.*not.*added/.test(msg);
    if (!missing) throw new Error(friendlyWalletError(err));
    try {
      await withTimeout(raw.request({ method: "wallet_addEthereumChain", params: [addParams] }), 90000, "Adding the QIE network");
    } catch (addErr) {
      throw new Error(friendlyWalletError(addErr));
    }
  }

  // some wallets add the chain but do not auto-switch
  if ((await rawChainId(raw)) !== ACTIVE_CHAIN.id) {
    try {
      await withTimeout(
        raw.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] }),
        60000,
        "Switching network",
      );
    } catch (err) {
      throw new Error(friendlyWalletError(err));
    }
  }
}

/** Back-compat alias (older call sites). */
export const switchToQie = ensureQieChain;

/**
 * SIWE signature via raw personal_sign — hex payload, explicit sender.
 * Going raw (instead of ethers signer.signMessage) means wallet rejection
 * objects arrive untouched and get normalized by friendlyWalletError().
 */
export async function signSiwe(wallet: WalletInfo, address: string, message: string): Promise<string> {
  const msgHex = hexlify(toUtf8Bytes(message));
  let sig: unknown;
  try {
    sig = await withTimeout(
      wallet.provider.request({ method: "personal_sign", params: [msgHex, address] }),
      240000,
      "Waiting for your signature",
    );
  } catch (err) {
    throw new Error(friendlyWalletError(err));
  }
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) {
    throw new Error("Your wallet returned an unexpected signature. Please try again.");
  }
  return sig;
}

/** Hook: connection state + connect/disconnect helpers. */
export function useConnection() {
  const { wallets } = useWallets();
  const [conn, setConn] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async (wallet: WalletInfo) => {
    setBusy(true);
    setError(null);
    try {
      const c = await connectWallet(wallet);
      try {
        await ensureQieChain(c); // failure is non-fatal; UI shows a switch prompt
      } catch {
        /* keep going on whatever chain */
      }
      const cid = await rawChainId(c.raw);
      setConn({ ...c, chainId: cid ?? c.chainId });
    } catch (e) {
      setError(friendlyWalletError(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const disconnect = useCallback(() => setConn(null), []);

  return { wallets, conn, connect, disconnect, busy, error };
}
