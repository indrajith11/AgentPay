// Shared types + helpers for the AgentPay dashboard
export type Merchant = {
  id: string;
  name: string;
  owner: string;
  phone: string | null;
  category: string;
  currency: string;
  qiePassId: string | null;
  qiePassStatus?: string | null;
  qiePassRequestId?: string | null;
  qiePassVerifiedAt?: string | null;
  chainAddr: string | null;
};

export type Invoice = {
  id: string;
  customerName: string;
  amountCents: number;
  paidCents: number;
  currency: string;
  status: "SENT" | "PARTIAL" | "PAID" | "OVERDUE";
  dueDate: string;
  paidAt: string | null;
};

export type Subscription = {
  id: string;
  customerName: string;
  planName: string;
  amountCents: number;
  interval: "WEEKLY" | "MONTHLY";
  status: "ACTIVE" | "CANCELLED" | "LAPSED";
  nextChargeAt: string;
  chargesCount: number;
};

export type EndpointCallRec = {
  id: string;
  agentName: string;
  agentWallet: string | null;
  amountCents: number;
  status: string;
  escrowRef: string | null;
  createdAt: string;
};

export type MachineEndpoint = {
  id: string;
  productKey: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  callsCount: number;
  revenueCents: number;
  calls: EndpointCallRec[];
};

export type AgentEvent = {
  id: string;
  kind: "RECONCILIATION" | "COLLECTION" | "TREASURY" | "MACHINE_SALE" | "CREDIT";
  title: string;
  detail: string;
  amountCents: number | null;
  createdAt: string;
};

export type LedgerEntry = {
  id: string;
  date: string;
  kind: "SALE" | "FEE" | "PAYOUT" | "TREASURY";
  label: string;
  amountCents: number;
};

export type CreditPassportRec = {
  score: number;
  onTimeCount: number;
  volumeCents: number;
  defaults: number;
  subjectName: string;
} | null;

export type Overview = {
  merchant: Merchant;
  kpis: {
    todaySalesCents: number;
    mrrCents: number;
    pendingCents: number;
    overdueCount: number;
    machineRevenueCents: number;
    endpointCalls: number;
    creditScore: number | null;
  };
  invoices: Invoice[];
  subscriptions: Subscription[];
  endpoints: MachineEndpoint[];
  events: AgentEvent[];
  ledger: LedgerEntry[];
  passport: CreditPassportRec;
};

export function fmtMoney(cents: number, currency: string): string {
  const symbols: Record<string, string> = { ZAR: "R", INR: "₹", USD: "$", EUR: "€" };
  const sym = symbols[currency] || `${currency} `;
  const abs = Math.abs(cents) / 100;
  return `${cents < 0 ? "−" : ""}${sym}${abs.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const AGENT_META: Record<string, { label: string; icon: string; color: string }> = {
  RECONCILIATION: { label: "Reconciliation", icon: "📘", color: "bg-emerald-100 text-emerald-900" },
  COLLECTION: { label: "Collections", icon: "📣", color: "bg-amber-100 text-amber-900" },
  TREASURY: { label: "Treasury", icon: "🏦", color: "bg-teal-100 text-teal-900" },
  MACHINE_SALE: { label: "Machine sale", icon: "🤖", color: "bg-lime-100 text-lime-900" },
  CREDIT: { label: "Credit passport", icon: "🪪", color: "bg-green-100 text-green-900" },
};
