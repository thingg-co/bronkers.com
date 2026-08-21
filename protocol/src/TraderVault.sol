// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISeasonGate, ITraderNFT, IVenue} from "./interfaces/ITraderNFT.sol";

/// @title TraderVault
/// @notice One ERC-4626 vault per trader. Outside LPs deposit the base asset;
/// the trader's AI trades vault assets through the ExecutionGuard; the token
/// owner earns a streamed management fee plus a performance fee above a
/// per-share high-water mark. Fee shares are minted to the trader's own
/// token-bound account, so accrued fees travel with the NFT automatically.
///
/// Prototype-grade valuation: non-base holdings are priced through the
/// execution venue's spot quote, which is manipulable. Production needs
/// TWAP/oracle pricing and delayed fee crystallization (see docs/architecture.md).
contract TraderVault is ERC4626 {
    using SafeERC20 for IERC20;

    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;
    uint256 private constant YEAR = 365 days;

    ITraderNFT public immutable nft;
    uint256 public immutable tokenId;
    address public immutable guard;
    IVenue public immutable router;
    address[] private _universe; // allowlisted non-base tokens the trader may hold

    uint16 public immutable managementFeeBps; // annualized
    uint16 public immutable performanceFeeBps;
    uint256 public highWaterMark = WAD; // assets per share, 1e18-scaled
    uint64 public lastCheckpoint;

    /// Compliance hook: deposits are gated by default (see whitepaper §9).
    bool public allowlistEnabled = true;
    mapping(address => bool) public depositAllowed;

    /// Ring the Bell: anyone may crank fee crystallization and earn 1% of the
    /// fee shares minted by that crank — paid out of the owner's fee take,
    /// never out of LP capital. Keeper incentives as a community ritual.
    uint16 public constant BELL_REWARD_BPS = 100;

    event FeesAccrued(uint256 managementShares, uint256 performanceShares, uint256 newHighWaterMark);
    event BellRung(address indexed ringer, uint256 rewardShares);
    event DepositAllowlistSet(address indexed account, bool allowed);
    event AllowlistEnabledSet(bool enabled);

    modifier onlyTraderOwner() {
        require(msg.sender == nft.ownerOf(tokenId), "Vault: not trader owner");
        _;
    }

    constructor(
        IERC20 baseAsset,
        ITraderNFT nft_,
        uint256 tokenId_,
        address guard_,
        IVenue router_,
        address[] memory universe_,
        uint16 managementFeeBps_,
        uint16 performanceFeeBps_
    )
        ERC4626(baseAsset)
        ERC20(
            string.concat("Brokner Vault #", _toString(tokenId_)),
            string.concat("bknr", _toString(tokenId_))
        )
    {
        require(managementFeeBps_ <= 500 && performanceFeeBps_ <= 3_000, "Vault: fee bounds");
        nft = nft_;
        tokenId = tokenId_;
        guard = guard_;
        router = router_;
        _universe = universe_;
        managementFeeBps = managementFeeBps_;
        performanceFeeBps = performanceFeeBps_;
        lastCheckpoint = uint64(block.timestamp);

        // The guard pulls trade legs from the vault; proceeds always return here.
        baseAsset.forceApprove(guard_, type(uint256).max);
        for (uint256 i = 0; i < universe_.length; i++) {
            IERC20(universe_[i]).forceApprove(guard_, type(uint256).max);
        }
    }

    function universe() external view returns (address[] memory) {
        return _universe;
    }

    /// @dev NAV = base balance + non-base holdings valued at venue spot.
    function totalAssets() public view override returns (uint256 nav) {
        nav = IERC20(asset()).balanceOf(address(this));
        for (uint256 i = 0; i < _universe.length; i++) {
            uint256 bal = IERC20(_universe[i]).balanceOf(address(this));
            if (bal > 0) nav += router.quote(_universe[i], asset(), bal);
        }
    }

    // ---- deposit gating ----

    function setDepositAllowed(address account, bool allowed) external onlyTraderOwner {
        depositAllowed[account] = allowed;
        emit DepositAllowlistSet(account, allowed);
    }

    function setAllowlistEnabled(bool enabled) external onlyTraderOwner {
        allowlistEnabled = enabled;
        emit AllowlistEnabledSet(enabled);
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        require(!allowlistEnabled || depositAllowed[caller], "Vault: depositor not allowed");
        // paper season: no outside capital until the trader has built a
        // minimum track record on its own book
        require(ISeasonGate(guard).seasoned(tokenId), "Vault: trader not seasoned");
        checkpoint();
        super._deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        checkpoint();
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    // ---- fees ----

    /// @notice Accrues management + performance fees as share dilution, minted
    /// to the trader's token-bound account. Public: called on every deposit,
    /// withdrawal, and NFT transfer, and callable by anyone in between.
    function checkpoint() public {
        _checkpoint(address(0));
    }

    /// @notice The public crank, with a reward: 1% of whatever fee shares this
    /// call crystallizes goes to the ringer, the rest to the trader's TBA.
    function ringTheBell() external {
        _checkpoint(msg.sender);
    }

    function _checkpoint(address ringer) internal {
        uint64 nowTs = uint64(block.timestamp);
        uint256 supply = totalSupply();
        if (supply == 0) {
            lastCheckpoint = nowTs;
            return;
        }
        address tba = nft.accountOf(tokenId);

        // management fee: dilute LPs by feeFraction of the vault, pro-rata in time
        uint256 mgmtShares = 0;
        uint256 elapsed = nowTs - lastCheckpoint;
        if (elapsed > 0 && managementFeeBps > 0) {
            uint256 frac = (uint256(managementFeeBps) * elapsed * WAD) / (BPS * YEAR);
            mgmtShares = (supply * frac) / (WAD - frac);
            _mintFee(tba, ringer, mgmtShares);
        }
        lastCheckpoint = nowTs;

        // performance fee: on assets-per-share gains above the high-water mark
        uint256 perfShares = 0;
        supply = totalSupply();
        uint256 assets = totalAssets();
        uint256 pps = (assets * WAD) / supply;
        if (pps > highWaterMark && performanceFeeBps > 0) {
            uint256 gainAssets = ((pps - highWaterMark) * supply) / WAD;
            uint256 feeAssets = (gainAssets * performanceFeeBps) / BPS;
            perfShares = (feeAssets * supply) / (assets - feeAssets);
            _mintFee(tba, ringer, perfShares);
            // HWM ratchets to the post-fee assets-per-share
            highWaterMark = (totalAssets() * WAD) / totalSupply();
        } else if (pps > highWaterMark) {
            highWaterMark = pps;
        }

        if (mgmtShares > 0 || perfShares > 0) {
            emit FeesAccrued(mgmtShares, perfShares, highWaterMark);
            if (ringer != address(0)) {
                emit BellRung(ringer, ((mgmtShares + perfShares) * BELL_REWARD_BPS) / BPS);
            }
        }
    }

    /// @dev Fee shares split: the ringer's cut comes out of the fee mint
    /// itself (the owner's take), so LPs are diluted identically either way.
    function _mintFee(address tba, address ringer, uint256 shares) private {
        if (shares == 0) return;
        uint256 reward = ringer == address(0) ? 0 : (shares * BELL_REWARD_BPS) / BPS;
        if (reward > 0) _mint(ringer, reward);
        _mint(tba, shares - reward);
    }

    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
