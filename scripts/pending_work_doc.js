// AgentPay — Pending Work & Next Steps (report, English, R1 cover, Dawn Mist Tech)
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, PageNumber, NumberFormat, SectionType,
  AlignmentType, HeadingLevel, WidthType, BorderStyle, ShadingType,
  TableOfContents, PageBreak, TableLayoutType,
} = require("docx");
const fs = require("fs");

// ---------- palette: Dawn Mist Tech ----------
const PAL = {
  primary: "0A1628", body: "1A2B40", secondary: "6878A0",
  accent: "5B8DB8", surface: "F4F8FC",
};
const COVER = {
  bg: "0A1628", titleColor: "FFFFFF", subtitleColor: "C9D6E8",
  metaColor: "9FB4D0", accent: "5B8DB8", footerColor: "8090A8",
};

// ---------- border constants (mandatory) ----------
const NB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: NB, bottom: NB, left: NB, right: NB };
const allNoBorders = { top: NB, bottom: NB, left: NB, right: NB, insideHorizontal: NB, insideVertical: NB };

// ---------- cover helpers (from design-system.md) ----------
function splitTitleLines(title, charsPerLine) {
  if (title.length <= charsPerLine) return [title];
  const breakAfter = new Set([...",.;:!?", ..."-_\u2014\u2013\u00b7/", ..." \t"]);
  const lines = [];
  let remaining = title;
  while (remaining.length > charsPerLine) {
    let breakAt = -1;
    for (let i = charsPerLine; i >= Math.floor(charsPerLine * 0.6); i--) {
      if (i < remaining.length && breakAfter.has(remaining[i - 1])) { breakAt = i; break; }
    }
    if (breakAt === -1) {
      const limit = Math.min(remaining.length, Math.ceil(charsPerLine * 1.3));
      for (let i = charsPerLine + 1; i < limit; i++) {
        if (breakAfter.has(remaining[i - 1])) { breakAt = i; break; }
      }
    }
    if (breakAt === -1) breakAt = charsPerLine;
    lines.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }
  if (remaining) lines.push(remaining);
  if (lines.length > 1 && lines[lines.length - 1].length <= 2) {
    const last = lines.pop();
    lines[lines.length - 1] += last;
  }
  return lines;
}
function calcTitleLayout(title, maxWidthTwips, preferredPt = 40, minPt = 24) {
  // English chars are ~half CJK width; use pt*11 as effective char width
  const charWidth = (pt) => pt * 11;
  const charsPerLine = (pt) => Math.floor(maxWidthTwips / charWidth(pt));
  let titlePt = preferredPt, lines;
  while (titlePt >= minPt) {
    const cpl = charsPerLine(titlePt);
    if (cpl < 2) { titlePt -= 2; continue; }
    lines = splitTitleLines(title, cpl);
    if (lines.length <= 3) break;
    titlePt -= 2;
  }
  if (!lines || lines.length > 3) { lines = splitTitleLines(title, charsPerLine(minPt)); titlePt = minPt; }
  return { titlePt, titleLines: lines };
}
function calcCoverSpacing(params) {
  const { titleLineCount = 1, titlePt = 36, hasSubtitle = false, hasEnglishLabel = false,
    metaLineCount = 0, fixedHeight = 800, pageHeight = 16838, marginTop = 0, marginBottom = 0 } = params;
  const SAFETY = 1200;
  const usableHeight = pageHeight - marginTop - marginBottom - SAFETY;
  const titleHeight = titleLineCount * (titlePt * 23 + 200);
  const subtitleHeight = hasSubtitle ? (12 * 23 + 600) : 0;
  const englishLabelHeight = hasEnglishLabel ? (9 * 23 + 600) : 0;
  const metaHeight = metaLineCount * (10 * 23 + 100);
  const implicitParaHeight = 3 * 300;
  const contentHeight = titleHeight + subtitleHeight + englishLabelHeight + metaHeight + fixedHeight + implicitParaHeight;
  const remainingSpace = usableHeight - contentHeight;
  const safeRemaining = Math.max(remainingSpace, 400);
  const FOOTER_MIN = 800;
  const rawTop = Math.floor(safeRemaining * 0.45);
  const rawBottom = Math.floor(safeRemaining * 0.45);
  const bottomSpacing = Math.max(rawBottom, FOOTER_MIN);
  const topSpacing = Math.max(rawTop - Math.max(0, FOOTER_MIN - rawBottom), 400);
  const midSpacing = Math.max(safeRemaining - topSpacing - bottomSpacing, 0);
  return { topSpacing, midSpacing, bottomSpacing };
}

