// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {TraderVault} from "../src/TraderVault.sol";
import {ERC6551Account} from "erc6551/examples/simple/ERC6551Account.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Reaping: a brain that goes broke and stays dead frees its slot. Never a
/// brain with LP or fee shares, never one still holding capital, and only
/// after the owner's refund window. Culling pays for the slot and mints
/// atomically. The cap becomes 4,096 alive.
contract ReapingTest is BaseTest {
    event Reaped(uint256 indexed tokenId, address indexed reaper);
    event Culled(uint256 indexed deadTokenId, address indexed payer, uint256 newTokenId, uint256 fee);

    function setUp() public override {
        super.setUp();
        guard.setReap(30 days, 10e18, 1e18); // idle 30d + dead; cullFee 10, dust 1
    }

    function fundAndTrade(uint256 id, uint256 amount) internal {
        address tba = nft.accountOf(id);
        usdc.mint(tba, amount);
        vm.prank(owner);
        ERC6551Account(payable(tba)).execute(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(guard), type(uint256).max)), 0);
        uint256 clip = amount / 10; // within the Intern 20%-of-NAV per-trade cap
        uint256 quoted = router.quote(address(usdc), address(weth), clip);
        vm.prank(executor);
        guard.executeTrade(id, address(router), address(usdc), address(weth), clip, quoted, false);
    }

    function test_ReapableOnlyWhenDeadAndIdlePastDelay() public {
        uint256 id = mintTrader(0, 0);
        assertFalse(guard.reapable(id), "never traded: not reapable");
        assertTrue(guard.insolvent(id), "empty at birth");

        fundAndTrade(id, 100e18); // now it has traded and holds weth
        assertFalse(guard.insolvent(id), "holds capital");
        assertFalse(guard.reapable(id));
        assertEq(guard.reapableAt(id), 0);

        // sweep it to zero: dead, but inside the window
        address tba = nft.accountOf(id);
        vm.startPrank(owner);
        ERC6551Account(payable(tba)).execute(address(weth), 0, abi.encodeCall(IERC20.transfer, (owner, weth.balanceOf(tba))), 0);
        ERC6551Account(payable(tba)).execute(address(usdc), 0, abi.encodeCall(IERC20.transfer, (owner, usdc.balanceOf(tba))), 0);
        vm.stopPrank();
        assertTrue(guard.insolvent(id));
        assertFalse(guard.reapable(id), "dead but inside the refund window");
        assertEq(guard.reapableAt(id), uint64(guard_lastTradeAt(id) + 30 days));

        vm.warp(vm.getBlockTimestamp() + 30 days);
        assertTrue(guard.reapable(id));
    }

    function guard_lastTradeAt(uint256 id) internal view returns (uint64) {
        (,,,, uint64 last,) = guard.policyOf(id);
        return last;
    }

    function test_ReapBurnsAndFreesASlot() public {
        uint256 id = mintTrader(0, 0);
        fundAndTrade(id, 100e18);
        address tba = nft.accountOf(id);
        vm.startPrank(owner);
        ERC6551Account(payable(tba)).execute(address(weth), 0, abi.encodeCall(IERC20.transfer, (owner, weth.balanceOf(tba))), 0);
        ERC6551Account(payable(tba)).execute(address(usdc), 0, abi.encodeCall(IERC20.transfer, (owner, usdc.balanceOf(tba))), 0);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 30 days);

        assertEq(nft.liveSupply(), 1);
        assertTrue(nft.exists(id));
        vm.expectEmit(true, true, false, false);
        emit Reaped(id, stranger);
        vm.prank(stranger); // anyone
        guard.reap(id);
        assertEq(nft.liveSupply(), 0);
        assertEq(nft.burnedCount(), 1);
        assertFalse(nft.exists(id));
        vm.expectRevert(); // burned: no metadata
        nft.tokenURI(id);
        // the reaped vault takes no more deposits
        assertTrue(TraderVault(nft.vaultOf(id)).retired());
    }

    function test_NeverReapAliveOrFundedOrShareholdingBrains() public {
        uint256 id = mintTrader(200, 0);
        lpDeposit(id, 10_000e18); // LP shares outstanding
        execTrade(id, address(usdc), address(weth), 1_000e18);
        vm.warp(vm.getBlockTimestamp() + 60 days);
        assertFalse(guard.insolvent(id), "has LP shares");
        assertFalse(guard.reapable(id));
        vm.prank(stranger);
        vm.expectRevert("Guard: not reapable");
        guard.reap(id);
    }

    function test_ReapConfigDeployerOnly_ZeroDisables() public {
        vm.prank(stranger);
        vm.expectRevert("Guard: not deployer");
        guard.setReap(1 days, 0, 0);
        guard.setReap(0, 0, 0); // disable
        uint256 id = mintTrader(0, 0);
        fundAndTrade(id, 100e18);
        vm.warp(vm.getBlockTimestamp() + 3650 days);
        assertFalse(guard.reapable(id), "reaping disabled");
    }

    function test_CullAndMint_PaysAndReplacesAtomically() public {
        // fill nothing special; just make id dead and reapable
        uint256 dead = mintTrader(0, 0);
        fundAndTrade(dead, 100e18);
        address tba = nft.accountOf(dead);
        vm.startPrank(owner);
        ERC6551Account(payable(tba)).execute(address(weth), 0, abi.encodeCall(IERC20.transfer, (owner, weth.balanceOf(tba))), 0);
        ERC6551Account(payable(tba)).execute(address(usdc), 0, abi.encodeCall(IERC20.transfer, (owner, usdc.balanceOf(tba))), 0);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 30 days);

        address[] memory universe = new address[](1);
        universe[0] = address(weth);
        usdc.mint(buyer, 10e18);
        vm.startPrank(buyer);
        usdc.approve(address(guard), 10e18);
        uint256 treasuryBefore = usdc.balanceOf(guard.treasury());
        uint256 newId = guard.cullAndMint(dead, keccak256("fresh"), 1, 4, 1, "claude-sonnet-5", "cid", universe, 200, 2_000);
        vm.stopPrank();

        assertFalse(nft.exists(dead), "old brain burned");
        assertEq(nft.ownerOf(newId), buyer, "new brain minted to the payer");
        assertGt(newId, dead, "a new id, never the old one");
        assertEq(nft.liveSupply(), 1, "one dead out, one new in");
        assertEq(usdc.balanceOf(guard.treasury()) - treasuryBefore, 10e18, "cull fee to the treasury");
        assertFalse(guard.reapable(newId), "the fresh brain is not reapable");
    }

    function test_CullRefusesLiveBrains() public {
        uint256 id = mintTrader(0, 0);
        fundAndTrade(id, 100e18); // still holds capital
        address[] memory universe = new address[](1);
        universe[0] = address(weth);
        usdc.mint(buyer, 10e18);
        vm.startPrank(buyer);
        usdc.approve(address(guard), 10e18);
        vm.expectRevert("Guard: not reapable");
        guard.cullAndMint(id, keccak256("fresh"), 1, 4, 1, "m", "cid", universe, 0, 0);
        vm.stopPrank();
    }

    /// The cap is now 4,096 alive: reaping one dead brain lets one more mint.
    function test_LiveSupplyCapReplacesTheEverCap() public {
        // exercise the accounting directly rather than minting 4,096 brains
        uint256 a = mintTrader(0, 0);
        uint256 b = mintTrader(0, 0);
        assertEq(nft.nextId(), b);
        assertEq(nft.liveSupply(), 2);
        fundAndTrade(a, 100e18);
        address tba = nft.accountOf(a);
        vm.startPrank(owner);
        ERC6551Account(payable(tba)).execute(address(weth), 0, abi.encodeCall(IERC20.transfer, (owner, weth.balanceOf(tba))), 0);
        ERC6551Account(payable(tba)).execute(address(usdc), 0, abi.encodeCall(IERC20.transfer, (owner, usdc.balanceOf(tba))), 0);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 30 days);
        vm.prank(stranger);
        guard.reap(a);
        assertEq(nft.nextId(), b, "ids do not roll back");
        assertEq(nft.burnedCount(), 1);
        assertEq(nft.liveSupply(), 1);
        uint256 c = mintTrader(0, 0);
        assertEq(c, b + 1, "the new brain gets a fresh, higher id");
    }
}
