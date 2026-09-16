import hre from "hardhat";
const { ethers } = hre;

import * as fs from "fs";
const ADDR = JSON.parse(fs.readFileSync("addresses/qieTestnet.json", "utf8"));
const WQIE = ADDR.WQIE;

async function main() {
  const roles = JSON.parse(fs.readFileSync("addresses/e2e_roles_qieTestnet.json", "utf8"));
  const [deployer] = await ethers.getSigners();
  const agent = new ethers.Wallet(roles.agent, ethers.provider);
  const mandateId = await (await ethers.getContractAt("MandateVault", ADDR.MandateVault)).nextMandateId() - 1n;

  const payEndpoint = (await ethers.getContractAt("PayEndpoint", ADDR.PayEndpoint)).connect(deployer) as any;
  const mandateVault = await ethers.getContractAt("MandateVault", ADDR.MandateVault);
  const escrow = (await ethers.getContractAt("EscrowCore", ADDR.EscrowCore)).connect(payEndpoint) as any;
  const creditPassport = await ethers.getContractAt("CreditPassport", ADDR.CreditPassport);

  console.log("mandateId used:", mandateId.toString());
  const m = await mandateVault.mandates(mandateId);
  console.log("mandate.agent:", m.agent, "| caller agent:", agent.address, "| token:", m.token);

  // probe mandateVault.spend as agent
  const mvAsAgent = (mandateVault as any).connect(agent);
  try {
    const g = await mvAsAgent.spend.staticCall(mandateId, ADDR.EscrowCore, ethers.parseEther("0.1"), "PROBE");
    console.log("mandateVault.spend probe OK:", g);
  } catch (e: any) {
    console.log("mandateVault.spend probe FAIL:", e.reason || e.shortMessage || e.message?.slice(0, 120));
  }

  // probe escrow.registerExternal as PayEndpoint address (impersonation impossible on live; staticCall from self won't match msg.sender)
  // instead probe payForCall with staticCall to capture revert reason
  try {
    await payEndpoint.connect(agent).payForCall.staticCall(mandateId, 1n, WQIE);
    console.log("payForCall staticCall OK");
  } catch (e: any) {
    console.log("payForCall staticCall FAIL:", JSON.stringify({
      reason: e.reason,
      revertArgs: e.revert?.args ? e.revert.args.map(String) : undefined,
      revertName: e.revert?.name,
      data: e.data,
      short: e.shortMessage,
      msg: e.message?.slice(0, 200),
    }));
  }

  // check creditPassport recorder wiring
  try {
    const rec = await creditPassport.recorders(ADDR.PayEndpoint);
    console.log("creditPassport.recorders[PayEndpoint]:", rec);
  } catch (e: any) {
    console.log("creditPassport.recorders read fail:", e.message?.slice(0, 100));
    // maybe named differently
    const iface = creditPassport.interface;
    for (const [sig] of Object.entries(iface.functions)) {
      if (/recorder|verifier|recorderIs|isRecorder/i.test(sig)) console.log("  has fn:", sig);
    }
  }
  try {
    const rec2 = await creditPassport.authorizedRecorders(ADDR.PayEndpoint);
    console.log("creditPassport.authorizedRecorders[PayEndpoint]:", rec2);
  } catch { /* not present */ }

  // escrow registerExternal role
  const escrowC = await ethers.getContractAt("EscrowCore", ADDR.EscrowCore);
  const ifaceE = escrowC.interface;
  for (const [sig] of Object.entries(ifaceE.functions)) {
    if (/relayer|registerExternal/i.test(sig)) console.log("escrow fn:", sig);
  }
  try { console.log("escrow.relayer:", await escrowC.relayer()); } catch (e: any) { console.log("escrow.relayer read fail"); }
  try { console.log("escrow.isRelayer(PayEndpoint):", await escrowC.isRelayer(ADDR.PayEndpoint)); } catch { /* */ }
}

main().catch((e) => { console.error("FATAL", e.message?.slice(0, 200)); process.exitCode = 1; });
