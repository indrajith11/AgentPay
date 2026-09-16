import hre from "hardhat";
const { ethers } = hre;
import * as fs from "fs";
import * as path from "path";

const ADDR = JSON.parse(fs.readFileSync("addresses/qieTestnet.json", "utf8"));

async function main() {
  const roles = JSON.parse(fs.readFileSync("addresses/e2e_roles_qieTestnet.json", "utf8"));
  const principal = new ethers.Wallet(roles.principal, ethers.provider);
  const payEndpoint = (await ethers.getContractAt("PayEndpoint", ADDR.PayEndpoint)).connect(principal) as any;
  const call2 = await payEndpoint.calls(2n);
  console.log("call2: escrowId=", call2.escrowId.toString(), "amount=", ethers.formatEther(call2.amount), "principal=", call2.principal);

  const escrow = await ethers.getContractAt("EscrowCore", ADDR.EscrowCore);
  const st = await escrow.statusOf(call2.escrowId);
  console.log("escrow state:", st[0].toString(), "payer:", st[3], "payee:", st[4], "amount:", ethers.formatEther(st[2]));
  console.log("principal wallet:", principal.address, "== payer?", st[3] === principal.address);
  console.log("relayer is PayEndpoint?", await escrow.relayers(ADDR.PayEndpoint));

  try {
    await payEndpoint.refundCall.staticCall(2n);
    console.log("refundCall staticCall OK");
  } catch (e: any) {
    console.log("refundCall staticCall FAIL selector:", e.data, "reason:", e.reason);
    if (e.data && e.data.length === 10) {
      const walk = (dir: string, out: string[] = []) => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) walk(p, out); else if (f.endsWith(".json") && !f.endsWith(".dbg.json")) out.push(p); } return out; };
      for (const f of walk("artifacts/contracts")) {
        try {
          const abi = JSON.parse(fs.readFileSync(f, "utf8")).abi || [];
          for (const item of abi) if (item.type === "error") {
            const sig = item.name + "(" + (item.inputs || []).map((i: any) => i.type).join(",") + ")";
            if (ethers.id(sig).slice(0, 10) === e.data) console.log("MATCH:", sig, "in", path.basename(f));
          }
        } catch { /* skip */ }
      }
    }
  }
}
main().catch((e) => { console.error("FATAL", e.message?.slice(0, 200)); process.exitCode = 1; });
