import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { db } from "@/lib/db";
import { serverRpcUrl, ACTIVE_CHAIN } from "@/lib/chains";
import { getQieUsd } from "@/lib/oracle";

/**
 * F1 QR sale lifecycle (Master Plan 5.1) - create a pending sale that the
 * event matcher can CONFIRM AUTOMATICALLY. No paste-tx-hash by default.
 *
 * POST { merchantId, amount } -> { saleId, uri, amountWei, qieAmount, expiresAt }
 * GET  ?id=<saleId>           -> matcher pass + status (WAITING | PAID | EXPIRED)
 *
 * Detection (per plan ch.9): targeted block scan of the delta since the last
 * poll (~1-2 blocks per pass at QIE's block time) for a successful native
 * transfer to the merchant payee with the EXACT expected wei value
 * (mismatchTolerance = 0). Idempotent: a tx can only ever book one sale.
 *
 * P2 polish: while scanning we also track the CLOSEST near-miss transfer
 * (same payee, wrong value) so the UI can surface "possible short payment"
 * failure states instead of a silent timeout — census problem P-07.
 */

const SALE_TTL_SECONDS = 300;
const MAX_BLOCKS_PER_PASS = 40;
// Trailing re-scan window: blocks this close to head are re-read every pass
// because the QIE RPC can serve them before their tx index settles.
const RESCAN_BLOCKS = 6;

// P2 latency tuning: one process-wide provider (no re-handshake per poll)
// with a static network (skips the chainId bootstrap roundtrip).
let _provider: ethers.JsonRpcProvider | null = null;
function provider() {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(serverRpcUrl(), ACTIVE_CHAIN.id, { staticNetwork: true });
  }
  return _provider;
}

// ---------- POST: create the pending sale ----------
export async function POST(req: NextRequest) {
  const { merchantId, amount } = await req.json();
  const fiat = parseFloat(String(amount));
  if (!merchantId || !isFinite(fiat) || fiat <= 0) {
    return NextResponse.json({ error: "merchantId and a positive amount are required", code: "AMOUNT_INVALID" }, { status: 400 });
  }
  const merchant = await db.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) return NextResponse.json({ error: "merchant not found", code: "MERCHANT_NOT_FOUND" }, { status: 404 });
  if (!merchant.active) return NextResponse.json({ error: "store is inactive", code: "MERCHANT_INACTIVE" }, { status: 409 });

  // oracle quote -> QIE amount (same conversion rules as the manual path)
  let qieUsd = 0n;
  let stale = false;
  try {
    const quote = await getQieUsd();
    if (quote) {
      qieUsd = quote.answer;
      stale = Date.now() / 1000 - quote.updatedAt > 26 * 3600;
    }
  } catch {
    /* reference price fallback below */
  }
  const effectivePrice = qieUsd > 0n ? qieUsd : 16000000n; // $0.16 ref, flagged
  const usdRate = merchant.currency === "ZAR" ? 0.055 : merchant.currency === "INR" ? 0.012 : 1;
  const usd = fiat * usdRate;
  // 6dp precision on QIE, matching the client math used before
  const qieAmount = usd / (Number(effectivePrice) / 1e8);
  const wei = BigInt(Math.round(qieAmount * 1e6)) * 10n ** 12n;

  const payee = (merchant.chainAddr || merchant.owner).toLowerCase();
  const refId = "sale_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const uri = `ethereum:${payee}@${ACTIVE_CHAIN.id}?value=${wei.toString()}`;

  let head = 0;
  try {
    head = await provider().getBlockNumber();
  } catch {
    /* matcher will start from 0 and use createdAt guard */
  }

  const usdCents = Math.round(usd * 100);
  const sale = await db.qrSale.create({
    data: {
      merchantId,
      refId,
      payee,
      amountWei: wei.toString(),
      qieAmount: qieAmount.toFixed(6),
      usdCents,
      status: "WAITING",
      scanFromBlock: Math.max(0, head - 2), // race guard: sale becomes scannable ~now
      lastScannedBlock: Math.max(0, head - 2),
      expiresAt: new Date(Date.now() + SALE_TTL_SECONDS * 1000),
    },
  });

  return NextResponse.json({
    saleId: sale.id,
    refId,
    uri,
    payee,
    amountWei: wei.toString(),
    qieAmount: qieAmount.toFixed(6),
    usdCents,
    oracleStale: qieUsd === 0n || stale,
    expiresAt: sale.expiresAt,
    explorer: ACTIVE_CHAIN.explorer,
  });
}

type NearMiss = { txHash: string; valueWei: string; valueQie: string; deltaWei: string; explorerUrl: string };

