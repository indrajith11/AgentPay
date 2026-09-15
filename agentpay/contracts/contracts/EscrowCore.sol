// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title EscrowCore
/// @notice Reversible-window payment escrow for machine and human commerce.
///         Payer can refund within `refundWindow` seconds; payee claims after.
///         This repairs the x402 failure mode of irreversible one-way pushes.
contract EscrowCore {
    using SafeERC20 for IERC20;

    enum State {
        Open,
        Released,
        Refunded
    }

    struct Escrow {
        uint256 id;
        IERC20 token;
        address payer; // principal who funded (attribution for credit)
        address agent; // executing agent (address(0) for human payments)
        address payee; // merchant
        uint256 amount;
        uint64 deadline; // refund window end
        State state;
        uint64 openedAt;
    }

    uint256 public nextEscrowId = 1;
    uint64 public defaultRefundWindow;
    address public owner;
    mapping(address => bool) public relayers; // protocol contracts (e.g. PayEndpoint) allowed to trigger refund

    mapping(uint256 => Escrow) public escrows;

    event EscrowOpened(
        uint256 indexed id,
        address indexed payer,
        address indexed agent,
        address payee,
        uint256 amount,
        uint64 deadline
    );
    event EscrowReleased(uint256 indexed id, uint256 amount);
    event EscrowRefunded(uint256 indexed id, uint256 amount);
    event DefaultWindowChanged(uint64 newWindow);

    error NotPayer();
    error NotPayee();
    error NotOpen();
    error WindowStillOpen();
    error WindowClosed();

    constructor(uint64 _defaultRefundWindow) {
        defaultRefundWindow = _defaultRefundWindow; // e.g. 10 minutes
        owner = msg.sender;
    }

    function setRelayer(address relayer, bool authorized) external {
        require(msg.sender == owner, "NOT_OWNER");
        require(relayer != address(0), "ZERO_RELAYER");
        relayers[relayer] = authorized;
    }

    /// @notice Open an escrow by pulling `amount` from the caller.
    /// @param agent The acting agent (address(0) if a human pays directly).
    function open(
        IERC20 token,
        address payer,
        address agent,
        address payee,
        uint256 amount,
        uint64 refundWindow
    ) external returns (uint256 id) {
        require(amount > 0, "ZERO_AMOUNT");
        require(payee != address(0), "ZERO_PAYEE");

        if (refundWindow == 0) refundWindow = defaultRefundWindow;

        id = nextEscrowId++;
        escrows[id] = Escrow({
            id: id,
            token: token,
            payer: payer,
            agent: agent,
            payee: payee,
            amount: amount,
            deadline: uint64(block.timestamp) + refundWindow,
            state: State.Open,
            openedAt: uint64(block.timestamp)
        });

        token.safeTransferFrom(msg.sender, address(this), amount);

        emit EscrowOpened(id, payer, agent, payee, amount, uint64(block.timestamp) + refundWindow);
    }

    /// @notice Register an escrow for funds that were ALREADY transferred to
    ///         this contract (e.g. MandateVault.spend sent them here directly).
    ///         Avoids a double token pull. Caller must ensure the funds arrived.
    function registerExternal(
        IERC20 token,
        address payer,
        address agent,
        address payee,
        uint256 amount,
        uint64 refundWindow
    ) external returns (uint256 id) {
        require(amount > 0, "ZERO_AMOUNT");
        require(payee != address(0), "ZERO_PAYEE");
        require(token.balanceOf(address(this)) >= amount, "FUNDS_NOT_ARRIVED");

        if (refundWindow == 0) refundWindow = defaultRefundWindow;

        id = nextEscrowId++;
        escrows[id] = Escrow({
            id: id,
            token: token,
            payer: payer,
            agent: agent,
            payee: payee,
            amount: amount,
            deadline: uint64(block.timestamp) + refundWindow,
            state: State.Open,
            openedAt: uint64(block.timestamp)
        });

        emit EscrowOpened(id, payer, agent, payee, amount, uint64(block.timestamp) + refundWindow);
    }

    /// @notice Payer refunds while the window is open. Protocol relayers
    ///         (e.g. PayEndpoint after validating the caller) may also trigger
    ///         it; funds always return to the recorded payer.
    function refund(uint256 id) external {
        Escrow storage e = escrows[id];
        if (e.state != State.Open) revert NotOpen();
        if (msg.sender != e.payer && msg.sender != e.agent && !relayers[msg.sender]) revert NotPayer();
        if (block.timestamp > e.deadline) revert WindowClosed();

        e.state = State.Refunded;
        e.token.safeTransfer(e.payer, e.amount);

        emit EscrowRefunded(id, e.amount);
    }

    /// @notice Payee claims settlement once the window has elapsed.
    function release(uint256 id) external {
        Escrow storage e = escrows[id];
        if (e.state != State.Open) revert NotOpen();
        if (msg.sender != e.payee) revert NotPayee();
        if (block.timestamp <= e.deadline) revert WindowStillOpen();

        e.state = State.Released;
        e.token.safeTransfer(e.payee, e.amount);

        emit EscrowReleased(id, e.amount);
    }

    /// @notice Anyone (keeper/agent) can settle an expired escrow to the payee —
    ///         keeps merchant settlement autonomous.
    function settleExpired(uint256 id) external {
        Escrow storage e = escrows[id];
        if (e.state != State.Open) revert NotOpen();
        if (block.timestamp <= e.deadline) revert WindowStillOpen();

        e.state = State.Released;
        e.token.safeTransfer(e.payee, e.amount);

        emit EscrowReleased(id, e.amount);
    }

    // ---------- views ----------

    function statusOf(uint256 id)
        external
        view
        returns (State state, uint64 deadline, uint256 amount, address payer, address payee)
    {
        Escrow storage e = escrows[id];
        return (e.state, e.deadline, e.amount, e.payer, e.payee);
    }
}