// ---------- Recipe R1: Pure Paragraph Cover ----------
function buildCoverR1(config) {
  const P = config.palette;
  const padL = 1200, padR = 800;
  const availableWidth = 11906 - padL - padR - 300;
  const { titlePt, titleLines } = calcTitleLayout(config.title, availableWidth, 40, 24);
  const titleSize = titlePt * 2;
  const spacing = calcCoverSpacing({
    titleLineCount: titleLines.length, titlePt,
    hasSubtitle: !!config.subtitle, hasEnglishLabel: !!config.englishLabel,
    metaLineCount: (config.metaLines || []).length, fixedHeight: 400,
  });
  const accentLeft = { style: BorderStyle.SINGLE, size: 8, color: P.accent, space: 12 };
  const children = [];
  children.push(new Paragraph({ spacing: { before: spacing.topSpacing } }));
  if (config.englishLabel) {
    children.push(new Paragraph({
      indent: { left: padL, right: padR }, spacing: { after: 500 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: P.accent, space: 8 } },
      children: [new TextRun({ text: config.englishLabel.split("").join("  "),
        size: 18, color: P.accent, font: { ascii: "Calibri", eastAsia: "SimHei" }, characterSpacing: 40 })],
    }));
  }
  for (let i = 0; i < titleLines.length; i++) {
    children.push(new Paragraph({
      indent: { left: padL },
      spacing: { after: i < titleLines.length - 1 ? 100 : 300, line: Math.ceil(titlePt * 23), lineRule: "atLeast" },
      children: [new TextRun({ text: titleLines[i], size: titleSize, bold: true,
        color: P.titleColor, font: { eastAsia: "SimHei", ascii: "Arial" } })],
    }));
  }
  if (config.subtitle) {
    children.push(new Paragraph({
      indent: { left: padL }, spacing: { after: 800 },
      children: [new TextRun({ text: config.subtitle, size: 24, color: P.subtitleColor,
        font: { eastAsia: "Microsoft YaHei", ascii: "Arial" } })],
    }));
  }
  for (const line of (config.metaLines || [])) {
    children.push(new Paragraph({
      indent: { left: padL + 200 }, spacing: { after: 80 },
      border: { left: accentLeft },
      children: [new TextRun({ text: line, size: 24, color: P.metaColor,
        font: { eastAsia: "Microsoft YaHei", ascii: "Arial" } })],
    }));
  }
  children.push(new Paragraph({ spacing: { before: spacing.bottomSpacing } }));
  children.push(new Paragraph({
    indent: { left: padL, right: padR },
    border: { top: { style: BorderStyle.SINGLE, size: 2, color: P.accent, space: 8 } },
    spacing: { before: 200 },
    children: [
      new TextRun({ text: config.footerLeft || "", size: 16, color: P.footerColor, font: { ascii: "Arial" } }),
      new TextRun({ text: "                                        " }),
      new TextRun({ text: config.footerRight || "", size: 16, color: P.footerColor, font: { ascii: "Arial" } }),
    ],
  }));
  return [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: allNoBorders,
    rows: [new TableRow({
      height: { value: 16838, rule: "exact" },
      children: [new TableCell({
        shading: { type: ShadingType.CLEAR, fill: P.bg }, borders: noBorders,
        children,
      })],
    })],
  })];
}

