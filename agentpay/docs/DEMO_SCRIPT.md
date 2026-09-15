# Demo Script — AgentPay (3 acts, ~4 minutes)

Judging weights: Innovation 30% · Technical 25% · UX 15% · Mainnet Integration 15% · Business 15% (T&C frame: presentation 25%). Every act hits at least two criteria.

---

## Pre-flight (before recording / going live)

1. Dashboard running (`bun run dev`), x402 service on :3030 (`cd mini-services/agentpay-endpoint && bun index.ts`)
2. Contracts deployed to QIE **mainnet** (or testnet for rehearsal) — address book wired into the Chain Setup tab
3. Seed data present (auto-seeds on first load)
4. Second screen: terminal with `curl` for the raw-protocol proof

## Act 1 — The human rail (0:00–1:15) "A shop that runs itself"

1. Open dashboard → merchant **Nomvula's Spaza (Soweto)**.
2. Point at KPIs: today's sales, recurring revenue, pending invoices, machine revenue — *one screen = the whole money back office*.
3. **Accept QR payment**: generate QR for R125 → simulate customer scan →
   *"Settled in 1.4 seconds. Fee 0.3% — BitPay charges 1–2%."*
4. Scroll AI staff activity: reconciliation booked it, treasury parked 10% into savings, collections already chased the overdue invoice.
5. **UX 15% + Business 15% + Real-world applicability answered in 75 seconds.**

## Act 2 — The machine rail (1:15–2:45) "Your first AI customer"

1. Switch to **Machine Paywall** tab.
2. Say: *"AI agents are already buying — 100M+ x402 transactions. But those payments are irreversible, identity-less and cents-only. We fixed all three on QIE."*
3. Click **Run live agent purchase** on Weather Nowcast → narrate the trace as it appears:
   - `HTTP 402` — agent discovers terms (mandate scheme, refund window 600s, price)
   - `HTTP 200` — mandate spent within caps → escrow opened → payload delivered
   - `CreditPassport.recordPayment()` — *the machine just built its human's credit score*
4. Terminal proof (judges love raw wire):
   ```bash
   curl -i http://localhost:3030/v1/product/fx-rate            # 402 + terms
   curl -i -X POST http://localhost:3030/v1/product/fx-rate/purchase \
        -H "X-PAYMENT: 0x<TX_OR_INTENT>" -H "X-AGENT-NAME: judge-bot"   # 200 + escrowRef
   curl -i -X POST http://localhost:3030/v1/call/call_00000X/refund     # refund in window
   ```
5. **Innovation 30% + Technical 25% in 90 seconds.**

## Act 3 — The moat (2:45–4:00) "Credit for the invisible merchant"

1. **Credit Passport** tab: score 648, tier GROWTH, 43 on-time payments.
2. *"60–80% of SA small businesses fail; only 14% of Indian MSMEs have formal credit. This merchant just built a bank-grade history from real payments — every QR sale, every machine call."*
3. Show tier unlocks: stock micro-loans → supplier credit → cash advances. This is the supply-chain bridge: credit passport → stock financing → distributor orders.
4. **Chain Setup** tab: 9 contracts, 11/11 tests, mainnet addresses verified on explorer; QIE components used: Wallet, QUSDC, Pass, DEX, Oracles (bonus coverage).
5. Close: *"Humans pay by QR. Agents pay by HTTP. AI staff run the books. Every payment builds credit. That is Track 04: commerce connected to the real world — trust, transparency, speed."*

---

## Q&A rapid answers

| Likely question | Answer |
|---|---|
| "How is this different from Qantara?" | They built developer payment rails; we built the merchant's operations + the machine-customer channel on top. Complementary, not competing — we can integrate their SDK. |
| "Where do agent customers come from?" | We ship the open endpoint standard + SDK; any dev with an LLM agent onboards in minutes. Our demo bots are live. |
| "What about x402 compatibility?" | We implement the 402 challenge/response shape; our on-chain legs add escrow/refund + KYA identity that raw x402 lacks. |
| "Milestone realism?" | Machine calls compound daily (tx volume), daily reports = recurring users, fees = revenue; 3 of 6 reachable honestly. |
| "Anti-abuse?" | Original contracts (auditable repo), original field footage, full dev authorship — no forks, no clones. |
