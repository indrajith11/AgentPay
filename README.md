# AgentPay × MerchantPilot

**Merchant Operating System on QIE — agentic commerce payment infrastructure for Track 04 (Commerce & Real World), QIE Hackathon 3.0 Mainnet Edition.**

One stack, three businesses in a box:

1. **Merchant payments** — QR / invoice / subscription checkout with on-chain settlement, escrow protection and automated payouts.
2. **Agent commerce (x402-style)** — machines pay machines: per-call mandates, spend caps, a machine paywall endpoint, all metered on-chain.
3. **On-chain credit** — every payment feeds a CreditPassport score (300–850) that unlocks trust for undercollateralized commerce.

No passwords, no email, no seed phrases: **your wallet is your account** (SIWE, EIP-4361) with **passkey step-up** (WebAuthn) for money-moving actions.

---

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
agentpay/agent/          reference AI-agent client (mandate + x402 flow)
agentpay/docs/           whitepaper, deploy guide, demo script
mini-services/           standalone x402 endpoint service
```

## Hackathon

Built for **QIE Hackathon 3.0 — Mainnet Edition** (Aug 1 – Dec 10, 2026), Track 04: Commerce & Real World. QIE testnet chain ID 1983; mainnet 1990 is a config flip (`NEXT_PUBLIC_QIE_NETWORK`).