// ---------- body builders (English formal profile) ----------
const EN = { ascii: "Times New Roman", eastAsia: "Times New Roman" };
function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 160, line: 380, lineRule: "atLeast" },
    children: [new TextRun({ text, bold: true, size: 32, color: PAL.primary, font: EN })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120, line: 350, lineRule: "atLeast" },
    children: [new TextRun({ text, bold: true, size: 28, color: PAL.primary, font: EN })],
  });
}
function body(text, opts = {}) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    spacing: { line: 312, after: opts.after ?? 120 },
    children: (Array.isArray(text) ? text : [{ t: text }]).map(r =>
      new TextRun({ text: r.t, bold: !!r.b, size: 24, color: r.c || PAL.body, font: EN })),
  });
}
function tableTitle(text) {
  return new Paragraph({
    keepNext: true, spacing: { before: 160, after: 80 },
    children: [new TextRun({ text, bold: true, size: 21, color: PAL.secondary, font: EN })],
  });
}
function mkTable(headers, rows, widths) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: PAL.accent },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: PAL.accent },
      left: NB, right: NB,
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "D0D8E4" },
      insideVertical: NB,
    },
    rows: [
      new TableRow({
        tableHeader: true, cantSplit: true,
        children: headers.map((text, i) => new TableCell({
          children: [new Paragraph({ spacing: { line: 276 }, children: [new TextRun({ text, bold: true, size: 20, color: PAL.primary, font: EN })] })],
          shading: { type: ShadingType.CLEAR, fill: PAL.surface },
          margins: { top: 60, bottom: 60, left: 120, right: 120 },
          width: { size: widths[i], type: WidthType.PERCENTAGE },
        })),
      }),
      ...rows.map((row, ri) => new TableRow({
        cantSplit: true,
        children: row.map((cell, i) => new TableCell({
          children: (Array.isArray(cell) ? cell : [cell]).map(txt => new Paragraph({
            spacing: { line: 276 },
            children: [new TextRun({ text: typeof txt === "object" ? txt.t : txt, bold: typeof txt === "object" && !!txt.b, size: 20, color: typeof txt === "object" && txt.c ? txt.c : PAL.body, font: EN })],
          })),
          shading: ri % 2 === 1 ? { type: ShadingType.CLEAR, fill: "FAFCFE" } : undefined,
          margins: { top: 60, bottom: 60, left: 120, right: 120 },
          width: { size: widths[i], type: WidthType.PERCENTAGE },
        })),
      })),
    ],
  });
}
function pageNumFooter() {
  return new Footer({ children: [new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "808080", font: EN })],
  })] });
}
function docHeader() {
  return new Header({ children: [new Paragraph({
    alignment: AlignmentType.RIGHT,
    border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: "D0D8E4", space: 4 } },
    children: [new TextRun({ text: "AgentPay \u00d7 MerchantPilot \u2014 Pending Work & Next Steps", size: 18, color: "808080", font: EN })],
  })] });
}

// ---------- content ----------
const bodyChildren = [];

