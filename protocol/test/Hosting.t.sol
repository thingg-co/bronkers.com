// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BaseTest} from "./Base.t.sol";
import {MockOysterMarket} from "../src/mocks/MockOysterMarket.sol";

/// The dev stand-in for the Oyster market the farm pays its lease into:
/// balance drains at the per-second rate, deposits extend the runway, and
/// the remaining-time arithmetic matches what the farm computes off-chain.
contract HostingTest is BaseTest {
    function test_MockMarket_DrainsAtRateAndTopsUp() public {
        MockOysterMarket market = new MockOysterMarket(IERC20(address(usdc)));
        address provider = makeAddr("provider");
        usdc.mint(address(this), 100e18);
        usdc.approve(address(market), type(uint256).max);

        uint256 hourly = 0.12e18; // 0.12 per hour
        uint256 rate = (hourly * 1e12) / 3600; // per second, with EXTRA_DECIMALS
        vm.recordLogs();
        market.jobOpen("brokners-farm", provider, rate, 1.2e18); // ten hours prepaid
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 job = logs[logs.length - 1].topics[1];
        assertApproxEqAbs(market.remainingSeconds(job), 10 hours, 2);

        vm.warp(vm.getBlockTimestamp() + 4 hours);
        assertApproxEqAbs(market.remainingSeconds(job), 6 hours, 2);
        market.jobSettle(job);
        assertApproxEqAbs(usdc.balanceOf(provider), 0.48e18, 1e12); // four hours billed to the provider

        market.jobDeposit(job, 0.6e18); // five more hours
        assertApproxEqAbs(market.remainingSeconds(job), 11 hours, 2);
        (, address jobOwner,, uint256 r, uint256 bal,) = market.jobs(job);
        assertEq(jobOwner, address(this));
        assertEq(r, rate);
        assertApproxEqAbs(bal, 1.32e18, 1e12);

        vm.warp(vm.getBlockTimestamp() + 20 hours); // runs dry
        assertEq(market.remainingSeconds(job), 0);
        market.jobSettle(job);
        (,,,, bal,) = market.jobs(job);
        assertEq(bal, 0);
        assertApproxEqAbs(usdc.balanceOf(provider), 1.8e18, 1e12); // everything ever deposited
    }
}
