import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ACTIVE_CHAIN } from "@/lib/chains";
import { DEPLOYED, DEPLOYER, E2E_PROOF, explorerTx } from "@/lib/deployed";
import { ethers } from "ethers";

async function readOnchainState(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const p = new ethers.JsonRpcProvider(ACTIVE_CHAIN.rpcs[0], ACTIVE_CHAIN.id, { staticNetwork: true });
    const wqie = new ethers.Contract(DEPLOYED.WQIE, ["function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)"], p);
    out.wqieTotalSupply = ethers.formatEther(await wqie.totalSupply());
    out.merchantWqieBalance = ethers.formatEther(await wqie.balanceOf(DEPLOYER));
    const ep = new ethers.Contract(DEPLOYED.PayEndpoint, ["function productCount() view returns (uint256)", "function nextCallId() view returns (uint256)"], p);
    out.payEndpointProducts = (await ep.productCount()).toString();
    out.payEndpointCalls = ((await ep.nextCallId()) - 1n).toString();
    const router = new ethers.Contract(DEPLOYED.SettlementRouter, ["function totalWithdrawable(address,address) view returns (uint256)", "function externalEarnings(address,address) view returns (uint256)"], p);
    out.merchantExternalEarnings = ethers.formatEther(await router.externalEarnings(DEPLOYER, DEPLOYED.WQIE));
    out.chainStateLive = "true";
  } catch (e: any) {
    out.chainStateLive = "false";
    out.error = e?.message?.slice(0, 80) ?? "read failed";
  }
  return out;
}

/** Chain + service health: pings QIE RPC and the x402 endpoint service. */
export async function GET() {
  const chainStatus = { rpc: process.env.QIE_RPC_URL || ACTIVE_CHAIN.rpcs[0], reachable: false, chainId: null as string | null };
  const serviceStatus = { url: "http://localhost:3030", reachable: false };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(chainStatus.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.ok) {
      const j = await res.json();
      chainStatus.chainId = j.result ?? null;
      chainStatus.reachable = true;
    }
  } catch { /* offline is fine — UI degrades gracefully */ }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch("http://localhost:3030/v1/products", { signal: ctrl.signal });
    clearTimeout(t);
    serviceStatus.reachable = res.ok;
  } catch { /* not running */ }

  const merchants = await db.merchant.count();
  const onchain = await readOnchainState();

  return NextResponse.json({
    mode: chainStatus.reachable ? "REAL — live chain reachable" : "REAL — chain offline (verify flows will error)",
    network: ACTIVE_CHAIN.key,
    chain: chainStatus,
    x402Service: serviceStatus,
    merchants,
    demoData: false,
    contracts: {
      deployed: true,
      deployer: DEPLOYER,
      addresses: DEPLOYED,
      network: { testnet: { chainId: 1983, rpc: "https://rpc1testnet.qie.digital/" }, mainnet: { chainId: 1990, rpc: "https://rpc1mainnet.qie.digital/" } },
      qieUsdOracle: ACTIVE_CHAIN.oracle.qieUsd,
      onchainState: onchain,
    },
    e2eProof: {
      ranAt: E2E_PROOF.ranAt,
      roles: E2E_PROOF.roles,
      txExplorerUrls: Object.fromEntries(
        Object.entries(E2E_PROOF.txs).map(([k, h]) => [k, explorerTx(ACTIVE_CHAIN.key, h)])
      ),
      finalState: E2E_PROOF.finalState,
    },
  });
}
