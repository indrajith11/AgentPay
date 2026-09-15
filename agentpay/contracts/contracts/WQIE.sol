// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title WQIE — Wrapped QIE (canonical WETH9 pattern)
/// @notice QIE's native coin cannot be moved by ERC20 flows (mandates,
///         escrow, router, approvals). WQIE wraps native QIE 1:1 into a
///         standard ERC20 so the whole AgentPay stack settles in the chain's
///         own asset. The official QIE Oracle QIE/USD feed prices WQIE
///         (1 WQIE = 1 QIE), enabling USD-priced products payable in QIE.
contract WQIE is ERC20, ReentrancyGuard {
    event Deposited(address indexed to, uint256 amount);
    event Withdrawn(address indexed from, uint256 amount);

    error InsufficientBalance();
    error ZeroAmount();

    constructor() ERC20("Wrapped QIE", "WQIE") {}

    receive() external payable {
        deposit();
    }

    /// @notice Wrap native QIE into WQIE (1:1).
    function deposit() public payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        _mint(msg.sender, msg.value);
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Unwrap WQIE back to native QIE (1:1).
    /// @param amount WQIE amount to burn.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (balanceOf(msg.sender) < amount) revert InsufficientBalance();
        _burn(msg.sender, amount);
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "QIE_TRANSFER_FAILED");
        emit Withdrawn(msg.sender, amount);
    }
}
