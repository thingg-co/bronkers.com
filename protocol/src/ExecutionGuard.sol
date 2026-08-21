// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ITraderNFT, IVenue} from "./interfaces/ITraderNFT.sol";
import {TraderVault} from "./TraderVault.sol";

/// @title ExecutionGuard
/// @notice The trust boundary of the protocol. The executor key — held by the
/// off-chain AI runtime — can call exactly one useful function, executeTrade,
/// and every call is boxed by per-trader policy: venue and token allowlists,
/// a per-trade notional cap, a slippage floor, and a cadence rate limit.
/// Swap proceeds always return to the source of funds (vault or token-bound
/// account); no code path moves assets to an arbitrary address.
///
/// Track-record integrity: venues and tokens are PROTOCOL-CURATED — trader
/// owners can only narrow their allowlists within the curated set, never add
/// an uncurated venue (which would open the door to wash-trading against
/// owner-controlled liquidity). New traders also serve a "paper season":
/// outside vault deposits stay closed until the trader has built a minimum
/// history trading its own book.
contract ExecutionGuard is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Policy {
        address executor;
        uint16 maxNotionalBps; // per-trade cap, bps of source NAV
        uint16 maxSlippageBps; // minAmountOut floor relative to quote
        uint64 minTradeInterval;
        uint64 lastTradeAt;
        address valuationRouter; // venue used to value non-base holdings
    }

    ITraderNFT public nft;
    address public immutable deployer;
    address public baseAsset;

    /// Paper-season parameters, fixed at deployment (protocol-level, not
    /// owner-tunable): a trader must make at least seasonMinTrades on its own
    /// book, and seasonDuration must have elapsed since its first trade,
    /// before its vault may accept outside deposits.
    uint64 public immutable seasonDuration;
    uint32 public immutable seasonMinTrades;

    /// Seat tiers: a brain's tier sets the ceiling of its trading policy.
    /// Everyone mints as an Intern; upgrades cost a one-time fee in the base
    /// asset, paid to the protocol treasury. Tier is mechanical, not
    /// cosmetic — executeTrade enforces the tier's notional ceiling.
    struct TierConfig {
        uint16 maxNotionalBps;
        uint256 fee;
    }

    uint8 public constant TIER_INTERN = 0;
    uint8 public constant TIER_ASSOCIATE = 1;
    uint8 public constant TIER_PARTNER = 2;

    TierConfig[3] public tiers;
    mapping(uint256 => uint8) public tierOf;
    address public treasury;

    mapping(uint256 => Policy) public policyOf;
    mapping(uint256 => mapping(address => bool)) public venueAllowed;
    mapping(uint256 => mapping(address => bool)) public tokenAllowed;
    mapping(address => bool) public curatedVenue;
    mapping(address => bool) public curatedToken;
    mapping(uint256 => uint32) public tradeCountOf;
    mapping(uint256 => uint64) public firstTradeAt;

    event TradeExecuted(
        uint256 indexed tokenId,
        address indexed venue,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bool fromVault
    );
    event ExecutorSet(uint256 indexed tokenId, address executor);
    event PolicySet(uint256 indexed tokenId, uint16 maxNotionalBps, uint16 maxSlippageBps, uint64 minTradeInterval);
    event VenueCurated(address indexed venue, bool curated);
    event TokenCurated(address indexed token, bool curated);
    event TierActivated(uint256 indexed tokenId, uint8 tier, uint256 fee);
    event TierConfigured(uint8 tier, uint16 maxNotionalBps, uint256 fee);

    modifier onlyTraderOwner(uint256 tokenId) {
        require(msg.sender == nft.ownerOf(tokenId), "Guard: not trader owner");
        _;
    }

    constructor(uint64 seasonDuration_, uint32 seasonMinTrades_) {
        deployer = msg.sender;
        treasury = msg.sender;
        seasonDuration = seasonDuration_;
        seasonMinTrades = seasonMinTrades_;
        // default seat tiers (testnet numbers; deployer can retune via setTier)
        tiers[TIER_INTERN] = TierConfig({maxNotionalBps: 2_000, fee: 0});
        tiers[TIER_ASSOCIATE] = TierConfig({maxNotionalBps: 3_000, fee: 100e18});
        tiers[TIER_PARTNER] = TierConfig({maxNotionalBps: 5_000, fee: 500e18});
    }

    function setTier(uint8 tier, uint16 maxNotionalBps, uint256 fee) external {
        require(msg.sender == deployer, "Guard: not deployer");
        require(tier < 3 && maxNotionalBps <= 10_000, "Guard: bad tier");
        tiers[tier] = TierConfig({maxNotionalBps: maxNotionalBps, fee: fee});
        emit TierConfigured(tier, maxNotionalBps, fee);
    }

    function setTreasury(address treasury_) external {
        require(msg.sender == deployer, "Guard: not deployer");
        treasury = treasury_;
    }

    /// @notice Upgrade a brain's seat. Upgrades only, one-time fee per jump,
    /// paid in the base asset to the protocol treasury. The policy's notional
    /// ceiling is lifted to the new tier's maximum immediately.
    function activate(uint256 tokenId, uint8 tier) external onlyTraderOwner(tokenId) {
        require(tier < 3 && tier > tierOf[tokenId], "Guard: not an upgrade");
        TierConfig memory t = tiers[tier];
        if (t.fee > 0) IERC20(baseAsset).safeTransferFrom(msg.sender, treasury, t.fee);
        tierOf[tokenId] = tier;
        policyOf[tokenId].maxNotionalBps = t.maxNotionalBps;
        emit TierActivated(tokenId, tier, t.fee);
    }

    /// @notice One-time wiring; the guard and NFT reference each other.
    function setNFT(address nft_, address baseAsset_) external {
        require(msg.sender == deployer, "Guard: not deployer");
        require(address(nft) == address(0), "Guard: already set");
        nft = ITraderNFT(nft_);
        baseAsset = baseAsset_;
    }

    // ---- protocol curation (deployer-level; the wash-trading defense) ----

    function setCuratedVenue(address venue, bool curated) external {
        require(msg.sender == deployer, "Guard: not deployer");
        curatedVenue[venue] = curated;
        emit VenueCurated(venue, curated);
    }

    function setCuratedToken(address token, bool curated) external {
        require(msg.sender == deployer, "Guard: not deployer");
        curatedToken[token] = curated;
        emit TokenCurated(token, curated);
    }

    /// @notice Called by TraderNFT during mint to install default policy.
    /// The trader's venue and entire asset universe must be protocol-curated.
    function initPolicy(uint256 tokenId, address venue, address[] calldata universe) external {
        require(msg.sender == address(nft), "Guard: not NFT");
        require(curatedVenue[venue], "Guard: venue not curated");
        require(curatedToken[baseAsset], "Guard: base not curated");
        Policy storage p = policyOf[tokenId];
        p.maxNotionalBps = tiers[TIER_INTERN].maxNotionalBps; // everyone starts as an Intern
        p.maxSlippageBps = 100; // 1%
        p.minTradeInterval = 0;
        p.valuationRouter = venue;
        venueAllowed[tokenId][venue] = true;
        tokenAllowed[tokenId][baseAsset] = true;
        for (uint256 i = 0; i < universe.length; i++) {
            require(curatedToken[universe[i]], "Guard: token not curated");
            tokenAllowed[tokenId][universe[i]] = true;
        }
    }

    // ---- owner administration (control follows ownerOf live) ----

    function setExecutor(uint256 tokenId, address executor) external onlyTraderOwner(tokenId) {
        policyOf[tokenId].executor = executor;
        emit ExecutorSet(tokenId, executor);
    }

    function setPolicy(uint256 tokenId, uint16 maxNotionalBps, uint16 maxSlippageBps, uint64 minTradeInterval)
        external
        onlyTraderOwner(tokenId)
    {
        require(maxNotionalBps <= 10_000 && maxSlippageBps <= 10_000, "Guard: bps");
        // owners tune freely below their seat's ceiling, never above it
        require(maxNotionalBps <= tiers[tierOf[tokenId]].maxNotionalBps, "Guard: exceeds tier");
        Policy storage p = policyOf[tokenId];
        p.maxNotionalBps = maxNotionalBps;
        p.maxSlippageBps = maxSlippageBps;
        p.minTradeInterval = minTradeInterval;
        emit PolicySet(tokenId, maxNotionalBps, maxSlippageBps, minTradeInterval);
    }

    /// @dev Owners may narrow their allowlists freely, but may only ADD
    /// venues/tokens that the protocol has curated.
    function setVenueAllowed(uint256 tokenId, address venue, bool allowed) external onlyTraderOwner(tokenId) {
        require(!allowed || curatedVenue[venue], "Guard: venue not curated");
        venueAllowed[tokenId][venue] = allowed;
    }

    function setTokenAllowed(uint256 tokenId, address token, bool allowed) external onlyTraderOwner(tokenId) {
        require(!allowed || curatedToken[token], "Guard: token not curated");
        tokenAllowed[tokenId][token] = allowed;
    }

    // ---- the one executor entrypoint ----

    /// @param fromVault true to trade the LP vault's assets, false to trade the
    /// trader's own book (its token-bound account; the TBA must have approved
    /// this guard for tokenIn — an owner action through the TBA).
    function executeTrade(
        uint256 tokenId,
        address venue,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        bool fromVault
    ) external nonReentrant returns (uint256 amountOut) {
        Policy storage p = policyOf[tokenId];
        require(msg.sender == p.executor, "Guard: not executor");
        require(venueAllowed[tokenId][venue], "Guard: venue not allowed");
        require(tokenAllowed[tokenId][tokenIn] && tokenAllowed[tokenId][tokenOut], "Guard: token not allowed");
        require(tokenIn != tokenOut && amountIn > 0, "Guard: bad trade");
        require(block.timestamp >= p.lastTradeAt + p.minTradeInterval, "Guard: cadence");

        address source = fromVault ? nft.vaultOf(tokenId) : nft.accountOf(tokenId);

        // per-trade notional cap, measured in base-asset terms against source NAV
        uint256 nav = fromVault ? TraderVault(source).totalAssets() : tbaNav(tokenId);
        uint256 notional =
            tokenIn == baseAsset ? amountIn : IVenue(p.valuationRouter).quote(tokenIn, baseAsset, amountIn);
        require(notional <= (nav * p.maxNotionalBps) / 10_000, "Guard: notional cap");

        // slippage floor: the executor may not accept worse than policy allows
        uint256 quoted = IVenue(venue).quote(tokenIn, tokenOut, amountIn);
        require(minAmountOut >= (quoted * (10_000 - p.maxSlippageBps)) / 10_000, "Guard: slippage bound");

        IERC20(tokenIn).safeTransferFrom(source, address(this), amountIn);
        IERC20(tokenIn).forceApprove(venue, amountIn);
        uint256 balBefore = IERC20(tokenOut).balanceOf(source);
        IVenue(venue).swap(tokenIn, tokenOut, amountIn, minAmountOut, source);
        amountOut = IERC20(tokenOut).balanceOf(source) - balBefore;
        require(amountOut >= minAmountOut, "Guard: short delivery");

        p.lastTradeAt = uint64(block.timestamp);
        if (firstTradeAt[tokenId] == 0) firstTradeAt[tokenId] = uint64(block.timestamp);
        tradeCountOf[tokenId]++;
        emit TradeExecuted(tokenId, venue, tokenIn, tokenOut, amountIn, amountOut, fromVault);
    }

    /// @notice Paper-season gate, checked by the vault before outside
    /// deposits: enough trades made, and enough time since the first one.
    function seasoned(uint256 tokenId) public view returns (bool) {
        if (tradeCountOf[tokenId] < seasonMinTrades) return false;
        if (seasonDuration > 0) {
            uint64 first = firstTradeAt[tokenId];
            if (first == 0 || block.timestamp < first + seasonDuration) return false;
        }
        return true;
    }

    /// @notice Value of the trader's own book (TBA) in base-asset terms.
    function tbaNav(uint256 tokenId) public view returns (uint256 nav) {
        address tba = nft.accountOf(tokenId);
        nav = IERC20(baseAsset).balanceOf(tba);
        address[] memory universe = TraderVault(nft.vaultOf(tokenId)).universe();
        IVenue router = IVenue(policyOf[tokenId].valuationRouter);
        for (uint256 i = 0; i < universe.length; i++) {
            uint256 bal = IERC20(universe[i]).balanceOf(tba);
            if (bal > 0) nav += router.quote(universe[i], baseAsset, bal);
        }
    }
}
