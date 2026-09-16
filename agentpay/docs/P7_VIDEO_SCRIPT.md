# P7 — Demo Video Script (recording-ready, target 3:30)

Judging weights (T&C): Innovation 30% · Technical 25% · UX 15% · Mainnet
Integration 15% · Business 15%. Every scene hits ≥2 criteria. This is the
RECORDING script (shots + verbatim narration); DEMO_SCRIPT.md remains the
live-presentation script.

---

## Recording pre-flight checklist

- [ ] Contracts on **QIE mainnet** (P6 part 2 done) — else record on testnet and
      swap the explorer overlay; script marks [MN] lines that change.
- [ ] Dashboard: `bun run dev`; endpoint service: `cd mini-services/agentpay-endpoint && bun index.ts`
- [ ] Browser window 1440×900 @100% zoom, bookmarks bar hidden, DND on.
- [ ] Terminal: font 16–18pt, only 2 tabs (curl ready lines pre-typed).
- [ ] Cursor: slow, deliberate; use cmd/ctrl+F highlight moments instead of hunting.
- [ ] Record 1080p30; audio: external mic 15 cm, clap sync per scene.
- [ ] One continuous take per scene — never across scenes; keeps cuts clean.

## Shot list & narration (verbatim)

### S1 · Hook (0:00–0:20) — screen: /network page, live numbers
**Video:** Slow scroll of the public **Network Stats** page: 26 calls paid,
3.51 QIE gross, escrow lifecycle counters, chain head ticking.
**Narration:**
> "This is not a slide — it's our live payment network, reconciled straight
> from chain events. AI agents are already buying here. In the next three
> minutes I'll show you the payment rails they use, and the credit system
> they quietly build for human merchants."

**Captions:** `AgentPay — agentic commerce on QIE mainnet` · `live on-chain stats`
**Hits:** Mainnet 15% + Innovation 30%.

### S2 · Problem (0:20–0:50) — screen: 3 static cards (slides or terminal)
**Narration:**
> "x402 proved agents will pay. But agent payments today are irreversible —
> no refunds, no identity, and cents-only caps. And the merchants serving
> them? Invisible to every credit bureau. AgentPay fixes both on QIE:
> escrowed machine payments with refund windows, and a credit passport that
> turns every agent payment into a merchant's credit history."

**Captions:** `irreversible → escrowed + refundable` · `identity-less → KYA mandates` · `no credit → CreditPassport`
**Hits:** Innovation 30% + Business 15%.

### S3 · Human rail (0:50–1:40) — screen: dashboard → Cash register QR
**Narration:**
> "First, the human rail — zero new habits. Nomvula's spaza generates a QR
> for 125 rand. The customer scans; the oracle-quoted price settles in QIE."
*(wait for the PAID flip — do not cut)*
> "Settled in under 2 seconds, fee 0.3% — BitPay charges 1–2%. Behind the
> screen, our AI staff already booked it, parked 10% to savings, and chased
> the overdue invoice."
**Captions:** `EIP-681 QR · oracle-quoted ZAR→QIE` · `0.3% vs 1–2% BitPay`
**Hits:** UX 15% + Business 15%.

### S4 · Machine rail (1:40–2:50) — screen: Machine Paywall tab → live run → terminal
**Narration:**
> "Now your first AI customer. We click Run live agent purchase — this is a
> real HTTP 402 flow against our contract suite, not a mock."
*(trace appears)*
> "402: the agent reads the terms — mandate scheme, 600-second refund window,
> price. 200: the mandate is spent inside its caps, escrow opens on-chain,
> and the payload is delivered. If the product is wrong, the agent gets a
> real refund — inside the window — straight from escrow."
**[MN] narration insert:** "— these contracts are verified on the QIE mainnet
explorer; you can read every line."
**Terminal overlay (3 curls, pre-typed):** 402 terms → 200 + escrowRef → refund OK.
**Captions:** `PayEndpoint → MandateVault → EscrowCore` · `refund window 600 s`
**Hits:** Technical 25% + Innovation 30%.

### S5 · The moat (2:50–3:20) — screen: Credit Passport tab → /network
**Narration:**
> "Every settled call feeds the merchant's Credit Passport — 300 to 850,
> on-chain, exportable to the supply-chain financiers who currently decline
> them. Same rails, real-world goods: tickets sold on the machine rail in
> our 25-check live suite."
**Captions:** `300–850 score, tier upgrades on-chain` · `25/25 live checks`
**Hits:** Business 15% + Technical 25%.

### S6 · Outro (3:20–3:30) — screen: /network again + repo QR
**Narration:**
> "AgentPay — the payment layer for the agent economy, live on QIE mainnet.
> Code, verified contracts and live stats are one scan away."
**Captions:** `github.com/indrajith11/AgentPay` · `/network — watch it live`

---

## Post-production

- Cut on claps; normalize audio −14 LUFS; captions burned in (85% opacity black bars).
- Overlay the chain-head counter subtly in S1/S6 (reinforces "live").
- Export 1080p H.264 < 200 MB; filename `AgentPay-QIE-Mainnet-Demo-v1.mp4`.
- Backup exports: 720p (Discord upload) + 60 s vertical cut of S3+S4 for traction posts.
