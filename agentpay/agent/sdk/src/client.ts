/**
 * @agentpay/sdk — AgentPayClient (X-05).
 *
 * The typed client for AI agents: discover → pay → verify → refund.
 *
 *   const agent = new AgentPayClient({ privateKey: process.env.AGENT_PRIVATE_KEY! });
 *   const catalog = await agent.discover("https://seller.example");
 *   const res = await agent.buyAndCall("https://seller.example", "weather-basic", { mandateId: 2 });
 *   console.log(res.data);                       // the paid payload
 *   await agent.refund(res.onChain!.callId);     // dispute within the window
 *
 * Money movement ALWAYS goes through the on-chain rail: the agent's
 * pre-funded MandateVault mandate (per-call cap + daily cap + expiry +
 * principal binding) pays PayEndpoint, funds land in EscrowCore, and the
 * human principal keeps a refund window. The seller verifies the tx on-chain
 * before serving data — no trust in either side.
 *
 * Zero dependencies beyond ethers v6.
 */
import { ethers } from "ethers";
import { NETWORKS, defaultNetwork } from "./chains.js";
import { AgentPayError, httpErrorToAgentPayError, toAgentPayError } from "./errors.js";
import type {
  CallReceipt,
  Catalog,
  MandateSnapshot,
  NetworkConfig,
  ProductInfo,
  PurchaseResult,
  Quote,
  RedemptionProof,
  Terms,
  TicketPayload,
  TicketPurchase,
  TicketStatusResult,
  VerifyResult,
} from "./types.js";

/** CallPaid(uint256 indexed callId, uint256 indexed productId, address indexed agent, address principal, uint256 amount, uint256 escrowId) */
const CALLPAID_TOPIC =
  "0x7ab7b7d94f73c16e533cbe1f2698b9283d0b664510294e157922de4a4fc03e68";

const PAY_ENDPOINT_ABI = [
  "function payForCall(uint256 mandateId, uint256 productId, address token) returns (uint256 callId)",
  "function quoteIn(uint256 productId, address token) view returns (uint256 amount)",
  "function products(uint256 id) view returns (uint256 id, address merchant, string name, string endpointPath, string metadataURI, uint256 pricePerCall, bool active, uint256 totalCalls, uint256 grossRevenue, uint64 createdAt, bool usdPriced, uint256 priceUsd)",
  "function refundCall(uint256 callId)",
  "function claimCall(uint256 callId)",
  "function calls(uint256 callId) view returns (uint256 id, uint256 productId, address agent, address principal, address merchant, address token, uint256 amount, uint256 escrowId, uint64 paidAt, bool refunded, bool claimed)",
  "function nextCallId() view returns (uint256)",
  "error TokenMismatch()", "error CallNotOpen()", "error StaleFeed()", "error NoFeed()",
  "error NotUsdPriced()", "error WrongAmount()", "error NotProductMerchant()",
];

/**
 * QIE's estimateGas returns the EXACT execution cost — zero headroom. Our
 * pay paths nest 2-3 contracts deep (PayEndpoint -> MandateVault/EscrowCore
 * -> CreditPassport), so the deepest subcall can hit the EIP-150 63/64 gas
 * wall on-chain even though it simulates fine. Sending with ~1.5x the
 * estimate + a flat buffer removes the whole class (gas is 7 wei/unit here —
 * headroom is free; a dead revert is not).
 */
async function withGasHeadroom(estimate: Promise<bigint>, fallbackGas: bigint): Promise<{ gasLimit: bigint }> {
  const est = await estimate.catch(() => fallbackGas);
  return { gasLimit: (est * 3n) / 2n + 100_000n };
}
const MANDATE_VAULT_ABI = [
  // exact MandateVault.Mandate order: id, principal, agent, token, perCallCap, dailyCap, spentToday, currentDay, balance, active, createdAt
  "function mandates(uint256 id) view returns (uint256 id, address principal, address agent, address token, uint256 perCallCap, uint256 dailyCap, uint256 spentToday, uint256 currentDay, uint256 balance, bool active, uint64 createdAt)",
  "function canSpend(uint256 mandateId, uint256 amount) view returns (bool ok, string reason)",
  "error NotAgent()", "error MandateInactive()", "error ExceedsPerCallCap()",
  "error ExceedsDailyCap()", "error InsufficientBalance()", "error NotPrincipal()",
];
const WQIE_ABI = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];

