// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "./IAggregatorV3.sol";
import "./MerchantRegistry.sol";
import "./AgentRegistry.sol";
import "./MandateVault.sol";
import "./EscrowCore.sol";
import "./SettlementRouter.sol";
import "./CreditPassport.sol";

/// @title PayEndpoint
/// @notice Machine-payable commerce: merchants list products with a
///         price-per-call; AI agents pay in stablecoins via pre-funded
///         mandates; funds land in a refund-window escrow (never held by
///         this contract); merchants claim settlement after the window;
///         the human principal behind the agent accrues credit history.
///         This is the on-chain settlement leg of the x402-style HTTP flow.
///
///         REAL CHAIN PRICING: products can be priced in USD (priceUsd, 8
///         decimals, oracle convention). The payable amount in ANY settlement
///         asset is computed on-chain via the official QIE Oracle price feeds
///         (AggregatorV3-compatible, e.g. QIE/USD at
///         0x3Bc617cF3A4Bb77003e4c556B87b13D556903D17 on QIE mainnet). This
///         protects merchants from token volatility even when customers pay
///         in a volatile asset — and uses a QIE mainnet component directly.
contract PayEndpoint {
    struct Product {
        uint256 id;
        address merchant;
        string name;
        string endpointPath; // e.g. "/v1/weather"
        string metadataURI; // machine-readable response schema
        uint256 pricePerCall; // fixed price in the settlement token (ignored when usdPriced)
        bool active;
        uint256 totalCalls;
        uint256 grossRevenue; // in settlement units actually paid
        uint64 createdAt;
        bool usdPriced; // when true, payable amount = quoteIn(productId, token) via QIE Oracle
        uint256 priceUsd; // USD price with 8 decimals (oracle convention)
    }

    struct Call {
        uint256 id;
        uint256 productId;
        address agent;
        address principal;
        uint256 amount;
        uint256 escrowId;
        uint64 at;
    }

    uint256 public nextProductId = 1;
    uint256 public nextCallId = 1;
    uint256 public feeBps = 50; // 0.5% platform fee
    uint256 public constant MAX_FEE_BPS = 200; // hard cap 2%

    MerchantRegistry public immutable merchantRegistry;
    AgentRegistry public immutable agentRegistry;
    MandateVault public immutable mandateVault;
    EscrowCore public immutable escrow;
    SettlementRouter public immutable settlementRouter;
    CreditPassport public immutable creditPassport;

    mapping(uint256 => Product) public products;
    mapping(uint256 => Call) public calls;
    mapping(address => uint256[]) public productsOfMerchant;

    // ---------- QIE Oracle USD pricing ----------
    mapping(address => address) public usdFeeds; // settlement token => AggregatorV3 USD feed
    uint256 public maxFeedAge = 26 hours; // QIE Oracle updates ~daily; reject older

    event UsdFeedSet(address indexed token, address indexed feed);
    event MaxFeedAgeChanged(uint256 seconds_);

    error StaleFeed();
    error NoFeed();
    error TokenMismatch();
    error WrongAmount();
    error NotUsdPriced();

    event ProductAdded(uint256 indexed id, address indexed merchant, string name, string endpointPath, uint256 pricePerCall);
    event ProductStatusChanged(uint256 indexed id, bool active);
    event CallPaid(uint256 indexed callId, uint256 indexed productId, address indexed agent, address principal, uint256 amount, uint256 escrowId);
    event CallClaimed(uint256 indexed callId, uint256 netToMerchant, uint256 fee);
    event CallRefunded(uint256 indexed callId);
    event FeeUpdated(uint256 newFeeBps);

    error NotProductMerchant();
    error CallNotOpen();

    constructor(
        address _merchantRegistry,
        address _agentRegistry,
        address _mandateVault,
        address _escrow,
        address _settlementRouter,
        address _creditPassport
    ) {
        merchantRegistry = MerchantRegistry(_merchantRegistry);
        agentRegistry = AgentRegistry(_agentRegistry);
        mandateVault = MandateVault(_mandateVault);
        escrow = EscrowCore(_escrow);
        settlementRouter = SettlementRouter(_settlementRouter);
        creditPassport = CreditPassport(_creditPassport);
    }

    /// @notice Merchant lists a machine-payable product.
    function addProduct(
        string calldata name,
        string calldata endpointPath,
        string calldata metadataURI,
        uint256 pricePerCall
    ) external returns (uint256 id) {
        require(merchantRegistry.isVerifiedMerchant(msg.sender), "NOT_VERIFIED_MERCHANT");
        require(bytes(name).length > 0, "EMPTY_NAME");
        require(pricePerCall > 0, "ZERO_PRICE");

        id = nextProductId++;
        products[id] = Product({
            id: id,
            merchant: msg.sender,
            name: name,
            endpointPath: endpointPath,
            metadataURI: metadataURI,
            pricePerCall: pricePerCall,
            active: true,
            totalCalls: 0,
            grossRevenue: 0,
            createdAt: uint64(block.timestamp),
            usdPriced: false,
            priceUsd: 0
        });
        productsOfMerchant[msg.sender].push(id);

        emit ProductAdded(id, msg.sender, name, endpointPath, pricePerCall);
    }

    function setProductActive(uint256 productId, bool active) external {
        Product storage p = products[productId];
        if (p.merchant != msg.sender) revert NotProductMerchant();
        p.active = active;
        emit ProductStatusChanged(productId, active);
    }

    // ---------- USD-priced products (oracle-quoted) ----------

    /// @notice Verifier (platform) maps a settlement asset to its official QIE
    ///         Oracle USD feed. QIE mainnet example: the native-QIE feed.
    function setUsdFeed(address token, address feed) external {
        require(msg.sender == merchantRegistry.verifier(), "NOT_VERIFIER");
        require(token != address(0) && feed != address(0), "ZERO_ADDR");
        usdFeeds[token] = feed;
        emit UsdFeedSet(token, feed);
    }

    function setMaxFeedAge(uint256 seconds_) external {
        require(msg.sender == merchantRegistry.verifier(), "NOT_VERIFIER");
        require(seconds_ >= 15 minutes, "TOO_SHORT");
        maxFeedAge = seconds_;
        emit MaxFeedAgeChanged(seconds_);
    }

    /// @notice Merchant lists a USD-priced product. The exact token amount is
    ///         computed at purchase time from the QIE Oracle, so the merchant
    ///         is insulated from asset volatility.
    function addProductUsd(
        string calldata name,
        string calldata endpointPath,
        string calldata metadataURI,
        uint256 priceUsd // 8 decimals
    ) external returns (uint256 id) {
        require(merchantRegistry.isVerifiedMerchant(msg.sender), "NOT_VERIFIED_MERCHANT");
        require(bytes(name).length > 0, "EMPTY_NAME");
        require(priceUsd > 0, "ZERO_PRICE");

        id = nextProductId++;
        products[id] = Product({
            id: id,
            merchant: msg.sender,
            name: name,
            endpointPath: endpointPath,
            metadataURI: metadataURI,
            pricePerCall: 0,
            active: true,
            totalCalls: 0,
            grossRevenue: 0,
            createdAt: uint64(block.timestamp),
            usdPriced: true,
            priceUsd: priceUsd
        });
        productsOfMerchant[msg.sender].push(id);

        emit ProductAdded(id, msg.sender, name, endpointPath, priceUsd);
    }

    /// @notice On-chain quote: how many units of `token` equal this product's
    ///         USD price right now, per the official QIE Oracle feed.
    ///         priceUsd (8 dec) * 10^tokenDecimals / feedAnswer (8 dec).
    function quoteIn(uint256 productId, address token) public view returns (uint256 amount) {
        Product storage p = products[productId];
        if (!p.usdPriced) revert NotUsdPriced();
        address feedAddr = usdFeeds[token];
        if (feedAddr == address(0)) revert NoFeed();

        (, int256 answer, , uint256 updatedAt, ) = IAggregatorV3(feedAddr).latestRoundData();
        if (answer <= 0) revert StaleFeed();
        if (block.timestamp - updatedAt > maxFeedAge) revert StaleFeed();

        uint8 tokenDecimals = IERC20Metadata(token).decimals();
        amount = (p.priceUsd * (10 ** tokenDecimals)) / uint256(answer);
    }

    /// @notice THE machine purchase path. Agent pays for one call of a product
    ///         using its pre-funded mandate. Flow:
    ///         1) mandate token is validated against the requested asset
    ///         2) the payable amount is fixed: product price, or oracle-quoted
    ///            USD value for usdPriced products
    ///         3) mandate.spend() moves that amount into the escrow contract
    ///         4) escrow.registerExternal() records a refund-window escrow
    ///         5) credit history accrues to the human principal
    /// @return callId Id of the recorded call.
    function payForCall(uint256 mandateId, uint256 productId, IERC20 token)
        external
        returns (uint256 callId)
    {
        Product storage p = products[productId];
        if (!p.active) revert CallNotOpen();

        // agent eligibility: registered + active + bound human principal
        require(agentRegistry.isEligibleAgent(msg.sender), "AGENT_NOT_ELIGIBLE");

        // the mandate must belong to the calling agent
        require(mandateVault.agentOf(mandateId) == msg.sender, "NOT_MANDATE_AGENT");
        address principal = mandateVault.principalOf(mandateId);

        // REAL currency check: the mandate can only spend its own asset.
        // Reject any mismatched token label up front (kills spoofed labels).
        (, , , IERC20 mandateToken, , , , , , , ) = mandateVault.mandates(mandateId);
        if (address(mandateToken) != address(token)) revert TokenMismatch();

        // payable amount: fixed price, or oracle-quoted USD value
        uint256 amount = p.usdPriced ? quoteIn(productId, address(token)) : p.pricePerCall;
        require(amount > 0, "ZERO_AMOUNT");

        // 1) mandate funds move to escrow (single token pull)
        mandateVault.spend(mandateId, address(escrow), amount, "PAY_ENDPOINT");

        // 2) escrow record for the arrived funds (payer = principal attribution)
        uint256 escrowId = escrow.registerExternal(
            token,
            principal,
            msg.sender,
            p.merchant,
            amount,
            0 // default window
        );

        callId = nextCallId++;
        calls[callId] = Call({
            id: callId,
            productId: productId,
            agent: msg.sender,
            principal: principal,
            amount: amount,
            escrowId: escrowId,
            at: uint64(block.timestamp)
        });

        p.totalCalls += 1;
        p.grossRevenue += amount;

        // 3) credit history accrues to the human principal
        creditPassport.recordPayment(principal, amount, true);

        emit CallPaid(callId, productId, msg.sender, principal, amount, escrowId);
    }

    /// @notice Merchant claims settlement of a call after the refund window.
    ///         Router records net earnings + platform fee (fee settlement
    ///         happens via SettlementRouter.payFeesOwed or platform invoice).
    function claimCall(uint256 callId) external {
        Call storage c = calls[callId];
        Product storage p = products[c.productId];
        if (p.merchant != msg.sender) revert NotProductMerchant();

        (EscrowCore.State state, , , , ) = escrow.statusOf(c.escrowId);
        if (state != EscrowCore.State.Open) revert CallNotOpen();

        escrow.settleExpired(c.escrowId); // full amount to merchant wallet

        // REAL token accounting: use the escrow's actual settlement asset
        // (instead of a zero placeholder) so merchant ledgers are per-token.
        (, IERC20 settledTokenI, , , , , , , ) = escrow.escrows(c.escrowId);

        uint256 fee = (c.amount * feeBps) / 10_000;
        uint256 net = c.amount - fee;
        settlementRouter.recordExternal(address(settledTokenI), p.merchant, net, fee);

        emit CallClaimed(callId, net, fee);
    }

    /// @notice Principal refunds a call within the window.
    function refundCall(uint256 callId) external {
        Call storage c = calls[callId];
        (EscrowCore.State state, , , address payer, ) = escrow.statusOf(c.escrowId);
        if (state != EscrowCore.State.Open) revert CallNotOpen();
        require(msg.sender == payer, "NOT_PAYER");

        escrow.refund(c.escrowId);
        creditPassport.recordPayment(c.principal, c.amount, false);

        emit CallRefunded(callId);
    }

    function setFeeBps(uint256 _feeBps) external {
        require(msg.sender == merchantRegistry.verifier(), "NOT_VERIFIER");
        require(_feeBps <= MAX_FEE_BPS, "FEE_TOO_HIGH");
        feeBps = _feeBps;
        emit FeeUpdated(_feeBps);
    }

    // ---------- views ----------

    function productCount() external view returns (uint256) {
        return nextProductId - 1;
    }

    function productsOf(address merchant) external view returns (uint256[] memory) {
        return productsOfMerchant[merchant];
    }
}
