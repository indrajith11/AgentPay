// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./AgentRegistry.sol";

/// @title MandateVault
/// @notice Human principals pre-fund spend mandates for their AI agents.
///         Every machine payment flows out of a mandate: per-call cap,
///         daily cap, prepaid balance. The agent can never exceed the
///         human's mandate — spend authority is enforced on-chain.
contract MandateVault {
    using SafeERC20 for IERC20;

    struct Mandate {
        uint256 id;
        address principal;
        address agent;
        IERC20 token;
        uint256 perCallCap;
        uint256 dailyCap;
        uint256 spentToday;
        uint256 currentDay;
        uint256 balance; // prepaid remaining
        bool active;
        uint64 createdAt;
    }

    uint256 public nextMandateId = 1;
    AgentRegistry public immutable agentRegistry;

    mapping(uint256 => Mandate) public mandates;
    mapping(address => uint256[]) public mandatesOfPrincipal;
    // principal-authorized infrastructure contracts (e.g. PayEndpoint) that
    // may execute spend() on behalf of the agent
    mapping(uint256 => mapping(address => bool)) public authorizedCallers;

    event MandateCreated(
        uint256 indexed id,
        address indexed principal,
        address indexed agent,
        address token,
        uint256 perCallCap,
        uint256 dailyCap,
        uint256 initialDeposit
    );
    event MandateDeposited(uint256 indexed id, uint256 amount, uint256 newBalance);
    event MandateSpent(
        uint256 indexed id,
        address indexed agent,
        address indexed to,
        uint256 amount,
        string purposeRef
    );
    event MandateClosed(uint256 indexed id, uint256 refunded);

    error NotAgent();
    error NotPrincipal();
    error MandateInactive();
    error ExceedsPerCallCap();
    error ExceedsDailyCap();
    error InsufficientBalance();

    constructor(address _agentRegistry) {
        require(_agentRegistry != address(0), "ZERO_REGISTRY");
        agentRegistry = AgentRegistry(_agentRegistry);
    }

    modifier onlyAgentOf(uint256 mandateId) {
        if (msg.sender != mandates[mandateId].agent && !authorizedCallers[mandateId][msg.sender]) {
            revert NotAgent();
        }
        _;
    }

    modifier onlyPrincipalOf(uint256 mandateId) {
        if (msg.sender != mandates[mandateId].principal) revert NotPrincipal();
        _;
    }

    function _rollDay(Mandate storage m) private {
        uint256 today = block.timestamp / 1 days;
        if (m.currentDay != today) {
            m.currentDay = today;
            m.spentToday = 0;
        }
    }

    /// @notice Principal creates a mandate and funds it in one tx.
    function createMandate(
        address agent,
        IERC20 token,
        uint256 perCallCap,
        uint256 dailyCap,
        uint256 initialDeposit
    ) external returns (uint256 id) {
        require(agentRegistry.isEligibleAgent(agent), "AGENT_NOT_ELIGIBLE");
        require(dailyCap >= perCallCap, "CAP_MISMATCH");

        id = nextMandateId++;
        mandates[id] = Mandate({
            id: id,
            principal: msg.sender,
            agent: agent,
            token: token,
            perCallCap: perCallCap,
            dailyCap: dailyCap,
            spentToday: 0,
            currentDay: block.timestamp / 1 days,
            balance: initialDeposit,
            active: true,
            createdAt: uint64(block.timestamp)
        });
        mandatesOfPrincipal[msg.sender].push(id);

        if (initialDeposit > 0) {
            token.safeTransferFrom(msg.sender, address(this), initialDeposit);
        }

        emit MandateCreated(id, msg.sender, agent, address(token), perCallCap, dailyCap, initialDeposit);
    }

    function deposit(uint256 mandateId, uint256 amount) external onlyPrincipalOf(mandateId) {
        Mandate storage m = mandates[mandateId];
        require(m.active, "MANDATE_INACTIVE");
        m.balance += amount;
        m.token.safeTransferFrom(msg.sender, address(this), amount);
        emit MandateDeposited(mandateId, amount, m.balance);
    }

    /// @notice Principal authorizes an infrastructure contract (e.g. PayEndpoint)
    ///         to execute spends from this mandate on behalf of the agent.
    function authorizeCaller(uint256 mandateId, address caller, bool authorized)
        external
        onlyPrincipalOf(mandateId)
    {
        require(caller != address(0), "ZERO_CALLER");
        authorizedCallers[mandateId][caller] = authorized;
    }

    /// @notice Agent executes an authorized spend. Enforces caps + prepaid balance.
    /// @param to Recipient (merchant wallet or PayEndpoint contract).
    /// @param amount Token amount.
    /// @param purposeRef Free string linking the spend to an order/call id.
    function spend(uint256 mandateId, address to, uint256 amount, string calldata purposeRef)
        external
        onlyAgentOf(mandateId)
        returns (bool ok)
    {
        Mandate storage m = mandates[mandateId];
        if (!m.active) revert MandateInactive();
        _rollDay(m);

        if (amount > m.perCallCap) revert ExceedsPerCallCap();
        if (m.spentToday + amount > m.dailyCap) revert ExceedsDailyCap();
        if (m.balance < amount) revert InsufficientBalance();

        m.spentToday += amount;
        m.balance -= amount;
        m.token.safeTransfer(to, amount);

        emit MandateSpent(mandateId, msg.sender, to, amount, purposeRef);
        return true;
    }

    /// @notice Principal closes the mandate and refunds the remaining balance.
    function closeMandate(uint256 mandateId) external onlyPrincipalOf(mandateId) {
        Mandate storage m = mandates[mandateId];
        require(m.active, "MANDATE_INACTIVE");

        m.active = false;
        uint256 refund = m.balance;
        if (refund > 0) {
            m.balance = 0;
            m.token.safeTransfer(m.principal, refund);
        }
        emit MandateClosed(mandateId, refund);
    }

    // ---------- views ----------

    function agentOf(uint256 mandateId) external view returns (address) {
        return mandates[mandateId].agent;
    }

    function principalOf(uint256 mandateId) external view returns (address) {
        return mandates[mandateId].principal;
    }

    function canSpend(uint256 mandateId, uint256 amount) external view returns (bool, string memory reason) {
        Mandate storage m = mandates[mandateId];
        if (!m.active) return (false, "INACTIVE");
        if (amount > m.perCallCap) return (false, "PER_CALL_CAP");
        uint256 spent = m.spentToday;
        if (m.currentDay != block.timestamp / 1 days) spent = 0;
        if (spent + amount > m.dailyCap) return (false, "DAILY_CAP");
        if (m.balance < amount) return (false, "BALANCE");
        return (true, "OK");
    }

    function mandateCountOfPrincipal(address principal) external view returns (uint256) {
        return mandatesOfPrincipal[principal].length;
    }
}
