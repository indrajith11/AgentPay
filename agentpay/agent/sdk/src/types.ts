/**
 * @agentpay/sdk — shared types.
 *
 * Every type an agent developer needs to integrate a paid API call:
 * discovery -> 402 terms -> on-chain payment -> receipt -> refund window.
 */

/** A purchasable API product advertised by a seller. */
export type ProductInfo = {
  key: string;
  /** On-chain PayEndpoint productId this product maps to (live settlement). */
  onChainProductId?: number;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  merchantId: string;
  /** JSON-ish schema of the payload the buyer receives. */
  schema: string;
  /** P4: "data" payloads vs "ticket" real-world goods. */
  kind?: "data" | "ticket";
  /** P4: ticket products show remaining supply (scarcity is public). */
  inventoryLeft?: number | null;
  /** P4: event metadata for ticket products. */
  event?: TicketEvent;
};

/** P4: the real-world event a ticket admits to. */
export type TicketEvent = {
  name: string;
  venue: string;
  startsAt: string;
  gate: string;
};

/** GET /v1/products — the seller's full catalog. */
export type Catalog = {
  baseUrl: string;
  products: ProductInfo[];
};

/** The 402 "Payment Required" terms document — the contract of the sale. */
export type Terms = {
  baseUrl: string;
  productKey: string;
  x402Version: number;
  scheme: string;
  network: string;
  /** Address that receives the payment (or its on-chain route). */
  payTo: string;
  asset: string;
  maxAmountRequired: string;
  refundWindowSeconds: number;
  escrowContract: string | null;
  payEndpointContract: string | null;
  description: string;
  responseSchema: string;
  howToPay: string;
  /** P4: ticket products carry scarcity + redemption info in the terms. */
  kind?: "data" | "ticket";
  inventoryLeft?: number | null;
  event?: TicketEvent;
  redeem?: string;
};

/** Quote for one call, fetched on-chain (no trust in the seller's math). */
export type Quote = {
  productId: number;
  token: string;
  amountWei: bigint;
  formatted: string;
  usdPriced: boolean;
};

/** Receipt of a settled on-chain payForCall. */
export type CallReceipt = {
  callId: bigint;
  productId: bigint;
  agent: string;
  principal: string;
  amountWei: bigint;
  escrowId: bigint;
  txHash: string;
  blockNumber: number;
  explorerUrl: string;
};

/** Result of POST /purchase — the paid payload plus settlement metadata. */
export type PurchaseResult = {
  ok: true;
  callId: string;
  escrowRef: string;
  refundWindowSeconds: number;
  refundUntil: string;
  settlementMode: string;
  paid: string;
  data: unknown;
  onChain?: CallReceipt | null;
  /** P4: present on ticket products. */
  kind?: "data" | "ticket";
  inventoryLeft?: number | null;
};

/** P4: the minted, redeemable good inside a ticket purchase payload. */
export type TicketPayload = {
  ticketId: string;
  /** One-time redeem proof (HMAC) — the buyer's possession of this IS the ticket. */
  secret: string;
  event?: TicketEvent;
  escrowRef?: string;
  redeemHow?: string;
  note?: string;
};

/** P4: the gate's response to a successful redemption. */
export type RedemptionProof = {
  ok: true;
  admission: "GRANTED";
  ticketId: string;
  event?: TicketEvent;
  gate: string;
  redeemedAt: string;
  boundCall: string;
  onChainCallId: string | null;
  escrowRef: string;
};

/** P4: ticket state without exposing the secret (venue/agent check). */
export type TicketStatusResult = {
  ticketId: string;
  productKey: string;
  callId: string;
  status: "VALID" | "REDEEMED" | "VOID";
  event?: TicketEvent;
  escrowRef: string;
  issuedAt: string;
  redeemedAt: string | null;
};

/** P4: buyTicket() result — purchase receipt + the typed ticket. */
export type TicketPurchase = PurchaseResult & {
  ticket: TicketPayload;
};

/** Client-side verification of any PayEndpoint transaction. */
export type VerifyResult = {
  ok: boolean;
  txHash: string;
  status?: number;
  blockNumber?: number;
  calls?: Array<{
    callId: string;
    productId: string;
    agent: string;
    principal: string;
    amountWei: string;
    escrowId: string;
  }>;
  reason?: string;
};

/** Full state of a spending mandate (the "why let an AI spend" controls). */
export type MandateSnapshot = {
  mandateId: number;
  agent: string;
  principal: string;
  token: string;
  balanceWei: string;
  perCallCapWei: string;
  dailyCapWei: string;
  spentTodayWei: string;
  expiry: number;
  active: boolean;
  /** canSpend() verdict for one more call at the current product quote. */
  nextCall: { ok: boolean; reason: string };
};

/** Network configuration the SDK ships with. */
export type NetworkConfig = {
  name: string;
  chainId: number;
  rpcUrls: string[];
  explorer: string;
  contracts: {
    WQIE?: string;
    PayEndpoint?: string;
    EscrowCore?: string;
    MandateVault?: string;
    AgentRegistry?: string;
    MerchantRegistry?: string;
    InvoiceVault?: string;
    RecurringMandate?: string;
    SettlementRouter?: string;
  };
};
