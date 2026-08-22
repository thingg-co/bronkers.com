// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC6551Registry} from "erc6551/ERC6551Registry.sol";
import {ERC6551Account} from "erc6551/examples/simple/ERC6551Account.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TraderNFT} from "../src/TraderNFT.sol";
import {TraderVault} from "../src/TraderVault.sol";
import {ExecutionGuard} from "../src/ExecutionGuard.sol";
import {JarRenderer} from "../src/JarRenderer.sol";
import {PaperVenue} from "../src/PaperVenue.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {IVenue} from "../src/interfaces/ITraderNFT.sol";

/// The paper market: prices from feeds, fills at the oracle price less the
/// spread, mock tokens minted on fill, and the guard trading through it like
/// any other curated venue.
contract PaperTest is Test {
    MockERC20 usdc;
    MockERC20 weth;
    MockAggregator ethFeed;
    PaperVenue venue;
    ExecutionGuard guard;
    TraderNFT nft;
    address owner = makeAddr("owner");
    address executor = makeAddr("executor");
    address lp = makeAddr("lp");

    function setUp() public {
        usdc = new MockERC20("Mock USDC", "mUSDC");
        weth = new MockERC20("Mock WETH", "mWETH");
        ethFeed = new MockAggregator("ETH / USD", 8, 2_000e8);
        venue = new PaperVenue();
        venue.setFixedUsd(address(usdc), 1e18);
        venue.setFeed(address(weth), address(ethFeed));
        venue.setMaxStale(1 hours); // exercise staleness; a real deployment sets this, mock-fed anvil leaves it 0

        ERC6551Registry registry = new ERC6551Registry();
        ERC6551Account accountImpl = new ERC6551Account();
        guard = new ExecutionGuard(0, 0);
        nft = new TraderNFT(IERC6551Registry(address(registry)), address(accountImpl), guard, IERC20(address(usdc)), IVenue(address(venue)), new JarRenderer());
        guard.setNFT(address(nft), address(usdc));
        guard.setCuratedVenue(address(venue), true);
        guard.setCuratedToken(address(usdc), true);
        guard.setCuratedToken(address(weth), true);
    }

    function test_QuotesFromFeedsAndFillsLessSpread() public {
        assertEq(venue.usdPrice(address(usdc)), 1e18);
        assertEq(venue.usdPrice(address(weth)), 2_000e18);
        assertEq(venue.quote(address(usdc), address(weth), 2_000e18), 1e18);
        assertEq(venue.quote(address(weth), address(usdc), 1e18), 2_000e18);

        usdc.mint(address(this), 2_000e18);
        usdc.approve(address(venue), 2_000e18);
        uint256 out = venue.swap(address(usdc), address(weth), 2_000e18, 0, lp);
        assertEq(out, 0.999e18); // 10 bps to the house
        assertEq(weth.balanceOf(lp), 0.999e18);
        assertEq(usdc.balanceOf(address(venue)), 2_000e18);

        vm.expectRevert("Paper: insufficient output");
        venue.swap(address(usdc), address(weth), 0, 1, lp);

        ethFeed.setAnswer(2_500e8);
        assertEq(venue.quote(address(weth), address(usdc), 1e18), 2_500e18);
    }

    function test_RefusesStaleOrBadFeedsAndUnpricedTokens() public {
        MockERC20 other = new MockERC20("Other", "OTH");
        vm.expectRevert("Paper: no price");
        venue.usdPrice(address(other));

        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert("Paper: stale price");
        venue.usdPrice(address(weth));
        venue.setMaxStale(0);
        assertEq(venue.usdPrice(address(weth)), 2_000e18);

        ethFeed.setAnswer(0);
        vm.expectRevert("Paper: bad answer");
        venue.usdPrice(address(weth));

        vm.prank(lp);
        vm.expectRevert("Paper: not deployer");
        venue.setSpread(50);
        vm.expectRevert("Paper: spread");
        venue.setSpread(1_001);
        venue.setSpread(50);
        assertEq(venue.spreadBps(), 50);
    }

    /// The guard trades through the paper venue like any other: NAV follows the feed.
    function test_GuardTradesThroughThePaperVenue() public {
        address[] memory universe = new address[](1);
        universe[0] = address(weth);
        vm.prank(owner);
        uint256 id = nft.mint(keccak256("paper"), 1, 4, 1, "claude-sonnet-5", "cid", universe, 200, 2_000);
        vm.prank(owner);
        guard.setExecutor(id, executor);
        TraderVault vault = TraderVault(nft.vaultOf(id));
        vm.prank(owner);
        vault.setDepositAllowed(lp, true);
        usdc.mint(lp, 10_000e18);
        vm.startPrank(lp);
        usdc.approve(address(vault), 10_000e18);
        vault.deposit(10_000e18, lp);
        vm.stopPrank();

        uint256 quoted = venue.quote(address(usdc), address(weth), 1_000e18);
        vm.prank(executor);
        guard.executeTrade(id, address(venue), address(usdc), address(weth), 1_000e18, (quoted * 9_950) / 10_000, true);
        assertEq(weth.balanceOf(address(vault)), (quoted * 9_990) / 10_000); // filled at the feed less the spread
        assertApproxEqRel(vault.totalAssets(), 10_000e18 - 1e18, 1e12); // the spread is the only cost

        ethFeed.setAnswer(3_000e8); // the market moves: NAV follows the feed, nothing to manipulate
        assertGt(vault.totalAssets(), 10_000e18);
    }
}