export type AgentPayClientOptions = {
  /** Agent's private key — the machine wallet that signs payForCall. */
  privateKey?: string;
  /** Or bring your own signer (browser wallet, AWS KMS wrapper, …). */
  signer?: ethers.Signer;
  network?: string;
  /** Override the network's default RPC list (first that answers wins). */
  rpcUrls?: string[];
  /** Override contract addresses (testnets / forks). */
  contracts?: Partial<NetworkConfig["contracts"]>;
};

export type BuyOptions = {
  mandateId: number;
  /** Product id on the PayEndpoint contract. Resolved from the terms when omitted. */
  productId?: number;
  /** Settlement token (defaults to the network WQIE). */
  token?: string;
  /** Friendly name the seller sees in its call ledger. */
  agentName?: string;
  /** Pay but do NOT call the seller (agent wants to inspect first). Default false. */
  payOnly?: boolean;
  /** Fetch timeout in ms. Default 15000. */
  timeoutMs?: number;
};

export class AgentPayClient {
  readonly network: NetworkConfig;
  readonly provider: ethers.JsonRpcProvider;
  readonly signer: ethers.Signer | null;
  readonly address: string | null;

  private readonly payEndpoint: ethers.Contract;
  private readonly mandateVault: ethers.Contract;

  constructor(opts: AgentPayClientOptions) {
    const key = opts.network || defaultNetwork;
    const base = NETWORKS[key];
    if (!base) throw new AgentPayError("RPC_ERROR", `unknown network '${key}' — expected one of ${Object.keys(NETWORKS).join(", ")}`);
    this.network = {
      ...base,
      contracts: { ...base.contracts, ...(opts.contracts || {}) },
    };
    const rpcs = opts.rpcUrls?.length ? opts.rpcUrls : base.rpcUrls;
    this.provider = new ethers.JsonRpcProvider(rpcs[0], base.chainId, { staticNetwork: true });
    this.signer = opts.signer ?? (opts.privateKey ? new ethers.Wallet(opts.privateKey, this.provider) : null);
    this.address = this.signer ? null : null; // resolved lazily (async)
    if (!this.network.contracts.PayEndpoint || !this.network.contracts.MandateVault) {
      throw new AgentPayError("RPC_ERROR", `network '${key}' has no deployed contracts yet`);
    }
    const signerOrProvider = (this.signer ?? this.provider) as ethers.Signer | ethers.Provider;
    this.payEndpoint = new ethers.Contract(this.network.contracts.PayEndpoint, PAY_ENDPOINT_ABI, signerOrProvider);
    this.mandateVault = new ethers.Contract(this.network.contracts.MandateVault, MANDATE_VAULT_ABI, signerOrProvider);
  }

  /** The agent's wallet address (async because signers resolve lazily). */
  async getAddress(): Promise<string> {
    if (!this.signer) throw new AgentPayError("RPC_ERROR", "client has no signer — pass privateKey or signer to pay on-chain");
    return await this.signer.getAddress();
  }

  // ------------------------------------------------------------------
  // DISCOVER
  // ------------------------------------------------------------------

  /** GET /v1/products — list the seller's purchasable products. */
  async discover(baseUrl: string, timeoutMs = 15_000): Promise<Catalog> {
    const j = (await this.http(`${baseUrl.replace(/\/$/, "")}/v1/products`, { timeoutMs })) as { products?: ProductInfo[] };
    return { baseUrl: baseUrl.replace(/\/$/, ""), products: j.products || [] };
  }

