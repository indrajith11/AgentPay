// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./MerchantRegistry.sol";
import "./SettlementRouter.sol";
import "./CreditPassport.sol";

/// @title RecurringMandate
/// @notice On-chain subscriptions with prepaid balances. Payers deposit once,
///         charges happen automatically each interval — anyone (the merchant's
///         or payer's collections agent) can trigger chargeDue() for due subs,
///         so recurring revenue never depends on the payer showing up.
///         Missed charges lapse the sub; paid charges feed CreditPassport.
contract RecurringMandate {
    using SafeERC20 for IERC20;

    enum Status {
        Active,
        Cancelled,
        Lapsed
    }

    struct Subscription {
        uint256 id;
        address merchant;
        address payer;
        IERC20 token;
        uint256 amountPerCycle;
        uint64 interval; // seconds
        uint64 nextDueAt;
        string planRef;
        uint256 balance; // prepaid
        uint32 chargesCount;
        Status status;
        uint64 createdAt;
    }

    uint256 public nextSubId = 1;
    uint256 public feeBps = 30;

    MerchantRegistry public immutable merchantRegistry;
    SettlementRouter public immutable settlementRouter;
    CreditPassport public immutable creditPassport;

    mapping(uint256 => Subscription) public subs;
    mapping(address => uint256[]) public subsOfPayer;
    mapping(address => uint256[]) public subsOfMerchant;

    event SubscriptionCreated(uint256 indexed id, address indexed merchant, address indexed payer, uint256 amountPerCycle, uint64 interval);
    event Deposited(uint256 indexed id, uint256 amount, uint256 balance);
    event Charged(uint256 indexed id, uint256 amount, uint32 chargesCount, uint64 nextDueAt);
    event Lapsed(uint256 indexed id);
    event Cancelled(uint256 indexed id, uint256 refunded);
    event FeeUpdated(uint256 newFeeBps);

    error NotPayer();
    error NotActive();
    error NotDueYet();

    constructor(address _merchantRegistry, address _settlementRouter, address _creditPassport) {
        merchantRegistry = MerchantRegistry(_merchantRegistry);
        settlementRouter = SettlementRouter(_settlementRouter);
        creditPassport = CreditPassport(_creditPassport);
    }

    /// @notice Payer creates a subscription with an initial prepaid deposit.
    function createSubscription(
        address merchant,
        IERC20 token,
        uint256 amountPerCycle,
        uint64 interval,
        string calldata planRef,
        uint256 initialDeposit
    ) external returns (uint256 id) {
        require(merchantRegistry.isVerifiedMerchant(merchant), "NOT_VERIFIED_MERCHANT");
        require(amountPerCycle > 0 && interval > 0, "BAD_PARAMS");

        id = nextSubId++;
        subs[id] = Subscription({
            id: id,
            merchant: merchant,
            payer: msg.sender,
            token: token,
            amountPerCycle: amountPerCycle,
            interval: interval,
            nextDueAt: uint64(block.timestamp) + interval,
            planRef: planRef,
            balance: initialDeposit,
            chargesCount: 0,
            status: Status.Active,
            createdAt: uint64(block.timestamp)
        });
        subsOfPayer[msg.sender].push(id);
        subsOfMerchant[merchant].push(id);

        if (initialDeposit > 0) {
            token.safeTransferFrom(msg.sender, address(this), initialDeposit);
        }

        emit SubscriptionCreated(id, merchant, msg.sender, amountPerCycle, interval);
    }

    function deposit(uint256 subId, uint256 amount) external {
        Subscription storage s = subs[subId];
        require(s.payer == msg.sender, "NOT_PAYER");
        require(s.status == Status.Active, "NOT_ACTIVE");

        s.balance += amount;
        s.token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(subId, amount, s.balance);
    }

    /// @notice Permissionless charge (agent/keeper calls when due). Splits
    ///         gross through SettlementRouter (fee to treasury, net held for
    ///         merchant withdrawal) and credits the payer's passport.
    function chargeDue(uint256 subId) external {
        Subscription storage s = subs[subId];
        if (s.status != Status.Active) revert NotActive();
        if (block.timestamp < s.nextDueAt) revert NotDueYet();
        require(s.balance >= s.amountPerCycle, "INSUFFICIENT_PREPAID");

        s.balance -= s.amountPerCycle;
        s.chargesCount += 1;
        s.nextDueAt = s.nextDueAt + s.interval;

        // push prepaid funds to the router, then credit net earnings
        s.token.safeTransfer(address(settlementRouter), s.amountPerCycle);
        settlementRouter.credit(s.token, s.merchant, s.payer, s.amountPerCycle, feeBps);
        creditPassport.recordPayment(s.payer, s.amountPerCycle, true);

        emit Charged(subId, s.amountPerCycle, s.chargesCount, s.nextDueAt);
    }

    /// @notice Anyone can lapse an Active sub that missed a cycle (insufficient
    ///         prepaid balance at due time) — keeps merchant dashboards honest.
    function lapseIfBroke(uint256 subId) external {
        Subscription storage s = subs[subId];
        if (s.status != Status.Active) revert NotActive();
        require(block.timestamp >= s.nextDueAt, "NOT_DUE_YET");
        require(s.balance < s.amountPerCycle, "CAN_STILL_PAY");

        s.status = Status.Lapsed;
        emit Lapsed(subId);
    }

    function cancel(uint256 subId) external {
        Subscription storage s = subs[subId];
        require(s.payer == msg.sender, "NOT_PAYER");
        require(s.status == Status.Active, "NOT_ACTIVE");

        s.status = Status.Cancelled;
        uint256 refund = s.balance;
        if (refund > 0) {
            s.balance = 0;
            s.token.safeTransfer(s.payer, refund);
        }
        emit Cancelled(subId, refund);
    }

    function setFeeBps(uint256 _feeBps) external {
        require(msg.sender == merchantRegistry.verifier(), "NOT_VERIFIER");
        require(_feeBps <= 200, "FEE_TOO_HIGH");
        feeBps = _feeBps;
        emit FeeUpdated(_feeBps);
    }

    // ---------- views ----------

    function subCount() external view returns (uint256) {
        return nextSubId - 1;
    }

    function subsOf(address payer) external view returns (uint256[] memory) {
        return subsOfPayer[payer];
    }

    function isDue(uint256 subId) external view returns (bool) {
        Subscription storage s = subs[subId];
        return s.status == Status.Active && block.timestamp >= s.nextDueAt && s.balance >= s.amountPerCycle;
    }
}