// ---------- GET: matcher pass + status ----------
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const sale = await db.qrSale.findUnique({ where: { id } });
  if (!sale) return NextResponse.json({ error: "sale not found" }, { status: 404 });

  if (sale.status === "PAID") {
    const paidInMs = sale.detectedAt ? sale.detectedAt.getTime() - sale.createdAt.getTime() : undefined;
    return NextResponse.json({
      status: "PAID", txHash: sale.txHash, explorerUrl: sale.explorerUrl,
      qieAmount: sale.qieAmount, usdCents: sale.usdCents, paidInMs,
    });
  }
  if (new Date() > sale.expiresAt) {
    if (sale.status !== "EXPIRED") {
      await db.qrSale.update({ where: { id }, data: { status: "EXPIRED" } });
    }
    return NextResponse.json({ status: "EXPIRED", nearMiss: await findNearMiss(sale) });
  }

  // ---- matcher pass (delta block scan, exact recipient + exact value) ----
  try {
    const p = provider();
    const head = await p.getBlockNumber();
    const from = Math.max(sale.lastScannedBlock + 1, sale.scanFromBlock);
    // scan through HEAD (not head-1): QIE finality is 1-2s, and waiting a full
    // block before looking costs ~1-2s of PAID-flip latency. The sale is still
    // protected by the createdAt filter + double-book guard by tx hash.
    const to = Math.min(head, from + MAX_BLOCKS_PER_PASS - 1);
    const expected = BigInt(sale.amountWei);
    const createdAtMs = sale.createdAt.getTime();

    if (to >= from) {
      let matched: { hash: string; block: number } | null = null;
      let near: { hash: string; value: bigint; delta: bigint } | null = null;
      // sequential walk — parallel fetches trip the QIE RPC's rate limit and
      // a failed block must NEVER be skipped past: we only advance the
      // checkpoint to the last block we actually read (lastOk).
      let lastOk = from - 1;
      for (let b = from; b <= to && !matched; b++) {
        // QIE RPC ignores ethers' prefetch flag (returns hash-only), so we call
        // eth_getBlockByNumber with full=true directly and read raw JSON fields.
        const raw = await p
          .send("eth_getBlockByNumber", ["0x" + b.toString(16), true])
          .catch(() => null);
        if (!raw || !Array.isArray(raw.transactions)) break; // retry next pass
        lastOk = b;
        const tsMs = parseInt(String(raw.timestamp), 16) * 1000;
        if (tsMs && tsMs < createdAtMs - 15_000) continue; // predates the sale
        for (const tx of raw.transactions) {
          const to_ = String(tx.to || "").toLowerCase();
          const val = BigInt(tx.value || 0);
          const from_ = String(tx.from || "").toLowerCase();
          if (to_ !== sale.payee || val === 0n || from_ === sale.payee) continue;
          if (val === expected) {
            matched = { hash: String(tx.hash), block: b };
            break;
          }
          // near-miss bookkeeping: closest wrong-value transfer to this payee
          const delta = val > expected ? val - expected : expected - val;
          // only care about plausibly-related amounts (0.1x - 10x of the bill)
          if (val > expected / 10n && val < expected * 10n && (!near || delta < near.delta)) {
            near = { hash: String(tx.hash), value: val, delta };
          }
        }
      }
      // Checkpoint rule v2 (re-scan window): QIE's RPC can serve ANY recent
      // block a moment before its transaction index settles — proven live when
      // a payment landed in block 8600216 while the matcher scanned clean
      // through it (block served with an empty tx list on first read). The old
      // rule only re-read the head block; that is not enough. We now never
      // checkpoint the trailing RESCAN_BLOCKS: every pass re-reads them, so a
      // block whose tx list settles late is re-scanned for up to ~6-12s of
      // chain time. Cost: +6 block reads per pass, trivially cheap. Safety:
      // idempotent — a tx can only ever book one sale (dupe guard below).
      await db.qrSale.update({
        where: { id },
        data: { lastScannedBlock: Math.min(lastOk, head - 1) - RESCAN_BLOCKS },
      });

      if (matched) {
        // double-spend guard: this tx must not already be booked for anyone
        const dupe = await db.ledgerEntry.findFirst({
          where: { label: { contains: matched.hash.slice(0, 18) } },
        });
        const paidInMs = Date.now() - createdAtMs;
        if (dupe) {
          await db.qrSale.update({
            where: { id },
            data: { status: "PAID", txHash: matched.hash, blockNumber: matched.block, detectedAt: new Date() },
          });
          return NextResponse.json({ status: "PAID", txHash: matched.hash, alreadyBooked: true, paidInMs, explorerUrl: `${ACTIVE_CHAIN.explorer}tx/${matched.hash}` });
        }
        await bookSale(sale, matched.hash, matched.block);
        return NextResponse.json({
          status: "PAID",
          txHash: matched.hash,
          explorerUrl: `${ACTIVE_CHAIN.explorer}tx/${matched.hash}`,
          qieAmount: sale.qieAmount,
          usdCents: sale.usdCents,
          paidInMs,
        });
      }

      // surface a short/over payment only once the exact payment had a fair
      // chance to land (8s) — keeps the hot path clean
      if (near && Date.now() - createdAtMs > 8_000) {
        return NextResponse.json({ status: "WAITING", scanningTo: to, nearMiss: toNearMiss(near) });
      }
    }

    return NextResponse.json({ status: "WAITING", scanningTo: to });
  } catch (e) {
    return NextResponse.json({ status: "WAITING", note: "scanner busy: " + String(e).slice(0, 80) });
  }
}

