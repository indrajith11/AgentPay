# AgentPay Indexer (P0)

Chain events -> idempotent SQLite ledger -> health API.
Implements Master Plan items I-01..I-06 (ch.4) and the ch.9 data architecture:
chain = source of truth, indexer = queryable projection, dashboard = renderer.

## Run

```bash
node index.js --smoke          # offline self-test (idempotency, checkpoint, heartbeat)
node index.js                  # continuous watch (QIE testnet default)
node index.js --backfill --from 8590000
```

Env: `RPC_URL`, `ADDRESS_BOOK`, `DB_FILE`, `HTTP_PORT` (default 3040),
`POLL_MS` (default 2000), `START_BLOCK`, `BACKFILL_WINDOW` (default 200k blocks).

Endpoints: `GET /health` (status, heartbeat age, checkpoints, event counts),
`GET /events?limit=50`.

## Design guarantees

- **Idempotency**: every ingest is `INSERT OR IGNORE` on `(tx_hash, log_index)`.
  Restarts, replays and backfills can never double-count a payment.
- **Checkpointing**: per-source `watcher_state.last_block`; resumes, never reprocesses.
- **Ordering**: events applied in (blockNumber, logIndex) order within a poll batch.
- **Heartbeat**: written every poll; `/health` flips to `degraded` if age > 30s.
- **Undecoded logs are kept**: raw chain truth is never dropped; ABI coverage can
  grow without backfilling from scratch (re-run `--backfill --from <checkpoint>`).
- **Range cap**: 5,000 blocks per getLogs batch (QIE RPC caps ranges at 10,000).

## Verified against QIE testnet (1983), 2026-09-15

Backfill from block 8,590,000 ingested **57 real events** across the deployed
address book - the full E2E lifecycle: MerchantRegistered/Verified,
AgentRegistered/PrincipalBound, MandateCreated x3, MandateSpent x2,
CallPaid x2, EscrowOpened x2, CallRefunded, EscrowRefunded, CallClaimed,
EscrowReleased, InvoiceCreated, InvoicePaid, PaymentReceived, Transfer x13.

21 logs currently decode as `Undecoded` (events outside the combined ABI,
e.g. PayoutProfileSet's full signature, UsdFeedSet, ProductAdded) - extend
`COMBINED_ABI` in index.js to decode them.

## Next integration (M-05)

The merchant PWA reads this SQLite file (or proxies `/health` + `/events`)
to flip a QR sale card from WAITING to PAID with zero merchant interaction.
