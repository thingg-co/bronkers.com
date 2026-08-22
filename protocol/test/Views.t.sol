// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {TraderVault} from "../src/TraderVault.sol";

/// Read-side helpers the Terminal relies on: pendingFees() must predict
/// exactly what ringTheBell() mints, and names are set once by the owner.
contract ViewsTest is BaseTest {
    function test_PendingFeesMatchesBell_ManagementOnly() public {
        uint256 id = mintTrader(200, 0);
        TraderVault vault = TraderVault(nft.vaultOf(id));
        lpDeposit(id, 10_000e18);
        vm.warp(block.timestamp + 365 days);

        (uint256 mgmt, uint256 perf, uint256 reward) = vault.pendingFees();
        assertGt(mgmt, 0);
        assertEq(perf, 0);
        assertEq(reward, mgmt / 100);

        address tba = nft.accountOf(id);
        uint256 tbaBefore = vault.balanceOf(tba);
        vm.prank(stranger);
        vault.ringTheBell();
        assertEq(vault.balanceOf(stranger), reward);
        assertEq(vault.balanceOf(tba) - tbaBefore, mgmt - reward);
    }

    function test_PendingFeesMatchesBell_WithPerformance() public {
        uint256 id = mintTrader(200, 2_000);
        TraderVault vault = TraderVault(nft.vaultOf(id));
        lpDeposit(id, 10_000e18);
        execTrade(id, address(usdc), address(weth), 2_000e18);
        router.setPrice(address(weth), address(usdc), WETH_PRICE * 3 / 2); // +50%
        vm.warp(block.timestamp + 30 days);

        (uint256 mgmt, uint256 perf, uint256 reward) = vault.pendingFees();
        assertGt(mgmt, 0);
        assertGt(perf, 0);
        assertEq(reward, (mgmt + perf) / 100);

        address tba = nft.accountOf(id);
        uint256 tbaBefore = vault.balanceOf(tba);
        vm.prank(stranger);
        vault.ringTheBell();
        assertEq(vault.balanceOf(stranger), reward);
        assertEq(vault.balanceOf(tba) - tbaBefore, mgmt + perf - reward);
        // nothing left to crystallize immediately afterwards
        (uint256 m2, uint256 p2, uint256 r2) = vault.pendingFees();
        assertEq(m2 + p2 + r2, 0);
    }

    function test_PendingFeesZeroWhenEmpty() public {
        uint256 id = mintTrader(200, 2_000);
        TraderVault vault = TraderVault(nft.vaultOf(id));
        vm.warp(block.timestamp + 365 days);
        (uint256 mgmt, uint256 perf, uint256 reward) = vault.pendingFees();
        assertEq(mgmt + perf + reward, 0);
    }

    function test_ChristenOnceByOwner() public {
        uint256 id = mintTrader(200, 2_000);
        assertEq(bytes(nft.nameOf(id)).length, 0);

        vm.prank(stranger);
        vm.expectRevert("Trader: not owner");
        nft.christen(id, "Umbra");

        vm.prank(owner);
        vm.expectRevert("Trader: name length");
        nft.christen(id, "");

        vm.prank(owner);
        vm.expectRevert("Trader: name length");
        nft.christen(id, "this name is much much longer than thirty-two bytes");

        vm.prank(owner);
        nft.christen(id, "Umbra");
        assertEq(nft.nameOf(id), "Umbra");

        vm.prank(owner);
        vm.expectRevert("Trader: already named");
        nft.christen(id, "Penumbra");
    }

    function test_NameSurvivesTransfer() public {
        uint256 id = mintTrader(200, 2_000);
        vm.prank(owner);
        nft.christen(id, "Vesper");
        vm.prank(owner);
        nft.transferFrom(owner, buyer, id);
        assertEq(nft.nameOf(id), "Vesper");
        vm.prank(buyer);
        vm.expectRevert("Trader: already named");
        nft.christen(id, "Not Vesper");
    }
}
