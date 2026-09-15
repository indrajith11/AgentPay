// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./MerchantRegistry.sol";
import "./SettlementRouter.sol";
import "./CreditPassport.sol";

/// @title InvoiceVault
/// @notice On-chain invoicing for real businesses: merchants issue invoices,
///         payers (human or agent) settle partially or fully, overdue marks
///         are permissionless (agents trigger them), all repayments feed the
///         CreditPassport. Funds settle through SettlementRouter.
contract InvoiceVault {
    using SafeERC20 for IERC20;

    enum Status {
        Open,
        Partial,
        Paid,
        Overdue
    }

    struct Invoice {
        uint256 id;
        address merchant;
        address payer; // expected payer (0 = anyone may pay)
        IERC20 token;
        uint256 amount;
        uint256 paidAmount;
        uint64 dueAt;
        string customerRef; // customer name/id (off-chain identity)
        string metadataURI; // line items document
        Status status;
        uint64 createdAt;
        uint64 paidAt;
    }

    uint256 public nextInvoiceId = 1;
    uint256 public feeBps = 30; // 0.3% — vs 1-2% incumbents (BitPay/CoinGate)

    MerchantRegistry public immutable merchantRegistry;
    SettlementRouter public immutable settlementRouter;
    CreditPassport public immutable creditPassport;

    mapping(uint256 => Invoice) public invoices;
    mapping(address => uint256[]) public invoicesOfMerchant;

    event InvoiceCreated(
        uint256 indexed id,
        address indexed merchant,
        address indexed payer,
        uint256 amount,
        uint64 dueAt,
        string customerRef
    );
    event InvoicePaid(uint256 indexed id, uint256 paidAmount, uint256 totalPaid, bool fullyPaid);
    event InvoiceOverdue(uint256 indexed id);
    event FeeUpdated(uint256 newFeeBps);

    error NotMerchant();
    error InvoiceNotOpen();
    error Overpay();
    error EmptyCustomer();

    constructor(address _merchantRegistry, address _settlementRouter, address _creditPassport) {
        merchantRegistry = MerchantRegistry(_merchantRegistry);
        settlementRouter = SettlementRouter(_settlementRouter);
        creditPassport = CreditPassport(_creditPassport);
    }

    /// @notice Merchant issues an invoice.
    function createInvoice(
        IERC20 token,
        address payer,
        uint256 amount,
        uint64 dueAt,
        string calldata customerRef,
        string calldata metadataURI
    ) external returns (uint256 id) {
        require(merchantRegistry.isVerifiedMerchant(msg.sender), "NOT_VERIFIED_MERCHANT");
        require(amount > 0, "ZERO_AMOUNT");
        require(bytes(customerRef).length > 0, "EMPTY_CUSTOMER");
        require(dueAt > block.timestamp, "BAD_DUE_DATE");

        id = nextInvoiceId++;
        invoices[id] = Invoice({
            id: id,
            merchant: msg.sender,
            payer: payer,
            token: token,
            amount: amount,
            paidAmount: 0,
            dueAt: dueAt,
            customerRef: customerRef,
            metadataURI: metadataURI,
            status: Status.Open,
            createdAt: uint64(block.timestamp),
            paidAt: 0
        });
        invoicesOfMerchant[msg.sender].push(id);

        emit InvoiceCreated(id, msg.sender, payer, amount, dueAt, customerRef);
    }

    /// @notice Pay an invoice (caller pays from own balance). Partial allowed.
    ///         Payer must approve this contract. Routed via SettlementRouter.
    function payInvoice(uint256 invoiceId, uint256 amount) external {
        Invoice storage inv = invoices[invoiceId];
        if (inv.status == Status.Paid) revert InvoiceNotOpen();
        require(amount > 0, "ZERO_AMOUNT");
        require(inv.paidAmount + amount <= inv.amount, "OVERPAY");

        // expected payer check (if set): allows mandate-agent to pay for principal
        if (inv.payer != address(0)) {
            require(msg.sender == inv.payer, "NOT_EXPECTED_PAYER");
        }

        uint256 remaining = inv.amount - inv.paidAmount;
        bool fullyPaid = amount >= remaining;

        inv.paidAmount += amount;
        inv.status = fullyPaid ? Status.Paid : Status.Partial;
        if (fullyPaid) inv.paidAt = uint64(block.timestamp);

        bool onTime = block.timestamp <= inv.dueAt;
        // pull from payer into the router, then credit net earnings
        inv.token.safeTransferFrom(msg.sender, address(settlementRouter), amount);
        settlementRouter.credit(inv.token, inv.merchant, msg.sender, amount, feeBps);
        creditPassport.recordPayment(msg.sender, amount, onTime);

        emit InvoicePaid(invoiceId, amount, inv.paidAmount, fullyPaid);
    }

    /// @notice Anyone (collections agent / keeper) marks an invoice overdue.
    function markOverdue(uint256 invoiceId) external {
        Invoice storage inv = invoices[invoiceId];
        if (inv.status != Status.Open && inv.status != Status.Partial) revert InvoiceNotOpen();
        require(block.timestamp > inv.dueAt, "NOT_DUE_YET");

        inv.status = Status.Overdue;
        emit InvoiceOverdue(invoiceId);
    }

    function setFeeBps(uint256 _feeBps) external {
        require(msg.sender == merchantRegistry.verifier(), "NOT_VERIFIER");
        require(_feeBps <= 200, "FEE_TOO_HIGH");
        feeBps = _feeBps;
        emit FeeUpdated(_feeBps);
    }

    // ---------- views ----------

    function invoiceCount() external view returns (uint256) {
        return nextInvoiceId - 1;
    }

    function invoicesOf(address merchant) external view returns (uint256[] memory) {
        return invoicesOfMerchant[merchant];
    }

    function isOverdue(uint256 invoiceId) external view returns (bool) {
        Invoice storage inv = invoices[invoiceId];
        return (inv.status == Status.Open || inv.status == Status.Partial) && block.timestamp > inv.dueAt;
    }
}