// 1. Executive summary
bodyChildren.push(h1("1. Executive Summary"));
bodyChildren.push(body("This register answers a single question with verifiable evidence: what remains to be done on AgentPay before the QIE Hackathon 3.0 submission closes on 30 November 2026, and in which order it should be executed. It follows a full from-scratch audit performed on 16 September 2026, in which every previously delivered phase was re-verified live rather than trusted from memory. The audit re-ran the 45-case contract test suite (all passing, including three randomized fuzz suites), the 26-point deployment smoke (26/26 PASS on testnet 1983), the QR cash-register end-to-end suite (ALL PASS, payment-to-PAID in 8.55 seconds of which only 2.69 seconds is application latency), and the ticketing end-to-end suite (25/25 PASS with exact budget accounting of 0.4/0.4 WQIE)."));
bodyChildren.push(body("The result is that no engineering debt blocks the roadmap: all six delivered phases are green, and the remaining work concentrates in four areas. First, the QIE mainnet deployment (P6 part 2) is fully prepared and rehearsed, and is blocked only by a single external dependency \u2014 funding the deployer wallet with 0.05\u20130.1 QIE of mainnet gas. Second, the traction layer (P5) \u2014 a judge-visible, on-chain-derived Network Stats page \u2014 starts immediately after this register and requires no funding. Third, the demo video (P7) and the final submission check (P8) schedule behind those two items so the recorded story can include mainnet addresses and live network metrics. Fourth, two small quality leftovers (a real-authenticator passkey test and refund-paired ledger rows) are scheduled opportunistically."));
bodyChildren.push(body([{ t: "The single action the team must take outside this workspace: " }, { t: "send 0.05\u20130.1 native QIE on QIE mainnet (chain ID 1990) to the deployer address 0xe91d9ddad8B1d13038aBe8A91F2573bF92583dBc", b: true }, { t: ". Everything else in this register is executable by the build agent without further input." }]));

// 2. Status snapshot
bodyChildren.push(h1("2. Current Status Snapshot \u2014 Verified 16 September 2026"));
bodyChildren.push(body("The snapshot below reflects the audited state, not aspirational status. \u201cVerified\u201d means the proof artifact was re-generated live during the 16 September audit and matched expectations. The repository head at audit time is commit 141cbe9 on github.com/indrajith11/AgentPay, pushed and confirmed via a remote listing, and a matching source archive (AgentPay-source-141cbe9.zip) was produced from the exact committed tree. The working tree contained no uncommitted differences from that commit at audit end."));
bodyChildren.push(tableTitle("Table 1: Phase status with live-verified proof"));
bodyChildren.push(mkTable(
  ["Phase / layer", "Status", "Proof re-generated 16 Sep"],
  [
    ["P0 Contracts (11) + indexer \u2014 testnet 1983", [{ t: "VERIFIED", b: true, c: "2E7D32" }], "45/45 tests incl. 3 fuzz suites; 26/26 smoke; all 10 sources \u201cPass - Verified\u201d on testnet explorer"],
    ["P1 Wallet + SIWE auth", [{ t: "VERIFIED", b: true, c: "2E7D32" }], "Production build clean; session 401 in 10 ms; nonce issues real SIWE; oracle price $0.1799 fresh; login renders at 390 px with zero console errors"],
    ["P2 QR cash register", [{ t: "VERIFIED", b: true, c: "2E7D32" }], "E2E ALL PASS: near-miss tx-matched and never booked; PAID flip 2.69 s after mining; SALE ledger row exact"],
    ["P3 Agent SDK + 3 reference agents", [{ t: "VERIFIED", b: true, c: "2E7D32" }], "tsc --noEmit clean; mandate ABI field order confirmed against live chain (mandates 6/10)"],
    ["P4 Ticketing on machine rail", [{ t: "VERIFIED", b: true, c: "2E7D32" }], "25/25 PASS on mandate 11: redeem/replay/void/restock, VIP scarcity, SOLD_OUT recovery, DAILY_CAP preflight, demo mode"],
    ["x402 endpoint service", [{ t: "VERIFIED", b: true, c: "2E7D32" }], "Boots; 402 terms complete; demo purchases via suite section I"],
    ["Agent daemon (3 loops)", [{ t: "VERIFIED", b: true, c: "2E7D32" }], "Reconciliation indexed 4 events gross 0.4; collections scanned; treasury watching; re-ingest adds 0 duplicate rows"],
    ["P6 part 1 \u2014 mainnet preflight + pipeline", [{ t: "COMMITTED", b: true, c: "1F4E79" }], "Commit 141cbe9 pushed and remote-verified; official QIE/USDT oracle feed confirmed live on mainnet"],
  ],
  [30, 14, 56]
));
bodyChildren.push(body("Two findings emerged from the audit and were fixed within it. The agent daemon referenced an .env.example file in its setup documentation that did not exist in the repository; the file now ships with all ten contract addresses and every environment variable documented. The mainnet RPC entries in the Hardhat configuration and the SDK network registry pointed at dead hostnames; both were corrected to the verified working endpoints and are covered by the preflight probe so the error class cannot recur silently.", { after: 200 }));

