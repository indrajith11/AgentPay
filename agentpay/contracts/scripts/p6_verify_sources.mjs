/**
 * P6: verify all deployed sources on the QIE explorer (Etherscan-v1 compatible).
 *
 * Reads addresses/<network>.json (with `deployments` journal written by deploy.ts)
 * and artifacts/build-info/*.json, then POSTs solidity-standard-json-input to
 *   POST /api?module=contract&action=verifysourcecode
 * and polls /api?module=contract&action=checkverifystatus&guid=...
 *
 * Usage:
 *   node scripts/p6_verify_sources.mjs qieMainnet
 *   EXPLORER_API=https://mainnet.qie.digital/api EXPLORER_API_KEY=None node scripts/p6_verify_sources.mjs qieMainnet
 * Env: EXPLORER_API, EXPLORER_API_KEY
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { AbiCoder } from "ethers";

const network = process.argv[2] || "qieMainnet";
const API = process.env.EXPLORER_API || `https://${network === "qieMainnet" ? "mainnet" : "testnet"}.qie.digital/api`;
const KEY = process.env.EXPLORER_API_KEY || "None";
const root = process.cwd();

const book = JSON.parse(readFileSync(join(root, "addresses", `${network}.json`), "utf8"));
const deploys = book.deployments || [];
if (!deploys.length) {
  console.error("No deployments journal in address book — deploy.ts must be the journaled version.");
  process.exit(1);
}

// pick the newest build-info containing every deployed contract name
const bis = readdirSync(join(root, "artifacts", "build-info"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => {
    const bi = JSON.parse(readFileSync(join(root, "artifacts", "build-info", f), "utf8"));
    return { f, bi };
  })
  .filter(({ bi }) => deploys.every((d) => {
    for (const [file, contracts] of Object.entries(bi.output.contracts || {})) {
      if (contracts[d.name]) return true;
    }
    return false;
  }))
  .sort((a, b) => mtime(b.f) - mtime(a.f));

function mtime(f) {
  try { return statSync(join(root, "artifacts", "build-info", f)).mtimeMs; } catch { return 0; }
}
if (!bis.length) { console.error("No build-info matches all deployed contracts"); process.exit(1); }
const { f: biFile, bi } = bis[0];
console.log(`Using build-info: ${biFile} (solc ${bi.solcLongVersion})`);

// contract source path lookup
function contractPath(name) {
  for (const [file, contracts] of Object.entries(bi.output.contracts)) {
    if (contracts[name]) return file;
  }
  throw new Error(`contract ${name} not in build-info`);
}

const coder = new AbiCoder();
const results = [];
for (const d of deploys) {
  const path = contractPath(d.name);
  const abiTypes = (bi.output.contracts[path]?.[d.name]?.abi || [])
    .filter((x) => x.type === "constructor")
    .flatMap((x) => x.inputs?.map((i) => i.type) || []);
  const argsHex = d.args.length
    ? coder.encode(abiTypes, d.args).slice(2)
    : "";

  const body = new URLSearchParams({
    apikey: KEY,
    module: "contract",
    action: "verifysourcecode",
    codeformat: "solidity-standard-json-input",
    sourceCode: JSON.stringify(bi.input),
    contractaddress: d.address,
    contractname: `${path}:${d.name}`,
    compilerversion: `v${bi.solcLongVersion}`,
    constructorArguements: argsHex,
  });

  const post = await fetch(API, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const pr = await post.json().catch(() => ({ raw: "non-json" }));

  let status = pr;
  if (pr?.status === "1" && /^[0-9a-f]{40,80}$/i.test(String(pr.result))) {
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const chk = await fetch(`${API}?module=contract&action=checkverifystatus&guid=${pr.result}&apikey=${KEY}`);
      status = await chk.json().catch(() => ({ raw: "non-json" }));
      if (status?.result !== "Pending in queue") break;
    }
  }
  const line = `${d.name.padEnd(18)} ${d.address} => ${JSON.stringify(status).slice(0, 140)}`;
  console.log(line);
  results.push({ name: d.name, address: d.address, verify: status });
}

const failed = results.filter((r) => {
  const s = String(r.verify?.result ?? r.verify?.message ?? "").toLowerCase();
  return !(s.includes("pass") || s.includes("verified") || s.includes("already verified"));
});
console.log(failed.length ? `\nFAILED: ${failed.map((f) => f.name).join(", ")}` : "\nALL SOURCES VERIFIED ✓");
process.exitCode = failed.length ? 1 : 0;