  /** GET /v1/product/:key — the 402 terms document (the contract of the sale). */
  async terms(baseUrl: string, productKey: string, timeoutMs = 15_000): Promise<Terms> {
    const url = `${baseUrl.replace(/\/$/, "")}/v1/product/${productKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 404) throw new AgentPayError("PRODUCT_NOT_FOUND", `no product '${productKey}' at ${baseUrl}`);
    if (res.status !== 402 || !body?.x402) {
      throw new AgentPayError("HTTP_ERROR", `expected 402 terms from ${url}, got ${res.status}`);
    }
    return { baseUrl: baseUrl.replace(/\/$/, ""), productKey, ...body.x402 } as Terms;
  }

  // ------------------------------------------------------------------
  // PAY (on-chain machine rail)
  // ------------------------------------------------------------------

  /** On-chain quote for one call of a PayEndpoint product. */
  async quote(productId: number, token?: string): Promise<Quote> {
    const t = token || this.network.contracts.WQIE!;
    try {
      const amountWei: bigint = await this.payEndpoint.quoteIn(productId, t);
      const dec = await new ethers.Contract(t, WQIE_ABI, this.provider).decimals();
      return {
        productId,
        token: t,
        amountWei,
        formatted: `${ethers.formatUnits(amountWei, dec)} (token ${t})`,
        usdPriced: true,
      };
    } catch (e) {
      throw toAgentPayError(e, `quote(${productId})`);
    }
  }

  /** Pre-flight a spend against the mandate's caps WITHOUT sending a tx. */
  async canSpend(mandateId: number, amountWei: bigint): Promise<{ ok: boolean; reason: string }> {
    try {
      const [ok, reason] = await this.mandateVault.canSpend(mandateId, amountWei);
      return { ok: Boolean(ok), reason: String(reason) };
    } catch (e) {
      throw toAgentPayError(e, `canSpend(${mandateId})`);
    }
  }

  /**
   * THE machine purchase: pay one call of an on-chain product from the
   * agent's mandate. Caps/balance are checked twice — pre-flight (typed
   * error, no gas burned) and on-chain (authoritative revert).
   */
  async payForCall(mandateId: number, productId: number, token?: string): Promise<CallReceipt> {
    if (!this.signer) throw new AgentPayError("RPC_ERROR", "payForCall needs a signer (privateKey or signer option)");
    const t = token || this.network.contracts.WQIE!;
    const q = await this.quote(productId, t);
    const pre = await this.canSpend(mandateId, q.amountWei);
    if (!pre.ok) {
      throw new AgentPayError(
        pre.reason === "PER_CALL_CAP" ? "PER_CALL_CAP"
        : pre.reason === "DAILY_CAP" ? "DAILY_CAP"
        : pre.reason === "BALANCE" ? "MANDATE_BALANCE"
        : "MANDATE_INACTIVE",
        `mandate ${mandateId} cannot spend ${q.formatted}: ${pre.reason}`,
        { mandateId, amountWei: q.amountWei.toString(), reason: pre.reason }
      );
    }
    let tx: ethers.ContractTransactionResponse;
    try {
      const overrides = await withGasHeadroom(
        (this.payEndpoint.connect(this.signer) as ethers.Contract).payForCall.estimateGas(mandateId, productId, t),
        600_000n
      );
      tx = await (this.payEndpoint.connect(this.signer) as ethers.Contract).payForCall(mandateId, productId, t, overrides);
    } catch (e) {
      throw toAgentPayError(e, `payForCall(mandate=${mandateId}, product=${productId})`);
    }
    // A tx that CONFIRMED as reverted (receipt status 0) provably did not
    // move money — retrying is safe, unlike a timed-out tx whose fate is
    // unknown. New chains (QIE testnet included) occasionally execute a tx
    // against a briefly stale replica; one retry clears that class.
    let rec: ethers.ContractTransactionReceipt | null = await tx.wait().catch(() => null);
    for (let attempt = 0; rec && rec.status !== 1 && attempt < 3; attempt++) {
      // Let the chain settle (~1 block): QIE's load-balanced RPC replicas can
      // execute a rapid follow-up tx against a briefly stale view, which
      // reverts. Waiting one block before the safe retry clears it.
      await new Promise((r) => setTimeout(r, 2500));
      const pre = await this.canSpend(mandateId, q.amountWei);
      if (!pre.ok) {
        throw new AgentPayError(
          pre.reason === "PER_CALL_CAP" ? "PER_CALL_CAP"
          : pre.reason === "DAILY_CAP" ? "DAILY_CAP"
          : pre.reason === "BALANCE" ? "MANDATE_BALANCE"
          : "MANDATE_INACTIVE",
          `mandate ${mandateId} cannot spend ${q.formatted}: ${pre.reason}`,
          { mandateId, amountWei: q.amountWei.toString(), reason: pre.reason }
        );
      }
      tx = await (this.payEndpoint.connect(this.signer) as ethers.Contract).payForCall(mandateId, productId, t, await withGasHeadroom((this.payEndpoint.connect(this.signer) as ethers.Contract).payForCall.estimateGas(mandateId, productId, t).catch(() => Promise.resolve(600_000n)), 600_000n));
      rec = await tx.wait().catch(() => null);
    }
    if (!rec || rec.status !== 1) {
      throw new AgentPayError("TX_FAILED", `payForCall tx reverted (${tx.hash})`, { txHash: tx.hash });
    }
    const calls = decodeCallPaid(rec.logs);
    const mine = calls.find((c) => c.callId !== undefined) || calls[calls.length - 1];
    if (!mine) throw new AgentPayError("TX_FAILED", `no CallPaid log in ${tx.hash}`);
    return {
      callId: BigInt(mine.callId),
      productId: BigInt(mine.productId),
      agent: mine.agent,
      principal: mine.principal,
      amountWei: BigInt(mine.amountWei),
      escrowId: BigInt(mine.escrowId),
      txHash: rec.hash,
      blockNumber: rec.blockNumber,
      explorerUrl: `${this.network.explorer}/tx/${rec.hash}`,
    };
  }

  // ------------------------------------------------------------------
  // CALL THE SELLER (HTTP leg of x402)
  // ------------------------------------------------------------------

  /**
   * POST /v1/product/:key/purchase with X-PAYMENT = the payForCall tx hash.
   * The seller verifies the receipt on-chain (receipt status, CallPaid log,
   * matching productId) before serving the payload — trustless for both sides.
   */
  async purchase(
    baseUrl: string,
    productKey: string,
    payment: string,
    opts: { agentName?: string; timeoutMs?: number } = {}
  ): Promise<PurchaseResult> {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/product/${productKey}/purchase`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-payment": payment,
        "x-agent-name": opts.agentName || "agentpay-sdk",
        "x-agent-wallet": (await this.getAddress().catch(() => "")) || "",
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw httpErrorToAgentPayError(res.status, j, `purchase(${productKey})`);
    return j as PurchaseResult;
  }

