// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {TraderVault} from "../src/TraderVault.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";
import {ERC6551Account} from "erc6551/examples/simple/ERC6551Account.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Track-record integrity: protocol curation (anti-wash-trading) and the
/// paper season (no outside capital until a trader has real history).
contract IntegrityTest is BaseTest {
    uint64 constant SEASON_DURATION = 3 days;
    uint32 constant SEASON_MIN_TRADES = 2;

    function seasonParams() internal pure override returns (uint64, uint32) {
        return (SEASON_DURATION, SEASON_MIN_TRADES);
    }

    function test_OwnerCannotAllowUncuratedVenue() public {
        uint256 id = mintTrader(0, 0);
        MockSwapRouter ownPool = new MockSwapRouter(); // owner-controlled liquidity
        vm.prank(owner);
        vm.expectRevert("Guard: venue not curated");
        guard.setVenueAllowed(id, address(ownPool), true);
        // narrowing (disallowing) needs no curation
        vm.prank(owner);
        guard.setVenueAllowed(id, address(router), false);
    }

    function test_OwnerCannotAllowUncuratedToken() public {
        uint256 id = mintTrader(0, 0);
        MockERC20 ownToken = new MockERC20("Own", "OWN");
        vm.prank(owner);
        vm.expectRevert("Guard: token not curated");
        guard.setTokenAllowed(id, address(ownToken), true);
    }

    function test_MintWithUncuratedUniverseReverts() public {
        MockERC20 rogue = new MockERC20("Rug", "RUG");
        address[] memory universe = new address[](1);
        universe[0] = address(rogue);
        vm.prank(owner);
        vm.expectRevert("Guard: token not curated");
        nft.mint(keccak256("g"), 0, 1, 0, "m", "cid", universe, 0, 0);
    }

    function test_CurationIsDeployerOnly() public {
        vm.prank(owner);
        vm.expectRevert("Guard: not deployer");
        guard.setCuratedVenue(address(0xBEEF), true);
        vm.prank(owner);
        vm.expectRevert("Guard: not deployer");
        guard.setCuratedToken(address(0xBEEF), true);
    }

    function test_PaperSeasonGatesOutsideDeposits() public {
        uint256 id = mintTrader(0, 0);
        TraderVault vault = TraderVault(nft.vaultOf(id));
        address tba = nft.accountOf(id);

        // fresh trader: no outside money
        vm.prank(owner);
        vault.setDepositAllowed(lp, true);
        usdc.mint(lp, 1_000e18);
        vm.startPrank(lp);
        usdc.approve(address(vault), 1_000e18);
        vm.expectRevert("Vault: trader not seasoned");
        vault.deposit(1_000e18, lp);
        vm.stopPrank();

        // the trader funds and trades its OWN book
        usdc.mint(tba, 1_000e18);
        vm.prank(owner);
        ERC6551Account(payable(tba)).execute(
            address(usdc), 0, abi.encodeCall(IERC20.approve, (address(guard), type(uint256).max)), 0
        );
        ownBookTrade(id, 100e18);
        assertFalse(guard.seasoned(id), "one trade is not enough");
        ownBookTrade(id, 100e18);
        assertFalse(guard.seasoned(id), "trade count met but duration not served");

        // deposits still gated until the season has elapsed
        vm.prank(lp);
        vm.expectRevert("Vault: trader not seasoned");
        vault.deposit(1_000e18, lp);

        vm.warp(uint64(vm.getBlockTimestamp()) + SEASON_DURATION);
        assertTrue(guard.seasoned(id));
        vm.prank(lp);
        vault.deposit(1_000e18, lp);
        assertEq(vault.balanceOf(lp), 1_000e18, "seasoned trader accepts outside capital");
    }

    function ownBookTrade(uint256 id, uint256 amountIn) internal {
        uint256 quoted = router.quote(address(usdc), address(weth), amountIn);
        vm.prank(executor);
        guard.executeTrade(id, address(router), address(usdc), address(weth), amountIn, quoted, false);
    }
}
