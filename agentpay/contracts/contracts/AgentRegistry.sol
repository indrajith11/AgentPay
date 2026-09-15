// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AgentRegistry
/// @notice Know-Your-Agent (KYA) registry. Every autonomous agent that can
///         spend on behalf of a human principal registers here and binds to
///         exactly one principal. Consumers of agent payments (PayEndpoint,
///         MandateVault) check active + bound principal before accepting a
///         machine purchase.
contract AgentRegistry {
    struct Agent {
        address agentAddr;
        address principal; // human accountable owner (address(0) until bound)
        string name;
        string qiePassId; // principal's QIE Pass reusable-KYC reference
        bool active;
        uint64 registeredAt;
        uint64 boundAt;
    }

    mapping(address => Agent) private _agents;
    address[] public agentList;

    event AgentRegistered(address indexed agent, string name);
    event PrincipalBound(address indexed agent, address indexed principal, string qiePassId);
    event AgentStatusChanged(address indexed agent, bool active);

    modifier onlyRegisteredAgent(address agent) {
        require(_agents[agent].agentAddr != address(0), "AGENT_NOT_REGISTERED");
        _;
    }

    /// @notice An agent wallet registers itself. Name should be a human-readable id.
    function registerAgent(string calldata name) external {
        require(bytes(name).length > 0, "EMPTY_NAME");
        require(_agents[msg.sender].agentAddr == address(0), "ALREADY_REGISTERED");

        _agents[msg.sender] = Agent({
            agentAddr: msg.sender,
            principal: address(0),
            name: name,
            qiePassId: "",
            active: true,
            registeredAt: uint64(block.timestamp),
            boundAt: 0
        });
        agentList.push(msg.sender);

        emit AgentRegistered(msg.sender, name);
    }

    /// @notice The human principal binds the agent to themselves. Only the
    ///         principal can do this, so accountability is opt-in by the human.
    function bindPrincipal(address agent, string calldata qiePassId)
        external
        onlyRegisteredAgent(agent)
    {
        require(msg.sender != agent, "PRINCIPAL_NOT_SELF");
        Agent storage a = _agents[agent];
        require(a.principal == address(0), "ALREADY_BOUND");

        a.principal = msg.sender;
        a.qiePassId = qiePassId;
        a.boundAt = uint64(block.timestamp);

        emit PrincipalBound(agent, msg.sender, qiePassId);
    }

    function setActive(address agent, bool active) external onlyRegisteredAgent(agent) {
        require(msg.sender == agent || msg.sender == _agents[agent].principal, "NOT_AUTHORIZED");
        _agents[agent].active = active;
        emit AgentStatusChanged(agent, active);
    }

    // ---------- views ----------

    function getAgent(address agent) external view returns (Agent memory) {
        return _agents[agent];
    }

    /// @notice Full eligibility check used by payment contracts: registered,
    ///         active, and bound to a human principal.
    function isEligibleAgent(address agent) external view returns (bool) {
        Agent storage a = _agents[agent];
        return a.agentAddr != address(0) && a.active && a.principal != address(0);
    }

    function principalOf(address agent) external view returns (address) {
        return _agents[agent].principal;
    }

    function agentCount() external view returns (uint256) {
        return agentList.length;
    }
}
