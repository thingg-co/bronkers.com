// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface ITraderNFT {
    function ownerOf(uint256 tokenId) external view returns (address);
    function accountOf(uint256 tokenId) external view returns (address);
    function vaultOf(uint256 tokenId) external view returns (address);
}

/// @notice Season gate: has this trader earned the right to outside capital?
interface ISeasonGate {
    function seasoned(uint256 tokenId) external view returns (bool);
}

/// @notice The minimal venue surface the guard trades through.
/// MockSwapRouter implements it; a thin adapter can wrap Uniswap v3 on testnet.
interface IVenue {
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256);
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        returns (uint256 amountOut);
}
