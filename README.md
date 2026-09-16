# AgentPay × MerchantPilot

**Merchant Operating System on QIE — agentic commerce payment infrastructure for Track 04 (Commerce & Real World), QIE Hackathon 3.0 Mainnet Edition.**

One stack, three businesses in a box:

1. **Merchant payments** — QR / invoice / subscription checkout with on-chain settlement, escrow protection and automated payouts.
2. **Agent commerce (x402-style)** — machines pay machines: per-call mandates, spend caps, a machine paywall endpoint, all metered on-chain.
3. **On-chain credit** — every payment feeds a CreditPassport score (300–850) that unlocks trust for undercollateralized commerce.

No passwords, no email, no seed phrases: **your wallet is your account** (SIWE, EIP-4361) with **passkey step-up** (WebAuthn) for money-moving actions.

---

## LIVE ON QIE MAINNET (chain 1990) — deployed Sep 16, 2026

Ten contracts deployed, wired and **source-verified on the explorer** (`agentpay/contracts/addresses/qieMainnet.json`). Smoke test: **26/26 PASS**. USD quoting uses the **official QIE Oracle QIE/USD feed** (`0x3Bc617cF…03D17`) — no mocks on mainnet.

| Contract | Mainnet address | |
|---|---|---|
| WQIE | `0x883E3098eF144f91818037936a722b8bd448074b` | [verified](https://mainnet.qie.digital/address/0x883E3098eF144f91818037936a722b8bd448074b) |
| MerchantRegistry | `0x0049BA098899713C0c24C2214252e4b71D9dC7b2` | [verified](https://mainnet.qie.digital/address/0x0049BA098899713C0c24C2214252e4b71D9dC7b2) |
| AgentRegistry | `0xB129871e87c3E3B53cFd50f31290fDA9343D4F20` | [verified](https://mainnet.qie.digital/address/0xB129871e87c3E3B53cFd50f31290fDA9343D4F20) |
| EscrowCore | `0xB5aa93a3B7611F3eEeeB27aE52C1DB6f65E27f8a` | [verified](https://mainnet.qie.digital/address/0xB5aa93a3B7611F3eEeeB27aE52C1DB6f65E27f8a) |
| SettlementRouter | `0x6b22be3198Dd66289874A6E6Ad35DBEF6e9d4076` | [verified](https://mainnet.qie.digital/address/0x6b22be3198Dd66289874A6E6Ad35DBEF6e9d4076) |
| CreditPassport | `0x837E6dCE04671d58703f7030906F6fCd32D6aA2E` | [verified](https://mainnet.qie.digital/address/0x837E6dCE04671d58703f7030906F6fCd32D6aA2E) |
| MandateVault | `0x4f1bb87B31648c9D265CbF743AeB107aA83E8906` | [verified](https://mainnet.qie.digital/address/0x4f1bb87B31648c9D265CbF743AeB107aA83E8906) |
| PayEndpoint | `0xb35b5693ea5c12dB23875032227A84C713bc9B5E` | [verified](https://mainnet.qie.digital/address/0xb35b5693ea5c12dB23875032227A84C713bc9B5E) |
| InvoiceVault | `0xC2a17d8a84e29A9f5726C76142e5aE1B2872989D` | [verified](https://mainnet.qie.digital/address/0xC2a17d8a84e29A9f5726C76142e5aE1B2872989D) |
| RecurringMandate | `0x9c75059E6C48F0550990499F1068f878a65C047B` | [verified](https://mainnet.qie.digital/address/0x9c75059E6C48F0550990499F1068f878a65C047B) |

Deployer: `0x33E00d801943D945DC5Ec92A2192425427023586`. Escrow relayer, SettlementRouter/CreditPassport recorder roles wired on-chain during deploy.

## Live on QIE testnet (chain 1983)

Eleven contracts deployed and wired (`agentpay/contracts/addresses/qieTestnet.json`):

| Contract | Address | Role |
|---|---|---|
| PayEndpoint | `0x4ccdE1dD4d2c3F39dB9D2b350516070257dfb647` | per-call machine payments (50 bps), USD quoting via official QIE oracle |
| MandateVault | `0x2FEf89522b8B0a55161ed11a7CB19B57C6fF2169` | prepaid agent mandates, per-call + daily caps |
| InvoiceVault | `0xD0FF272B69FA884fd2C323ce334dC77F9243Ac0C` | crypto invoicing (30 bps), partial pay, overdue agent |
| RecurringMandate | `0x0AaC5b7c0E669D3Ecae635d6820858D4ab897D8f` | on-chain subscriptions (30 bps), lapse handling |
| EscrowCore | `0x7566803615CB5d9Ac15f24269C3305a2738C995b` | 600 s protection window, refund / settleExpired |
| SettlementRouter | `0x1713B2fb74A3b57f55088f21743668a8Bb261523` | merchant credit ledger + auto-withdraw payouts |
| MerchantRegistry | `0x7918e72d7725E87D3C09bB80873991a05BaEc9aA` | verifier-gated merchant registry |
| AgentRegistry | `0x715f9449145C2FC74c74556154F17C522a30ED09` | AI agent identity |
| CreditPassport | `0xCaecF75Eebb659148DE2d2a4a28131dF428B5cA8` | on-chain credit score: 300 floor, +8 on-time, −120 default, 850 cap |
| WQIE | `0x5e165E6c7AC4039aEDc2a5505Ae35cb20764916c` | wrapped native token |
| MockAggregator | `0x71206B14F6B005E70909F83048CcE8002F03EF70` | oracle feed harness (testnet) |

End-to-end proof with real transactions: `agentpay/contracts/addresses/e2e_proof_qieTestnet.json`.

## Build an agent that pays (X-05 SDK + X-06 reference agents)

Agents pay APIs the way users tap a card — but with on-chain caps and a
refund window. The `@agentpay/sdk` typed client covers the whole flow:
**discover → pay → verify → refund**.

```ts
import { AgentPayClient } from "@agentpay/sdk";

const agent = new AgentPayClient({ privateKey: process.env.AGENT_PRIVATE_KEY! });
const res = await agent.buyAndCall("http://localhost:3030", "weather-basic", {
  mandateId: 2, // your pre-funded mandate (per-call cap + daily cap on-chain)
});
console.log(res.data);                    // paid payload — seller verified your tx on-chain
await agent.verify(res.onChain!.txHash);  // check the settlement yourself
await agent.refund(res.onChain!.callId);  // dispute within the 600 s window
```

Caps are **reverts, not UI promises**: exceed a mandate's per-call or daily
cap and you get a typed `AgentPayError` (`PER_CALL_CAP`, `DAILY_CAP`,
`MANDATE_BALANCE`, …) — pre-flighted so no gas is burned. Full guide:
[`agentpay/agent/sdk/README.md`](agentpay/agent/sdk/README.md).

**Four reference agents run end-to-end on testnet 1983**
(`agentpay/agent/examples/`, driven with `bun`):

| agent | what it proves (2026-09-15 trace) |
|-------|-----------------------------------|
| `shopping-agent.ts` | agent buys goods at a QR store — pays the exact EIP-681 amount, matcher auto-books PAID in 8.3 s |
| `data-buyer-agent.ts` | full x402: 402 terms → `payForCall` (callId/escrow on-chain) → seller verifies tx LIVE → self-verify → **replayed tx hash rejected** → principal refund mined |
| `ticket-buyer-agent.ts` | mandate controls: buys tickets until the daily cap blocks ticket #3 as a typed `DAILY_CAP` — zero gas wasted, nothing bypassed |
| `ticket-agent.ts` | **real-world goods**: buys an event ticket, redeems it at the gate, and a replayed secret is rejected — the ticket cannot be double-spent |

```bash
cd agentpay/agent
AGENT_PRIVATE_KEY=0x… MANDATE_ID=2 bun examples/data-buyer-agent.ts
```

## Real-world goods: tickets on the machine rail (P4)

x402 agents buy data. AgentPay agents buy **real things**. Products with
`kind: "ticket"` are scarce, redeemable goods on the same on-chain rail —
the payment is still `payForCall` → escrow → refund window, but the payload
the agent receives is an **HMAC-signed bearer ticket** bound to the on-chain
callId:

```
agent.buyTicket(url, "event-ticket", { mandateId })   →  ticket { id, secret }
agent.redeemTicket(url, ticketId, secret)             →  admission GRANTED at the gate
agent.redeemTicket(url, ticketId, secret)  again      →  409 TICKET_ALREADY_REDEEMED
agent.ticketStatus(url, ticketId)                     →  VALID / REDEEMED / VOID (auditable)
```

The trust properties that make this commerce, not a demo:

- **Scarcity is public** — the 402 terms carry `inventoryLeft`; a sold-out
  product answers `409 sold_out` BEFORE touching the payment, so the agent's
  escrowed money stays fully recoverable via `refundCall`.
- **Single-use redemption** — the gate verifies the HMAC secret in constant
  time; a screenshot of a ticket cannot be reused by anyone.
- **Refund ↔ redemption are mutually exclusive** — refunding the escrow voids
  unredeemed tickets and restocks inventory (the seller verifies the on-chain
  `CallRefunded` log before recording it); a REDEEMED ticket blocks the
  refund leg — no eat-cake-and-have-it.

**25/25 assertions PASS on testnet 1983** (2026-09-15, mandate 10, `scripts/e2e_p4_tickets.mjs`):

| step | on-chain trace |
|------|----------------|
| buy GA ticket → seller verified `CallPaid(product 2)` | `0xb01a68f6…5aa4` |
| redeem at gate → GRANTED 13:56:55Z; replay → typed `TICKET_ALREADY_REDEEMED` | ticket `tkt_00001_4abf104a` |
| buy GA #2 → principal `refundCall` → seller voids ticket + restocks | `0x5bc50011…e549` / `0xfc1cdf17…5db2` |
| buy VIP (stock 1 → 0) | `0x41eb51b1…2878` |
| sold-out attempt with a fresh real payment → `409 SOLD_OUT`, tx not consumed → escrow recovered | `0x4d087304…6778` / `0x87a802e3…7d7cc` |
| ticket #3 for GA → typed `DAILY_CAP` pre-flight, zero gas | mandate 10 drained exactly 0.4/0.4 WQIE |

Tickets work in demo mode too (dashboard path unchanged): a signed-intent
purchase mints the same bearer ticket without an on-chain tx.

## Mainnet-ready (P6) — deploy pipeline proven, QIE mainnet 1990

Every mainnet risk was retired on testnet first, and the full verification
pipeline now ships in-repo:

- **Official QIE Oracle feed verified live on mainnet** (`0x3Bc6…3D17`,
  "QIE / USDT", 8 decimals, fresh heartbeat) — `deploy.ts` wires it
  automatically on `--network qieMainnet` (testnet uses a clearly-labelled
  MockAggregator).
- **Explorer source verification automated** (`agentpay/contracts/scripts/p6_verify_sources.mjs`):
  standard-JSON solc input + constructor args from a deploy-time journal
  (`deploy.ts` records address, args, tx hash and gas for every contract) →
  POST to the Etherscan-compatible API → poll to **"Pass - Verified"**.
  **All 10 testnet contracts are source-verified** — inspect every source on
  `testnet.qie.digital`.
- **26-point post-deploy smoke** (`scripts/p6_smoke.mjs`): code at every
  address, relayer/recorder wiring, feed price + freshness, refund window,
  verifier/treasury authority — currently **26/26 PASS on testnet**.
- **RPC truth**: mainnet endpoints are `rpc1mainnet` / `rpc2mainnet.qie.digital`
  (verified `eth_chainId = 1990`); `rpc1.qie.digital` / `rpc.qie.digital` are
  NOT eth JSON-RPC — configs and the SDK registry were corrected.
- Full deploy rehearsal passes on an in-memory network; the mainnet deploy is
  a single funded command (`npx hardhat run scripts/deploy.ts --network qieMainnet`).

## Public network stats (P5) — live on-chain transparency

Anyone can audit AgentPay's real activity without trusting our claims: the public
**`/network`** page (and `GET /api/network-stats`) reconciles raw event logs directly
from QIE RPC — no database of record, no cached demo numbers.

**What it counts (live, from chain):** merchants registered/verified
(MerchantRegistry), agents registered + principals bound (AgentRegistry),
machine-pay calls paid, gross volume in QIE, protocol fees, unique agents,
settled vs refunded splits and the latest call tx (PayEndpoint), escrow
opened/released/refunded (EscrowCore), invoices created/fully paid
(InvoiceVault), payout profiles saved (SettlementRouter).

**Engineering notes (why this was non-trivial):**

- QIE RPC caps `getLogs` at 10k blocks per query — the reconciler walks the
  chain in 9.5k-block windows with rotation across 6 official RPC endpoints,
  jittered backoff, and surfaces `skippedWindows` in the payload instead of
  silently dropping coverage.
- Public replica RPCs ignore `eth_getLogs` topic filters → events are
  classified client-side by `topic0` and de-duplicated across overlapping
  windows.
- Event topic hashes come from the full indexed-annotated signature via
  `Interface.getEvent().topicHash` (hand-hashed signatures with `"indexed"`
  silently match nothing); ethers 6.17 requires the `event ` prefix on
  signature strings.
- Chain head + per-RPC latency shown so reviewers can judge freshness; manual
  refresh button; verified responsive at 390px.

Live testnet snapshot at time of writing: **26 calls paid · 3.5111 QIE gross ·
3 unique agents · 5 settled / 17 refunded · escrow 26/5/17 · 0 skipped
windows**.

## Architecture

```
Browser (Next.js 16 PWA, 390px-first)
  ├─ SIWE sign-in (EIP-4361) + WebAuthn passkey step-up
  ├─ Cash register: QR sale → countdown → 3 s PAID flip
  └─ ethers v6 → QIE RPC (chain 1983)
        │
Event indexer (viem poller → SQLite ledger, idempotent (tx_hash, log_index))
        │
API routes (merchant profiles, invoices, subs, overview, x402 endpoint service)
        │
11 Solidity contracts (OpenZeppelin) on QIE testnet → mainnet 1990 ready
```

## Security model

- **SIWE no-password auth**: server-issued single-use nonce (10 min TTL), signature recovery verified server-side, HMAC-signed httpOnly session cookie (7 d).
- **Passkey step-up**: WebAuthn registration + assertion; money-moving endpoints demand a fresh 5-minute step-up; full verification of challenge, origin, rpId, UP/UV and signature counter.
- **Secrets hygiene**: deployer / faucet keys are git-ignored (`faucet_funder*.json`, `.env`); `.env.example` documents every variable; hardhat reads keys from env only.

## Quickstart

```bash
# 1. dependencies
bun install            # or npm install

# 2. environment
cp .env.example .env   # fill in DATABASE_URL at minimum

# 3. database
bunx prisma db push

# 4. run the dashboard
bun run dev            # http://localhost:3000
```

Contracts workspace:

```bash
cd agentpay/contracts
npm install
npx hardhat compile
npx hardhat test       # 45-case masterplan suite (mandates, escrow, settlement, credit fuzzing)
```

Edge services:

```bash
cd mini-services/agentpay-endpoint && bun run dev   # x402 machine-paywall endpoint (:3030)
cd agentpay/indexer && npm i && npm start           # event indexer → SQLite ledger
```

## Repo map

```
src/app/                 Next.js routes + API (auth, merchants, invoices, subs, QR, indexer, health)
src/lib/                 chains, wallets (EIP-6963), wallet-error normalizer, auth (SIWE), passkey, abis
src/components/merchant/ login, cash register, ops (invoices/subs/payout), machine paywall, security
prisma/                  schema (merchants, sessions, nonces, passkeys, settings)
agentpay/contracts/      11 Solidity contracts + deploy/e2e scripts + 45-case test suite
agentpay/indexer/        viem event poller → idempotent SQLite ledger
agentpay/agent/sdk/      @agentpay/sdk — typed agent client (discover/pay/verify/refund, X-05)
agentpay/agent/examples/ 4 reference agents: shopping, data-buyer, ticket-buyer, ticket (X-06)
agentpay/docs/           whitepaper, deploy guide, demo script
mini-services/           standalone x402 endpoint service (single-use callId + ticket redemption rail)
```

## Hackathon

Built for **QIE Hackathon 3.0 — Mainnet Edition** (Aug 1 – Dec 10, 2026), Track 04: Commerce & Real World. QIE testnet chain ID 1983; mainnet 1990 is a config flip (`NEXT_PUBLIC_QIE_NETWORK`).
