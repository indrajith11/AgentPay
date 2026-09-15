// Minimal human-readable ABI fragments for REAL contract calls from the
// dashboard. Kept intentionally small — only what the UI needs.

export const SETTLEMENT_ROUTER_ABI = [
  // earnings ledger
  "function totalWithdrawable(address merchant, address token) view returns (uint256)",
  "function earnings(address merchant, address token) view returns (uint256)",
  "function externalEarnings(address merchant, address token) view returns (uint256)",
  "function feesOwed(address merchant, address token) view returns (uint256)",
  // payout automation ("setup bank transfer once, withdraw anytime")
  "function setPayoutProfile(tuple(address payoutAddress, bytes32 providerRef, string provider, string fiatCurrency, uint8 rail, uint256 minThreshold, uint64 interval, uint64 lastPayoutAt, bool autoEnabled, bool active) profile)",
  "function requestWithdrawal(address token) returns (uint256 swept)",
  "function executeAutoWithdraw(address token, address merchant) returns (uint256 swept)",
  "function canAutoWithdraw(address merchant, address token) view returns (bool ok, string reason)",
  "function payoutProfileOf(address merchant) view returns (address payoutAddress, bytes32 providerRef, string provider, string fiatCurrency, uint8 rail, uint256 minThreshold, uint64 interval, uint64 lastPayoutAt, bool autoEnabled, bool active)",
  "event WithdrawalRequested(address indexed merchant, address indexed token, uint256 amount, address indexed to, uint8 rail, string provider, string fiatCurrency, bytes32 providerRef, bool automated, uint64 at)",
  "event PayoutProfileSet(address indexed merchant, address payoutAddress, uint8 rail, string provider, string fiatCurrency, uint256 minThreshold, uint64 interval, bool autoEnabled)",
];

export const PAY_ENDPOINT_ABI = [
  "function quoteIn(uint256 productId, address token) view returns (uint256 amount)",
  "function products(uint256 id) view returns (uint256 id, address merchant, string name, string endpointPath, string metadataURI, uint256 pricePerCall, bool active, uint256 totalCalls, uint256 grossRevenue, uint64 createdAt, bool usdPriced, uint256 priceUsd)",
  "function usdFeeds(address token) view returns (address feed)",
];

export const ORACLE_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];
