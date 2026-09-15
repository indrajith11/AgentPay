// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IAggregatorV3.sol";

/// @title MockAggregator
/// @notice Test-only AggregatorV3 mock that mimics the QIE Oracle feed shape
///         (8-decimal USD answers + updatedAt for staleness checks).
contract MockAggregator is IAggregatorV3 {
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId = 1;
    uint8 public feedDecimals = 8;

    function setData(int256 _answer, uint256 _updatedAt) external {
        answer = _answer;
        updatedAt = _updatedAt;
        roundId++;
    }

    function decimals() external view returns (uint8) {
        return feedDecimals;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80,
            int256,
            uint256,
            uint256,
            uint80
        )
    {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}
