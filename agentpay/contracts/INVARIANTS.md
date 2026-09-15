# System Invariants — AgentPay x MerchantPilot

Invariants designed BEFORE the code (Master Plan ch.6). The test suite
(`test/masterplan.test.ts`) names each case after the invariant it defends.
A judge or auditor should be able to check every line below against the
contracts and the tests.

## I-1 Mandate spend safety (MandateVault)
1. No spend outside `perCallCap` — strictly `amount <= perCallCap`, else
   revert `ExceedsPerCallCap`. (tests 2.1, 9.4)
2. Cumulative same-UTC-day spend never exceeds `dailyCap` — day buckets roll
   in `_rollDay`, `spentToday` resets exactly at the day boundary. (2.2, 2.3, 9.4)
3. Spend never exceeds prepaid balance. (canSpend "BALANCE" branch)
4. Only the mandate's agent, or a caller the PRINCIPAL explicitly authorized
   (`authorizeCaller`), can move funds. (2.4, 5.2)
5. `closeMandate` returns the exact remaining balance to the principal and
   deactivates; closed mandates cannot spend. (2.6)

## I-2 Pricing truth (PayEndpoint)
6. Every USD quote derives from the official feed with `block.timestamp -
   updatedAt <= maxFeedAge` — else revert `StaleFeed`; negative answers
   rejected. (3.2, 3.3)
7. Tokens without a wired feed can never be quoted or paid — `NoFeed`. (3.4)
8. `quoteIn(productId, token) = priceUsd * 10^decimals / feedAnswer` — no
   other price source exists in the system. (3.1)

## I-3 Escrow terminality (EscrowCore)
9. An escrow moves Open -> Released OR Open -> Refunded exactly once; every
   other transition reverts (`NotOpen`). (4.4, 9.5)
10. Refund only inside the window (`WindowClosed` after) and only to the
    recorded payer. (4.1, 4.2)
11. Settlement (`settleExpired`/`release`) only after the window
    (`WindowStillOpen` before) and only to the recorded payee. (4.3, 4.5)
12. Fuzz: after random interleavings of open/refund/settle across time, no
    token remains stranded in the escrow contract. (9.5)

## I-4 Machine payment integrity (PayEndpoint)
13. `payForCall` requires: active product, eligible agent (registered +
    active + principal-bound), mandate owned by the calling agent, token
    equal to the mandate token (`TokenMismatch`), amount from the oracle
    quote. (5.1, 5.2, 5.3)
14. Funds move mandate -> escrow in a single pull; escrow records the same
    amount; `CallPaid` emitted exactly once per call.
15. Refund path (inside window) returns funds to the mandate side and records
    a late repayment in the passport; double refund reverts `CallNotOpen`. (5.5)
16. Claim path records merchant `externalEarnings` net of `feeBps` and the
    matching `feesOwed`; only the product merchant can claim. (5.4)

## I-5 Settlement accounting (SettlementRouter)
17. Only registered recorders can `credit()`/`recordExternal()` — else
    `NotAuthorized`. (6.2)
18. `credit()` forwards the fee to treasury immediately and credits net to
    the merchant; `credit` requires the funds actually arrived. (6.1)
19. Withdrawals (manual or auto) can never exceed recorded earnings. (6.3)
20. Auto-withdraw fires only when profile.active AND autoEnabled AND
    earnings >= minThreshold AND interval elapsed; it is permissionless but
    always sweeps to the merchant's own saved payout address. (6.4, 6.5)
21. Bank details never touch the chain — only `providerRef` hash. (6.4)

## I-6 Credit passport bounds (CreditPassport)
22. Score is bounded [300, 850] forever: floor at creation and after defaults
    (penalty 120), cap at 850. (9.1, 9.2, 9.6)
23. Score changes only via authorized recorders and only from emitted
    settlement events; there is no admin set-score function (seedScore is
    verifier-only, once, and only for subjects with no history).

## I-7 Wrapper conservation (WQIE)
24. totalSupply always equals the sum of wrapped native; deposit/withdraw are
    1:1 with reentrancy protection. (9.3)

## I-8 Ledger projection (off-chain, indexer + app)
25. Every ingest is idempotent on (txHash, logIndex) — replays never
    double-book. (indexer --smoke; qr-sale double-spend guard)
26. A payment tx books at most one sale across the whole system.
27. The ledger projection is rebuildable from raw chain events at any time.
