// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {TraderVault} from "../src/TraderVault.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";

contract GuardrailsTest is BaseTest {
    uint256 id;
    TraderVault vault;

    function setUp() public override {
        super.setUp();
        id = mintTrader(0, 0);
        vault = TraderVault(nft.vaultOf(id));
        lpDeposit(id, 10_000e18);
    }

    function test_HappyPathTradeFromVault() public {
        uint256 navBefore = vault.totalAssets();
        uint256 out = execTrade(id, address(usdc), address(weth), 1_000e18);
        assertEq(out, router.quote(address(usdc), address(weth), 1_000e18));
        assertEq(weth.balanceOf(address(vault)), out); // proceeds land in the vault
        assertEq(usdc.balanceOf(address(guard)), 0); // guard keeps nothing
        assertEq(weth.balanceOf(address(guard)), 0);
        assertApproxEqRel(vault.totalAssets(), navBefore, 1e12); // NAV preserved at spot
    }

    function test_RevertWhen_NotExecutor() public {
        vm.prank(stranger);
        vm.expectRevert("Guard: not executor");
        guard.executeTrade(id, address(router), address(usdc), address(weth), 100e18, 0, true);
    }

    function test_RevertWhen_VenueNotAllowed() public {
        MockSwapRouter rogue = new MockSwapRouter();
        vm.prank(executor);
        vm.expectRevert("Guard: venue not allowed");
        guard.executeTrade(id, address(rogue), address(usdc), address(weth), 100e18, 0, true);
    }

    function test_RevertWhen_TokenNotAllowed() public {
        MockERC20 shitcoin = new MockERC20("Rug", "RUG");
        vm.prank(executor);
        vm.expectRevert("Guard: token not allowed");
        guard.executeTrade(id, address(router), address(usdc), address(shitcoin), 100e18, 0, true);
    }

    function test_RevertWhen_NotionalOverCap() public {
        // default policy caps a single trade at 20% of NAV (10k) = 2k
        uint256 amount = 2_001e18;
        uint256 quoted = router.quote(address(usdc), address(weth), amount);
        vm.prank(executor);
        vm.expectRevert("Guard: notional cap");
        guard.executeTrade(id, address(router), address(usdc), address(weth), amount, quoted, true);
    }

    function test_RevertWhen_SlippageBoundBreached() public {
        // executor tries to accept 2% below quote; policy allows 1%
        uint256 amount = 1_000e18;
        uint256 minOut = (router.quote(address(usdc), address(weth), amount) * 9_800) / 10_000;
        vm.prank(executor);
        vm.expectRevert("Guard: slippage bound");
        guard.executeTrade(id, address(router), address(usdc), address(weth), amount, minOut, true);
    }

    function test_RevertWhen_VenueDeliversShort() public {
        router.setSkew(200); // venue executes 2% worse than quote
        uint256 amount = 1_000e18;
        uint256 quoted = router.quote(address(usdc), address(weth), amount);
        vm.prank(executor);
        vm.expectRevert("MockSwapRouter: insufficient output");
        guard.executeTrade(id, address(router), address(usdc), address(weth), amount, quoted, true);
    }

    /// The declared cadence trait (fixture: 4/day, so every 6 hours) is a
    /// bound enforced on-chain: the owner may tighten the interval but can
    /// never loosen it below what the brain declared at birth.
    function test_CadenceRateLimit() public {
        // absolute timestamps: via-IR CSEs repeated block.timestamp reads across vm.warp
        vm.warp(10_000);
        assertEq(guard.cadenceIntervalOf(id), 6 hours);
        assertEq(guard.tradeIntervalOf(id), 6 hours);
        assertEq(guard.nextTradeAt(id), 0);
        execTrade(id, address(usdc), address(weth), 500e18);
        assertEq(guard.nextTradeAt(id), 10_000 + 6 hours);
        uint256 quoted = router.quote(address(usdc), address(weth), 500e18);
        vm.prank(executor);
        vm.expectRevert("Guard: cadence");
        guard.executeTrade(id, address(router), address(usdc), address(weth), 500e18, quoted, true);

        // an owner-set 1h interval changes nothing: the declared cadence floors it
        vm.prank(owner);
        guard.setPolicy(id, 2_000, 100, 1 hours);
        assertEq(guard.tradeIntervalOf(id), 6 hours);
        vm.warp(10_000 + 1 hours);
        vm.prank(executor);
        vm.expectRevert("Guard: cadence");
        guard.executeTrade(id, address(router), address(usdc), address(weth), 500e18, quoted, true);
        vm.warp(10_000 + 6 hours);
        execTrade(id, address(usdc), address(weth), 500e18); // passes once the declared interval has elapsed

        // tightening to 12h is honoured
        vm.prank(owner);
        guard.setPolicy(id, 2_000, 100, 12 hours);
        assertEq(guard.tradeIntervalOf(id), 12 hours);
        vm.warp(10_000 + 6 hours + 6 hours);
        vm.prank(executor);
        vm.expectRevert("Guard: cadence");
        guard.executeTrade(id, address(router), address(usdc), address(weth), 500e18, quoted, true);
        vm.warp(10_000 + 6 hours + 12 hours);
        execTrade(id, address(usdc), address(weth), 500e18);
    }

    function test_PolicyAdminOnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert("Guard: not trader owner");
        guard.setExecutor(id, stranger);
        vm.prank(stranger);
        vm.expectRevert("Guard: not trader owner");
        guard.setPolicy(id, 10_000, 10_000, 0);
    }

    /// The core invariant: whatever trades the executor makes within policy,
    /// value never leaves the vault<->venue loop — the guard retains nothing
    /// and NAV at spot prices is preserved.
    function testFuzz_ExecutorCannotExtractValue(uint96 rawAmount) public {
        uint256 amount = bound(uint256(rawAmount), 1e6, 2_000e18); // within notional cap
        uint256 navBefore = vault.totalAssets();
        execTrade(id, address(usdc), address(weth), amount);
        assertEq(usdc.balanceOf(address(guard)), 0);
        assertEq(weth.balanceOf(address(guard)), 0);
        assertEq(usdc.balanceOf(executor), 0);
        assertEq(weth.balanceOf(executor), 0);
        assertApproxEqRel(vault.totalAssets(), navBefore, 1e12);
    }
}
