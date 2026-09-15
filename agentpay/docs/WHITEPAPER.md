# AgentPay × MerchantPilot — Whitepaper
**The Merchant Operating System on QIE | QIE Hackathon 3.0 (Mainnet Edition) · Track 04: Commerce & Real World**

---

## 1. Thesis

Blockchain commerce has a **merchant problem**, not a payments problem.

- Consumers can already pay: QIE Wallet does scan-to-pay at **30,000+ South African merchants**.
- Payment infrastructure exists: Hackathon 2's winner (Qantara) built invoices, escrow, streaming, subscriptions and SDKs on QIE.
- Yet **only 4–6% of merchants accept stablecoins directly** (Flagship Advisory / Aetherum, 2026) against ~75% stated intent (Deloitte). The gap is not rails. It is everything AROUND the rails: books, late payers, cash-out, fraud exposure, credit history, and — the 2026 frontier — **AI-agent customers**.

AgentPay closes that gap with one platform where **humans pay by QR** and **AI agents pay by HTTP**, with **AI staff** running the merchant's money back office, and every payment building a **portable on-chain credit passport**.

## 2. The problem census behind it (research, not guesswork)

251 sourced real-world problems (2024–2026) across South Africa, India, LATAM, SE Asia and global B2B were factored into 8 common failure patterns:

| Factor | Problems | How AgentPay uses it |
|---|---|---|
| F7 Endpoint Vacuum | 117 | Every merchant gets QR + machine-payable endpoints |
| F2 Fee-Stack Tax | 62 | 0.3% flat (vs BitPay 1–2%, CoinGate 1%) |
| F5 Cash Trap | 58 | QR stablecoin acceptance, instant settlement |
| F4 Trust & Fraud Deficit | 41 | Refund-window escrow + spend mandates |
| F3 Back-Office Burden | 29 | Reconciliation agent books every sale automatically |
| F6 Credit Invisibility | 20 | CreditPassport: payment history → lending tiers |
| F1 Settlement Gap | 18 | QIE 1–2s finality; fiat-out T+0 |
| F8 Onboarding Cliff | 12 | No seed phrases; WhatsApp daily report |

Design rules extracted from a startup graveyard audit: **fiat-out by default, zero new habits, the boring ledger is the retention loop.**

### 2.1 The off-ramp answer (real-world settlement, added Sep 2026)
Crypto → bank account is a regulated third-party step. The merchant saves their bank beneficiary ONCE at a licensed off-ramp (VALR/Luno FSCA in SA; Transak/Onramper global), stores the provider deposit address + a hash reference on-chain in a `PayoutProfile`, and earnings auto-sweep there whenever threshold + interval pass — **permissionless**: keepers/agents can trigger it, the merchant pays no gas and never opens the app. Bank details never touch the chain. QIE liquidity (~$70K/day) means value is USD-denominated via the official QIE Oracle and never forced to stay in QIE.

## 3. Architecture

### 3.1 On-chain (9 contracts, Solidity 0.8.24, 11/11 tests passing)

| Contract | Role |
|---|---|
| `MerchantRegistry` | Merchant onboarding, verification, QIE Pass link |
| `AgentRegistry` | Know-Your-Agent: agent ↔ human principal binding |
| `MandateVault` | Pre-funded agent spend mandates: per-call cap, daily cap, prepaid balance, principal-authorized relayers |
| `EscrowCore` | Refund-window escrow (payer refunds in-window, payee/settler claims after) |
| `PayEndpoint` | Machine-payable products: **USD-priced via official QIE Oracle (AggregatorV3)**, agent purchases via mandates, escrow settlement, platform fee |
| `SettlementRouter` | Merchant earnings ledger, fee accounting, withdrawals, **payout automation: saved bank off-ramp profile + permissionless auto-withdraw (threshold + interval)** |
| `InvoiceVault` | On-chain invoices: partial pays, permissionless overdue marks |
| `RecurringMandate` | Prepaid subscriptions, permissionless due-charges, auto-lapse |
| `CreditPassport` | 300–850 score from real payments: on-time +8, defaults −120, volume bonus, lending tiers |

### 3.2 Off-chain

- **x402-style endpoint service** (`mini-services/agentpay-endpoint`): real HTTP flow — `GET /v1/product/:key` → **402 Payment Required** with terms (scheme `qie.mandate-v1`, refund window, price, response schema) → `POST …/purchase` with `X-PAYMENT` → **200** + escrowed receipt + payload. Plus `/refund` (the feature x402 lacks) and `/v1/calls` merchant feed.
- **Agent daemon** (`agentpay/agent`): Reconciliation (event indexing → ledger + webhook), Collections (overdue scan → `markOverdue()` + reminders), Treasury (threshold sweep → withdrawal, dry-run by default).
- **Merchant dashboard** (Next.js PWA): live KPIs, QR acceptance, invoices, subscriptions, machine paywall with **live agent-purchase trace**, credit passport, chain/deploy status.

## 4. Why we win (mapped to the official rubric)

| Criterion | Weight | Our answer |
|---|---|---|
| Innovation | 30% | Merchant-grade agentic commerce (x402 fixed: identity, mandates, refunds, credit) — nobody on QIE has it |
| Technical | 25% | 9 original contracts + agent runtime + HTTP protocol; 11/11 tests; cap/escrow security model |
| UX | 15% | Live 10-second agent purchase trace; WhatsApp-style reports; zero-habit QR flow |
| Mainnet Integration | 15% | Wallet + QUSDC + Pass + DEX + Oracle; bonus-multiplier coverage |
| Business Potential | 15% | 0.3% fees, per-call revenue, credit/lending upside; traction engineered in |
| Real-World Applicability (T&C 25%) | — | Real shops transacting during the event; 251-problem evidence base |

**Differentiation vs Hackathon 2 winners:** Qantara built rails for developers; we build the merchant's operations and the machine-customer channel ON rails. Fluenci's agents watch streams for fraud; our agents are the merchant's employees. SpendGrid gates treasuries; our MandateVault gates machine spend per-purchase with refundable escrow.

## 5. Traction plan (3 of 6 payout milestones)

| Milestone | Path |
|---|---|
| Wallet growth | Merchant wallets + agent-dev wallets via SDK |
| Transaction volume | Per-call micro-purchases compound fast |
| Recurring users | Daily ledger reports = daily active merchants |
| Merchants | 10–30 physical/API merchants during build window |
| Active monthly usage | Agents run 24/7; devs run agents |
| Revenue | 0.3% + per-call fees from day one |

Special awards: **Most Traction ($2,500)** and **Community Choice ($1,000)** are process-based — weekly build updates on Telegram/X from week 1.

## 6. Roadmap (Aug 1 – Dec 10, 2026)

- **W1–2**: Testnet deploy (Chain ID 1983), verify on explorer, seed 5 merchants
- **W3–6**: Field onboarding (shops + API sellers), mainnet dry-run, demo video v1
- **W7–10**: CreditPassport lending-partner conversations, supply-chain stock-credit pilot (CreditPassport → distributor orders)
- **W11–13**: Mainnet submission package, demo week rehearsal (Dec 1–5), winners Dec 10
