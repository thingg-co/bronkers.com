// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IVenue} from "./interfaces/ITraderNFT.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Chainlink AggregatorV3, the part we read.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title PaperVenue
/// @notice A paper market: real prices, fake money. Quotes any curated pair
/// from USD price feeds (Chainlink on a public testnet, a settable mock
/// aggregator locally), fills at that price less a small spread, and mints or
/// holds the mock tokens it trades, so there is unlimited depth at the oracle
/// price and nothing for a brain to manipulate. Everything else the protocol
/// does — the guard, the vaults, the fees, the record — runs unchanged on top,
/// which is what makes it a place to learn. The base asset (mUSDC) is priced
/// at a fixed 1 USD; every other token needs a feed.
contract PaperVenue is IVenue {
    using SafeERC20 for IERC20;

    uint256 private constant WAD = 1e18;

    address public immutable deployer;
    mapping(address => AggregatorV3Interface) public feedOf; // token -> USD feed
    mapping(address => uint256) public fixedUsd; // token -> fixed USD price (1e18), for the base asset
    uint16 public spreadBps = 10; // the house takes 0.10%
    uint256 public maxStale; // a feed older than this is refused; 0 (default) = never refuse (mock feeds; a real deployment sets it)

    event FeedSet(address indexed token, address feed);
    event FixedUsdSet(address indexed token, uint256 usd);
    event SpreadSet(uint16 bps);
    event MaxStaleSet(uint256 seconds_);
    event PaperFill(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address recipient);

    constructor() {
        deployer = msg.sender;
    }

    modifier onlyDeployer() {
        require(msg.sender == deployer, "Paper: not deployer");
        _;
    }

    function setFeed(address token, address feed) external onlyDeployer {
        feedOf[token] = AggregatorV3Interface(feed);
        emit FeedSet(token, feed);
    }

    function setFixedUsd(address token, uint256 usd) external onlyDeployer {
        fixedUsd[token] = usd;
        emit FixedUsdSet(token, usd);
    }

    function setSpread(uint16 bps) external onlyDeployer {
        require(bps <= 1_000, "Paper: spread");
        spreadBps = bps;
        emit SpreadSet(bps);
    }

    function setMaxStale(uint256 seconds_) external onlyDeployer {
        maxStale = seconds_;
        emit MaxStaleSet(seconds_);
    }

    /// @notice USD price of one whole token, 1e18-scaled, from its feed or its fixed price.
    function usdPrice(address token) public view returns (uint256) {
        AggregatorV3Interface feed = feedOf[token];
        if (address(feed) == address(0)) {
            uint256 fixed_ = fixedUsd[token];
            require(fixed_ > 0, "Paper: no price");
            return fixed_;
        }
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        require(answer > 0, "Paper: bad answer");
        require(maxStale == 0 || block.timestamp <= updatedAt + maxStale, "Paper: stale price");
        uint8 d = feed.decimals();
        return d <= 18 ? uint256(answer) * 10 ** (18 - d) : uint256(answer) / 10 ** (d - 18);
    }

    /// @notice Oracle cross rate: tokens are 18-decimal mocks, so amounts scale directly.
    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        return (amountIn * usdPrice(tokenIn)) / usdPrice(tokenOut);
    }

    /// @notice Fill at the oracle price less the spread. Pulls tokenIn from the
    /// caller (the guard, which approved exactly amountIn) and mints tokenOut to
    /// the recipient (the source book). The house keeps what it is paid.
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        amountOut = (quote(tokenIn, tokenOut, amountIn) * (10_000 - spreadBps)) / 10_000;
        require(amountOut >= minAmountOut, "Paper: insufficient output");
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        MockERC20(tokenOut).mint(recipient, amountOut);
        emit PaperFill(tokenIn, tokenOut, amountIn, amountOut, recipient);
    }
}
