// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {TraderVault} from "../src/TraderVault.sol";
import {ERC6551Account} from "erc6551/examples/simple/ERC6551Account.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Generations: the owner trains the brain between fights. A revision appends
/// a committed generation; trades stay attributable to the generation that
/// made them; a revised genome spars on the own book (camp) and waits out the
/// notice period before it may trade the vault; the high-water mark carries.
contract GenerationsTest is BaseTest {
    event GenomeRevised(uint256 indexed tokenId, uint32 generation, bytes32 commitment, string model);

    function fundOwnBook(uint256 id, uint256 amount) internal {
        address tba = nft.accountOf(id);
        usdc.mint(tba, amount);
        vm.prank(owner);
        ERC6551Account(payable(tba)).execute(
            address(usdc), 0, abi.encodeCall(IERC20.approve, (address(guard), type(uint256).max)), 0
        );
    }

    function ownBookTrade(uint256 id, uint256 amountIn) internal {
        uint256 quoted = router.quote(address(usdc), address(weth), amountIn);
        vm.prank(executor);
        guard.executeTrade(id, address(router), address(usdc), address(weth), amountIn, quoted, false);
    }

    function test_ReviseAppendsAGeneration_OwnerOnly() public {
        uint256 id = mintTrader(200, 2_000);
        assertEq(nft.generationOf(id), 0);
        (bytes32 c0,,, uint64 b0,) = nft.generationAt(id, 0);
        assertEq(c0, keccak256("genome-fixture"));
        assertEq(b0, uint64(block.number));

        vm.prank(stranger);
        vm.expectRevert("Trader: not owner");
        nft.revise(id, keccak256("v2"), "claude-opus-5", "cid-v2");
        vm.prank(owner);
        vm.expectRevert("Trader: empty commitment");
        nft.revise(id, bytes32(0), "m", "cid");
        vm.prank(owner);
        vm.expectRevert("Trader: same genome");
        nft.revise(id, keccak256("genome-fixture"), "m", "cid");

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.roll(block.number + 10);
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit GenomeRevised(id, 1, keccak256("v2"), "claude-opus-5");
        nft.revise(id, keccak256("v2"), "claude-opus-5", "cid-v2");

        assertEq(nft.generationOf(id), 1);
        assertEq(nft.genomeOf(id).commitment, keccak256("v2"));
        assertEq(nft.genomeOf(id).model, "claude-opus-5");
        assertEq(nft.genomeOf(id).birthBlock, b0, "birth block belongs to the token, not the generation");
        assertEq(nft.genomeOf(id).cadence, 4, "public traits do not change");
        (bytes32 c1, string memory m1,, uint64 b1, uint64 t1) = nft.generationAt(id, 1);
        assertEq(c1, keccak256("v2"));
        assertEq(m1, "claude-opus-5");
        assertEq(b1, uint64(vm.getBlockNumber())); // via-IR caches block.number across vm.roll
        assertEq(nft.generationSince(id, 1), t1);
        assertEq(nft.generationSince(id, 7), 0);
    }

    /// A revised brain may trade its own book at once, but the vault only
    /// after campMinTrades own-book trades and the notice period.
    function test_CampGatesVaultTradesForRevisedGenome() public {
        uint256 id = mintTrader(200, 2_000);
        lpDeposit(id, 10_000e18);
        fundOwnBook(id, 1_000e18);
        execTrade(id, address(usdc), address(weth), 500e18); // generation 0 trades the vault freely

        guard.setCamp(2, 1 days);
        vm.warp(vm.getBlockTimestamp() + 6 hours);
        vm.prank(owner);
        nft.revise(id, keccak256("v2"), "claude-sonnet-5", "cid-v2");
        (uint32 gen, bool inCamp, uint32 trades, uint32 minTrades, uint64 vaultFrom) = guard.campStatus(id);
        assertEq(gen, 1);
        assertTrue(inCamp);
        assertEq(trades, 0);
        assertEq(minTrades, 2);
        assertEq(vaultFrom, uint64(vm.getBlockTimestamp()) + 1 days);

        // vault trade refused while in camp
        uint256 quoted = router.quote(address(usdc), address(weth), 500e18);
        vm.prank(executor);
        vm.expectRevert("Guard: in camp");
        guard.executeTrade(id, address(router), address(usdc), address(weth), 500e18, quoted, true);

        // sparring on the own book is allowed and counts
        ownBookTrade(id, 50e18);
        (, inCamp, trades,,) = guard.campStatus(id);
        assertEq(trades, 1);
        assertTrue(inCamp);
        vm.warp(vm.getBlockTimestamp() + 6 hours);
        ownBookTrade(id, 50e18);
        (, inCamp, trades,,) = guard.campStatus(id);
        assertEq(trades, 2);
        assertTrue(inCamp, "trades done but the notice period has not passed");

        vm.warp(vm.getBlockTimestamp() + 6 hours);
        vm.prank(executor);
        vm.expectRevert("Guard: in camp");
        guard.executeTrade(id, address(router), address(usdc), address(weth), 500e18, quoted, true);

        vm.warp(vaultFrom);
        assertTrue(guard.campDone(id, 1));
        (, inCamp,,,) = guard.campStatus(id);
        assertFalse(inCamp);
        execTrade(id, address(usdc), address(weth), 500e18); // the new generation fights
        // own-book count is per generation: generation 0's trades do not count for generation 1
        assertEq(guard.campTradesOf(id, 0), 0);
        assertEq(guard.campTradesOf(id, 1), 2);
    }

    function test_CampConfigIsDeployerOnlyAndNeedsAtLeastOneSpar() public {
        vm.prank(stranger);
        vm.expectRevert("Guard: not deployer");
        guard.setCamp(1, 0);
        vm.expectRevert("Guard: camp");
        guard.setCamp(0, 0);
        guard.setCamp(3, 2 days);
        assertEq(guard.campMinTrades(), 3);
        assertEq(guard.revisionNotice(), 2 days);
        // the base fixture deploys with seasonMinTrades 0: camp still asks for one spar
        (uint32 minTrades,) = (guard.campMinTrades(), guard.revisionNotice());
        assertGt(minTrades, 0);
    }

    /// Revising never resets fees: the high-water mark carries across generations.
    function test_HighWaterMarkCarriesAcrossGenerations() public {
        uint256 id = mintTrader(0, 2_000);
        TraderVault vault = TraderVault(nft.vaultOf(id));
        lpDeposit(id, 10_000e18);
        execTrade(id, address(usdc), address(weth), 2_000e18);
        router.setPrice(address(weth), address(usdc), WETH_PRICE * 3 / 2); // +50%: fee crystallises, HWM ratchets
        vault.checkpoint();
        uint256 hwm = vault.highWaterMark();
        assertGt(hwm, 1e18);

        router.setPrice(address(weth), address(usdc), WETH_PRICE); // back down: under water
        vm.prank(owner);
        nft.revise(id, keccak256("v2"), "claude-sonnet-5", "cid-v2");
        vault.checkpoint();
        assertEq(vault.highWaterMark(), hwm, "a new generation starts under the old mark");
        (uint256 mgmt, uint256 perf,) = vault.pendingFees();
        assertEq(mgmt + perf, 0, "no fee until the old mark is recovered");
    }

    function test_TokenURICarriesTheGeneration() public {
        uint256 id = mintTrader(200, 2_000);
        vm.prank(owner);
        nft.revise(id, keccak256("v2"), "claude-sonnet-5", "cid-v2");
        string memory uri = nft.tokenURI(id);
        assertGt(bytes(uri).length, 400);
        assertEq(nft.generationOf(id), 1);
    }
}