function toNearMiss(near: { hash: string; value: bigint; delta: bigint }): NearMiss {
  return {
    txHash: near.hash,
    valueWei: near.value.toString(),
    valueQie: (Number(near.value) / 1e18).toFixed(6),
    deltaWei: near.delta.toString(),
    explorerUrl: `${ACTIVE_CHAIN.explorer}tx/${near.hash}`,
  };
}

/** Rescan the whole sale window for the closest wrong-value transfer (used on expiry). */
async function findNearMiss(sale: { payee: string; amountWei: string; createdAt: Date; scanFromBlock: number }): Promise<NearMiss | undefined> {
  try {
    const p = provider();
    const head = await p.getBlockNumber();
    const expected = BigInt(sale.amountWei);
    const createdAtMs = sale.createdAt.getTime();
    let near: { hash: string; value: bigint; delta: bigint } | null = null;
    for (let b = sale.scanFromBlock; b <= head - 1 && b <= sale.scanFromBlock + 120; b++) {
      const raw = await p.send("eth_getBlockByNumber", ["0x" + b.toString(16), true]).catch(() => null);
      if (!raw || !Array.isArray(raw.transactions)) continue;
      const tsMs = parseInt(String(raw.timestamp), 16) * 1000;
      if (tsMs && tsMs < createdAtMs - 15_000) continue;
      for (const tx of raw.transactions) {
        const to_ = String(tx.to || "").toLowerCase();
        const val = BigInt(tx.value || 0);
        const from_ = String(tx.from || "").toLowerCase();
        if (to_ !== sale.payee || val === 0n || val === expected || from_ === sale.payee) continue;
        if (val <= expected / 10n || val >= expected * 10n) continue;
        const delta = val > expected ? val - expected : expected - val;
        if (!near || delta < near.delta) near = { hash: String(tx.hash), value: val, delta };
      }
    }
    return near ? toNearMiss(near) : undefined;
  } catch {
    return undefined;
  }
}

// ---------- booking (mirrors verify-payment's real accounting) ----------
async function bookSale(
  sale: { id: string; merchantId: string; amountWei: string; qieAmount: string; usdCents: number | null; refId: string },
  txHash: string,
  blockNumber: number
) {
  const qieWei = BigInt(sale.amountWei);
  let qieUsd = 0n;
  let oracleNote = "oracle-unavailable";
  try {
    const quote = await getQieUsd();
    if (quote) {
      qieUsd = quote.answer;
      oracleNote = `QIE/USD ${(Number(quote.answer) / 1e8).toFixed(4)} (${quote.source})`;
    }
  } catch {
    /* keep note */
  }

  let amountCents: number;
  if (qieUsd > 0n) {
    const usd = (qieWei * qieUsd) / 10n ** 18n;
    amountCents = Number(usd / 10n ** 6n);
  } else {
    const usd = (qieWei * 16000000n) / 10n ** 18n;
    amountCents = Number(usd / 10n ** 6n);
  }
  const fee = Math.round(amountCents * 0.003);
  const short = `${txHash.slice(0, 10)}…${txHash.slice(-6)}`;

  await db.ledgerEntry.create({
    data: { merchantId: sale.merchantId, kind: "SALE", date: new Date(), label: `QR sale (auto) — ${sale.qieAmount} QIE · tx ${short}`, amountCents },
  });
  await db.ledgerEntry.create({
    data: { merchantId: sale.merchantId, kind: "FEE", date: new Date(), label: `AgentPay fee 0.3% · tx ${short}`, amountCents: -fee },
  });
  await db.agentEvent.create({
    data: {
      merchantId: sale.merchantId,
      kind: "RECONCILIATION",
      title: "QR sale auto-confirmed",
      detail: `${sale.qieAmount} QIE detected in block ${blockNumber} by the event matcher (exact payee + exact value). ${oracleNote}. Booked with zero merchant interaction.`,
      amountCents,
    },
  });
  await db.qrSale.update({
    where: { id: sale.id },
    data: {
      status: "PAID",
      txHash,
      blockNumber,
      detectedAt: new Date(),
      explorerUrl: `${ACTIVE_CHAIN.explorer}tx/${txHash}`,
      usdCents: amountCents,
    },
  });
}
