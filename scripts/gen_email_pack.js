// AgentPay — Mainnet Gas Support Request Email Pack (docx)
// English letter-pack: no cover, no TOC, single section, page-number footer.
const {
  Document, Packer, Paragraph, TextRun, Footer, Header, PageNumber,
  AlignmentType, HeadingLevel, BorderStyle,
} = require("docx");
const fs = require("fs");

// ---------- palette (short-form letter doc => headings pure black) ----------
const INK = "000000";
const GRAY = "5A6472";
const ACCENT = "8A93A6"; // left rule for copy boxes

const F = { ascii: "Calibri", eastAsia: "Microsoft YaHei" };

// ---------- helpers ----------
function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 400, after: 160, line: 312 },
    children: [new TextRun({ text, bold: true, size: 30, color: INK, font: F })],
  });
}

function body(text, opts = {}) {
  return new Paragraph({
    alignment: AlignmentType.LEFT, // English email body: left aligned
    spacing: { after: opts.after ?? 160, line: 312 },
    children: [new TextRun({ text, size: 22, color: INK, font: F, bold: !!opts.bold, italics: !!opts.italics })],
  });
}

// paragraph inside a "copy box": continuous left rule + light indent
function boxPara(text, opts = {}) {
  return new Paragraph({
    alignment: opts.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
    spacing: { after: opts.after ?? 160, line: 312 },
    indent: { left: 240 },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: ACCENT, space: 12 } },
    children: [new TextRun({
      text, size: 22, color: INK, font: F,
      bold: !!opts.bold, italics: !!opts.italics,
    })],
  });
}

// multi-run box paragraph (for mixed bold/regular lines)
function boxRuns(runs, opts = {}) {
  return new Paragraph({
    alignment: opts.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
    spacing: { after: opts.after ?? 160, line: 312 },
    indent: { left: 240 },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: ACCENT, space: 12 } },
    children: runs.map(r => new TextRun({ text: r.text, size: 22, color: INK, font: F, bold: !!r.bold })),
  });
}

function bullet(text) {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 100, line: 312 },
    children: [new TextRun({ text, size: 22, color: INK, font: F })],
  });
}

// ---------- email content ----------
const ADDR = "0x33E00d801943D945DC5Ec92A2192425427023586";

const email1 = [
  boxRuns([{ text: "To: ", bold: true }, { text: "info@qie.digital (send from indrajeetmp11@gmail.com)" }], { after: 80 }),
  boxRuns([{ text: "Subject: ", bold: true }, { text: "AgentPay - QIE Hackathon 3.0 Mainnet Edition (Track 04) - kind request for mainnet gas support" }], { after: 240 }),
  boxPara("Dear QIE Team,"),
  boxPara("I hope this message finds you well. My name is Indrajith, and I have registered as a solo participant in the QIE Hackathon 3.0 (Mainnet Edition) on the Hackathon Hub - username indrajeetmp11, registered email indrajeetmp11@gmail.com - building in Track 04: Commerce & Real World."),
  boxPara("Over the past weeks I have been building AgentPay, an agentic-commerce payment infrastructure for the QIE blockchain. On your testnet (chain 1983) it currently includes: a suite of eleven Solidity contracts covering merchant and agent registries, capped spending mandates, escrowed machine payments with refund windows, invoicing, recurring billing and settlement; all deployed contracts source-verified on testnet.qie.digital; a 45-test suite passing live; a merchant dashboard with QR payments priced through the official QIE Oracle; an agent SDK with working HTTP-402 purchase flows; and a public network-stats page that reconciles raw chain events. I am also planning deeper integration with QIE ecosystem components such as the QIE Wallet and QIE Pass."),
  boxPara("I am writing because I have run into one small blocker that I am unable to solve on my own: the hackathon requires deployment on QIE Mainnet for eligibility (your FAQ states that testnet-only projects are not eligible), while the available faucet covers only the testnet. My full deployment has been rehearsed at roughly 13.6M gas - about 0.016 QIE, less than a quarter of a US dollar at current market rates - so the amount involved is genuinely tiny."),
  boxPara("May I kindly ask whether the team could support a solo builder with a small amount of mainnet QIE for deployment gas? Even 1 QIE would fully cover the deployment, source verification and demo transactions with comfortable margin. If that is agreeable, any amount to my deployer address would be sincerely appreciated:"),
  boxPara(ADDR + " (chain 1990 - rpc1mainnet.qie.digital)", { bold: true }),
  boxPara("If there is an official process, a builder gas programme, or a team member I should approach instead (Discord or Telegram), I would be very happy to follow it - I simply did not want to miss the submission window of 30 November for lack of this one small step. In return, I will immediately deploy and source-verify the full suite on mainnet.qie.digital, publish the verified addresses in the project README, and run my public live-stats page against mainnet - adding more verified mainnet activity and a stronger showcase for the hackathon."),
  boxPara("Thank you very much for your time and for organising this hackathon - building on QIE has been a genuinely smooth EVM experience. I completely understand if no provision exists for this and will continue the project regardless, but if any support is possible, it would make a real difference for a solo builder."),
  boxPara("Best regards,", { right: true, after: 40 }),
  boxPara("Indrajith", { right: true, after: 40 }),
  boxPara("Solo participant - QIE Hackathon 3.0 Mainnet Edition, Track 04", { right: true, after: 40 }),
  boxPara("Registered: indrajeetmp11@gmail.com - Hub: indrajeetmp11", { right: true, after: 40 }),
  boxPara("Project: AgentPay - github.com/indrajith11/AgentPay (private repo; happy to grant access on request)", { right: true, after: 0 }),
];

