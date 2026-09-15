# Security Policy — AgentPay x MerchantPilot contracts

Status: hardened for the QIE Hackathon 3.0 mainnet submission. Static analysis
and the full test matrix run in CI (`.github/workflows/ci.yml`). Findings and
their dispositions are recorded here — an explained finding is engineering
maturity, a hidden one is concealment.

## Hardening checklist (applies to every contract)

- Solidity 0.8.24+ overflow checks; checks-effects-interactions ordering;
  `ReentrancyGuard` on native-token paths (WQIE).
- Named custom errors on hot paths (`NotAgent`, `ExceedsPerCallCap`,
  `ExceedsDailyCap`, `InsufficientBalance`, `StaleFeed`, `NoFeed`,
  `TokenMismatch`, `WindowClosed`, `WindowStillOpen`, `NotOpen`, `NotPayer`,
  `NotPayee`, `CallNotOpen`, `NotProductMerchant`, `NotAuthorized`,
  `NothingToWithdraw`, `ProfileInactive`, `BadProfile`, `ThresholdNotMet`,
  `IntervalNotElapsed`, `AutoDisabled`, `NotVerifier`).
- No `tx.origin`; no delegatecall; no unbounded loops over user arrays.
- Oracle reads bounded: every USD quote checks `updatedAt` against
  `maxFeedAge` (26h default; QIE Oracle updates ~daily) and reverts
  `StaleFeed`; negative answers rejected.
- Escrow: funds move Open -> exactly one terminal state (Released/Refunded);
  refunds only inside the window by payer/agent/authorized relayer; settlement
  (permissionless `settleExpired`) only after the window.
- Mandates: per-call cap, UTC-day-bucketed daily cap, prepaid balance,
  expiry, principal-bound agents, principal-authorized callers only.
- SettlementRouter: only registered recorders can `credit()`; fees forwarded
  to treasury at credit time; withdrawals cannot exceed recorded earnings;
  auto-withdraw requires profile.active + autoEnabled + threshold + interval.
- Bank details NEVER on-chain: only `providerRef` (hash of the provider-side
  beneficiary id) and a payout address are stored.
- Fee caps: PayEndpoint MAX_FEE_BPS = 200 (2%); verifier-only fee changes.

## Static analysis

| Tool | Scope | Disposition policy |
|---|---|---|
| Slither | all contracts | every finding fixed or dispositioned in the table below |
| Aderyn | all contracts | same |

CI runs compile + 45-case test suite (incl. 3 deterministic fuzz harnesses)
on every push. Slither/Aderyn are wired via the `slither-action` container;
new findings block merge until dispositioned here.

## Finding dispositions

| Finding | Contract | Disposition |
|---|---|---|
| `escrow.refund` allows agent to refund to payer | EscrowCore | **accepted by design** — the agent executed the payment on the principal's behalf; refunds always return to the recorded payer (principal), never to a third party |
| `settleExpired` is permissionless | EscrowCore | **accepted by design** — keeper-friendliness; it only accelerates settlement to the recorded payee after the window; cannot redirect funds |
| `registerExternal` has no caller restriction | EscrowCore | **accepted (testnet) / tighten before mainnet** — funds must have arrived for the recorded amount (`FUNDS_NOT_ARRIVED`); mainnet: restrict to known recorders |
| Owner functions are single-key (`onlyOwner`/`onlyVerifier`) | all | **accepted for hackathon window** — verifier key held by deployer hardware-backed wallet; two-step ownership transfer planned before demo week (plan P6) |
| Fee-on-transfer tokens break exact-amount accounting | token-dependent | **mitigated by design** — settlement token is fixed at deployment (WQIE / QUSDC-class standard ERC20); FoT tokens rejected at integration review |

## Test matrix

45 cases in `test/masterplan.test.ts`, 9 groups: registration (5), mandate
caps/windows (6), oracle quoting (4), escrow lifecycle (6), machine payment
end-to-end (5), settlement + payout automation (5), invoices (4), recurring
subscriptions (4), passport/WQIE/deterministic fuzz (6). Fuzz groups assert:
daily-cap invariant over 200 random spends, escrow single-terminal-state over
random interleavings with zero stranded funds, passport score bounded
[300, 850] over 60 random records.

## Deployment security

- Deployer key generated locally, encrypted backup, funded minimally (~$20).
- Two-phase deploy: deploy script then a verification script that re-reads
  every constructor-set address from the address book and fails loudly.
- Explorer source verification is part of the deploy's definition of done.
- Testnet rehearsal is mandatory before every mainnet deploy action.
