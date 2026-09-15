/**
 * AgentPay Agent Daemon
 * =====================
 * Three autonomous agents run against the deployed AgentPay contracts:
 *
 *   1. Reconciliation Agent — indexes payment events (InvoicePaid, CallPaid,
 *      Charged) and produces a daily ledger; pushes a summary webhook
 *      (WhatsApp/SMS gateway in production).
 *
 *   2. Collections Agent — finds overdue invoices on-chain, triggers
 *      markOverdue() (permissionless), and emits reminder webhooks.
 *
 *   3. Treasury Agent (AUTO-WITHDRAW KEEPER) — discovers merchants from
 *      PayoutProfileSet events and settlement tokens from PaymentReceived
 *      events. Whenever canAutoWithdraw() flips true (balance >= threshold,
 *      interval elapsed, auto enabled) it executes the PERMISSIONLESS
 *      executeAutoWithdraw() on the merchant's behalf. The merchant pays no
 *      gas and never opens the app — the sweep lands at their saved off-ramp
 *      deposit address and the provider pays their bank account.
 *
 * Env: see .env.example. All loops respect AGENT_INTERVAL_SECONDS.
 * RPCs: RPC_URLS (comma-separated) rotates automatically on failure.
 */
import { ethers } from "ethers";
import * as fs from "fs";

// ---- config ----
const RPC_URLS = (process.env.RPC_URLS || process.env.RPC_URL || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DEFAULT_RPCS =
  "https://rpc1testnet.qie.digital/,https://rpc2testnet.qie.digital/,https://rpc3testnet.qie.digital/";
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY || "";
const INTERVAL = Number(process.env.AGENT_INTERVAL_SECONDS || 60);
const LEDGER_DIR = process.env.LEDGER_DIR || "./ledger";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const DRY_RUN = process.env.TREASURY_DRY_RUN !== "false";

const ADDR = {
  MerchantRegistry: process.env.MERCHANT_REGISTRY || "",
  AgentRegistry: process.env.AGENT_REGISTRY || "",
  EscrowCore: process.env.ESCROW_CORE || "",
  SettlementRouter: process.env.SETTLEMENT_ROUTER || "",
  CreditPassport: process.env.CREDIT_PASSPORT || "",
  MandateVault: process.env.MANDATE_VAULT || "",
  PayEndpoint: process.env.PAY_ENDPOINT || "",
  InvoiceVault: process.env.INVOICE_VAULT || "",
  RecurringMandate: process.env.RECURRING_MANDATE || "",
  WQIE: process.env.WQIE || "",
};

const ABI = {
  InvoiceVault: [
    "event InvoicePaid(uint256 indexed id, uint256 paidAmount, uint256 totalPaid, bool fullyPaid)",
    "event InvoiceOverdue(uint256 indexed id)",
    "function invoices(uint256) view returns (uint256 id, address merchant, address payer, address token, uint256 amount, uint256 paidAmount, uint64 dueAt, string customerRef, string metadataURI, uint8 status, uint64 createdAt, uint64 paidAt)",
    "function markOverdue(uint256 invoiceId)",
    "function nextInvoiceId() view returns (uint256)",
  ],
  PayEndpoint: [
    "event CallPaid(uint256 indexed callId, uint256 indexed productId, address indexed agent, address principal, uint256 amount, uint256 escrowId)",
    "function nextCallId() view returns (uint256)",
  ],
  RecurringMandate: [
    "event Charged(uint256 indexed id, uint256 amount, uint32 chargesCount, uint64 nextDueAt)",
    "function nextSubId() view returns (uint256)",
  ],
  SettlementRouter: [
    "event PayoutProfileSet(address indexed merchant, address payoutAddress, uint8 rail, string provider, string fiatCurrency, uint256 minThreshold, uint64 interval, bool autoEnabled)",
    "event PaymentReceived(address indexed merchant, address indexed token, address payer, uint256 gross, uint256 fee)",
    "event WithdrawalRequested(address indexed merchant, address indexed token, uint256 amount, address indexed to, uint8 rail, string provider, string fiatCurrency, bytes32 providerRef, bool automated, uint64 at)",
    "function canAutoWithdraw(address merchant, address token) view returns (bool ok, string reason)",
    "function executeAutoWithdraw(address token, address merchant) returns (uint256 swept)",
    "function payoutProfileOf(address merchant) view returns (address payoutAddress, bytes32 providerRef, string provider, string fiatCurrency, uint8 rail, uint256 minThreshold, uint64 interval, uint64 lastPayoutAt, bool autoEnabled, bool active)",
  ],
};

function log(agent: string, msg: string) {
  const line = `[${new Date().toISOString()}] [${agent}] ${msg}`;
  console.log(line);
}

async function webhook(payload: Record<string, unknown>) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    /* non-fatal */
  }
}