  /**
   * One-liner agents actually write: terms -> quote -> cap pre-flight ->
   * payForCall -> purchase -> payload. When `payOnly` is set the agent pays
   * and returns the receipt without calling the seller (async flows).
   */
  async buyAndCall(baseUrl: string, productKey: string, opts: BuyOptions): Promise<PurchaseResult & { receipt?: CallReceipt }> {
    const t = await this.terms(baseUrl, productKey, opts.timeoutMs);
    const productId = opts.productId ?? (await this.resolveProductId(t));
    const q = await this.quote(productId, opts.token);
    const receipt = await this.payForCall(opts.mandateId, productId, opts.token);
    if (opts.payOnly) {
      return { ok: true, callId: receipt.callId.toString(), escrowRef: `escrow#${receipt.escrowId}`, refundWindowSeconds: Number(t.refundWindowSeconds || 0), refundUntil: "", settlementMode: "live", paid: q.formatted, data: null, onChain: receipt };
    }
    const res = await this.purchase(baseUrl, productKey, receipt.txHash, { agentName: opts.agentName, timeoutMs: opts.timeoutMs });
    return { ...res, onChain: receipt };
  }

  /**
   * Demo-mode payment: a signed intent header (no on-chain tx). Used when
   * the seller runs with CHAIN_MODE != live. The signature binds the agent's
   * wallet to the exact terms — sellers can verify it offline.
   */
  async signDemoIntent(terms: Terms): Promise<string> {
    if (!this.signer) throw new AgentPayError("RPC_ERROR", "signDemoIntent needs a signer");
    const addr = await this.getAddress();
    const msg = [
      "AgentPay demo payment intent",
      `product: ${terms.productKey}`,
      `maxAmount: ${terms.maxAmountRequired}`,
      `network: ${terms.network}`,
      `agent: ${addr}`,
      `refundWindow: ${terms.refundWindowSeconds}s`,
    ].join("\n");
    const sig = await this.signer.signMessage(msg);
    return `demo:${Buffer.from(msg).toString("base64")}:${sig}`;
  }

  // ------------------------------------------------------------------
  // P4 — REAL-WORLD GOODS: buy + redeem a ticket
  // ------------------------------------------------------------------

  /**
   * One-liner for real-world goods: buyAndCall + pull the typed ticket out
   * of the payload. The returned `ticket.secret` IS the ticket — the agent
   * presents it at the gate; the venue redeems it single-use.
   */
  async buyTicket(baseUrl: string, productKey: string, opts: BuyOptions): Promise<TicketPurchase> {
    const res = await this.buyAndCall(baseUrl, productKey, opts);
    const data = res.data as { ticket?: TicketPayload } | null;
    if (!data?.ticket?.ticketId || !data.ticket.secret) {
      throw new AgentPayError("HTTP_ERROR", `seller did not mint a ticket for '${productKey}' (kind != ticket?)`, { data: res.data ?? null });
    }
    return { ...res, ticket: data.ticket };
  }

