// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title SettlementRouter
/// @notice Merchant settlement ledger + treasury fee accounting + payout
///         automation. Two recording modes:
///         - receivePayment(): router HOLDS the funds (human QR / invoice
///           path). Merchant withdraws anytime — the "fiat-out" leg (off-ramp
///           to bank/M-Pesa/UPI) executes off-chain after withdrawal.
///         - recordExternal(): accounting-only for flows that settled outside
///           (escrow direct-to-merchant). Tracks fee owed by the merchant.
///
///         REAL-WORLD OFF-RAMP DESIGN ("setup bank transfer once, withdraw
///         anytime"): the merchant saves their bank beneficiary at a regulated
///         off-ramp provider ONCE (VALR / Luno FSCA exchange, Transak, etc.).
///         The provider issues the merchant a crypto deposit address. The
///         merchant stores that address + provider reference in a PayoutProfile
///         on-chain. From then on:
///           - requestWithdrawal(): merchant sweeps earnings to their payout
///             address at ANY time (no threshold).
///           - executeAutoWithdraw(): ANYONE may trigger the sweep for a
///             merchant whose balance crossed minThreshold and whose interval
///             elapsed — the merchant never pays gas or opens the app. Our
///             treasury agent calls this on a schedule.
///         The fiat leg (crypto -> ZAR/INR/KES -> saved bank account) runs at
///         the regulated provider; the chain never touches bank details —
///         only a hashed provider reference is stored.
contract SettlementRouter {
    using SafeERC20 for IERC20;

    address public verifier; // operator set at deploy (same as MerchantRegistry.verifier)
    address public treasury;

    // withdrawable earnings held by the router
    mapping(address => mapping(address => uint256)) public earnings; // merchant => token => amount
    // accounting for flows settled outside the router
    mapping(address => mapping(address => uint256)) public externalEarnings;
    mapping(address => mapping(address => uint256)) public feesOwed; // merchant => token => fee owed
    mapping(address => uint256) public feesCollected; // token => total

    mapping(address => bool) public authorizedRecorders; // PayEndpoint / InvoiceVault / RecurringMandate

    // ---------- payout automation (real-world off-ramp handoff) ----------

    enum PayoutRail {
        CRYPTO_WALLET,   // sweep to a plain wallet the merchant controls
        OFFRAMP_PROVIDER // sweep to merchant's deposit address at a regulated
                         // off-ramp (VALR/Luno/Transak); provider pays the
                         // saved bank account in fiatCurrency
    }

    struct PayoutProfile {
        address payoutAddress; // on-chain sweep destination (wallet or provider deposit address)
        bytes32 providerRef;   // hash of the KYC'd bank beneficiary ID at the provider (0 for CRYPTO_WALLET)
        string  provider;      // provider slug: "valr" | "luno" | "transak" | "onramper" | ...
        string  fiatCurrency;  // ISO code of the saved bank account: "ZAR" | "INR" | "KES" | ...
        PayoutRail rail;
        uint256 minThreshold;  // auto-withdraw trigger (token units)
        uint64  interval;      // min seconds between automatic withdrawals
        uint64  lastPayoutAt;  // last sweep (manual or auto)
        bool    autoEnabled;   // allow executeAutoWithdraw()
        bool    active;
    }

    mapping(address => PayoutProfile) public payoutProfiles; // merchant => profile

    event PayoutProfileSet(address indexed merchant, address payoutAddress, PayoutRail rail, string provider, string fiatCurrency, uint256 minThreshold, uint64 interval, bool autoEnabled);
    event WithdrawalRequested(
        address indexed merchant,
        address indexed token,
        uint256 amount,
        address indexed to,
        PayoutRail rail,
        string provider,
        string fiatCurrency,
        bytes32 providerRef,
        bool automated,
        uint64 at
    );

    event PaymentReceived(address indexed merchant, address indexed token, address payer, uint256 gross, uint256 fee);
    event ExternalRecorded(address indexed merchant, address indexed token, uint256 net, uint256 fee);
    event Withdrawn(address indexed merchant, address indexed token, address to, uint256 amount);
    event FeesPaid(address indexed merchant, address indexed token, uint256 amount);
    event RecorderUpdated(address indexed recorder, bool authorized);
    event TreasuryChanged(address indexed newTreasury);

    error NotAuthorized();
    error NotMerchant();
    error NothingToWithdraw();
    error ProfileInactive();
    error BadProfile();
    error ThresholdNotMet();
    error IntervalNotElapsed();
    error AutoDisabled();

    constructor(address _verifier, address _treasury) {
        require(_verifier != address(0) && _treasury != address(0), "ZERO_ADDR");
        verifier = _verifier;
        treasury = _treasury;
    }

    modifier onlyVerifier() {
        if (msg.sender != verifier) revert NotAuthorized();
        _;
    }

    modifier onlyRecorder() {
        if (!authorizedRecorders[msg.sender]) revert NotAuthorized();
        _;
    }

    function setRecorder(address recorder, bool authorized) external onlyVerifier {
        authorizedRecorders[recorder] = authorized;
        emit RecorderUpdated(recorder, authorized);
    }

    function setTreasury(address newTreasury) external onlyVerifier {
        require(newTreasury != address(0), "ZERO_ADDR");
        treasury = newTreasury;
        emit TreasuryChanged(newTreasury);
    }

    /// @notice Credit a payment whose funds were ALREADY transferred to the
    ///         router by the calling recorder (InvoiceVault pulls from payer,
    ///         RecurringMandate pushes from prepaid balance). Splits gross:
    ///         net to merchant earnings, fee to treasury.
    function credit(IERC20 token, address merchant, address payer, uint256 gross, uint256 feeBps)
        external
        onlyRecorder
        returns (uint256 fee, uint256 net)
    {
        require(gross > 0, "ZERO_AMOUNT");
        require(token.balanceOf(address(this)) >= gross, "FUNDS_NOT_ARRIVED");

        fee = (gross * feeBps) / 10_000;
        net = gross - fee;

        earnings[merchant][address(token)] += net;
        if (fee > 0) {
            feesCollected[address(token)] += fee;
            token.safeTransfer(treasury, fee);
        }

        emit PaymentReceived(merchant, address(token), payer, gross, fee);
    }

    /// @notice Accounting-only record for flows settled outside (escrow path).
    function recordExternal(address token, address merchant, uint256 net, uint256 fee)
        external
        onlyRecorder
    {
        externalEarnings[merchant][token] += net;
        if (fee > 0) feesOwed[merchant][token] += fee;
        emit ExternalRecorded(merchant, token, net, fee);
    }

    /// @notice Merchant withdraws router-held earnings (fiat-out happens next,
    ///         off-chain, via the bridge/off-ramp partner).
    function withdraw(IERC20 token, uint256 amount, address to) external {
        if (amount == 0) revert NothingToWithdraw();
        uint256 bal = earnings[msg.sender][address(token)];
        require(bal >= amount, "INSUFFICIENT");

        earnings[msg.sender][address(token)] = bal - amount;
        token.safeTransfer(to, amount);

        emit Withdrawn(msg.sender, address(token), to, amount);
    }

    /// @notice Merchant settles accrued fees from the external-escrow path.
    function payFeesOwed(IERC20 token, uint256 amount) external {
        uint256 owed = feesOwed[msg.sender][address(token)];
        require(owed >= amount, "OVERPAY");
        feesOwed[msg.sender][address(token)] = owed - amount;
        feesCollected[address(token)] += amount;
        token.safeTransferFrom(msg.sender, treasury, amount);

        emit FeesPaid(msg.sender, address(token), amount);
    }

    // ---------- payout automation ----------

    /// @notice Merchant saves their payout configuration ONCE. For the fiat
    ///         rail, payoutAddress is the merchant's crypto deposit address at
    ///         the regulated off-ramp provider and providerRef is the hash of
    ///         the saved bank beneficiary at that provider. Bank account
    ///         numbers NEVER go on-chain.
    function setPayoutProfile(PayoutProfile calldata profile) external {
        if (!profile.active) revert BadProfile();
        if (profile.payoutAddress == address(0)) revert BadProfile();
        if (profile.rail == PayoutRail.OFFRAMP_PROVIDER) {
            if (profile.providerRef == bytes32(0) || bytes(profile.provider).length == 0 || bytes(profile.fiatCurrency).length == 0) {
                revert BadProfile();
            }
        }
        payoutProfiles[msg.sender] = profile;
        emit PayoutProfileSet(
            msg.sender,
            profile.payoutAddress,
            profile.rail,
            profile.provider,
            profile.fiatCurrency,
            profile.minThreshold,
            profile.interval,
            profile.autoEnabled
        );
    }

    /// @notice Merchant sweeps their FULL earnings to the saved payout
    ///         destination at any time. Emits WithdrawalRequested carrying the
    ///         off-ramp references — our treasury worker executes the fiat leg
    ///         at the provider (or the merchant self-serves in their exchange
    ///         app, which converts to fiat and pays the saved bank account).
    function requestWithdrawal(IERC20 token) external returns (uint256 swept) {
        swept = _sweep(msg.sender, token, false);
    }

    /// @notice Permissionless automatic withdrawal. Anyone (our treasury
    ///         agent, a friend, a keeper) may trigger the sweep once the
    ///         merchant's earnings crossed minThreshold and the interval
    ///         elapsed. The merchant sets it and forgets it.
    function executeAutoWithdraw(IERC20 token, address merchant) external returns (uint256 swept) {
        swept = _sweep(merchant, token, true);
    }

    function _sweep(address merchant, IERC20 token, bool autoTrigger) private returns (uint256 swept) {
        PayoutProfile storage p = payoutProfiles[merchant];
        if (!p.active) revert ProfileInactive();
        if (autoTrigger) {
            if (!p.autoEnabled) revert AutoDisabled();
            if (earnings[merchant][address(token)] < p.minThreshold) revert ThresholdNotMet();
            if (block.timestamp < p.lastPayoutAt + p.interval) revert IntervalNotElapsed();
        }

        swept = earnings[merchant][address(token)];
        if (swept == 0) revert NothingToWithdraw();
        earnings[merchant][address(token)] = 0;
        p.lastPayoutAt = uint64(block.timestamp);

        token.safeTransfer(p.payoutAddress, swept);
        emit WithdrawalRequested(
            merchant,
            address(token),
            swept,
            p.payoutAddress,
            p.rail,
            p.provider,
            p.fiatCurrency,
            p.providerRef,
            autoTrigger,
            uint64(block.timestamp)
        );
    }

    // ---------- views ----------

    function totalWithdrawable(address merchant, address token) external view returns (uint256) {
        return earnings[merchant][token];
    }

    /// @notice Whether the auto-withdrawal policy is currently satisfied.
    function canAutoWithdraw(address merchant, address token)
        external
        view
        returns (bool ok, string memory reason)
    {
        PayoutProfile storage p = payoutProfiles[merchant];
        if (!p.active) return (false, "NO_PROFILE");
        if (!p.autoEnabled) return (false, "AUTO_DISABLED");
        if (earnings[merchant][token] < p.minThreshold) return (false, "BELOW_THRESHOLD");
        if (block.timestamp < p.lastPayoutAt + p.interval) return (false, "INTERVAL");
        return (true, "OK");
    }

    function payoutProfileOf(address merchant)
        external
        view
        returns (
            address payoutAddress,
            bytes32 providerRef,
            string memory provider,
            string memory fiatCurrency,
            PayoutRail rail,
            uint256 minThreshold,
            uint64 interval,
            uint64 lastPayoutAt,
            bool autoEnabled,
            bool active
        )
    {
        PayoutProfile storage p = payoutProfiles[merchant];
        return (
            p.payoutAddress,
            p.providerRef,
            p.provider,
            p.fiatCurrency,
            p.rail,
            p.minThreshold,
            p.interval,
            p.lastPayoutAt,
            p.autoEnabled,
            p.active
        );
    }
}