// ---------------- RPC rotation ----------------
const rpcList = RPC_URLS.length ? RPC_URLS : DEFAULT_RPCS.split(",");
let rpcIdx = 0;

function makeProvider(): ethers.JsonRpcProvider {
  const url = rpcList[rpcIdx % rpcList.length];
  return new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
}

/** Run fn on the current RPC; rotate to the next on failure and retry once. */
async function withRotation<T>(fn: (p: ethers.JsonRpcProvider) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < rpcList.length; attempt++) {
    const provider = makeProvider();
    try {
      const out = await fn(provider);
      return out;
    } catch (e) {
      rpcIdx++;
      log("rpc", `rpc #${(rpcIdx - 1) % rpcList.length} failed (${(e as Error).message.slice(0, 80)}) -> rotating to #${rpcIdx % rpcList.length}`);
    }
  }
  throw new Error("all RPCs failed this cycle");
}

// ---------------- 1. Reconciliation Agent ----------------
async function reconciliationCycle(provider: ethers.JsonRpcProvider, fromBlock: number) {
  const inv = new ethers.Contract(ADDR.InvoiceVault, ABI.InvoiceVault, provider);
  const pay = new ethers.Contract(ADDR.PayEndpoint, ABI.PayEndpoint, provider);
  const sub = new ethers.Contract(ADDR.RecurringMandate, ABI.RecurringMandate, provider);

  const [paid, callsEv, charged] = await Promise.all([
    inv.queryFilter(inv.filters.InvoicePaid(), fromBlock),
    pay.queryFilter(pay.filters.CallPaid(), fromBlock),
    sub.queryFilter(sub.filters.Charged(), fromBlock),
  ]);

  if (paid.length + callsEv.length + charged.length === 0) {
    log("reconciliation", "no new payment events");
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  let total = 0n;

  for (const e of paid) {
    const a = (e.args[1] as bigint).toString();
    lines.push(`INVOICE #${e.args[0]} paid ${a} units (full=${e.args[3]})`);
    total += e.args[1] as bigint;
  }
  for (const e of callsEv) {
    lines.push(`MACHINE CALL #${e.args[0]} product=${e.args[1]} agent=${e.args[2]} amount=${e.args[4].toString()}`);
    total += e.args[4] as bigint;
  }
  for (const e of charged) {
    lines.push(`SUBSCRIPTION #${e.args[0]} charge ${e.args[1].toString()} (cycle ${e.args[2]})`);
    total += e.args[1] as bigint;
  }

  if (!fs.existsSync(LEDGER_DIR)) fs.mkdirSync(LEDGER_DIR, { recursive: true });
  const file = `${LEDGER_DIR}/ledger-${today}.csv`;
  fs.appendFileSync(file, lines.join("\n") + "\n");

  log("reconciliation", `${lines.length} entries -> ${file} (gross ${ethers.formatEther(total)})`);
  await webhook({ agent: "reconciliation", entries: lines.length, gross: ethers.formatEther(total) });
}

// ---------------- 2. Collections Agent ----------------
async function collectionsCycle(provider: ethers.JsonRpcProvider, signer: ethers.Wallet) {
  const inv = new ethers.Contract(ADDR.InvoiceVault, ABI.InvoiceVault, signer);
  const count = Number(await inv.nextInvoiceId());

  for (let id = 1; id < count; id++) {
    const i = await inv.invoices(id);
    const open = Number(i.status) === 0 || Number(i.status) === 1; // Open | Partial
    const overdue = BigInt(i.dueAt) < BigInt(Math.floor(Date.now() / 1000));
    if (open && overdue) {
      log("collections", `invoice #${id} (${i.customerRef}) overdue -> marking + reminding`);
      try {
        const tx = await inv.markOverdue(id);
        await tx.wait();
      } catch (e) {
        log("collections", `markOverdue(${id}) failed: ${(e as Error).message}`);
      }
      await webhook({ agent: "collections", invoice: id, customer: i.customerRef, action: "reminder" });
    }
  }
  log("collections", `scanned ${count - 1} invoices`);
}

// ---------------- 3. Treasury Agent (AUTO-WITHDRAW KEEPER) ----------------
// Discovers merchants + tokens purely from on-chain events, then executes
// the permissionless executeAutoWithdraw() whenever policy allows.
class AutoWithdrawKeeper {
  merchants = new Set<string>();
  tokens = new Set<string>();

  async refreshDiscovery(provider: ethers.JsonRpcProvider, fromBlock: number) {
    const router = new ethers.Contract(ADDR.SettlementRouter, ABI.SettlementRouter, provider);

    const profiles = await router.queryFilter(router.filters.PayoutProfileSet(), fromBlock);
    for (const e of profiles) {
      const m = e.args[0] as string;
      const autoEnabled = e.args[7] as boolean;
      if (autoEnabled) {
        if (!this.merchants.has(m)) log("treasury", `discovered auto-withdraw merchant ${m} (${e.args[3]} -> ${e.args[4]})`);
        this.merchants.add(m);
      }
    }
    const payments = await router.queryFilter(router.filters.PaymentReceived(), fromBlock);
    for (const e of payments) {
      const t = e.args[1] as string;
      if (t !== ethers.ZeroAddress) this.tokens.add(t);
    }
    if (ADDR.WQIE) this.tokens.add(ADDR.WQIE);
  }

  async runCycle(provider: ethers.JsonRpcProvider, signer: ethers.Wallet) {
    const router = new ethers.Contract(ADDR.SettlementRouter, ABI.SettlementRouter, signer);
    for (const m of this.merchants) {
      for (const t of this.tokens) {
        try {
          const [ok, reason] = await router.canAutoWithdraw(m, t);
          if (!ok) {
            log("treasury", `${m.slice(0, 10)}… token ${t.slice(0, 10)}…: waiting (${reason})`);
            continue;
          }
          if (DRY_RUN) {
            log("treasury", `[dry-run] would executeAutoWithdraw(${t.slice(0, 10)}…, ${m.slice(0, 10)}…) — set TREASURY_DRY_RUN=false`);
            continue;
          }
          const tx = await router.executeAutoWithdraw(t, m);
          const rec = await tx.wait();
          log("treasury", `AUTO-WITHDRAW executed for ${m.slice(0, 10)}… tx=${rec?.hash?.slice(0, 14)}…`);
          await webhook({ agent: "treasury", merchant: m, token: t, action: "auto_withdraw", tx: rec?.hash });
        } catch (e) {
          log("treasury", `cycle error for ${m.slice(0, 10)}…: ${(e as Error).message.slice(0, 100)}`);
        }
      }
    }
    if (this.merchants.size === 0) log("treasury", "no auto-withdraw merchants discovered yet (watching PayoutProfileSet)");
  }
}

// ---------------- main ----------------
async function main() {
  for (const [k, v] of Object.entries(ADDR)) {
    if (["MerchantRegistry", "AgentRegistry", "EscrowCore", "SettlementRouter", "CreditPassport", "MandateVault", "PayEndpoint", "InvoiceVault", "RecurringMandate"].includes(k) && !v) {
      console.error(`Missing env ${k}. Copy addresses/<network>.json values into .env`);
      process.exit(1);
    }
  }

  const provider = await withRotation(async (p) => {
    const net = await p.getNetwork();
    log("boot", `connected chainId=${net.toString()} via rpc #${rpcIdx % rpcList.length} (QIE testnet=1983, mainnet=1990)`);
    return p;
  });

  const signer = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, provider) : null;
  if (!signer) log("boot", "no AGENT_PRIVATE_KEY — read-only mode (collections/treasury disabled)");

  const latest = await provider.getBlockNumber();
  let cursor = Math.max(0, latest - 5000);

  const keeper = new AutoWithdrawKeeper();

  const loop = async () => {
    try {
      await withRotation(async (p) => {
        await reconciliationCycle(p, cursor);
        const newLatest = await p.getBlockNumber();
        cursor = Math.max(cursor, newLatest - 10);
        await keeper.refreshDiscovery(p, Math.max(0, newLatest - 5000));
      });
      if (signer) {
        await withRotation(async (p) => {
          const s = signer.connect(p);
          await collectionsCycle(p, s);
          await keeper.runCycle(p, s);
        });
      }
    } catch (e) {
      log("loop", `error: ${(e as Error).message}`);
    }
    setTimeout(loop, INTERVAL * 1000);
  };
  loop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
