// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {TraderVault} from "../src/TraderVault.sol";
import {ERC6551Account} from "erc6551/examples/simple/ERC6551Account.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract TransferFlowsTest is BaseTest {
    uint256 id;
    TraderVault vault;
    ERC6551Account tba;

    function setUp() public override {
        super.setUp();
        id = mintTrader(200, 2_000);
        vault = TraderVault(nft.vaultOf(id));
        tba = ERC6551Account(payable(nft.accountOf(id)));
        lpDeposit(id, 10_000e18);
        usdc.mint(address(tba), 5_000e18); // the trader's own book
    }

    function sweep(address caller, address to) internal {
        bytes memory call = abi.encodeCall(IERC20.transfer, (to, usdc.balanceOf(address(tba))));
        vm.prank(caller);
        tba.execute(address(usdc), 0, call, 0);
    }

    function test_SellWithCapital() public {
        vm.warp(block.timestamp + 90 days); // let some fees accrue

        vm.prank(owner);
        nft.safeTransferFrom(owner, buyer, id);

        // the trader's book travelled with the token
        assertEq(usdc.balanceOf(address(tba)), 5_000e18);
        // accrued fee shares live in the TBA, so they travelled too
        assertGt(vault.balanceOf(address(tba)), 0);
        // buyer now controls the TBA...
        sweep(buyer, buyer);
        assertEq(usdc.balanceOf(buyer), 5_000e18);
        // ...and the manager's seat
        vm.prank(buyer);
        guard.setExecutor(id, buyer);
    }

    function test_SellWithoutCapital() public {
        sweep(owner, owner); // owner sweeps the book first
        assertEq(usdc.balanceOf(owner), 5_000e18);

        vm.prank(owner);
        nft.safeTransferFrom(owner, buyer, id);

        assertEq(usdc.balanceOf(address(tba)), 0, "buyer receives an empty book");
        assertEq(nft.genomeOf(id).commitment, keccak256("genome-fixture"), "identity intact");
        // LPs are untouched either way
        assertEq(vault.balanceOf(lp), 10_000e18);
        assertGe(vault.totalAssets(), 10_000e18);
    }

    function test_FeesCheckpointedOnTransfer() public {
        vm.warp(block.timestamp + 365 days);
        uint256 tbaSharesBefore = vault.balanceOf(address(tba));
        vm.prank(owner);
        nft.safeTransferFrom(owner, buyer, id); // no explicit checkpoint call
        assertGt(vault.balanceOf(address(tba)), tbaSharesBefore, "transfer hook crystallized fees");
    }

    function test_OldOwnerFullyLockedOut() public {
        vm.prank(owner);
        nft.safeTransferFrom(owner, buyer, id);

        vm.prank(owner);
        vm.expectRevert("Guard: not trader owner");
        guard.setExecutor(id, owner);

        vm.prank(owner);
        vm.expectRevert("Vault: not trader owner");
        vault.setDepositAllowed(owner, true);

        vm.prank(owner);
        vm.expectRevert("Invalid signer");
        tba.execute(address(usdc), 0, abi.encodeCall(IERC20.transfer, (owner, 1)), 0);
    }

    function test_ExecutorSurvivesTransferUntilRotated() public {
        // documented buyer-safety issue: the seller's executor key keeps trading
        // rights until the buyer rotates it — hence the due-diligence checklist.
        vm.prank(owner);
        nft.safeTransferFrom(owner, buyer, id);
        execTrade(id, address(usdc), address(weth), 100e18); // old executor still works
        vm.prank(buyer);
        guard.setExecutor(id, buyer); // rotation kills it
        uint256 quoted = router.quote(address(usdc), address(weth), 100e18);
        vm.prank(executor);
        vm.expectRevert("Guard: not executor");
        guard.executeTrade(id, address(router), address(usdc), address(weth), 100e18, quoted, true);
    }

    function test_FullLifecycle() public {
        // trade → gain → fees → sell with capital → buyer collects
        execTrade(id, address(usdc), address(weth), 2_000e18);
        router.setPrice(address(weth), address(usdc), 3_000e18);
        vm.warp(block.timestamp + 180 days);
        vault.checkpoint();
        uint256 feeShares = vault.balanceOf(address(tba));
        assertGt(feeShares, 0);

        vm.prank(owner);
        nft.safeTransferFrom(owner, buyer, id);

        // buyer redeems the inherited fee shares out of the TBA
        bytes memory call = abi.encodeCall(vault.redeem, (feeShares, buyer, address(tba)));
        vm.prank(buyer);
        tba.execute(address(vault), 0, call, 0);
        assertGt(usdc.balanceOf(buyer), 0, "buyer collected inherited fees");
    }
}
