// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AggregatorV3Interface} from "../PaperVenue.sol";

/// @notice A settable Chainlink-shaped price feed for anvil and tests: the
/// Developer tab's "move the mock market" lever writes here, and the paper
/// venue reads it exactly as it would read a real feed.
contract MockAggregator is AggregatorV3Interface {
    uint8 public immutable decimals;
    string public description;
    int256 private _answer;
    uint256 private _updatedAt;
    uint80 private _round;

    constructor(string memory description_, uint8 decimals_, int256 answer_) {
        description = description_;
        decimals = decimals_;
        _set(answer_);
    }

    /// @notice Anyone may move a mock price; it is a dev lever, not a feed.
    function setAnswer(int256 answer_) external {
        _set(answer_);
    }

    function _set(int256 answer_) private {
        _answer = answer_;
        _updatedAt = block.timestamp;
        _round++;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (_round, _answer, _updatedAt, _updatedAt, _round);
    }
}
