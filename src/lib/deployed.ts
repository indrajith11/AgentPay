// LIVE deployed contract address book + on-chain proof of work.
// Source of truth: agentpay/contracts/addresses/qieTestnet.json
// Deployed 2026-09-15 on QIE Testnet (chain 1983) by 0xe91d9ddad8B1d13038aBe8A91F2573bF92583dBc

export const DEPLOYED: Record<string, string> = {
  WQIE: "0x5e165E6c7AC4039aEDc2a5505Ae35cb20764916c",
  MockAggregator: "0x71206B14F6B005E70909F83048CcE8002F03EF70",
  MerchantRegistry: "0x7918e72d7725E87D3C09bB80873991a05BaEc9aA",
  AgentRegistry: "0x715f9449145C2FC74c74556154F17C522a30ED09",
  EscrowCore: "0x7566803615CB5d9Ac15f24269C3305a2738C995b",
  SettlementRouter: "0x1713B2fb74A3b57f55088f21743668a8Bb261523",
  CreditPassport: "0xCaecF75Eebb659148DE2d2a4a28131dF428B5cA8",
  MandateVault: "0x2FEf89522b8B0a55161ed11a7CB19B57C6fF2169",
  PayEndpoint: "0x4ccdE1dD4d2c3F39dB9D2b350516070257dfb647",
  InvoiceVault: "0xD0FF272B69FA884fd2C323ce334dC77F9243Ac0C",
  RecurringMandate: "0x0AaC5b7c0E669D3Ecae635d6820858D4ab897D8f",
};

export const DEPLOYER = "0xe91d9ddad8B1d13038aBe8A91F2573bF92583dBc";

/** Full commerce lifecycle executed live on testnet 1983 (e2e_live.ts). */
export const E2E_PROOF = {
  ranAt: "2026-09-15",
  roles: {
    merchant: DEPLOYER,
    principal: "0xaa7D0e7Cb165eE5BAd27f7244b526EFfd3aa1358",
    agent: "0x78aEeA04Bd2Cb8e65fF3193f35e0cbc2988DB110",
    offrampDeposit: "0xE4392C1fc8765736D92FBD2D5CB9471FbcA94F8D",
  },
  txs: {
    registerMerchant: "0x2dc3fd771e7588fbb4c3ac6be56c1d3b7a8ab55dd5f561f28054ed6cde63389a",
    payForCall_1: "0x727070729eb8e508458e6adfc80358343fd9adb2c3eb40f8c819a9ff84611e01",
    payForCall_2: "0xd6bd8ff9caf6977a5de0f905c4ff1df1d2a9434115a6fb5866e7bc01a0ad4203",
    refundCall_dispute: "0x94bbf72bfb5522521058ad40e0177b4c25b95c19ac92c1bc0409d0c1e5b55546",
    payInvoice_routerCredit: "0x1b244af0a14561c430654fc1e13e8233daae7dadca70d70da7f5f39d74f3233a",
    claimCall_afterWindow: "0xe0a6bf38ad93fa100b0e395f563acd16f626aff3c4408398eccebddc9c38f5f5",
    executeAutoWithdraw_fiatOut: "0xf42456db4b9fa03813f0cab78970337d9b8eb8093d2dfd0d726909fa6895eb98",
  },
  finalState: {
    machineCallQuote: "0.5556 WQIE = $0.10 (oracle $0.18/QIE)",
    creditAfterRefund: "score 317 (onTime 2 / late 1) — refund dents history by design",
    invoiceSettled: "0.2991 WQIE net (0.3% platform fee) credited to SettlementRouter",
    autoWithdrawSwept: "0.2991 WQIE -> VALR(ZAR) deposit address; fiat leg off-chain",
  },
} as const;

export function explorerTx(chainKey: "qieTestnet" | "qieMainnet", hash: string): string {
  return chainKey === "qieMainnet"
    ? `https://mainnet.qie.digital/tx/${hash}`
    : `https://testnet.qie.digital/tx/${hash}`;
}
