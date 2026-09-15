// DEMO DATA REMOVED (2026-09-15): the simulated SA/IN scene, fake ledger
// entries and random-tx simulations are gone. This module is kept only so
// existing imports keep working — it is a deliberate no-op.
//
// Real data flow:
//   - merchants self-register via POST /api/merchants (real wallet address)
//   - QR sales are verified against REAL QIE transactions by
//     /api/verify-payment (tx hash → RPC receipt → oracle USD → ledger)
//   - agent events come from the agent daemon indexing real contract events

export async function ensureSeed(): Promise<void> {
  // no-op — no demo data ships in the real build
}
