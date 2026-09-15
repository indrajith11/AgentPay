# Deploy & Run Guide — AgentPay on QIE (REAL BUILD, Sep 2026)

## 0. Prerequisites

- Node 18+ (Node 20/24 recommended), npm or bun
- A wallet with QIE gas tokens
  - Testnet faucet: https://www.qie.digital/faucet — API is `POST https://admin-api.qie.digital/api/test-token` `{walletAddress}` (24h cooldown per address, batched delivery — poll with `scripts/poll_balance.cjs`)
  - Chain IDs: **testnet 1983** (`https://rpc1testnet.qie.digital/`) · **mainnet 1990** (`https://rpc1mainnet.qie.digital/`)
- Settlement asset: **no trustless stablecoin exists on QIE yet** — by default the suite deploys its own **WQIE** (wrapped native QIE, WETH9 pattern) and USD-prices it via the official QIE Oracle. When QIE ships an official stable, set `SETTLEMENT_TOKEN=0x…` instead.

## 1. Contracts

```bash
cd agentpay/contracts
npm install

# compile + local tests (19/19 passing)
npx hardhat compile
npx hardhat test

# testnet deploy — deploys WQIE + 9 core contracts + testnet mock price feed
export DEPLOYER_PRIVATE_KEY=0xyour_test_key
npx hardhat run scripts/deploy.ts --network qieTestnet

# mainnet deploy (submission target) — wires the OFFICIAL QIE Oracle QIE/USD feed automatically
export DEPLOYER_PRIVATE_KEY=0xyour_main_key
npx hardhat run scripts/deploy.ts --network qieMainnet
# optional overrides: SETTLEMENT_TOKEN, USD_FEED_TOKEN, USD_FEED_ADDRESS
```

Output: `addresses/<network>.json` with WQIE + all 9 contract addresses + feed wiring.
Verify sources on the explorer so judges can inspect: paste addresses into `testnet.qie.digital` / `mainnet.qie.digital`.

### Post-deploy wiring (operator = deployer)
1. Verify real merchants: `MerchantRegistry.verifyMerchant(merchant, true)`
2. Merchants list USD-priced machine products: `PayEndpoint.addProductUsd(name, path, schemaURI, priceUsd)` (or fixed-price `addProduct`)
3. Principals bind agents: `AgentRegistry.bindPrincipal(agent, qiePassId)` then fund `MandateVault.createMandate(...)` and authorize the relayer: `MandateVault.authorizeCaller(mandateId, PayEndpointAddress, true)`
4. Merchants save bank off-ramp ONCE: `SettlementRouter.setPayoutProfile({ payoutAddress: <provider deposit addr>, providerRef: keccak(beneficiaryId), provider: "valr"|"luno"|"transak", fiatCurrency: "ZAR"|…, rail: 1, minThreshold, interval, autoEnabled: true, active: true })` — then the keeper agent (see §3) auto-sweeps; the provider pays the saved bank account.

## 2. x402 endpoint service (port 3030)

```bash
cd mini-services/agentpay-endpoint
bun install
CHAIN_MODE=live PAYENDPOINT_ADDRESS=0x… ESCROW_ADDRESS=0x… \
QUSDC_ADDRESS=0x… MERCHANT_WALLET=0x… bun index.ts
```

Demo mode (no env) works out of the box for rehearsals.

Quick test:
```bash
curl -i http://localhost:3030/v1/product/weather-basic     # 402 + terms
curl -i -X POST http://localhost:3030/v1/product/weather-basic/purchase \
     -H "X-PAYMENT: 0x<tx hash or signed intent>" \
     -H "X-AGENT-NAME: shopper-bot"                        # 200 + escrowRef + payload
```

## 3. Agent daemon

```bash
cd agentpay/agent
bun install
cp .env.example .env   # fill RPC_URLS, addresses, AGENT_PRIVATE_KEY, webhook
bun start
```

Runs three loops (all RPC-rotating across the official QIE endpoint list):
- **reconciliation** — payment events → ledger CSV + webhook
- **collections** — overdue scan → `markOverdue()` + reminders
- **treasury (AUTO-WITHDRAW KEEPER)** — discovers auto-enabled merchants from `PayoutProfileSet` events + tokens from `PaymentReceived` events; whenever `canAutoWithdraw()` flips true it executes the permissionless `executeAutoWithdraw()` — merchants pay no gas, never open the app. `TREASURY_DRY_RUN=false` to arm.

## 4. Merchant dashboard (Next.js, port 3000)

```bash
# at repo root
bun install
bun run db:push      # Prisma/SQLite schema
bun run lint
bun run dev          # dev server on :3000 (auto-managed in this workspace)
```

Dashboard features (REAL MODE — zero demo data): real merchant onboarding, KPIs, QR acceptance (real EIP-681 payment URI priced by the live QIE Oracle + paste-tx-hash verification against the chain + explorer link), invoices (issue/partial/settle), subscriptions (create/chargeDue), Machine Paywall (live 402→200 agent purchase trace), **Payout & Wallet tab** (EIP-6963 multi-wallet connect incl. WalletConnect QR when `NEXT_PUBLIC_REOWN_PROJECT_ID` is set, live on-chain settlement state, one-time bank payout profile, withdraw-now), Credit Passport, Chain Setup.

`/api/health` pings the QIE RPC (`eth_chainId`) and the x402 service so judges can see liveness; `/api/price` serves the live official-oracle QIE/USD quote (verified working: $0.17998784).

## 5. Submission checklist (per official rules)

- [ ] Mainnet deployment (contracts + verified sources)
- [ ] Live public app (dashboard reachable, x402 service reachable)
- [ ] Open-source repo with docs (WHITEPAPER, DEMO_SCRIPT, this guide)
- [ ] Demo video (script: `agentpay/docs/DEMO_SCRIPT.md`)
- [ ] Team presentation deck
- [ ] One submission per team, before **Nov 30, 2026**
