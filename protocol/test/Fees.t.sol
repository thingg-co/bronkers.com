// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {TraderVault} from "../src/TraderVault.sol";

contract FeesTest is BaseTest {
    function test_ManagementFeeStreamsToTBA() public {
        uint256 id = mintTrader(200, 0); // 2% annual management, no perf
        TraderVault vault = TraderVault(nft.vaultOf(id));
        lpDeposit(id, 10_000e18);
        address tba = nft.accountOf(id);

        vm.warp(block.timestamp + 365 days);
        vault.checkpoint();

        // TBA should own ~2% of the vault by value
        uint256 tbaValue = vault.convertToAssets(vault.balanceOf(tba));
        assertApproxEqRel(tbaValue, 200e18, 1e15);
        // and half as much after half a year, pro-rata
        assertGt(vault.balanceOf(tba), 0);
    }

    function test_ManagementFeeProRata() public {
        uint256 id = mintTrader(200, 0);
        TraderVault vault = TraderVault(nft.vaultOf(id));
        lpDeposit(id, 10_000e18);
        vm.warp(block.timestamp + 365 days / 2);
        vault.checkpoint();
        uint256 tbaValue = vault.convertToAssets(vault.balanceOf(nft.accountOf(id)));
        assertApproxEqRel(tbaValue, 100e18, 1e15);
    }

    function test_PerformanceFeeAboveHWM() public {
        uint256 id = mintTrader(0, 2_000); // 20% perf, no mgmt
        TraderVault vault = TraderVault(nft.vaultOf(id));
        lpDeposit(id, 10_000e18);
        address tba = nft.accountOf(id);

        // trade into weth, then the market moves up 50%
        execTrade(id, address(usdc), address(weth), 2_000e18);
        router.setPrice(address(weth), address(usdc), 3_000e18);
        assertApproxEqRel(vault.totalAssets(), 11_000e18, 1e12);

        vault.checkpoint();

        // gain 1_000, fee 20% = 200 (in assets), paid as shares to the TBA
        uint256 tbaValue = vault.convertToAssets(vault.balanceOf(tba));
        assertApproxEqRel(tbaValue, 200e18, 1e14);
        assertGt(vault.highWaterMark(), 1e18); // HWM ratcheted up
    }

    function test_NoPerformanceFeeOnRecoveryBelowHWM() public {
        uint256 id = mintTrader(0, 2_000);
        TraderVault vault = TraderVault(nft.vaultOf(id));
        lpDeposit(id, 10_000e18);
        address tba = nft.accountOf(id);

        // gain, fee charged, HWM ratchets
        execTrade(id, address(usdc), address(weth), 2_000e18);
        router.setPrice(address(weth), address(usdc), 3_000e18);
        vault.checkpoint();
        uint256 tbaSharesAfterGain = vault.balanceOf(tba);
        uint256 hwm = vault.highWaterMark();

        // crash below HWM, then partial recovery still below HWM: no new fee
        router.setPrice(address(weth), address(usdc), 1_000e18);
        vault.checkpoint();
        router.setPrice(address(weth), address(usdc), 2_500e18);
        vault.checkpoint();

        assertEq(vault.balanceOf(tba), tbaSharesAfterGain, "no fee below HWM");
        assertEq(vault.highWaterMark(), hwm, "HWM never ratchets down");
    }

    function test_DepositAllowlistGates() public {
        uint256 id = mintTrader(0, 0);
        TraderVault vault = TraderVault(nft.vaultOf(id));
        usdc.mint(stranger, 1_000e18);

        vm.startPrank(stranger);
        usdc.approve(address(vault), 1_000e18);
        vm.expectRevert("Vault: depositor not allowed");
        vault.deposit(1_000e18, stranger);
        vm.stopPrank();

        // owner allowlists them — deposit passes
        vm.prank(owner);
        vault.setDepositAllowed(stranger, true);
        vm.prank(stranger);
        vault.deposit(1_000e18, stranger);
        assertEq(vault.balanceOf(stranger), 1_000e18);

        // owner can disable gating entirely (the "ungated" configuration)
        vm.prank(owner);
        vault.setAllowlistEnabled(false);
        usdc.mint(buyer, 10e18);
        vm.startPrank(buyer);
        usdc.approve(address(vault), 10e18);
        vault.deposit(10e18, buyer);
        vm.stopPrank();
    }

    function test_AllowlistAdminOnlyOwner() public {
        uint256 id = mintTrader(0, 0);
        TraderVault vault = TraderVault(nft.vaultOf(id));
        vm.prank(stranger);
        vm.expectRevert("Vault: not trader owner");
        vault.setDepositAllowed(stranger, true);
        vm.prank(stranger);
        vm.expectRevert("Vault: not trader owner");
        vault.setAllowlistEnabled(false);
    }

    function test_FeeBoundsEnforcedAtMint() public {
        address[] memory universe = new address[](0);
        vm.prank(owner);
        vm.expectRevert("Vault: fee bounds");
        nft.mint(keccak256("x"), 0, 1, 0, "m", "cid", universe, 501, 0);
        vm.prank(owner);
        vm.expectRevert("Vault: fee bounds");
        nft.mint(keccak256("x"), 0, 1, 0, "m", "cid", universe, 0, 3_001);
    }
}
