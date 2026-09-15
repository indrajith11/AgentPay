// index.js - AgentPay x MerchantPilot P0 event indexer (entry point).
// Chain events -> idempotent SQLite ledger -> health API + HMAC-signed webhook.
// Master Plan refs: I-01..I-06 (ch.4), ch.9 data architecture.
//
// Usage:
//   RPC_URL=... node index.js                     # continuous watch
//   node index.js --backfill --from 12345         # replay from a block, then exit
//   node index.js --smoke                         # offline self-test (no RPC)
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Ledger } from "./src/db.js";
import { Watcher } from "./src/watcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
const env = process.env;
const CFG = {
  rpcUrl: env.RPC_URL || "https://rpc1testnet.qie.digital/",
  addressBook:
    env.ADDRESS_BOOK ||
    path.resolve(__dirname, "../contracts/addresses/qieTestnet.json"),
  dbFile: env.DB_FILE || path.resolve(__dirname, "data/ledger.sqlite"),
  httpPort: Number(env.HTTP_PORT || 3040),
  pollMs: Number(env.POLL_MS || 2000),
  // START_BLOCK wins; else BACKFILL_WINDOW blocks before current head on first run
  startBlock: Number(env.START_BLOCK || 0),
  backfillWindow: Number(env.BACKFILL_WINDOW || 200_000),
  qrWallets: (env.QR_WALLETS || "") // extra merchant wallets to tag on Transfer
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  webhookUrl: env.WEBHOOK_URL || "",
  webhookSecret: env.WEBHOOK_SECRET || "agentpay-dev-secret",
};

// ---------- combined event ABI (from agentpay/contracts sources) ----------
import { parseAbiItem } from "viem";
const COMBINED_ABI = [
  parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
  parseAbiItem("event Approval(address indexed owner, address indexed spender, uint256 value)"),
  parseAbiItem("event PaymentReceived(address indexed merchant, address indexed token, address payer, uint256 gross, uint256 fee)"),
  parseAbiItem("event ExternalRecorded(address indexed merchant, address indexed token, uint256 net, uint256 fee)"),
  parseAbiItem("event Withdrawn(address indexed merchant, address indexed token, address to, uint256 amount)"),
  parseAbiItem("event FeesPaid(address indexed merchant, address indexed token, uint256 amount)"),
  parseAbiItem("event CallPaid(uint256 indexed callId, uint256 indexed productId, address indexed agent, address principal, uint256 amount, uint256 escrowId)"),
  parseAbiItem("event CallClaimed(uint256 indexed callId, uint256 netToMerchant, uint256 fee)"),
  parseAbiItem("event CallRefunded(uint256 indexed callId)"),
  parseAbiItem("event ProductAdded(uint256 indexed id, address indexed merchant, string name, string endpointPath, uint256 price)"),
  parseAbiItem("event ProductStatusChanged(uint256 indexed id, bool active)"),
  parseAbiItem("event UsdFeedSet(address indexed token, address indexed feed)"),
  parseAbiItem("event MaxFeedAgeChanged(uint256 seconds_)"),
  parseAbiItem("event FeeUpdated(uint256 newFeeBps)"),
  parseAbiItem("event EscrowOpened(uint256 indexed id, address payer, address agent, address payee, uint256 amount, uint64 deadline)"),
  parseAbiItem("event EscrowReleased(uint256 indexed id, uint256 amount)"),
  parseAbiItem("event EscrowRefunded(uint256 indexed id, uint256 amount)"),
  parseAbiItem("event DefaultWindowChanged(uint64 newWindow)"),
  parseAbiItem("event InvoiceCreated(uint256 indexed id, address indexed merchant, address payer, uint256 amount, uint64 dueAt, string customerRef)"),
  parseAbiItem("event InvoicePaid(uint256 indexed id, uint256 paidAmount, uint256 totalPaid, bool fullyPaid)"),
  parseAbiItem("event InvoiceOverdue(uint256 indexed id)"),
  parseAbiItem("event SubscriptionCreated(uint256 indexed id, address indexed merchant, address indexed payer, uint256 amountPerCycle, uint64 interval)"),
  parseAbiItem("event Deposited(uint256 indexed id, uint256 amount, uint256 balance)"),
  parseAbiItem("event Charged(uint256 indexed id, uint256 amount, uint32 chargesCount, uint64 nextDueAt)"),
  parseAbiItem("event Lapsed(uint256 indexed id)"),
  parseAbiItem("event Cancelled(uint256 indexed id, uint256 refunded)"),
  parseAbiItem("event MandateCreated(uint256 indexed id, address indexed principal, address indexed agent, address token, uint256 perCallCap, uint256 dailyCap, uint256 initialDeposit)"),
  parseAbiItem("event MandateDeposited(uint256 indexed id, uint256 amount, uint256 newBalance)"),
  parseAbiItem("event MandateSpent(uint256 indexed id, address indexed agent, address indexed to, uint256 amount, string purposeRef)"),
  parseAbiItem("event MandateClosed(uint256 indexed id, uint256 refunded)"),
  parseAbiItem("event MerchantRegistered(address indexed merchant, string name, string metadataURI)"),
  parseAbiItem("event MerchantVerified(address indexed merchant, bool verified)"),
  parseAbiItem("event MerchantUpdated(address indexed merchant, string name, string metadataURI)"),
  parseAbiItem("event MerchantStatusChanged(address indexed merchant, bool active)"),
  parseAbiItem("event VerifierChanged(address indexed newVerifier)"),
  parseAbiItem("event AgentRegistered(address indexed agent, string name)"),
  parseAbiItem("event PrincipalBound(address indexed agent, address indexed principal, string qiePassId)"),
  parseAbiItem("event AgentStatusChanged(address indexed agent, bool active)"),
  parseAbiItem("event PaymentRecorded(address indexed subject, uint256 amount, bool onTime, uint256 newScore)"),
  parseAbiItem("event DefaultRecorded(address indexed subject, uint256 amount, uint256 newScore)"),
  parseAbiItem("event RecorderUpdated(address indexed recorder, bool authorized)"),
  parseAbiItem("event TreasuryChanged(address indexed newTreasury)"),
  parseAbiItem("event PayoutProfileSet(address indexed merchant, address payoutAddress, uint8 rail, string provider, string fiatCurrency, uint256 minThreshold, uint64 interval, bool autoEnabled)"),
  parseAbiItem("event WithdrawalRequested(address indexed merchant, address indexed token, uint256 amount, address to, uint8 rail, string provider, string fiatCurrency, bytes32 providerRef, bool autoTrigger, uint64 at)"),
];