  /**
   * THE gate leg: present the ticket secret at the venue. Single-use — a
   * replayed secret is rejected (TICKET_ALREADY_REDEEMED); a forged one is
   * rejected (TICKET_INVALID_SECRET); a refunded escrow voids the ticket
   * (TICKET_VOID). Success returns a signed-style redemption proof bound to
   * the on-chain callId.
   */
  async redeemTicket(
    baseUrl: string,
    ticketId: string,
    secret: string,
    opts: { timeoutMs?: number } = {}
  ): Promise<RedemptionProof> {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/ticket/${ticketId}/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw httpErrorToAgentPayError(res.status, j, `redeemTicket(${ticketId})`);
    return j as RedemptionProof;
  }

  /**
   * Ticket state WITHOUT the secret — venues, auditors or the agent itself
   * can check VALID / REDEEMED / VOID at any time.
   */
  async ticketStatus(baseUrl: string, ticketId: string, opts: { timeoutMs?: number } = {}): Promise<TicketStatusResult> {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/ticket/${ticketId}`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw httpErrorToAgentPayError(res.status, j, `ticketStatus(${ticketId})`);
    return (j as { ticket: TicketStatusResult }).ticket;
  }

  // ------------------------------------------------------------------
  // VERIFY
  // ------------------------------------------------------------------

  /** Verify ANY transaction against the PayEndpoint: status + CallPaid decode. */
  async verify(txHash: string, expectedProductId?: number): Promise<VerifyResult> {
    const out: VerifyResult = { ok: false, txHash };
    try {
      const receipt = await this.provider.getTransactionReceipt(txHash);
      if (!receipt) return { ...out, reason: "receipt not found (unmined?)" };
      if (receipt.status !== 1) return { ...out, reason: "tx reverted on-chain" };
      const calls = decodeCallPaid(receipt.logs);
      const relevant = expectedProductId != null
        ? calls.filter((c) => Number(c.productId) === expectedProductId)
        : calls;
      if (relevant.length === 0) return { ...out, status: 1, blockNumber: receipt.blockNumber, reason: `no CallPaid log${expectedProductId != null ? ` for product ${expectedProductId}` : ""} from PayEndpoint` };
      return { ok: true, txHash, status: 1, blockNumber: receipt.blockNumber, calls: relevant.map((c) => ({ ...c, callId: String(c.callId), productId: String(c.productId), amountWei: String(c.amountWei), escrowId: String(c.escrowId) })) };
    } catch (e) {
      return { ...out, reason: toAgentPayError(e, "verify").message };
    }
  }

  // ------------------------------------------------------------------
  // REFUND (dispute within the window) + MERCHANT CLAIM
  // ------------------------------------------------------------------

  /**
   * Refund a call within the window (payer right — the human principal, or
   * the agent itself: EscrowCore allows payer OR agent OR relayer). Funds go
   * back to the principal; the merchant's dashboard records the dispute.
   *
   * Safe retry: a confirmed-but-reverted tx provably moved no money (the
   * escrow stays Open), and refundCall is idempotent (re-refund reverts
   * NOT_OPEN) — so a stale-replica revert can be retried blindly, exactly
   * like payForCall.
   */
  async refund(callId: bigint): Promise<{ txHash: string; explorerUrl: string }> {
    if (!this.signer) throw new AgentPayError("RPC_ERROR", "refund needs a signer");
    try {
      let tx: ethers.ContractTransactionResponse = await (this.payEndpoint.connect(this.signer) as ethers.Contract).refundCall(callId, await withGasHeadroom((this.payEndpoint.connect(this.signer) as ethers.Contract).refundCall.estimateGas(callId).catch(() => Promise.resolve(300_000n)), 300_000n));
      let rec: ethers.ContractTransactionReceipt | null = await tx.wait().catch(() => null);
      for (let attempt = 0; (!rec || rec.status !== 1) && attempt < 3; attempt++) {
        // QIE load-balanced replicas can execute a rapid follow-up against a
        // stale view and revert empty. One block + safe resend clears it.
        await new Promise((r) => setTimeout(r, 2500));
        tx = await (this.payEndpoint.connect(this.signer) as ethers.Contract).refundCall(callId, await withGasHeadroom((this.payEndpoint.connect(this.signer) as ethers.Contract).refundCall.estimateGas(callId).catch(() => Promise.resolve(300_000n)), 300_000n));
        rec = await tx.wait().catch(() => null);
      }
      if (!rec || rec.status !== 1) {
        throw new AgentPayError("TX_FAILED", `refundCall tx reverted (${tx.hash})`, { txHash: tx.hash });
      }
      return { txHash: rec.hash, explorerUrl: `${this.network.explorer}/tx/${rec.hash}` };
    } catch (e) {
      throw toAgentPayError(e, `refund(callId=${callId})`);
    }
  }

  /** Merchant claims settlement after the window (permissionless keeper variant: settleExpired). Safe-retry like refund(). */
  async claim(callId: bigint): Promise<{ txHash: string; explorerUrl: string }> {
    if (!this.signer) throw new AgentPayError("RPC_ERROR", "claim needs a signer");
    try {
      let tx: ethers.ContractTransactionResponse = await (this.payEndpoint.connect(this.signer) as ethers.Contract).claimCall(callId, await withGasHeadroom((this.payEndpoint.connect(this.signer) as ethers.Contract).claimCall.estimateGas(callId).catch(() => Promise.resolve(300_000n)), 300_000n));
      let rec: ethers.ContractTransactionReceipt | null = await tx.wait().catch(() => null);
      for (let attempt = 0; (!rec || rec.status !== 1) && attempt < 3; attempt++) {
        await new Promise((r) => setTimeout(r, 2500));
        tx = await (this.payEndpoint.connect(this.signer) as ethers.Contract).claimCall(callId, await withGasHeadroom((this.payEndpoint.connect(this.signer) as ethers.Contract).claimCall.estimateGas(callId).catch(() => Promise.resolve(300_000n)), 300_000n));
        rec = await tx.wait().catch(() => null);
      }
      if (!rec || rec.status !== 1) {
        throw new AgentPayError("TX_FAILED", `claimCall tx reverted (${tx.hash})`, { txHash: tx.hash });
      }
      return { txHash: rec.hash, explorerUrl: `${this.network.explorer}/tx/${rec.hash}` };
    } catch (e) {
      throw toAgentPayError(e, `claim(callId=${callId})`);
    }
  }

  // ------------------------------------------------------------------
  // MANDATE INTROSPECTION — the "why let an AI spend money" controls
  // ------------------------------------------------------------------

  /** Full mandate state + canSpend verdict for one more call of `productId`. */
  async mandateSnapshot(mandateId: number, productId?: number): Promise<MandateSnapshot> {
    const m = await this.mandateVault.mandates(mandateId);
    let nextCall = { ok: false, reason: "NO_PRODUCT" };
    if (productId != null) {
      const q = await this.quote(productId).catch(() => null);
      if (q) nextCall = await this.canSpend(mandateId, q.amountWei);
    }
    return {
      mandateId,
      agent: m.agent,
      principal: m.principal,
      token: m.token,
      balanceWei: m.balance.toString(),
      perCallCapWei: m.perCallCap.toString(),
      dailyCapWei: m.dailyCap.toString(),
      spentTodayWei: m.spentToday.toString(),
      expiry: Number(m.createdAt),
      active: Boolean(m.active),
      nextCall,
    };
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  /** Map a terms document to the seller's on-chain productId (best effort). */
  private async resolveProductId(terms: Terms): Promise<number> {
    if (terms.payEndpointContract) {
      // seller publishes its mapping in the terms when it knows it
      const id = Number((terms as { onChainProductId?: number }).onChainProductId || 0);
      if (id > 0) return id;
    }
    // default: product 1 (single-product sellers) — override with BuyOptions.productId
    return 1;
  }

  private async http(url: string, init: RequestInit & { timeoutMs?: number }): Promise<unknown> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 15_000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new AgentPayError(res.status === 404 ? "PRODUCT_NOT_FOUND" : "HTTP_ERROR", `${url} -> ${res.status}`, j);
    return j;
  }
}

/** Decode every CallPaid log in a receipt into plain objects. */
export function decodeCallPaid(logs: readonly ethers.Log[]): Array<{
  callId: string; productId: string; agent: string; principal: string; amountWei: string; escrowId: string;
}> {
  const out: Array<{ callId: string; productId: string; agent: string; principal: string; amountWei: string; escrowId: string }> = [];
  for (const log of logs) {
    if (log.topics[0] !== CALLPAID_TOPIC || log.topics.length < 4) continue;
    const data = log.data.slice(2).match(/.{64}/g) || [];
    out.push({
      callId: BigInt(log.topics[1]).toString(),
      productId: BigInt(log.topics[2]).toString(),
      agent: "0x" + log.topics[3].slice(26),
      principal: "0x" + (data[0] || "0").slice(-40),
      amountWei: BigInt("0x" + (data[1] || "0")).toString(),
      escrowId: BigInt("0x" + (data[2] || "0")).toString(),
    });
  }
  return out;
}
