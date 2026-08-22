// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRuntimeRegistry, ITraderNFT, IVenue} from "./interfaces/ITraderNFT.sol";
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

    /// Training camp: a revised genome (generation >= 1) spars on the brain's
    /// own book before it may trade the vault: campMinTrades own-book trades
    /// under that generation, and revisionNotice elapsed since it was committed,
    /// so depositors can leave before a strategy they did not back trades their
    /// money. The mint genome's camp is the paper season itself.
    uint32 public campMinTrades;
    uint64 public revisionNotice;
    mapping(uint256 => mapping(uint32 => uint32)) public campTradesOf; // tokenId -> generation -> own-book trades

    /// Reaping the dead. A brain is dead when its vault holds no shares (no LP
    /// or unredeemed fee shares — burning either would strand someone) and its
    /// NAV (vault + own book) is at or below dustNav. A dead brain that has not
    /// traded for reapDelay may be reaped by anyone (free), which burns it and
    /// frees a supply slot; or culled by paying cullFee to the treasury, which
    /// burns it and mints the payer's new brain in the same transaction, so a
    /// reclaimed slot cannot be sniped. The owner's remedy is to refund the
    /// brain (which lifts its NAV above dust) any time before it is reaped.
    uint64 public reapDelay;
    uint256 public cullFee;
    uint256 public dustNav;

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

    /// Runtime fee: a flat amount of the base asset paid from the traded book
    /// to the executor on each successful trade, so an enclave operator (a
    /// harvester, on the site) is reimbursed for gas and model calls out of the
    /// brain's own resources. Owner-set per brain, protocol-capped, zero by
    /// default, and best-effort: if the source has no base left after the swap
    /// the fee is skipped rather than blocking the trade. Bounded per trade by
    /// maxRuntimeFee and per day by the declared cadence (trades are
    /// rate-limited to it on-chain, see tradeIntervalOf), so the most an
    /// executor can ever draw is cadence * maxRuntimeFee a day: a fund expense,
    /// not an extraction path.
    ///
    /// Paid for evidence, not claims: when a RuntimeRegistry is set, only an
    /// executor it marks attested is paid; a trade below minFeeNotionalBps of
    /// NAV pays no fee (dust cannot be churned for fees); and a fee raise takes
    /// effect only after runtimeFeeDelay, so depositors see it coming. Lowering
    /// is immediate.
    uint256 public maxRuntimeFee;
    address public registry; // IRuntimeRegistry; zero = fees are not gated on attestation
    uint16 public minFeeNotionalBps = 100; // a trade must move at least 1% of NAV to pay a fee
    uint64 public runtimeFeeDelay; // notice period for fee raises; zero = immediate

    struct PendingFee {
        uint256 fee;
        uint64 effectiveAt;
    }

    mapping(uint256 => uint256) private _runtimeFee;
    mapping(uint256 => PendingFee) public pendingRuntimeFeeOf;

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
    event CampConfigured(uint32 minTrades, uint64 notice);
    event ReapConfigured(uint64 reapDelay, uint256 cullFee, uint256 dustNav);
    event Reaped(uint256 indexed tokenId, address indexed reaper);
    event Culled(uint256 indexed deadTokenId, address indexed payer, uint256 newTokenId, uint256 fee);
    event TierConfigured(uint8 tier, uint16 maxNotionalBps, uint256 fee);
    event RuntimeFeeSet(uint256 indexed tokenId, uint256 fee);
    event RuntimeFeeScheduled(uint256 indexed tokenId, uint256 fee, uint64 effectiveAt);
    event MaxRuntimeFeeSet(uint256 fee);
    event RuntimeFeePaid(uint256 indexed tokenId, address indexed executor, uint256 fee);
    event RegistrySet(address registry);
    event MinFeeNotionalSet(uint16 bps);
    event RuntimeFeeDelaySet(uint64 delay);
    /// The executor's hash of the inference transcript behind a trade (market
    /// snapshot in, intent out, model and usage). Evidence that can be audited
    /// later without exposing the genome; optional for self-hosted runtimes.
    event TranscriptCommitted(uint256 indexed tokenId, bytes32 transcript);

    modifier onlyTraderOwner(uint256 tokenId) {
        require(msg.sender == nft.ownerOf(tokenId), "Guard: not trader owner");
        _;
    }

    constructor(uint64 seasonDuration_, uint32 seasonMinTrades_) {
        deployer = msg.sender;
        treasury = msg.sender;
        seasonDuration = seasonDuration_;
        seasonMinTrades = seasonMinTrades_;
        campMinTrades = seasonMinTrades_ == 0 ? 1 : seasonMinTrades_; // a new generation always spars at least once
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

    /// @notice Training-camp parameters for revised genomes (deployer-level).
    function setCamp(uint32 minTrades, uint64 notice) external {
        require(msg.sender == deployer, "Guard: not deployer");
        require(minTrades > 0, "Guard: camp");
        campMinTrades = minTrades;
        revisionNotice = notice;
        emit CampConfigured(minTrades, notice);
    }

    /// @notice Reaping parameters (deployer-level).
    function setReap(uint64 reapDelay_, uint256 cullFee_, uint256 dustNav_) external {
        require(msg.sender == deployer, "Guard: not deployer");
        reapDelay = reapDelay_;
        cullFee = cullFee_;
        dustNav = dustNav_;
        emit ReapConfigured(reapDelay_, cullFee_, dustNav_);
    }

    function setTreasury(address treasury_) external {
        require(msg.sender == deployer, "Guard: not deployer");
        treasury = treasury_;
    }

    function setMaxRuntimeFee(uint256 fee) external {
        require(msg.sender == deployer, "Guard: not deployer");
        maxRuntimeFee = fee;
        emit MaxRuntimeFeeSet(fee);
    }

    /// @notice The RuntimeRegistry whose `attested()` gates fee payment; zero disables the gate.
    function setRegistry(address registry_) external {
        require(msg.sender == deployer, "Guard: not deployer");
        registry = registry_;
        emit RegistrySet(registry_);
    }

    function setMinFeeNotionalBps(uint16 bps) external {
        require(msg.sender == deployer, "Guard: not deployer");
        require(bps <= 10_000, "Guard: bps");
        minFeeNotionalBps = bps;
        emit MinFeeNotionalSet(bps);
    }

    function setRuntimeFeeDelay(uint64 delay) external {
        require(msg.sender == deployer, "Guard: not deployer");
        runtimeFeeDelay = delay;
        emit RuntimeFeeDelaySet(delay);
    }

    /// @notice What this brain pays its executor per trade, in base asset, as
    /// of now: a scheduled raise counts once its notice period has passed.
    function runtimeFeeOf(uint256 tokenId) public view returns (uint256) {
        PendingFee storage p = pendingRuntimeFeeOf[tokenId];
        if (p.effectiveAt != 0 && block.timestamp >= p.effectiveAt) return p.fee;
        return _runtimeFee[tokenId];
    }

    /// @notice Set the fee. Owner-tunable up to the protocol cap. Lowering
    /// takes effect at once; raising is scheduled runtimeFeeDelay ahead (if a
    /// delay is set) and announced, so depositors are not surprised by a new
    /// expense.
    function setRuntimeFee(uint256 tokenId, uint256 fee) external onlyTraderOwner(tokenId) {
        require(fee <= maxRuntimeFee, "Guard: fee above cap");
        uint256 current = runtimeFeeOf(tokenId);
        if (fee <= current || runtimeFeeDelay == 0) {
            _runtimeFee[tokenId] = fee;
            delete pendingRuntimeFeeOf[tokenId];
            emit RuntimeFeeSet(tokenId, fee);
        } else {
            _runtimeFee[tokenId] = current; // settle anything already effective
            uint64 effectiveAt = uint64(block.timestamp) + runtimeFeeDelay;
            pendingRuntimeFeeOf[tokenId] = PendingFee(fee, effectiveAt);
            emit RuntimeFeeScheduled(tokenId, fee, effectiveAt);
        }
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

    // ---- the one executor entrypoint (with or without evidence attached) ----

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
        return _executeTrade(tokenId, venue, tokenIn, tokenOut, amountIn, minAmountOut, fromVault, bytes32(0));
    }

    /// @notice The same trade, with the hash of the inference transcript that
    /// produced it committed alongside (TranscriptCommitted). An attested
    /// runtime always uses this form; the transcript itself stays with the
    /// operator and can be disclosed for audit without exposing the genome.
    function executeTradeWithTranscript(
        uint256 tokenId,
        address venue,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        bool fromVault,
        bytes32 transcript
    ) external nonReentrant returns (uint256 amountOut) {
        return _executeTrade(tokenId, venue, tokenIn, tokenOut, amountIn, minAmountOut, fromVault, transcript);
    }

    function _executeTrade(
        uint256 tokenId,
        address venue,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        bool fromVault,
        bytes32 transcript
    ) internal returns (uint256 amountOut) {
        Policy storage p = policyOf[tokenId];
        require(msg.sender == p.executor, "Guard: not executor");
        require(venueAllowed[tokenId][venue], "Guard: venue not allowed");
        require(tokenAllowed[tokenId][tokenIn] && tokenAllowed[tokenId][tokenOut], "Guard: token not allowed");
        require(tokenIn != tokenOut && amountIn > 0, "Guard: bad trade");
        // declared cadence is a bound, not a label: the owner may tighten it, never loosen it
        require(p.lastTradeAt == 0 || block.timestamp >= p.lastTradeAt + tradeIntervalOf(tokenId), "Guard: cadence");

        // a revised genome trades the vault only once it has sparred on the own book
        uint32 generation = nft.generationOf(tokenId);
        if (fromVault) require(campDone(tokenId, generation), "Guard: in camp");

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
        if (!fromVault) campTradesOf[tokenId][generation]++;
        emit TradeExecuted(tokenId, venue, tokenIn, tokenOut, amountIn, amountOut, fromVault);
        if (transcript != bytes32(0)) emit TranscriptCommitted(tokenId, transcript);

        // best-effort runtime reimbursement, after the swap so it never
        // competes with the trade itself for the source's base balance; only
        // to an attested executor, only for a trade that moved real size
        uint256 fee = runtimeFeeOf(tokenId);
        if (
            fee > 0 && fee <= maxRuntimeFee && notional >= (nav * minFeeNotionalBps) / 10_000
                && (registry == address(0) || IRuntimeRegistry(registry).attested(msg.sender))
                && IERC20(baseAsset).balanceOf(source) >= fee
        ) {
            IERC20(baseAsset).safeTransferFrom(source, msg.sender, fee);
            emit RuntimeFeePaid(tokenId, msg.sender, fee);
        }
    }

    /// @notice Seconds between trades implied by the brain's declared cadence
    /// (a public trait: max trades per day). "24/day" means at most hourly.
    function cadenceIntervalOf(uint256 tokenId) public view returns (uint64) {
        uint8 cadence = nft.cadenceOf(tokenId);
        return cadence == 0 ? uint64(1 days) : uint64(1 days) / cadence;
    }

    /// @notice The interval executeTrade enforces: the owner-set
    /// minTradeInterval, floored at the declared cadence. Everything priced per
    /// trade (the runtime fee) is therefore bounded per day as well.
    function tradeIntervalOf(uint256 tokenId) public view returns (uint64) {
        uint64 declared = cadenceIntervalOf(tokenId);
        uint64 set = policyOf[tokenId].minTradeInterval;
        return set > declared ? set : declared;
    }

    /// @notice Earliest timestamp the next trade may execute (0 if it never traded).
    function nextTradeAt(uint256 tokenId) external view returns (uint64) {
        uint64 last = policyOf[tokenId].lastTradeAt;
        return last == 0 ? 0 : last + tradeIntervalOf(tokenId);
    }

    /// @notice Has this generation earned the vault? The mint genome is
    /// covered by the paper season; a revision needs campMinTrades own-book
    /// trades under it and revisionNotice since it was committed.
    function campDone(uint256 tokenId, uint32 generation) public view returns (bool) {
        if (generation == 0) return true;
        if (campTradesOf[tokenId][generation] < campMinTrades) return false;
        return block.timestamp >= nft.generationSince(tokenId, generation) + revisionNotice;
    }

    /// @notice The current generation's camp: in camp, trades sparred, trades needed, earliest vault time.
    function campStatus(uint256 tokenId)
        external
        view
        returns (uint32 generation, bool inCamp, uint32 trades, uint32 minTrades, uint64 vaultFrom)
    {
        generation = nft.generationOf(tokenId);
        trades = campTradesOf[tokenId][generation];
        minTrades = generation == 0 ? 0 : campMinTrades;
        vaultFrom = generation == 0 ? 0 : nft.generationSince(tokenId, generation) + revisionNotice;
        inCamp = !campDone(tokenId, generation);
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

    /// @notice Is this brain dead? No vault shares outstanding (no LP or
    /// unredeemed fee shares) and NAV at or below dust. A brain with any shares
    /// or real capital is never dead, so reaping can never strand a depositor
    /// or destroy an owner's unredeemed fees or swept capital.
    function insolvent(uint256 tokenId) public view returns (bool) {
        TraderVault vault = TraderVault(nft.vaultOf(tokenId));
        if (vault.totalSupply() > 0) return false;
        return vault.totalAssets() + tbaNav(tokenId) <= dustNav;
    }

    /// @notice May this brain be reaped now: dead, and idle for reapDelay since
    /// its last trade (a brain that never traded, or is refunded and trading,
    /// is safe). reapDelay 0 disables reaping entirely.
    function reapable(uint256 tokenId) public view returns (bool) {
        if (reapDelay == 0) return false;
        uint64 last = policyOf[tokenId].lastTradeAt;
        if (last == 0 || block.timestamp < last + reapDelay) return false;
        return insolvent(tokenId);
    }

    /// @notice When a dead brain becomes reapable (0 if it never traded or is not dead).
    function reapableAt(uint256 tokenId) external view returns (uint64) {
        uint64 last = policyOf[tokenId].lastTradeAt;
        if (reapDelay == 0 || last == 0 || !insolvent(tokenId)) return 0;
        return last + reapDelay;
    }

    /// @notice Reap a dead brain: free (anyone), burns it, frees a slot.
    function reap(uint256 tokenId) external nonReentrant {
        require(reapable(tokenId), "Guard: not reapable");
        nft.reapBurn(tokenId);
        emit Reaped(tokenId, msg.sender);
    }

    /// @notice Pay to reclaim a dead brain's slot and mint your own in its
    /// place, atomically. Same eligibility as reap (the owner's refund window
    /// is respected); cullFee goes to the treasury.
    function cullAndMint(
        uint256 deadTokenId,
        bytes32 commitment,
        uint8 riskProfile,
        uint8 cadence,
        uint8 custody,
        string calldata model,
        string calldata encryptedPromptCID,
        address[] calldata universe,
        uint16 managementFeeBps,
        uint16 performanceFeeBps
    ) external nonReentrant returns (uint256 newTokenId) {
        require(reapable(deadTokenId), "Guard: not reapable");
        if (cullFee > 0) IERC20(baseAsset).safeTransferFrom(msg.sender, treasury, cullFee);
        nft.reapBurn(deadTokenId);
        newTokenId =
            nft.mintFor(msg.sender, commitment, riskProfile, cadence, custody, model, encryptedPromptCID, universe, managementFeeBps, performanceFeeBps);
        emit Culled(deadTokenId, msg.sender, newTokenId, cullFee);
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
