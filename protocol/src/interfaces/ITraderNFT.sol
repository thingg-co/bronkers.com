// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface ITraderNFT {
    function ownerOf(uint256 tokenId) external view returns (address);
    function accountOf(uint256 tokenId) external view returns (address);
    function vaultOf(uint256 tokenId) external view returns (address);
    /// @notice Declared max trades per day (public trait, >= 1). The guard
    /// enforces it as a floor under the owner's minTradeInterval.
    function cadenceOf(uint256 tokenId) external view returns (uint8);
}

/// @notice Verifies a TEE quote and returns what the RuntimeRegistry binds:
/// a runtime measurement and the first 32 bytes of the quote's report data.
/// Must revert on an invalid quote. Implementations wrap a chain's DCAP
/// verifier (AutomataDcapTdxVerifier) or, in tests, return fixed values.
interface IQuoteVerifier {
    function verify(bytes calldata quote) external payable returns (bytes32 measurement, bytes32 reportData);
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
