import hre from "hardhat";
const { ethers } = hre;
import * as fs from "fs";
import * as path from "path";

const ADDR = JSON.parse(fs.readFileSync("addresses/qieTestnet.json", "utf8"));
const WQIE = ADDR.WQIE;

function selectorFor(sig: string) {
  return ethers.id(sig).slice(0, 10);
}

async function main() {
  const roles = JSON.parse(fs.readFileSync("addresses/e2e_roles_qieTestnet.json", "utf8"));
  const agent = new ethers.Wallet(roles.agent, ethers.provider);
  const payEndpoint = (await ethers.getContractAt("PayEndpoint", ADDR.PayEndpoint)).connect(agent) as any;
  const mandateVault = await ethers.getContractAt("MandateVault", ADDR.MandateVault);
  const mandateId = (await mandateVault.nextMandateId()) - 1n;
  const m = await mandateVault.mandates(mandateId);
  console.log("mandateId:", mandateId.toString(), "balance:", ethers.formatEther(m.balance), "spentToday:", ethers.formatEther(m.spentToday));
  console.log("escrowId of call#2 area — nextEscrowId:", (await (await ethers.getContractAt("EscrowCore", ADDR.EscrowCore)).nextEscrowId()).toString());
  console.log("nextCallId:", (await payEndpoint.nextCallId()).toString());

  try {
    await payEndpoint.payForCall.staticCall(mandateId, 1n, WQIE);
    console.log("staticCall OK — would succeed now");
  } catch (e: any) {
    const sel: string | undefined = e.data;
    console.log("staticCall revert selector:", sel);
    if (sel && sel.startsWith("0x") && sel.length === 10) {
      // brute force match across artifacts
      const walk = (dir: string, out: string[] = []) => {
        for (const f of fs.readdirSync(dir)) {
          const p = path.join(dir, f);
          if (fs.statSync(p).isDirectory()) walk(p, out);
          else if (f.endsWith(".json") && !f.endsWith(".dbg.json")) out.push(p);
        }
        return out;
      };
      for (const f of walk("artifacts/contracts")) {
        try {
          const abi = JSON.parse(fs.readFileSync(f, "utf8")).abi || [];
          for (const item of abi) {
            if (item.type === "error") {
              const sig = item.name + "(" + (item.inputs || []).map((i: any) => i.type).join(",") + ")";
              if (selectorFor(sig) === sel) console.log("MATCH:", sig, "in", path.basename(f));
            }
          }
        } catch { /* skip */ }
      }
    } else {
      console.log("reason:", e.reason, "| msg:", e.message?.slice(0, 160));
    }
  }
}

main().catch((e) => { console.error("FATAL", e.message?.slice(0, 300)); process.exitCode = 1; });
