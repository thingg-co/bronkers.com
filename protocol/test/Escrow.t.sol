// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {TraderVault} from "../src/TraderVault.sol";
import {RuntimeRegistry} from "../src/RuntimeRegistry.sol";
import {ERC6551Account} from "erc6551/examples/simple/ERC6551Account.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Escrowed rent: anyone may prepay a brain's runtime fees; the book pays
/// first and escrow is the backstop, under the same gates and per-day bound;
/// escrow is opex, not capital (no NAV, no rescue from reaping), travels
/// with the token, and refunds to the owner on reap or cull.
contract EscrowTest is BaseTest {
    event RuntimeEscrowFunded(uint256 indexed tokenId, address indexed from, uint256 amount);
    event RuntimeEscrowWithdrawn(uint256 indexed tokenId, address indexed to, uint256 amount);
    event RuntimeEscrowDraw(uint256 indexed tokenId, uint256 fee);
    event RuntimeEscrowRefunded(uint256 indexed tokenId, address indexed to, uint256 amount);
    event RuntimeFeePaid(uint256 indexed tokenId, address indexed executor, uint256 fee);

    function fundEscrow(uint256 id, address from, uint256 amount) internal {
        usdc.mint(from, amount);
        vm.startPrank(from);
        usdc.approve(address(guard), amount);
        guard.fundRuntime(id, amount);
        vm.stopPrank();
    }

    /// Fee plumbing shared by the backstop tests: 2 mUSDC per trade, a
    /// partner seat so the brain can swing half its book in one trade.
    function feeSetup(uint256 id) internal {
        guard.setMaxRuntimeFee(5e18);
        vm.prank(owner);
        guard.setRuntimeFee(id, 2e18);
        usdc.mint(owner, 500e18);
        vm.startPrank(owner);
        usdc.approve(address(guard), 500e18);
        guard.activate(id, 2);
        guard.setPolicy(id, 5_000, 100, 0);
        vm.stopPrank();
    }

    /// A brain that traded once and was swept to zero: dead, but owner-refundable.
    function makeDead(uint256 id) internal {
        address tba = nft.accountOf(id);
        usdc.mint(tba, 100e18);
        vm.prank(owner);
        ERC6551Account(payable(tba)).execute(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(guard), type(uint256).max)), 0);
        uint256 quoted = router.quote(address(usdc), address(weth), 10e18);
        vm.prank(executor);
        guard.executeTrade(id, address(router), address(usdc), address(weth), 10e18, quoted, false);
        vm.startPrank(owner);
        ERC6551Account(payable(tba)).execute(address(weth), 0, abi.encodeCall(IERC20.transfer, (owner, weth.balanceOf(tba))), 0);
        ERC6551Account(payable(tba)).execute(address(usdc), 0, abi.encodeCall(IERC20.transfer, (owner, usdc.balanceOf(tba))), 0);
        vm.stopPrank();
    }

    function test_Escrow_FundByAnyone_WithdrawByOwnerOnly() public {
        uint256 id = mintTrader(0, 0);

        vm.expectRevert("Guard: zero amount");
        guard.fundRuntime(id, 0);
        vm.expectRevert(); // never minted
        guard.fundRuntime(999, 1e18);

        usdc.mint(stranger, 7e18);
        vm.startPrank(stranger);
        usdc.approve(address(guard), 7e18);
        vm.expectEmit(true, true, false, true);
        emit RuntimeEscrowFunded(id, stranger, 7e18);
        guard.fundRuntime(id, 7e18);
        vm.stopPrank();
        assertEq(guard.runtimeEscrowOf(id), 7e18);
        assertEq(usdc.balanceOf(address(guard)), 7e18);

        vm.prank(stranger);
        vm.expectRevert("Guard: not trader owner");
        guard.withdrawRuntime(id, 1e18);
        vm.prank(owner);
        vm.expectRevert("Guard: escrow balance");
        guard.withdrawRuntime(id, 8e18);

        vm.prank(owner);
        vm.expectEmit(true, true, false, true);
        emit RuntimeEscrowWithdrawn(id, owner, 3e18);
        guard.withdrawRuntime(id, 3e18);
        assertEq(guard.runtimeEscrowOf(id), 4e18);
        assertEq(usdc.balanceOf(owner), 3e18);
    }

    function test_Escrow_BackstopsFeeWhenBookCannotPay() public {
        uint256 id = mintTrader(0, 0);
        feeSetup(id);
        lpDeposit(id, 10e18);
        fundEscrow(id, stranger, 10e18);

        // 10 base in the vault: trade 5 -> 5 left -> the BOOK pays the 2 fee
        execTrade(id, address(usdc), address(weth), 5e18);
        assertEq(usdc.balanceOf(executor), 2e18);
        assertEq(guard.runtimeEscrowOf(id), 10e18); // book paid; escrow untouched

        // next cadence slot: trade the remaining 3 -> no base left -> escrow pays
        vm.warp(vm.getBlockTimestamp() + 6 hours);
        uint256 quoted = router.quote(address(usdc), address(weth), 3e18);
        vm.expectEmit(true, false, false, true);
        emit RuntimeEscrowDraw(id, 2e18);
        vm.expectEmit(true, true, false, true);
        emit RuntimeFeePaid(id, executor, 2e18);
        vm.prank(executor);
        guard.executeTrade(id, address(router), address(usdc), address(weth), 3e18, quoted, true);

        assertEq(usdc.balanceOf(executor), 4e18);
        assertEq(guard.runtimeEscrowOf(id), 8e18);
        assertEq(usdc.balanceOf(address(guard)), 8e18); // exactly the escrow remains with the guard
        assertEq(usdc.balanceOf(address(TraderVault(nft.vaultOf(id)))), 0);
    }

    function test_Escrow_PaysOnlyAttestedExecutors() public {
        uint256 id = mintTrader(0, 0);
        RuntimeRegistry reg = new RuntimeRegistry();
        guard.setRegistry(address(reg));
        feeSetup(id);
        lpDeposit(id, 10e18);
        fundEscrow(id, stranger, 10e18);

        // unattested: neither the book nor the escrow pays
        execTrade(id, address(usdc), address(weth), 5e18);
        vm.warp(vm.getBlockTimestamp() + 6 hours);
        execTrade(id, address(usdc), address(weth), 5e18);
        assertEq(usdc.balanceOf(executor), 0);
        assertEq(guard.runtimeEscrowOf(id), 10e18);

        // attested: the empty book falls through to the escrow
        bytes32 m = keccak256("agent-src-bundle-v1");
        vm.prank(executor);
        reg.register(m, hex"01");
        reg.approveMeasurement(m, true);
        lpDeposit(id, 1e18); // one base in, gone in the trade itself
        vm.warp(vm.getBlockTimestamp() + 6 hours);
        execTrade(id, address(usdc), address(weth), 1e18);
        assertEq(usdc.balanceOf(executor), 2e18);
        assertEq(guard.runtimeEscrowOf(id), 8e18);
    }

    function test_Escrow_RefundedOnReap_NotCapital() public {
        guard.setReap(30 days, 10e18, 1e18);
        uint256 id = mintTrader(0, 0);
        makeDead(id);
        fundEscrow(id, stranger, 7e18);

        assertTrue(guard.insolvent(id), "escrow is not NAV");
        vm.warp(vm.getBlockTimestamp() + 30 days);
        assertTrue(guard.reapable(id), "escrow does not save a dead brain");

        uint256 before = usdc.balanceOf(owner);
        vm.expectEmit(true, true, false, true);
        emit RuntimeEscrowRefunded(id, owner, 7e18);
        vm.prank(stranger);
        guard.reap(id);
        assertEq(usdc.balanceOf(owner), before + 7e18);
        assertEq(guard.runtimeEscrowOf(id), 0);
        assertEq(usdc.balanceOf(address(guard)), 0);
    }

    function test_Escrow_RefundedOnCull() public {
        guard.setReap(30 days, 10e18, 1e18);
        uint256 id = mintTrader(0, 0);
        makeDead(id);
        fundEscrow(id, stranger, 5e18);
        vm.warp(vm.getBlockTimestamp() + 30 days);

        uint256 before = usdc.balanceOf(owner);
        address[] memory universe = new address[](1);
        universe[0] = address(weth);
        usdc.mint(buyer, 10e18);
        vm.startPrank(buyer);
        usdc.approve(address(guard), 10e18);
        uint256 newId = guard.cullAndMint(id, keccak256("new-genome"), 1, 4, 1, "claude-sonnet-5", "bafy-cid", universe, 0, 0);
        vm.stopPrank();

        assertEq(usdc.balanceOf(owner), before + 5e18, "old owner got the escrow back");
        assertEq(guard.runtimeEscrowOf(id), 0);
        assertEq(guard.runtimeEscrowOf(newId), 0, "the new brain starts unfunded");
    }

    function test_Escrow_TravelsWithTheToken() public {
        uint256 id = mintTrader(0, 0);
        fundEscrow(id, stranger, 5e18);

        vm.prank(owner);
        nft.transferFrom(owner, buyer, id);
        vm.prank(owner);
        vm.expectRevert("Guard: not trader owner");
        guard.withdrawRuntime(id, 5e18);
        vm.prank(buyer);
        guard.withdrawRuntime(id, 5e18);
        assertEq(usdc.balanceOf(buyer), 5e18);
    }
}
