#!/bin/bash
# P5 STEP 2 — single clean commit, push, verify ls-remote
# Pre-flight aborts if a stray auto-commit sits on top of origin/main.
set -e
cd /home/z/my-project
export GIT_SSH=/home/z/my-project/scripts/git_ssh_paramiko.py

echo "=== 0. pre-flight: HEAD must be origin/main (no stray UUID commits) ==="
EXPECTED=$(git rev-parse origin/main)
if [ "$(git rev-parse HEAD)" != "$EXPECTED" ]; then
  echo "ABORT: HEAD != origin/main — stray commit detected"; git log --oneline -3; exit 1
fi
git status --short | head -20

echo "=== 1. stage P5 feature files + README + indexer typefix ==="
git add src/lib/networkstats.ts src/app/network/page.tsx \
        src/app/api/network-stats/route.ts src/components/network/refresh-button.tsx \
        src/app/api/indexer/route.ts \
        README.md
git status --short | head -20

echo "=== 2. single clean commit ==="
git commit -m "P5: public network stats page — live on-chain transparency (/network + /api/network-stats)" \
  -m "Reconciles raw event logs from QIE RPC (no DB of record): merchants, agents, CallPaid volume, escrow lifecycle, invoices, payouts. getLogs 10k-cap handled via 9.5k-block windows + 6-RPC rotation + client-side topic0 classification & dedupe; skippedWindows surfaced. 390px responsive verified. Includes indexer route typefix for newer Prisma client types."
git log --oneline -2

echo "=== 3. push ==="
git push origin main
echo "=== 4. verify remote head ==="
git ls-remote origin main
echo "local HEAD: $(git rev-parse HEAD)"