// 3. Pending work register
bodyChildren.push(h1("3. Pending Work Register \u2014 Prioritized"));
bodyChildren.push(body("The register is ordered by dependency and by impact on judging. The judging weights are Innovation 30, Technical 25, User Experience 15, Mainnet 15 and Business 15; items W1 and W2 directly secure the Mainnet and Business weights respectively, which is why they lead the queue. Effort estimates assume the build agent works without interruption and exclude the external funding wait on W1."));
bodyChildren.push(tableTitle("Table 2: Pending items with priority, blocker and owner"));
bodyChildren.push(mkTable(
  ["ID", "Item", "Priority", "Blocked by", "Owner", "Effort"],
  [
    ["W1", "P6 part 2: mainnet deploy to chain 1990 + explorer source verification + SDK/README address wiring", [{ t: "HIGH", b: true }], "0.05\u20130.1 QIE mainnet gas (user action)", "User funds; agent executes", "~30 min after funding"],
    ["W2", "P5 traction: public Network Stats page from live on-chain events", [{ t: "HIGH", b: true }], "None \u2014 starts now", "Agent (this session)", "1 session"],
    ["W3", "Passkey step-up E2E with a real authenticator (WebAuthn)", "MEDIUM", "Needs a human finger/face at the browser", "User + agent", "15 min"],
    ["W4", "Refund-paired rows in the daemon daily ledger CSV", "LOW", "None", "Agent", "20 min"],
    ["W5", "P7 demo video: script polish + screen recording + deck", [{ t: "HIGH", b: true }], "Best recorded after W1 + W2", "Agent records; user reviews", "1\u20132 sessions"],
    ["W6", "P8 final submission checklist per official rules", [{ t: "HIGH", b: true }], "After W1, W2, W5", "Agent", "1 session"],
  ],
  [7, 40, 12, 17, 12, 12]
));

