/**
 * @agentpay/sdk — the typed client for AI agents on QIE.
 *
 *   import { AgentPayClient } from "@agentpay/sdk";
 *
 * X-05 in the AgentPay master plan: discover → pay → verify → refund,
 * with mandate caps enforced on-chain and a refund window for the human
 * principal. See README.md for the 10-minute integration guide.
 */
export { AgentPayClient, decodeCallPaid } from "./client.js";
export type { AgentPayClientOptions, BuyOptions } from "./client.js";
export { NETWORKS, defaultNetwork } from "./chains.js";
export { AgentPayError, toAgentPayError, httpErrorToAgentPayError } from "./errors.js";
export type { AgentPayErrorCode } from "./errors.js";
export type {
  Catalog, ProductInfo, Terms, Quote, CallReceipt, PurchaseResult,
  VerifyResult, MandateSnapshot, NetworkConfig,
  TicketEvent, TicketPayload, RedemptionProof, TicketStatusResult, TicketPurchase,
} from "./types.js";
