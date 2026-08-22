// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {TraderVault} from "../src/TraderVault.sol";
import {RuntimeRegistry} from "../src/RuntimeRegistry.sol";

/// Runtime economics and identity: the per-trade runtime fee is owner-set,
/// protocol-capped, best-effort, and paid to the executor; the registry binds
/// an executor key to a self-reported measurement the deployer can approve;
/// tokenURI renders without a server.
contract RuntimeTest is BaseTest {
    function test_RuntimeFee_DefaultZero_ExecutorGetsNothing() public {
        uint256 id = mintTrader(200, 2_000);
        lpDeposit(id, 10_000e18);
        execTrade(id, address(usdc), address(weth), 1_000e18);
        assertEq(usdc.balanceOf(executor), 0);
    }

    function test_RuntimeFee_CappedByProtocol_OwnerOnly() public {
        uint256 id = mintTrader(200, 2_000);
        vm.prank(owner);
        vm.expectRevert("Guard: fee above cap");
        guard.setRuntimeFee(id, 1);

        guard.setMaxRuntimeFee(5e18); // deployer == this test
        vm.prank(stranger);
        vm.expectRevert("Guard: not trader owner");
        guard.setRuntimeFee(id, 1e18);
        vm.prank(owner);
        vm.expectRevert("Guard: fee above cap");
        guard.setRuntimeFee(id, 6e18);
        vm.prank(owner);
        guard.setRuntimeFee(id, 2e18);
        assertEq(guard.runtimeFeeOf(id), 2e18);
    }

    function test_RuntimeFee_PaidFromVaultToExecutor() public {
        uint256 id = mintTrader(200, 2_000);
        guard.setMaxRuntimeFee(5e18);
        vm.prank(owner);
        guard.setRuntimeFee(id, 2e18);
        lpDeposit(id, 10_000e18);
        TraderVault vault = TraderVault(nft.vaultOf(id));
        uint256 navBefore = vault.totalAssets();
        execTrade(id, address(usdc), address(weth), 1_000e18);
        assertEq(usdc.balanceOf(executor), 2e18);
        assertApproxEqRel(vault.totalAssets(), navBefore - 2e18, 1e12); // the fee is a fund expense, nothing else leaks
        assertEq(usdc.balanceOf(address(guard)), 0);
    }

    function test_RuntimeFee_SkippedWhenNoBaseLeft() public {
        uint256 id = mintTrader(200, 2_000);
        guard.setMaxRuntimeFee(5e18);
        vm.prank(owner);
        guard.setRuntimeFee(id, 2e18);
        lpDeposit(id, 10e18);
        // partner seat so the brain can swing the whole book in one trade
        usdc.mint(owner, 500e18);
        vm.startPrank(owner);
        usdc.approve(address(guard), 500e18);
        guard.activate(id, 2);
        guard.setPolicy(id, 5_000, 100, 0);
        vm.stopPrank();
        // 10 base in the vault: trade 5 -> 5 left -> fee 2 paid -> 3 left
        execTrade(id, address(usdc), address(weth), 5e18);
        assertEq(usdc.balanceOf(executor), 2e18);
        // trade the remaining 3 (within the 50% cap): nothing left for the fee, trade still succeeds
        execTrade(id, address(usdc), address(weth), 3e18);
        assertEq(usdc.balanceOf(executor), 2e18); // no further fee, no revert
        assertEq(usdc.balanceOf(address(TraderVault(nft.vaultOf(id)))), 0);
    }

    function test_Registry_RegisterApproveAttested() public {
        RuntimeRegistry reg = new RuntimeRegistry();
        bytes32 m = keccak256("agent-src-bundle-v1");
        vm.prank(executor);
        vm.expectRevert("Registry: empty measurement");
        reg.register(bytes32(0), hex"01");
        vm.prank(executor);
        reg.register(m, hex"0102");
        (bytes32 mm, bytes memory pk, uint64 at) = reg.runtimeOf(executor);
        assertEq(mm, m);
        assertEq(pk, hex"0102");
        assertGt(at, 0);
        assertFalse(reg.attested(executor));
        vm.prank(stranger);
        vm.expectRevert("Registry: not deployer");
        reg.approveMeasurement(m, true);
        reg.approveMeasurement(m, true);
        assertTrue(reg.attested(executor));
        reg.approveMeasurement(m, false);
        assertFalse(reg.attested(executor));
    }

    function test_TokenURI_IsInlineJsonWithImage() public {
        uint256 id = mintTrader(200, 2_000);
        vm.prank(owner);
        nft.christen(id, "Umbra");
        string memory uri = nft.tokenURI(id);
        bytes memory b = bytes(uri);
        assertEq(string(_slice(b, 0, 29)), "data:application/json;base64,");
        assertGt(b.length, 400);
        vm.expectRevert();
        nft.tokenURI(999);
    }

    function _slice(bytes memory b, uint256 start, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i = 0; i < len; i++) out[i] = b[start + i];
    }
}