// 4. Action plan
bodyChildren.push(h1("4. Action Plan \u2014 Execution Detail per Item"));
bodyChildren.push(h2("4.1 W1 \u2014 Mainnet deployment (P6 part 2)"));
bodyChildren.push(body("Once the deployer wallet holds gas, the entire sequence is one scripted run: execute npx hardhat run scripts/deploy.ts --network qieMainnet, which deploys all ten contracts in dependency order, wires the relayer and recorder roles, and points the USD feed at the official QIE Oracle QIE/USDT aggregator that was verified live on mainnet at $0.18001654 with a fresh heartbeat. The deploy script writes a per-contract journal (address, constructor arguments, transaction hash and gas used) into addresses/qieMainnet.json. The 26-point smoke then runs read-only against mainnet, and the source-verification script pushes the exact solc standard-JSON input plus ABI-encoded constructor arguments to the explorer API and polls each contract to \u201cPass - Verified\u201d. Measured rehearsal cost is approximately 13.6 million gas, about 0.015 QIE at the observed 1.125 gwei; the requested 0.05\u20130.1 QIE therefore carries a three-to-six-fold safety buffer. The finish line is: SDK qieMainnet registry filled, README address table added, one commit pushed, remote listing confirmed."));
bodyChildren.push(h2("4.2 W2 \u2014 Network Stats page (P5 traction)"));
bodyChildren.push(body("Judges reward traction evidence, and the most credible traction evidence available to this project is the chain itself. The build adds one public API route that aggregates, directly from RPC event reads: verified merchants, registered agents with bound principals, machine calls paid (count and gross volume), escrows settled versus refunded, ticket sales and redemptions, and invoice/subscription activity \u2014 all scoped to the deployed contracts on testnet 1983 with the mainnet slot ready. A public dashboard page renders the counters with live latency badges and explorer links for every headline transaction. The definition of done is: page reachable without authentication, numbers reconciling against the E2E proof artifacts from P2/P4, lint and production build clean, one commit pushed. This converts the audit\u2019s verified history into a persistent, judge-visible Business-weight asset."));
bodyChildren.push(h2("4.3 W3 \u2014 Passkey step-up E2E (real authenticator)"));
bodyChildren.push(body("The WebAuthn passkey step-up routes have been live since P1, but the final proof requires a physical authenticator, which only a human can provide. The run is fifteen minutes: the user opens the dashboard in a browser, enrolls a passkey on the security card, and performs the step-up challenge on a sensitive action. The agent asserts that the server verifies the attestation and that the UI reflects the elevated session. If no authenticator is available on judge day, the feature degrades honestly \u2014 the card explains enrollment is device-dependent \u2014 which is why this item is MEDIUM rather than HIGH."));
bodyChildren.push(h2("4.4 W4 \u2014 Refund-paired ledger rows"));
bodyChildren.push(body("The audit found one honest limitation worth one small fix: the daemon\u2019s daily CSV records CallPaid events at gross, so a call that was later refunded (such as the sold-out ticket recovery) appears without its compensating CallRefunded row, while the application feed correctly excludes it. The fix pairs each refund event into the same CSV with a reference to the original call, making the file reconciliation-grade. Effort is twenty minutes plus a re-run of the daemon boot smoke to confirm the row count and totals."));
bodyChildren.push(h2("4.5 W5 \u2014 Demo video (P7)"));
bodyChildren.push(body("The demo script exists at agentpay/docs/DEMO_SCRIPT.md; recording is deliberately scheduled after W1 and W2 so the story includes a mainnet explorer link and the live Network Stats page. The recorded arc follows the judge-day path: wallet sign-in, QR sale flipping to PAID in under three seconds, an agent buying a ticket on the machine rail with pre-flight cap enforcement, the redeem-and-replay-guard demonstration, and the treasury auto-withdraw keeper. The agent records and cuts; the user reviews one edit round before it is marked final."));
bodyChildren.push(h2("4.6 W6 \u2014 Final submission check (P8)"));
bodyChildren.push(body("The official checklist requires: mainnet deployment with verified sources, a live public application, an open-source repository with documentation, a demo video, a team presentation deck, and exactly one submission before 30 November 2026. The final session walks that list item by item, refreshes the README evidence tables, produces the final source archive, and re-verifies the remote head. Nothing in this register is allowed to remain uncommitted at submission time."));

// 5. Risks & operational notes
bodyChildren.push(h1("5. Risks, Dependencies & Operational Notes"));
bodyChildren.push(body([{ t: "Mainnet gas is the single hard external dependency. ", b: true }, { t: "The deployer wallet 0xe91d9ddad8B1d13038aBe8A91F2573bF92583dBc holds zero native QIE on chain 1990. All preflight work that does not require gas \u2014 RPC validation, oracle feed verification, deploy journaling, verification pipeline, in-memory rehearsal \u2014 is already complete, so funding converts directly into a deployed-and-verified mainnet presence within half an hour." }]));
bodyChildren.push(body("Testnet economics remain workable but thin, and the audit quantified them. The funder wallet\u2019s native dust fell below the QR suite\u2019s honest 0.0001 ZAR bill floor during the audit; 0.002 WQIE was unwrapped to native to restore headroom, leaving 0.4544 WQIE for future mandates. Gas prices near seven wei mean contract operations are effectively free; the binding constraint is payment principal, not gas. The faucet enforces a 24-hour cooldown per address, so any top-up plan should not assume instant refills."));
bodyChildren.push(body("Two workspace behaviors are worth remembering. First, the sandbox periodically auto-commits dirty files under random UUID messages; the mitigation is already standard practice \u2014 commit each phase deliberately and reset any stray before pushing, which kept the public history clean through both audit sessions. Second, the QIE RPC surface has known quirks that the codebase now defends against in depth: a trailing six-block re-scan window for payment matching, 1.5\u00d7 plus 100k gas headroom on deep calls, and status-zero safe-retry against stale load-balanced replicas. Judge-day operations should keep the dashboard on port 3000 and the endpoint service on port 3030 running for the full session, as the health endpoint reports both."));

