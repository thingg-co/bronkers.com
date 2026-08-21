import { parseAbi } from "viem";

export const traderNftAbi = parseAbi([
  "struct Genome { bytes32 commitment; uint64 birthBlock; uint8 riskProfile; uint8 cadence; uint8 custody; string model; string encryptedPromptCID; }",
  "function genomeOf(uint256 tokenId) view returns (Genome)",
  "function accountOf(uint256 tokenId) view returns (address)",
  "function vaultOf(uint256 tokenId) view returns (address)",
  "function ownerOf(uint256 tokenId) view returns (address)",
]);

export const guardAbi = parseAbi([
  "function executeTrade(uint256 tokenId, address venue, address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, bool fromVault) returns (uint256)",
  "function policyOf(uint256 tokenId) view returns (address executor, uint16 maxNotionalBps, uint16 maxSlippageBps, uint64 minTradeInterval, uint64 lastTradeAt, address valuationRouter)",
  "function tokenAllowed(uint256 tokenId, address token) view returns (bool)",
  "function venueAllowed(uint256 tokenId, address venue) view returns (bool)",
  "function tbaNav(uint256 tokenId) view returns (uint256)",
  "function seasoned(uint256 tokenId) view returns (bool)",
  "function tradeCountOf(uint256 tokenId) view returns (uint32)",
  "event TradeExecuted(uint256 indexed tokenId, address indexed venue, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, bool fromVault)",
]);

export const vaultAbi = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function asset() view returns (address)",
  "function universe() view returns (address[])",
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
]);

export const venueAbi = parseAbi([
  "function quote(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
]);
