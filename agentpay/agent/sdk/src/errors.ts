/**
 * @agentpay/sdk — typed errors.
 *
 * Every failure an agent can hit is surfaced as an AgentPayError with a
 * stable `code`, so agent code can branch on `e.code` instead of parsing
 * strings. Revert reasons from the deployed contracts are mapped 1:1.
 */

export type AgentPayErrorCode =
  // seller / HTTP leg
  | "PAYMENT_REQUIRED" // 402 — expected first contact, carries the terms
  | "INVALID_PAYMENT" // 402 — payment failed seller verification
  | "PRODUCT_NOT_FOUND" // 404
  | "CALL_NOT_FOUND" // 404 on call endpoints
  | "ALREADY_SETTLED" // 409 — call already refunded/claimed
  | "REFUND_WINDOW_CLOSED" // 403 — dispute window elapsed
  | "HTTP_ERROR" // any other non-2xx
  // on-chain rail (contract custom errors)
  | "AGENT_NOT_ELIGIBLE" // AgentRegistry: not registered/active/bound
  | "NOT_MANDATE_AGENT" // mandate belongs to another agent
  | "MANDATE_INACTIVE" // mandate closed or expired
  | "PER_CALL_CAP" // amount > mandate perCallCap
  | "DAILY_CAP" // spentToday + amount > mandate dailyCap
  | "MANDATE_BALANCE" // mandate prepaid balance too low
  | "TOKEN_MISMATCH" // mandate asset != requested token
  | "CALL_NOT_OPEN" // product inactive on PayEndpoint
  | "STALE_FEED" // oracle feed stale or missing
  | "NOT_PAYER" // refund attempted by a non-payer wallet
  | "WINDOW_CLOSED" // escrow refund window elapsed (on-chain)
  | "WINDOW_STILL_OPEN" // claim attempted before window end
  | "NOT_OPEN" // escrow already refunded/released
  | "NOT_PAYEE" // claim attempted by non-payee
  | "WRONG_AMOUNT" // msg.value != quote on payable paths
  // transport
  | "RPC_ERROR"
  | "TIMEOUT"
  | "TX_FAILED";

export class AgentPayError extends Error {
  readonly code: AgentPayErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: AgentPayErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AgentPayError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/** Revert string (require) or custom-error name -> typed code. */
const REVERT_MAP: Array<[RegExp, AgentPayErrorCode]> = [
  [/AGENT_NOT_ELIGIBLE/i, "AGENT_NOT_ELIGIBLE"],
  [/NOT_MANDATE_AGENT|NotAgent/i, "NOT_MANDATE_AGENT"],
  [/MandateInactive/i, "MANDATE_INACTIVE"],
  [/ExceedsPerCallCap|PER_CALL_CAP/i, "PER_CALL_CAP"],
  [/ExceedsDailyCap|DAILY_CAP/i, "DAILY_CAP"],
  [/InsufficientBalance|MANDATE_BALANCE/i, "MANDATE_BALANCE"],
  [/TokenMismatch/i, "TOKEN_MISMATCH"],
  [/CallNotOpen/i, "CALL_NOT_OPEN"],
  [/StaleFeed|NoFeed/i, "STALE_FEED"],
  [/NotUsdPriced/i, "STALE_FEED"],
  [/WindowClosed/i, "WINDOW_CLOSED"],
  [/WindowStillOpen/i, "WINDOW_STILL_OPEN"],
  [/NotOpen/i, "NOT_OPEN"],
  [/NotPayee/i, "NOT_PAYEE"],
  [/NotPayer/i, "NOT_PAYER"],
  [/WrongAmount/i, "WRONG_AMOUNT"],
];

/**
 * Best-effort mapping of any thrown value (ethers CallExceptionError with
 * custom-error data, a require string, or an HTTP body) into a typed
 * AgentPayError. Unknown shapes fall back to RPC_ERROR — never a raw string.
 */
export function toAgentPayError(e: unknown, context?: string): AgentPayError {
  if (e instanceof AgentPayError) return e;
  const raw = (() => {
    if (e instanceof Error) return e.message;
    return String(e);
  })();
  // ethers v6 attaches the decoded revert on .revert / shortMessage / data
  const decoded =
    (e as { revert?: { name?: string } })?.revert?.name ||
    (e as { shortMessage?: string })?.shortMessage ||
    raw;
  for (const [re, code] of REVERT_MAP) {
    if (re.test(decoded)) {
      return new AgentPayError(code, `${context ? context + ": " : ""}${decoded}`, { raw });
    }
  }
  return new AgentPayError("RPC_ERROR", `${context ? context + ": " : ""}${raw}`, { raw });
}
