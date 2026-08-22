import { parseAbi } from "viem";

export const traderNftAbi = parseAbi([
  "struct Genome { bytes32 commitment; uint64 birthBlock; uint8 riskProfile; uint8 cadence; uint8 custody; string model; string encryptedPromptCID; }",
  "function genomeOf(uint256 tokenId) view returns (Genome)",
  "function accountOf(uint256 tokenId) view returns (address)",
  "function vaultOf(uint256 tokenId) view returns (address)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function nameOf(uint256 tokenId) view returns (string)",
  "function cadenceOf(uint256 tokenId) view returns (uint8)",
  "function nextId() view returns (uint256)",
  "function liveSupply() view returns (uint256)",
  "function burnedCount() view returns (uint256)",
  "function revise(uint256 tokenId, bytes32 commitment, string model, string encryptedPromptCID)",
  "function generationOf(uint256 tokenId) view returns (uint32)",
  "function generationSince(uint256 tokenId, uint32 generation) view returns (uint64)",
  "function generationAt(uint256 tokenId, uint32 generation) view returns (bytes32 commitment, string model, string encryptedPromptCID, uint64 sinceBlock, uint64 sinceTime)",
  "event EnvelopePublished(uint256 indexed tokenId, bytes envelope)",
  "event GenomeRevised(uint256 indexed tokenId, uint32 generation, bytes32 commitment, string model)",
]);

export const guardAbi = parseAbi([
  "function executeTrade(uint256 tokenId, address venue, address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, bool fromVault) returns (uint256)",
  "function executeTradeWithTranscript(uint256 tokenId, address venue, address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, bool fromVault, bytes32 transcript) returns (uint256)",
  "function policyOf(uint256 tokenId) view returns (address executor, uint16 maxNotionalBps, uint16 maxSlippageBps, uint64 minTradeInterval, uint64 lastTradeAt, address valuationRouter)",
  "function tokenAllowed(uint256 tokenId, address token) view returns (bool)",
  "function venueAllowed(uint256 tokenId, address venue) view returns (bool)",
  "function tbaNav(uint256 tokenId) view returns (uint256)",
  "function seasoned(uint256 tokenId) view returns (bool)",
  "function tradeCountOf(uint256 tokenId) view returns (uint32)",
  "function runtimeFeeOf(uint256 tokenId) view returns (uint256)",
  "function maxRuntimeFee() view returns (uint256)",
  "function pendingRuntimeFeeOf(uint256 tokenId) view returns (uint256 fee, uint64 effectiveAt)",
  "function runtimeFeeDelay() view returns (uint64)",
  "function minFeeNotionalBps() view returns (uint16)",
  "function registry() view returns (address)",
  "function baseAsset() view returns (address)",
  "function cadenceIntervalOf(uint256 tokenId) view returns (uint64)",
  "function tradeIntervalOf(uint256 tokenId) view returns (uint64)",
  "function nextTradeAt(uint256 tokenId) view returns (uint64)",
  "function campStatus(uint256 tokenId) view returns (uint32 generation, bool inCamp, uint32 trades, uint32 minTrades, uint64 vaultFrom)",
  "function campDone(uint256 tokenId, uint32 generation) view returns (bool)",
  "event TradeExecuted(uint256 indexed tokenId, address indexed venue, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, bool fromVault)",
  "event RuntimeFeePaid(uint256 indexed tokenId, address indexed executor, uint256 fee)",
  "event RuntimeFeeSet(uint256 indexed tokenId, uint256 fee)",
  "event RuntimeFeeScheduled(uint256 indexed tokenId, uint256 fee, uint64 effectiveAt)",
  "event TranscriptCommitted(uint256 indexed tokenId, bytes32 transcript)",
]);

export const vaultAbi = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function asset() view returns (address)",
  "function universe() view returns (address[])",
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
]);

export const registryAbi = parseAbi([
  "function register(bytes32 measurement, bytes enclavePublicKey)",
  "function registerAttested(bytes quote, bytes enclavePublicKey) payable",
  "function runtimeOf(address executor) view returns (bytes32 measurement, bytes enclavePublicKey, uint64 registeredAt)",
  "function attestationOf(address executor) view returns (uint8)",
  "function attested(address executor) view returns (bool)",
  "function hardwareAttested(address executor) view returns (bool)",
  "function verifier() view returns (address)",
]);

export const venueAbi = parseAbi([
  "function quote(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

/** The Marlin Oyster market (MarketV1 on Arbitrum One) and the dev mock share this surface. */
export const marketAbi = parseAbi([
  "function jobs(bytes32 job) view returns (string metadata, address owner, address provider, uint256 rate, uint256 balance, uint256 lastSettled)",
  "function jobDeposit(bytes32 job, uint256 amount)",
  "function jobSettle(bytes32 job)",
  "function EXTRA_DECIMALS() view returns (uint256)",
  "function token() view returns (address)",
  "event JobDeposited(bytes32 indexed job, address indexed from, uint256 amount)",
]);

/** Circle CCTP v2: TokenMessengerV2.depositForBurn and MessageTransmitterV2.receiveMessage. */
export const cctpAbi = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
  "function receiveMessage(bytes message, bytes attestation)",
]);