// 6. Immediate next steps
bodyChildren.push(h1("6. Immediate Next Steps"));
bodyChildren.push(body("The build agent starts W2 immediately after issuing this register: the Network Stats API route and public page are implemented, verified against the chain, linted and production-built, then pushed as a single P5 commit with the README updated per the per-phase discipline already followed for P0 through P6 part 1. The audit evidence tables in this document give the page its expected baseline numbers, which serves as the acceptance test."));
bodyChildren.push(body("In parallel, one user action unlocks the highest-priority engineering item: sending 0.05\u20130.1 native QIE on QIE mainnet (chain ID 1990) to 0xe91d9ddad8B1d13038aBe8A91F2573bF92583dBc, then replying \u201cdone\u201d in the working session. On confirmation, the agent executes the W1 sequence end to end and reports the mainnet contract addresses with explorer links. W3 can be completed at any convenient moment the user has a browser with a biometric-capable authenticator available; W4, W5 and W6 follow in the order set by the register."));

// ---------- assemble ----------
const pgSize = { width: 11906, height: 16838 };
const pgMargin = { top: 1440, bottom: 1440, left: 1701, right: 1417 };

const doc = new Document({
  styles: { default: { document: {
    run: { font: EN, size: 24, color: PAL.body },
    paragraph: { spacing: { line: 312 } },
  }}},
  sections: [
    { // Section 1: cover — no footer, no page number
      properties: { page: { size: pgSize, margin: { top: 0, bottom: 0, left: 0, right: 0 } } },
      children: buildCoverR1({
        title: "AgentPay \u2014 Pending Work & Next Steps",
        subtitle: "Status register after the full-system audit \u00b7 what remains before submission",
        englishLabel: "STATUS REGISTER",
        metaLines: [
          "Competition: QIE Hackathon 3.0 \u00b7 Track 04 (Commerce & Real World)",
          "Repository: github.com/indrajith11/AgentPay @ 141cbe9 (push-verified)",
          "Testnet 1983: live \u00b7 Mainnet 1990: preflighted, awaiting gas funding",
          "Date: 16 September 2026",
        ],
        footerLeft: "AgentPay \u00d7 MerchantPilot",
        footerRight: "Internal working document",
        palette: COVER,
      }),
    },
    { // Section 2: TOC — Roman numerals
      properties: {
        type: SectionType.NEXT_PAGE,
        page: { size: pgSize, margin: pgMargin, pageNumbers: { start: 1, formatType: NumberFormat.UPPER_ROMAN } },
      },
      headers: { default: docHeader() },
      footers: { default: pageNumFooter() },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER, spacing: { before: 480, after: 360 },
          children: [new TextRun({ text: "Table of Contents", bold: true, size: 32, color: PAL.primary, font: EN })],
        }),
        new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-2" }),
        new Paragraph({
          spacing: { before: 200 },
          children: [new TextRun({
            text: "Note: This Table of Contents is generated via field codes. To ensure page number accuracy after editing, please right-click the TOC and select \u201cUpdate Field.\u201d",
            italics: true, size: 18, color: "888888", font: EN })],
        }),
        new Paragraph({ children: [new PageBreak()] }),
      ],
    },
    { // Section 3: body — Arabic from 1
      properties: {
        type: SectionType.NEXT_PAGE,
        page: { size: pgSize, margin: pgMargin, pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL } },
      },
      headers: { default: docHeader() },
      footers: { default: pageNumFooter() },
      children: bodyChildren,
    },
  ],
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync("/home/z/my-project/download/AgentPay-Pending-Work-and-Next-Steps.docx", buf);
  console.log("docx written:", buf.length, "bytes");
});
