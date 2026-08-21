// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Deterministic test venue. Prices are set by the test/deployer;
/// `skewBps` lets tests force execution worse than quote for slippage checks.
/// Output tokens are minted on demand (both sides are MockERC20s), so the
/// router never needs seeded liquidity.
contract MockSwapRouter {
    using SafeERC20 for IERC20;

    /// price[tokenIn][tokenOut]: units of tokenOut per 1e18 units of tokenIn
    mapping(address => mapping(address => uint256)) public price;
    uint16 public skewBps; // execution shortfall vs quote, for negative tests

    function setPrice(address tokenIn, address tokenOut, uint256 p) external {
        price[tokenIn][tokenOut] = p;
    }

    function setSkew(uint16 bps) external {
        skewBps = bps;
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        uint256 p = price[tokenIn][tokenOut];
        require(p != 0, "MockSwapRouter: no price");
        return (amountIn * p) / 1e18;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        amountOut = (quote(tokenIn, tokenOut, amountIn) * (10_000 - skewBps)) / 10_000;
        require(amountOut >= minAmountOut, "MockSwapRouter: insufficient output");
        MockERC20(tokenOut).mint(recipient, amountOut);
    }
}
