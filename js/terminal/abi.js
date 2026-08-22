// Contract surfaces the Terminal talks to. Human-readable ABIs, parsed once.
import { parseAbi } from "https://esm.sh/viem@2.21.19";

export const nftAbi = parseAbi([
  "struct Genome { bytes32 commitment; uint64 birthBlock; uint8 riskProfile; uint8 cadence; uint8 custody; string model; string encryptedPromptCID; }",
  "function nextId() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function genomeOf(uint256) view returns (Genome)",
  "function ownerOf(uint256) view returns (address)",
  "function vaultOf(uint256) view returns (address)",
  "function accountOf(uint256) view returns (address)",
  "function nameOf(uint256) view returns (string)",
  "function cadenceOf(uint256) view returns (uint8)",
  "function christen(uint256,string)",
  "function publishEnvelope(uint256,bytes)",
  "function tokenURI(uint256) view returns (string)",
  "function mint(bytes32,uint8,uint8,uint8,string,string,address[],uint16,uint16) returns (uint256)",
  "function safeTransferFrom(address,address,uint256)",
  "event TraderBorn(uint256 indexed tokenId, address indexed minter, bytes32 commitment, address account, address vault)",
  "event Christened(uint256 indexed tokenId, string name)",
  "event EnvelopePublished(uint256 indexed tokenId, bytes envelope)",
]);

export const guardAbi = parseAbi([
  "function policyOf(uint256) view returns (address executor, uint16 maxNotionalBps, uint16 maxSlippageBps, uint64 minTradeInterval, uint64 lastTradeAt, address valuationRouter)",
  "function tierOf(uint256) view returns (uint8)",
  "function tiers(uint256) view returns (uint16 maxNotionalBps, uint256 fee)",
  "function seasoned(uint256) view returns (bool)",
  "function tradeCountOf(uint256) view returns (uint32)",
  "function firstTradeAt(uint256) view returns (uint64)",
  "function seasonDuration() view returns (uint64)",
  "function seasonMinTrades() view returns (uint32)",
  "function tbaNav(uint256) view returns (uint256)",
  "function tokenAllowed(uint256,address) view returns (bool)",
  "function curatedToken(address) view returns (bool)",
  "function activate(uint256,uint8)",
  "function setExecutor(uint256,address)",
  "function setPolicy(uint256,uint16,uint16,uint64)",
  "function setTokenAllowed(uint256,address,bool)",
  "function runtimeFeeOf(uint256) view returns (uint256)",
  "function maxRuntimeFee() view returns (uint256)",
  "function setRuntimeFee(uint256,uint256)",
  "function pendingRuntimeFeeOf(uint256) view returns (uint256 fee, uint64 effectiveAt)",
  "function runtimeFeeDelay() view returns (uint64)",
  "function minFeeNotionalBps() view returns (uint16)",
  "function registry() view returns (address)",
  "function cadenceIntervalOf(uint256) view returns (uint64)",
  "function tradeIntervalOf(uint256) view returns (uint64)",
  "function nextTradeAt(uint256) view returns (uint64)",
  "function baseAsset() view returns (address)",
  "event RuntimeFeePaid(uint256 indexed tokenId, address indexed executor, uint256 fee)",
  "event RuntimeFeeSet(uint256 indexed tokenId, uint256 fee)",
  "event RuntimeFeeScheduled(uint256 indexed tokenId, uint256 fee, uint64 effectiveAt)",
  "event TranscriptCommitted(uint256 indexed tokenId, bytes32 transcript)",
  "event TradeExecuted(uint256 indexed tokenId, address indexed venue, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, bool fromVault)",
  "event TierActivated(uint256 indexed tokenId, uint8 tier, uint256 fee)",
  "event ExecutorSet(uint256 indexed tokenId, address executor)",
]);

export const vaultAbi = parseAbi([
  "function asset() view returns (address)",
  "function universe() view returns (address[])",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function previewDeposit(uint256) view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
  "function highWaterMark() view returns (uint256)",
  "function lastCheckpoint() view returns (uint64)",
  "function managementFeeBps() view returns (uint16)",
  "function performanceFeeBps() view returns (uint16)",
  "function allowlistEnabled() view returns (bool)",
  "function depositAllowed(address) view returns (bool)",
  "function pendingFees() view returns (uint256 mgmtShares, uint256 perfShares, uint256 bellReward)",
  "function deposit(uint256,address) returns (uint256)",
  "function withdraw(uint256,address,address) returns (uint256)",
  "function redeem(uint256,address,address) returns (uint256)",
  "function ringTheBell()",
  "function checkpoint()",
  "function setDepositAllowed(address,bool)",
  "function setAllowlistEnabled(bool)",
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
  "event FeesAccrued(uint256 managementShares, uint256 performanceShares, uint256 newHighWaterMark)",
  "event BellRung(address indexed ringer, uint256 rewardShares)",
]);

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function mint(address,uint256)",
]);

export const registryAbi = parseAbi([
  "function runtimeOf(address) view returns (bytes32 measurement, bytes enclavePublicKey, uint64 registeredAt)",
  "function attested(address) view returns (bool)",
  "function attestationOf(address) view returns (uint8)",
  "function hardwareAttested(address) view returns (bool)",
  "function verifier() view returns (address)",
  "function approvedMeasurement(bytes32) view returns (bool)",
]);

/** The machine market the farm pays its lease into (Marlin Oyster on Arbitrum, the mock locally). */
export const marketAbi = parseAbi([
  "function jobs(bytes32) view returns (string metadata, address owner, address provider, uint256 rate, uint256 balance, uint256 lastSettled)",
  "function EXTRA_DECIMALS() view returns (uint256)",
  "function token() view returns (address)",
]);

export const ATTESTATION = ["none", "self-reported", "hardware"];

export const tbaAbi = parseAbi([
  "function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)",
  "function owner() view returns (address)",
  "function token() view returns (uint256 chainId, address tokenContract, uint256 tokenId)",
]);

export const venueAbi = parseAbi([
  "function quote(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)",
  "function setPrice(address tokenIn, address tokenOut, uint256 p)",
]);

export const CUSTODY = [
  { key: "authored", label: "Authored", blurb: "The creator keeps a decryption key. Every past owner can read the prompt." },
  { key: "sealed", label: "Sealed", blurb: "The prompt was sealed to the enclave at birth. No owner, past or future, can read it." },
  { key: "sealed-gen", label: "Sealed & generated", blurb: "The enclave wrote the prompt from a brief and sealed it. No human has ever read it." },
];
export const TIERS = ["Intern", "Associate", "Partner"];
export const RISK = ["conservative", "balanced", "aggressive"];
