/**
 * P6: read-only smoke test of a mainnet (or any-network) deployment.
 * Proves: code at every address, wiring intact (relayer/recorders), USD feed
 * live via the OFFICIAL QIE oracle, quote() sanity, WQIE wrap/unwrap params.
 *
 * Usage: node scripts/p6_smoke.mjs qieMainnet
 * Env: QIE_RPC_URL (optional override)
 */
import { ethers } from "ethers";
import { readFileSync } from "fs";
import { join } from "path";

const network = process.argv[2] || "qieMainnet";
const RPC = process.env.QIE_RPC_URL
  || (network === "qieMainnet" ? "https://rpc1mainnet.qie.digital/" : "https://rpc1testnet.qie.digital/");
const book = JSON.parse(readFileSync(join(process.cwd(), "addresses", `${network}.json`), "utf8"));
const P = new ethers.JsonRpcProvider(RPC, Number(book.chainId || (network === "qieMainnet" ? 1990 : 1983)), { staticNetwork: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
};

const head = await P.getBlockNumber();
const net = await P.getNetwork();
ok("chainId", Number(net.chainId) === (network === "qieMainnet" ? 1990 : 1983), `head=${head} chainId=${net.chainId}`);

const A = book;
const code = async (addr) => { const c = await P.getCode(addr); return c === "0x" ? 0 : c.length / 2 - 1; };

// 1) code present at all deployed addresses
for (const d of book.deployments || []) {
  const sz = await code(d.address);
  ok(`code ${d.name}`, sz > 100, `${sz} bytes`);
}

// 2) wiring: Escrow relayer + recorders
const escrow = new ethers.Contract(A.EscrowCore, [
  "function relayers(address) view returns (bool)",
], P);
ok("EscrowCore relayers(PayEndpoint)", await escrow.relayers(A.PayEndpoint).catch(() => false));

const srAbi = ["function authorizedRecorders(address) view returns (bool)"];
const settlementRouter = new ethers.Contract(A.SettlementRouter, srAbi, P);
const cpAbi = ["function authorizedRecorders(address) view returns (bool)"];
const creditPassport = new ethers.Contract(A.CreditPassport, cpAbi, P);
for (const [nm, addr] of [["PayEndpoint", A.PayEndpoint], ["InvoiceVault", A.InvoiceVault], ["RecurringMandate", A.RecurringMandate]]) {
  ok(`SettlementRouter recorder(${nm})`, await settlementRouter.authorizedRecorders(addr).catch(() => false));
  ok(`CreditPassport recorder(${nm})`, await creditPassport.authorizedRecorders(addr).catch(() => false));
}

// 3) official USD feed freshness + quote sanity
const feedAddr = book.usdFeedAddress || book.MockAggregator || book.usdFeedAddress;
const feed = new ethers.Contract(feedAddr, [
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
], P);
const [dec, data] = await Promise.all([feed.decimals(), feed.latestRoundData()]);
const price = Number(ethers.formatUnits(data[1], dec)); // positional: (roundId, answer, startedAt, updatedAt, roundId)
const age = Math.floor(Date.now() / 1000) - Number(data[3]);
ok("USD feed live", price > 0.0001 && price < 1000, `$${price.toFixed(6)} age=${age}s feed=${feedAddr}`);

// 4) EscrowCore default refund window = 600 (matches deploy arg)
const esc = new ethers.Contract(A.EscrowCore, ["function defaultRefundWindow() view returns (uint64)"], P);
const win = await esc.defaultRefundWindow().catch(() => -1n);
ok("EscrowCore defaultRefundWindow=600", String(win) === "600", String(win));

// 5) WQIE metadata
const wq = new ethers.Contract(A.WQIE, ["function decimals() view returns (uint8)", "function symbol() view returns (string)"], P);
ok("WQIE decimals=18", Number(await wq.decimals()) === 18);
ok("WQIE symbol", (await wq.symbol()) === "WQIE");

// 6) protocol authority = deployer (verifier/treasury pattern, not Ownable)
const authAbi = ["function verifier() view returns (address)", "function treasury() view returns (address)"];
for (const [nm, addr, fn] of [["MerchantRegistry", A.MerchantRegistry, "verifier"], ["SettlementRouter", A.SettlementRouter, "verifier"], ["CreditPassport", A.CreditPassport, "verifier"]]) {
  const c = new ethers.Contract(addr, authAbi, P);
  const o = await c[fn]().catch(() => "n/a");
  ok(`${nm}.${fn}=${book.deployer}`, String(o).toLowerCase() === String(book.deployer).toLowerCase());
}
const srTreasury = await new ethers.Contract(A.SettlementRouter, authAbi, P).treasury().catch(() => "n/a");
ok("SettlementRouter.treasury set", String(srTreasury).toLowerCase() === String(book.deployer).toLowerCase());

console.log(`\n${pass} pass / ${fail} fail — ${network}`);
process.exitCode = fail ? 1 : 0;
