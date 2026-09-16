/**
 * P6 prep: retroactively add the `deployments` journal to addresses/qieTestnet.json
 * (deploy.ts predates journaling). Order + ctor args match scripts/deploy.ts exactly.
 * Then the source-verification pipeline works for the TESTNET deployment too —
 * judges can inspect verified sources on testnet.qie.digital.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const book = JSON.parse(readFileSync(join(process.cwd(), "addresses", "qieTestnet.json"), "utf8"));
if (book.deployments?.length) { console.log("journal already present — nothing to do"); process.exit(0); }

const D = book.deployer;
const A = book;
const entries = [
  ["WQIE", A.WQIE, []],
  ["MerchantRegistry", A.MerchantRegistry, [D]],
  ["AgentRegistry", A.AgentRegistry, []],
  ["EscrowCore", A.EscrowCore, [600]],
  ["SettlementRouter", A.SettlementRouter, [D, D]],
  ["CreditPassport", A.CreditPassport, [D]],
  ["MandateVault", A.MandateVault, [A.AgentRegistry]],
  ["PayEndpoint", A.PayEndpoint, [A.MerchantRegistry, A.AgentRegistry, A.MandateVault, A.EscrowCore, A.SettlementRouter, A.CreditPassport]],
  ["InvoiceVault", A.InvoiceVault, [A.MerchantRegistry, A.SettlementRouter, A.CreditPassport]],
  ["RecurringMandate", A.RecurringMandate, [A.MerchantRegistry, A.SettlementRouter, A.CreditPassport]],
];
book.deployments = entries.map(([name, address, args]) => ({ name, address, args, txHash: "", gasUsed: undefined }));
writeFileSync(join(process.cwd(), "addresses", "qieTestnet.json"), JSON.stringify(book, null, 2));
console.log("journal added:", book.deployments.map((d) => d.name).join(", "));