const email2 = [
  boxRuns([{ text: "To: ", bold: true }, { text: "info@qie.digital - reply in the same thread" }], { after: 80 }),
  boxRuns([{ text: "Subject: ", bold: true }, { text: "Re: AgentPay - QIE Hackathon 3.0 Mainnet Edition (Track 04) - kind request for mainnet gas support" }], { after: 240 }),
  boxPara("Dear QIE Team,"),
  boxPara("Just gently following up on my note below. My mainnet deployment is fully rehearsed and ready (eleven contracts, all deployed contracts verified on your testnet explorer), and the submission deadline of 30 November is approaching. If any small gas support is possible - even 1 QIE - it would unblock the mandatory mainnet step for a solo builder; my deployer address is " + ADDR + " (chain 1990)."),
  boxPara("If there is a designated process, form or admin for this, kindly point me to it and I will follow it right away. Thank you again for your time and for a great hackathon."),
  boxPara("Best regards,", { right: true, after: 40 }),
  boxPara("Indrajith - solo builder, AgentPay, Track 04 (indrajeetmp11@gmail.com)", { right: true, after: 0 }),
];

const dm = [
  boxPara("Hi QIE team - I am Indrajith, a solo participant in Hackathon 3.0 Mainnet Edition (Track 04: Commerce & Real World; Hub username indrajeetmp11). My project AgentPay is fully ready for the mandatory mainnet deploy: eleven contracts, all deployed contracts source-verified on your testnet explorer, 45/45 tests passing, live merchant dashboard and agent SDK with the official QIE Oracle integrated. Since the faucet is testnet-only and mainnet deployment is required for eligibility, could the team kindly support around 1-5 mainnet QIE of deploy gas to " + ADDR + " (chain 1990)? The full deploy costs only about 0.016 QIE, so this would also cover verification and demo transactions. I am happy to share the repo or registration details, and if there is a better channel or admin for this request, please point me there. Thank you!", { after: 0 }),
];

// ---------- assembly ----------
const children = [
  // title block (no cover for letter packs)
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 80, line: 400, lineRule: "atLeast" },
    children: [new TextRun({ text: "Mainnet Gas Support Request - Email Pack", bold: true, size: 34, color: INK, font: F })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 60, line: 312 },
    children: [new TextRun({ text: "QIE Hackathon 3.0 Mainnet Edition - Track 04: Commerce & Real World", size: 20, color: GRAY, font: F })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 240, line: 312 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "C7CDD8", space: 8 } },
    children: [new TextRun({ text: "Prepared for Indrajith (Hub: indrajeetmp11 - indrajeetmp11@gmail.com) - 16 September 2026", size: 18, color: GRAY, font: F })],
  }),

  h1("Before you send"),
  body("This pack contains every message you need to request mainnet deployment gas from the QIE team, written politely and in full compliance with the hackathon rules. The hackathon FAQ requires mainnet deployment for eligibility (testnet-only projects are not eligible), while the faucet is testnet-only, so this request is grounded in the rules rather than a favour. The full deployment has been rehearsed at roughly 0.016 QIE, so even 1 QIE covers everything with margin."),
  body("Your identity is already filled in everywhere: Indrajith, solo participant, Hub username indrajeetmp11, registered email indrajeetmp11@gmail.com. The deployer address below is the only thing the team needs to send gas; never share the private key with anyone.", { after: 120 }),
  boxRuns([{ text: "Deployer address: ", bold: true }, { text: ADDR + " (chain 1990)" }], { after: 0 }),

  h1("Email 1 - Main request (send today)"),
  ...email1,

  h1("Email 2 - Polite follow-up (after 24-48 hours)"),
  ...email2,

  h1("Direct message version (Telegram / Discord)"),
  body("Use this shorter version in the official Telegram group (t.me/qieblockchain) or ask the Discord admins (discord.gg/8DD4kSHBvr) which channel fits best. Send it about a day after the email, so both touchpoints complement rather than duplicate each other.", { after: 120 }),
  ...dm,

  h1("Send checklist"),
  body("Work through the steps in this order; each one keeps the thread professional and verifiable on your side.", { after: 120 }),
  bullet("Send Email 1 to info@qie.digital from indrajeetmp11@gmail.com (matching the Hub registration helps them verify you). CC yourself."),
  bullet("No attachments are needed. Only the public address appears in the mail - that is safe. Never share the private key with anyone."),
  bullet("After 24-48 hours with no reply, send Email 2 as a reply in the same thread."),
  bullet("In parallel, send the direct-message version in the official Telegram group after about a day, and ask Discord admins for the right channel."),
  bullet("When funds land (check the address on mainnet.qie.digital), report back - the deploy pipeline then runs immediately: deploy, 26-point smoke, source verification, README address table, single commit and push."),
  bullet("Fallback if there is no response by about 20 November: buy roughly USD 2 of QIE on MEXC from your own device and withdraw on the QIE native network to the same deployer address."),
];

const doc = new Document({
  styles: {
    default: {
      document: {
        run: { font: F, size: 22, color: INK },
        paragraph: { spacing: { line: 312 } },
      },
      heading1: {
        run: { font: F, size: 30, bold: true, color: INK },
        paragraph: { spacing: { before: 400, after: 160, line: 312 } },
      },
    },
  },
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 },
        margin: { top: 1440, bottom: 1440, left: 1701, right: 1417 },
      },
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          spacing: { line: 240 },
          children: [new TextRun({ text: "AgentPay - Hackathon 3.0 - gas request pack", size: 16, color: GRAY, font: F })],
        })],
      }),
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { line: 240 },
          children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: GRAY, font: F })],
        })],
      }),
    },
    children,
  }],
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync("/home/z/my-project/download/AgentPay-Gas-Request-Email-Pack.docx", buf);
  console.log("OK: written", buf.length, "bytes");
});
