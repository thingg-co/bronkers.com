// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {stdStorage, StdStorage} from "forge-std/Test.sol";
import {BaseTest} from "./Base.t.sol";
import {TraderVault} from "../src/TraderVault.sol";

/// The cheap wins: supply cap, Ring the Bell, and seat tiers.
contract TiersTest is BaseTest {
    using stdStorage for StdStorage;

    // ── supply cap ──────────────────────────────────────────────

    function test_SupplyCapped() public {
        stdstore.target(address(nft)).sig("nextId()").checked_write(nft.MAX_SUPPLY());
        address[] memory universe = new address[](0);
        vm.prank(owner);
        vm.expectRevert("Trader: sold out");
        nft.mint(keccak256("g"), 0, 1, 0, "m", "cid", universe, 0, 0);
    }

    // ── seat tiers ──────────────────────────────────────────────

    function test_MintsAsInternWithTierCeiling() public {
        uint256 id = mintTrader(0, 0);
        assertEq(guard.tierOf(id), guard.TIER_INTERN());
        vm.prank(owner);
        vm.expectRevert("Guard: exceeds tier");
        guard.setPolicy(id, 2_001, 100, 0);
        vm.prank(owner);
        guard.setPolicy(id, 1_500, 100, 0); // narrowing below the ceiling is fine
    }

    function test_ActivatePaysFeeAndLiftsCeiling() public {
        uint256 id = mintTrader(0, 0);
        (, uint256 fee) = guard.tiers(guard.TIER_ASSOCIATE());
        usdc.mint(owner, fee);
        vm.startPrank(owner);
        usdc.approve(address(guard), fee);
        guard.activate(id, guard.TIER_ASSOCIATE());
        vm.stopPrank();

        assertEq(guard.tierOf(id), guard.TIER_ASSOCIATE());
        assertEq(usdc.balanceOf(guard.treasury()), fee, "fee lands in treasury");
        (, uint16 maxNotionalBps,,,,) = guard.policyOf(id);
        assertEq(maxNotionalBps, 3_000, "ceiling lifted immediately");
        vm.prank(owner);
        guard.setPolicy(id, 3_000, 100, 0); // now allowed
        vm.prank(owner);
        vm.expectRevert("Guard: exceeds tier");
        guard.setPolicy(id, 3_001, 100, 0); // still bounded by the seat
    }

    function test_ActivateUpgradesOnlyAndOwnersOnly() public {
        uint256 id = mintTrader(0, 0);
        vm.prank(stranger);
        vm.expectRevert("Guard: not trader owner");
        guard.activate(id, 1);

        // jump straight to Partner, then no downgrades and no re-activation
        uint8 partner = guard.TIER_PARTNER();
        uint8 associate = guard.TIER_ASSOCIATE();
        (, uint256 fee) = guard.tiers(partner);
        usdc.mint(owner, fee);
        vm.startPrank(owner);
        usdc.approve(address(guard), fee);
        guard.activate(id, partner);
        vm.expectRevert("Guard: not an upgrade");
        guard.activate(id, associate);
        vm.expectRevert("Guard: not an upgrade");
        guard.activate(id, partner);
        vm.stopPrank();
    }

    function test_TierAdminIsDeployerOnly() public {
        vm.prank(stranger);
        vm.expectRevert("Guard: not deployer");
        guard.setTier(1, 4_000, 1e18);
        vm.prank(stranger);
        vm.expectRevert("Guard: not deployer");
        guard.setTreasury(stranger);
    }

    // ── Ring the Bell ───────────────────────────────────────────

    function test_RingTheBellRewardsRinger() public {
        uint256 id = mintTrader(200, 0); // 2% annual mgmt fee
        TraderVault vault = TraderVault(nft.vaultOf(id));
        lpDeposit(id, 10_000e18);
        address tba = nft.accountOf(id);

        vm.warp(vm.getBlockTimestamp() + 365 days);
        vm.prank(stranger);
        vault.ringTheBell();

        uint256 ringerShares = vault.balanceOf(stranger);
        uint256 tbaShares = vault.balanceOf(tba);
        assertGt(ringerShares, 0, "ringer earned a cut");
        // 1% of the crystallized fee shares, 99% to the TBA
        assertApproxEqRel(ringerShares * 99, tbaShares, 1e12);
        // and the ringer's cut came out of the owner's take, not LP capital
        assertEq(vault.balanceOf(lp), 10_000e18);
    }

    function test_PlainCheckpointPaysNoReward() public {
        uint256 id = mintTrader(200, 0);
        TraderVault vault = TraderVault(nft.vaultOf(id));
        lpDeposit(id, 10_000e18);

        vm.warp(vm.getBlockTimestamp() + 365 days);
        vm.prank(stranger);
        vault.checkpoint();
        assertEq(vault.balanceOf(stranger), 0, "checkpoint() is rewardless");
        assertGt(vault.balanceOf(nft.accountOf(id)), 0, "fees still crystallized");
    }
}
