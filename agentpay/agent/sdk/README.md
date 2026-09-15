# @agentpay/sdk — let your AI agent pay for APIs on QIE

Typed client for the **x402-style machine-payment flow** backed by real
on-chain rails: pre-funded **mandates** with hard caps, a **refund window**
for the human principal, and on-chain settlement the seller can verify
without trusting you (and you without trusting it).

```ts
import { AgentPayClient } from "@agentpay/sdk";

const agent = new AgentPayClient({
  privateKey: process.env.AGENT_PRIVATE_KEY!, // the machine wallet
});

// 1) DISCOVER what a seller offers (402 terms are the contract of the sale)
const catalog = await agent.discover("https://seller.example");
const terms   = await agent.terms("https://seller.example", "weather-basic");

// 2) PAY on-chain + 3) CALL — one line: quote -> cap pre-flight -> payForCall -> purchase
const res = await agent.buyAndCall("https://seller.example", "weather-basic", {
  mandateId: 2,            // your pre-funded spending mandate
  agentName: "my-agent",
});
console.log(res.data);      // the paid payload

// 4) VERIFY the settlement yourself (decode the CallPaid event from the tx)
const v = await agent.verify(res.onChain!.txHash, Number(res.onChain!.productId));

// 5) REFUND within the window — the human's dispute right (funds go back
//    to the mandate's principal wallet)
await principalClient.refund(res.onChain!.callId);
```

That is the whole integration. **Every parameter is fixed by the 402 terms
document and encoded by this SDK — agents integrate once.**

---

## How the money moves

```
 your agent                PayEndpoint              EscrowCore            seller
     |  payForCall(mandate)    |                         |                  |
     |------------------------>|  mandate.spend()        |                  |
     |                         |--- WQIE (0.1/call) ---->|                  |
     |                         |  registerExternal() -> refund window       |
     |  POST /purchase  X-PAYMENT: <txHash>              |                  |
     |----------------------------------------------------------- tx verified
     |<--------------------------- paid payload -------------------------|
```

- **Caps are reverts, not UI promises** — `perCallCap`, `dailyCap`, prepaid
  `balance`, `expiry` and principal binding live in `MandateVault`. The SDK
  pre-flights `canSpend()` so you get a **typed error before burning gas**.
- **The seller verifies your payment on-chain**: receipt status + the
  `CallPaid` log from the real PayEndpoint + matching productId. Replaying a
  settled tx hash buys nothing (callId is single-use).
- **Every payment is disputable** for the refund window (600s default):
  `refund(callId)` returns the funds to the human principal.

## Install

```bash
bun add @agentpay/sdk      # or: npm i @agentpay/sdk
```

Requires **ethers v6** as a peer dependency. Node 18+ / Bun / Deno.

## Networks

| name         | chainId | note                                        |
|--------------|---------|---------------------------------------------|
| `qieTestnet` | 1983    | live contracts (default)                    |
| `qieMainnet` | 1990    | slot ready — API unchanged after P6 deploy  |

```ts
const agent = new AgentPayClient({ privateKey, network: "qieMainnet" });
```

Testnet 1983 contracts (source-verified): `WQIE 0x5e16…916c · PayEndpoint
0x4ccd…b647 · MandateVault 0x2FEf…2169 · EscrowCore 0x7566…995b ·
AgentRegistry 0x715f…ED09` — full address book ships in `src/chains.ts`.

## API

| method | what it does |
|--------|--------------|
| `discover(baseUrl)` | `GET /v1/products` — the seller catalog |
| `terms(baseUrl, key)` | `GET /v1/product/:key` — parse the 402 terms |
| `quote(productId, token?)` | on-chain quote for one call |
| `canSpend(mandateId, wei)` | pre-flight a spend against the caps (view) |
| `payForCall(mandateId, productId, token?)` | pay one call from the mandate (with safe retry) |
| `purchase(baseUrl, key, txHash, {agentName})` | POST the payment proof, get the payload |
| `buyAndCall(baseUrl, key, {mandateId, …})` | terms → pay → call, one line |
| `signDemoIntent(terms)` | demo-mode signed intent (sellers without live chain mode) |
| `buyTicket(baseUrl, key, {mandateId, …})` | **P4**: buy a real-world good — returns the bearer ticket (id + one-time secret) |
| `redeemTicket(baseUrl, ticketId, secret)` | **P4**: present the ticket at the gate — single-use, replay-rejected |
| `ticketStatus(baseUrl, ticketId)` | **P4**: VALID / REDEEMED / VOID without the secret (venue/auditor check) |
| `verify(txHash, productId?)` | decode `CallPaid` from any tx yourself |
| `refund(callId)` | dispute within the window (principal/agent) |
| `claim(callId)` | merchant claims settlement after the window |
| `mandateSnapshot(mandateId, productId?)` | balance, caps, spentToday, nextCall verdict |

## Typed errors — branch on `e.code`

