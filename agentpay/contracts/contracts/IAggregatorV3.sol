// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAggregatorV3
/// @notice Minimal Chainlink AggregatorV3-compatible interface. The QIE Oracle
///         (official docs: docs.qie.digital/qie-oracle) implements exactly this
///         standard, so no external dependency is needed.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}