// ---------- sources from address book ----------
async function loadSources(defaultStartBlock) {
  const book = JSON.parse(fs.readFileSync(CFG.addressBook, "utf8"));
  const watched = [
    "WQIE", "SettlementRouter", "PayEndpoint", "EscrowCore",
    "InvoiceVault", "RecurringMandate", "MandateVault",
    "MerchantRegistry", "AgentRegistry", "CreditPassport",
  ];
  const sources = [];
  for (const name of watched) {
    const address = book[name];
    if (address && /^0x[a-fA-F0-9]{40}$/.test(address)) {
      sources.push({
        name,
        address,
        rpcUrls: [CFG.rpcUrl],
        startBlock: CFG.startBlock || defaultStartBlock,
      });
    }
  }
  return sources;
}

// ---------- smoke self-test (no RPC): idempotency + checkpoint + heartbeat ----------
async function smoke() {
  // isolated temp DB so the smoke test never collides with real ledger data
  const ledger = new Ledger("/tmp/agentpay_smoke_" + Date.now() + ".sqlite");
  const base = {
    txHash: "0x" + "ab".repeat(32),
    logIndex: 0,
    blockNumber: 100,
    blockTime: null,
    contract: "0x" + "cd".repeat(20),
    event: "PaymentReceived",
    merchant: "0x" + "ee".repeat(20),
    token: "0x" + "cd".repeat(20),
    amount: "1000000000000000000",
    payload: '{"args":{"gross":"1000000000000000000"}}',
  };
  const first = ledger.ingest(base);
  const dup = ledger.ingest({ ...base });
  const idx = ledger.ingest({ ...base, logIndex: 1, event: "CallPaid" });
  ledger.setCheckpoint("SettlementRouter", 99);
  ledger.heartbeat(null);
  const ok =
    first === 1 && dup === 0 && idx === 1 &&
    ledger.getCheckpoint("SettlementRouter") === 99 &&
    Object.keys(ledger.counts()).length === 2;
  console.log(JSON.stringify({
    smoke: ok ? "PASS" : "FAIL",
    first, dup, idx,
    counts: ledger.counts(),
    heartbeatAge: ledger.heartbeatAge(),
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

// ---------- health HTTP API ----------
function startHealthServer(ledger, watchers) {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/health") {
      const heartbeatAge = ledger.heartbeatAge();
      const body = {
        status: heartbeatAge >= 0 && heartbeatAge < 30 ? "ok" : "degraded",
        heartbeatAgeSeconds: heartbeatAge,
        ledgerHead: ledger.head(),
        checkpoints: Object.fromEntries(
          watchers.map((w) => [w.name, { lastBlock: ledger.getCheckpoint(w.name), address: w.address }])
        ),
        eventCounts: ledger.counts(),
      };
      res.end(JSON.stringify(body, null, 2));
    } else if (req.url && req.url.startsWith("/events")) {
      const limit = Number(new URL(req.url, "http://x").searchParams.get("limit") || 50);
      res.end(JSON.stringify({ events: ledger.recent(Math.min(limit, 500)) }, null, 2));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found", endpoints: ["/health", "/events?limit=50"] }));
    }
  });
  server.listen(CFG.httpPort, () =>
    console.log(`[indexer] health API on http://localhost:${CFG.httpPort}/health`)
  );
  return server;
}

// ---------- main ----------
async function main() {
  if (process.argv.includes("--smoke")) return smoke();

  const ledger = new Ledger(CFG.dbFile);

  // First-run default start: BACKFILL_WINDOW blocks before head (RPC caps getLogs
  // at 10000-block ranges; full genesis scans are impractical on this chain).
  let defaultStart = 1;
  if (!CFG.startBlock && !process.argv.includes("--from")) {
    try {
      const { createPublicClient, http } = await import("viem");
      const probe = createPublicClient({ transport: http(CFG.rpcUrl, { timeout: 12_000 }) });
      const head = Number(await probe.getBlockNumber());
      defaultStart = Math.max(1, head - CFG.backfillWindow);
    } catch (e) {
      console.error("[indexer] head probe failed, starting from block 1:", String(e).slice(0, 120));
    }
  }

  const sources = await loadSources(defaultStart);
  if (sources.length === 0) {
    console.error("[indexer] no watchable addresses in address book:", CFG.addressBook);
    process.exit(1);
  }
  const watchers = sources.map((s) => new Watcher(s, COMBINED_ABI, ledger));

  if (process.argv.includes("--backfill")) {
    const idx = process.argv.indexOf("--from");
    const from = idx > -1 ? Number(process.argv[idx + 1]) : defaultStart;
    for (const w of watchers) {
      if (ledger.getCheckpoint(w.name) < from - 1) ledger.setCheckpoint(w.name, from - 1);
    }
    console.log(`[indexer] backfill from block ${from}`);
    let empty = 0;
    while (empty < 2) {
      let pending = 0;
      for (const w of watchers) {
        const head = await w.head();
        pending += Math.max(0, head - 1 - ledger.getCheckpoint(w.name));
        await w.pollOnce();
      }
      console.log(`[indexer] backfill progress: pending=${pending} events=${JSON.stringify(ledger.counts())}`);
      empty = pending === 0 ? empty + 1 : 0;
    }
    console.log("[indexer] backfill complete:", ledger.counts());
    return;
  }

  // ---------- signed webhook out (Master Plan I-05) ----------
  async function deliverWebhook(events) {
    if (!CFG.webhookUrl || events.length === 0) return;
    const body = JSON.stringify({ source: "agentpay-indexer", deliveredAt: new Date().toISOString(), events });
    const sig = "sha256=" + crypto.createHmac("sha256", CFG.webhookSecret).update(body).digest("hex");
    try {
      const res = await fetch(CFG.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agentpay-signature": sig },
        body,
      });
      console.log(`[indexer] webhook ${CFG.webhookUrl} -> ${res.status} (${events.length} events)`);
    } catch (e) {
      console.error("[indexer] webhook failed:", String(e).slice(0, 120));
    }
  }

  startHealthServer(ledger, watchers);
  console.log(`[indexer] watching ${watchers.length} sources on ${CFG.rpcUrl} every ${CFG.pollMs}ms`);
  if (CFG.webhookUrl) console.log(`[indexer] webhook out -> ${CFG.webhookUrl} (HMAC signed)`);
  for (const w of watchers) console.log(`  - ${w.name}: ${w.address}`);

  let running = true;
  process.on("SIGINT", () => (running = false));
  while (running) {
    for (const w of watchers) {
      try {
        const r = await w.pollOnce();
        if (r.newEvents > 0) {
          console.log(`[indexer] ${w.name}: +${r.newEvents} events (head ${r.head})`);
          const fresh = ledger.recent(r.newEvents);
          await deliverWebhook(fresh);
        }
      } catch (e) {
        console.error(`[indexer] ${w.name} poll error:`, String(e).slice(0, 160));
      }
    }
    await new Promise((r) => setTimeout(r, CFG.pollMs));
  }
  console.log("[indexer] shut down cleanly");
}

main().catch((e) => {
  console.error("[indexer] fatal:", e);
  process.exit(1);
});