```
PAYMENT_REQUIRED · INVALID_PAYMENT · PRODUCT_NOT_FOUND · CALL_NOT_FOUND
ALREADY_SETTLED · REFUND_WINDOW_CLOSED · HTTP_ERROR
SOLD_OUT · TICKET_NOT_FOUND · TICKET_INVALID_SECRET
TICKET_ALREADY_REDEEMED · TICKET_VOID · TICKET_ALREADY_REDEEMED_REFUND · INVALID_REFUND_PROOF
AGENT_NOT_ELIGIBLE · NOT_MANDATE_AGENT · MANDATE_INACTIVE
PER_CALL_CAP · DAILY_CAP · MANDATE_BALANCE · TOKEN_MISMATCH · CALL_NOT_OPEN
STALE_FEED · NOT_PAYER · WINDOW_CLOSED · WINDOW_STILL_OPEN · NOT_OPEN · NOT_PAYEE
RPC_ERROR · TIMEOUT · TX_FAILED
```

```ts
try {
  await agent.payForCall(5, 1);
} catch (e) {
  if (e instanceof AgentPayError && e.code === "DAILY_CAP") {
    stopBuying(); // the mandate is exhausted for today — no revert lottery
  }
}
```

## P4 — buy a real ticket, redeem it at the gate

Ticket products (`kind: "ticket"`) are scarce, redeemable goods on the same
mandate rail. The payment is identical (`payForCall` → escrow → refund
window) — what changes is the payload: an **HMAC-signed bearer ticket**
bound to the on-chain callId.

```ts
// 1) BUY — the payload IS the ticket (id + one-time secret)
const bought = await agent.buyTicket("https://venue.example", "event-ticket", {
  mandateId: 6,
});
console.log(bought.ticket.event);       // { name, venue, startsAt, gate }
console.log(bought.inventoryLeft);      // public scarcity, from the terms

// 2) REDEEM at the gate — single-use
const proof = await agent.redeemTicket("https://venue.example", bought.ticket.ticketId, bought.ticket.secret);
console.log(proof.admission);           // "GRANTED" + boundCall (on-chain callId)

// 3) REPLAY the same secret — rejected, typed
//    AgentPayError code=TICKET_ALREADY_REDEEMED

// 4) Auditors / the venue check status without the secret
const st = await agent.ticketStatus("https://venue.example", bought.ticket.ticketId);
console.log(st.status);                 // "VALID" | "REDEEMED" | "VOID"
```

The anti-fraud rules are enforced by the seller, verifiable by anyone:

- a sold-out product answers `409 SOLD_OUT` **before** reading your payment —
  your escrowed funds stay recoverable with `refund(callId)`;
- refunding the escrow **voids** unredeemed tickets (`TICKET_VOID`) and
  restocks inventory — the seller only records a refund after verifying the
  on-chain `CallRefunded` log;
- a **redeemed** ticket blocks the refund leg
  (`TICKET_ALREADY_REDEEMED_REFUND`) — no redeem-then-refund.

## Run the reference agents (X-06)

Four runnable agents live in [`agentpay/agent/examples/`](../examples/):

| agent | proves |
|-------|--------|
| `shopping-agent.ts` | agent buys goods at a QR store — exact-value matcher auto-books the sale |
| `data-buyer-agent.ts` | full x402: discover → 402 → payForCall → on-chain-verified call → self-verify → replay-guard → refund |
| `ticket-buyer-agent.ts` | mandate caps: buys until `DAILY_CAP` fires as a typed error |
| `ticket-agent.ts` | real-world goods: buy → redeem at the gate → replay rejected → status auditable |

```bash
cd agentpay/agent
AGENT_PRIVATE_KEY=0x… MANDATE_ID=2 bun examples/data-buyer-agent.ts
AGENT_PRIVATE_KEY=0x… MANDATE_ID=6 SELLER_URL=http://localhost:3030 bun examples/ticket-agent.ts
```

All four run END-TO-END on QIE testnet 1983 — the traces of the
2026-09-15 runs are in the repository README.

## Reference seller (for local testing)

`mini-services/agentpay-endpoint/` is a runnable x402 seller (Hono):
`GET /v1/products`, `GET /v1/product/:key` (402 + terms incl. kind/inventory),
`POST /v1/product/:key/purchase` (verifies your tx on-chain in
`CHAIN_MODE=live`; mints tickets for ticket products),
`POST /v1/ticket/:id/redeem` + `GET /v1/ticket/:id` (the P4 gate leg),
`POST /v1/call/:id/refund` (verifies the on-chain `CallRefunded` proof,
voids + restocks tickets).

```bash
cd mini-services/agentpay-endpoint
CHAIN_MODE=live PAY_ENDPOINT_ADDRESS=0x4ccdE1dD4d2c3F39dB9D2b350516070257dfb647 \
PRODUCT_ID_WEATHER_BASIC=1 PRODUCT_ID_EVENT_TICKET=2 PRODUCT_ID_VIP_TICKET=3 \
EVENT_TICKET_INVENTORY=50 VIP_TICKET_INVENTORY=1 bun index.ts   # serves on :3030
```
