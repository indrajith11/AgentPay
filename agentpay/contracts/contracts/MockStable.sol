// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockStable
/// @notice Test/demo stand-in for QUSDC (QIE stablecoin). Mainnet deployments
///         use the real QUSDC address instead.
contract MockStable is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        _mint(msg.sender, 1_000_000 ether);
    }

    function faucet() external {
        _mint(msg.sender, 1_000 ether);
    }
}
