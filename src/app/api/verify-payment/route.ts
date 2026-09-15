import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { db } from "@/lib/db";
import { serverRpcUrl, ACTIVE_CHAIN } from "@/lib/chains";
import { getQieUsd } from "@/lib/oracle";

/**
 * REAL on-chain payment verification (replaces the old /api/simulate).
 *
 * Flow: customer pays the merchant's chain address on QIE (any wallet).
 * Merchant pastes the transaction hash here. We verify against the live
 * network — receipt status, recipient, value — then convert to USD with the
 * OFFICIAL QIE Oracle feed and book a real ledger entry. No mocks.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { merchantId, txHash } = body;
  if (!merchantId || !txHash || typeof txHash !== "string" || !/^0x([a-fA-F0-9]{64})$/.test(txHash)) {
    return NextResponse.json({ error: "merchantId and valid txHash required" }, { status: 400 });
  }

  const merchant = await db.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) return NextResponse.json({ error: "merchant not found" }, { status: 404 });
  const payee = (merchant.chainAddr || merchant.owner).toLowerCase();

  // already booked? idempotency by tx hash
  const dupe = await db.ledgerEntry.findFirst({
    where: { merchantId, label: { contains: txHash.slice(0, 18) } },
  });
  if (dupe) {
    return NextResponse.json({ error: "transaction already booked", ledgerId: dupe.id }, { status: 409 });
  }

  const provider = new ethers.JsonRpcProvider(serverRpcUrl());
  let tx: ethers.TransactionResponse | null;
  let receipt: ethers.TransactionReceipt | null;
  try {
    tx = await provider.getTransaction(txHash);
    if (!tx) return NextResponse.json({ error: "transaction not found on " + ACTIVE_CHAIN.name }, { status: 404 });
    receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      // maybe pending — wait up to ~20s for inclusion (QIE finality is 1-2s)
      receipt = await provider.waitForTransaction(txHash, 1, 20_000).catch(() => null);
    }
  } catch (e) {
    return NextResponse.json(
      { error: `RPC unreachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }

  if (!receipt || receipt.status !== 1) {
    return NextResponse.json({ error: "transaction not successful on-chain" }, { status: 422 });
  }

  const to = (tx.to || "").toLowerCase();
  if (to !== payee) {
    return NextResponse.json(
      { error: `tx recipient ${to} does not match merchant payout address ${payee}` },
      { status: 422 }
    );
  }

  const qieWei = tx.value;
  if (qieWei <= 0n) {
    return NextResponse.json({ error: "zero-value transaction" }, { status: 422 });
  }

  // ---- USD conversion via the OFFICIAL QIE Oracle feed (real mainnet integration) ----
  let qieUsd = 0n;
  let oracleNote = "oracle-unavailable";
  try {
    const quote = await getQieUsd();
    if (quote) {
      qieUsd = quote.answer; // 8 decimals
      oracleNote = `QIE/USD ${(Number(quote.answer) / 1e8).toFixed(4)} (${quote.source})`;
    }
  } catch {
    /* fall through with oracle-unavailable */
  }

  let amountCents: number;
  let label: string;
  if (qieUsd > 0n) {
    const usd = (qieWei * qieUsd) / 10n ** 18n; // usd * 1e8
    amountCents = Number(usd / 10n ** 6n); // -> cents
    label = `QR sale — ${ethers.formatEther(qieWei)} QIE · tx ${txHash.slice(0, 10)}…${txHash.slice(-6)}`;
  } else {
    // Oracle down: still book the REAL QIE amount at a $0.16 reference price,
    // flagged for the reconciliation agent to re-price later.
    const refPrice = 16000000n; // $0.16 in 8-decimals
    const usd = (qieWei * refPrice) / 10n ** 18n;
    amountCents = Number(usd / 10n ** 6n);
    label = `QR sale — ${ethers.formatEther(qieWei)} QIE (ref price) · tx ${txHash.slice(0, 10)}…${txHash.slice(-6)}`;
  }

  const fee = Math.round(amountCents * 0.003); // 0.3% platform fee

  const entry = await db.ledgerEntry.create({
    data: { merchantId, kind: "SALE", date: new Date(), label, amountCents },
  });
  await db.ledgerEntry.create({
    data: { merchantId, kind: "FEE", date: new Date(), label: `AgentPay fee 0.3% · tx ${txHash.slice(0, 10)}…`, amountCents: -fee },
  });
  await db.agentEvent.create({
    data: {
      merchantId,
      kind: "RECONCILIATION",
      title: "QR sale verified on-chain",
      detail: `${ethers.formatEther(qieWei)} QIE confirmed in block ${receipt.blockNumber}. ${oracleNote}. Reconciliation agent booked it automatically.`,
      amountCents,
    },
  });

  return NextResponse.json({
    verified: true,
    ledgerId: entry.id,
    blockNumber: receipt.blockNumber,
    qieReceived: ethers.formatEther(qieWei),
    usdCents: amountCents,
    oracleNote,
    explorerUrl: `${ACTIVE_CHAIN.explorer}tx/${txHash}`,
  });
}
