// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {TraderVault} from "../src/TraderVault.sol";
import {RuntimeRegistry} from "../src/RuntimeRegistry.sol";
import {AutomataDcapTdxVerifier} from "../src/AutomataDcapTdxVerifier.sol";
import {MockQuoteVerifier} from "../src/mocks/MockQuoteVerifier.sol";
import {MockDcapAttestation} from "../src/mocks/MockDcapAttestation.sol";

/// Runtime economics and identity: the per-trade runtime fee is owner-set,
/// protocol-capped, best-effort, paid to the executor, and bounded per day by
/// the declared cadence; the registry binds an executor key to a measurement
/// either self-reported (deployer approves) or carried by a verified TEE
/// quote; tokenURI renders without a server.
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
        // next cadence slot: trade the remaining 3 (within the 50% cap): nothing left for the fee, trade still succeeds
        vm.warp(vm.getBlockTimestamp() + 6 hours);
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

    /// Over a day, at most `cadence` trades can execute, so the executor can
    /// draw at most cadence * maxRuntimeFee: a bounded fund expense.
    function test_RuntimeFee_BoundedByDeclaredCadence() public {
        uint256 id = mintTrader(200, 2_000); // fixture cadence 4/day
        guard.setMaxRuntimeFee(5e18);
        vm.prank(owner);
        guard.setRuntimeFee(id, 5e18);
        lpDeposit(id, 10_000e18);
        uint256 t0 = vm.getBlockTimestamp();
        uint256 executed;
        for (uint256 h = 0; h < 24; h++) {
            vm.warp(t0 + h * 1 hours);
            uint256 quoted = router.quote(address(usdc), address(weth), 200e18); // 2% of NAV: above the dust floor
            vm.prank(executor);
            try guard.executeTrade(id, address(router), address(usdc), address(weth), 200e18, quoted, true) {
                executed++;
            } catch {}
        }
        assertEq(executed, 4);
        assertEq(usdc.balanceOf(executor), 4 * 5e18);
        assertLe(usdc.balanceOf(executor), uint256(nft.cadenceOf(id)) * guard.maxRuntimeFee());
    }

    /// Paid for evidence: with a registry set, only an attested executor is paid.
    function test_RuntimeFee_OnlyToAttestedExecutorWhenRegistrySet() public {
        uint256 id = mintTrader(200, 2_000);
        guard.setMaxRuntimeFee(5e18);
        vm.prank(owner);
        guard.setRuntimeFee(id, 2e18);
        lpDeposit(id, 10_000e18);
        RuntimeRegistry reg = new RuntimeRegistry();
        vm.prank(stranger);
        vm.expectRevert("Guard: not deployer");
        guard.setRegistry(address(reg));
        guard.setRegistry(address(reg));

        execTrade(id, address(usdc), address(weth), 500e18);
        assertEq(usdc.balanceOf(executor), 0, "unregistered executor is not paid");

        bytes32 m = keccak256("farm-image");
        vm.prank(executor);
        reg.register(m, hex"0102");
        vm.warp(vm.getBlockTimestamp() + 6 hours);
        execTrade(id, address(usdc), address(weth), 500e18);
        assertEq(usdc.balanceOf(executor), 0, "registered but unapproved is not paid");

        reg.approveMeasurement(m, true);
        vm.warp(vm.getBlockTimestamp() + 6 hours);
        execTrade(id, address(usdc), address(weth), 500e18);
        assertEq(usdc.balanceOf(executor), 2e18, "attested executor is paid");

        guard.setRegistry(address(0)); // gate off: anyone enrolled is paid again
        vm.warp(vm.getBlockTimestamp() + 6 hours);
        execTrade(id, address(usdc), address(weth), 500e18);
        assertEq(usdc.balanceOf(executor), 4e18);
    }

    /// Dust cannot be churned for fees: a trade below minFeeNotionalBps of NAV pays nothing.
    function test_RuntimeFee_NoFeeOnDustTrades() public {
        uint256 id = mintTrader(200, 2_000);
        guard.setMaxRuntimeFee(5e18);
        vm.prank(owner);
        guard.setRuntimeFee(id, 2e18);
        lpDeposit(id, 10_000e18);
        assertEq(guard.minFeeNotionalBps(), 100);
        execTrade(id, address(usdc), address(weth), 50e18); // 0.5% of NAV
        assertEq(usdc.balanceOf(executor), 0);
        vm.warp(vm.getBlockTimestamp() + 6 hours);
        execTrade(id, address(usdc), address(weth), 200e18); // 2%
        assertEq(usdc.balanceOf(executor), 2e18);
        vm.prank(stranger);
        vm.expectRevert("Guard: not deployer");
        guard.setMinFeeNotionalBps(500);
        guard.setMinFeeNotionalBps(500); // 5%
        vm.warp(vm.getBlockTimestamp() + 6 hours);
        execTrade(id, address(usdc), address(weth), 200e18); // 2% < 5%
        assertEq(usdc.balanceOf(executor), 2e18, "below the raised floor: no fee");
    }

    /// Raises are announced: they take effect after runtimeFeeDelay; lowering is immediate.
    function test_RuntimeFee_RaiseTakesEffectAfterDelay_LowerAtOnce() public {
        uint256 id = mintTrader(200, 2_000);
        guard.setMaxRuntimeFee(5e18);
        lpDeposit(id, 10_000e18);
        vm.prank(stranger);
        vm.expectRevert("Guard: not deployer");
        guard.setRuntimeFeeDelay(1 days);
        guard.setRuntimeFeeDelay(1 days);
        uint256 t0 = vm.getBlockTimestamp();

        vm.prank(owner);
        guard.setRuntimeFee(id, 1e18); // a raise from 0: scheduled
        assertEq(guard.runtimeFeeOf(id), 0);
        (uint256 pf, uint64 at) = guard.pendingRuntimeFeeOf(id);
        assertEq(pf, 1e18);
        assertEq(at, t0 + 1 days);
        execTrade(id, address(usdc), address(weth), 500e18);
        assertEq(usdc.balanceOf(executor), 0, "not yet in effect");

        vm.warp(t0 + 1 days);
        assertEq(guard.runtimeFeeOf(id), 1e18);
        execTrade(id, address(usdc), address(weth), 500e18);
        assertEq(usdc.balanceOf(executor), 1e18, "in effect after the notice period");

        vm.prank(owner);
        guard.setRuntimeFee(id, 0.5e18); // lowering: immediate, clears any schedule
        assertEq(guard.runtimeFeeOf(id), 0.5e18);
        (pf, at) = guard.pendingRuntimeFeeOf(id);
        assertEq(at, 0);

        vm.prank(owner);
        guard.setRuntimeFee(id, 3e18); // raise again: scheduled from now
        assertEq(guard.runtimeFeeOf(id), 0.5e18);
        (pf, at) = guard.pendingRuntimeFeeOf(id);
        assertEq(pf, 3e18);
        assertEq(at, t0 + 2 days);

        guard.setRuntimeFeeDelay(0); // no delay: raises are immediate again
        vm.prank(owner);
        guard.setRuntimeFee(id, 4e18);
        assertEq(guard.runtimeFeeOf(id), 4e18);
    }

    event TranscriptCommitted(uint256 indexed tokenId, bytes32 transcript);

    /// A trade can carry the hash of the inference transcript that produced it.
    function test_TranscriptCommittedWithTrade() public {
        uint256 id = mintTrader(200, 2_000);
        lpDeposit(id, 10_000e18);
        bytes32 h = keccak256("snapshot+intent+model");
        uint256 quoted = router.quote(address(usdc), address(weth), 500e18);
        vm.prank(executor);
        vm.expectEmit(true, false, false, true);
        emit TranscriptCommitted(id, h);
        guard.executeTradeWithTranscript(id, address(router), address(usdc), address(weth), 500e18, quoted, true, h);
        assertEq(guard.tradeCountOf(id), 1);
        // same policy, same guard: a stranger cannot use the transcript form either
        vm.prank(stranger);
        vm.expectRevert("Guard: not executor");
        guard.executeTradeWithTranscript(id, address(router), address(usdc), address(weth), 500e18, quoted, true, h);
    }

    function test_Registry_AttestedViaVerifier() public {
        RuntimeRegistry reg = new RuntimeRegistry();
        MockQuoteVerifier ver = new MockQuoteVerifier();
        bytes memory key = hex"0102";
        bytes32 m = keccak256("tdx-image");

        vm.prank(executor);
        vm.expectRevert("Registry: no verifier");
        reg.registerAttested(hex"aa", key);
        vm.prank(stranger);
        vm.expectRevert("Registry: not deployer");
        reg.setVerifier(ver);
        reg.setVerifier(ver);

        // the quote's report data must commit to (executor key, enclave key)
        ver.set(m, keccak256("something else"));
        vm.prank(executor);
        vm.expectRevert("Registry: report data");
        reg.registerAttested(hex"aa", key);

        // a rejected quote reverts through
        ver.set(m, keccak256(abi.encodePacked(executor, key)));
        ver.setReject(true);
        vm.prank(executor);
        vm.expectRevert("MockQuoteVerifier: invalid quote");
        reg.registerAttested(hex"aa", key);
        ver.setReject(false);

        vm.deal(executor, 1 ether);
        vm.prank(executor);
        reg.registerAttested{value: 0.01 ether}(hex"aa", key);
        assertEq(ver.lastValue(), 0.01 ether); // verifier fee forwarded
        assertEq(reg.attestationOf(executor), reg.ATTESTATION_HARDWARE());
        (bytes32 mm, bytes memory pk, uint64 at) = reg.runtimeOf(executor);
        assertEq(mm, m);
        assertEq(pk, key);
        assertGt(at, 0);
        // hardware binds the key to the measurement; the protocol still has to approve the measurement
        assertFalse(reg.attested(executor));
        assertFalse(reg.hardwareAttested(executor));
        reg.approveMeasurement(m, true);
        assertTrue(reg.attested(executor));
        assertTrue(reg.hardwareAttested(executor));

        // re-registering self-reported keeps "attested" but drops the hardware label
        vm.prank(executor);
        reg.register(m, key);
        assertEq(reg.attestationOf(executor), reg.ATTESTATION_SELF_REPORTED());
        assertTrue(reg.attested(executor));
        assertFalse(reg.hardwareAttested(executor));
    }

    /// The adapter reads mrTd, the RTMRs and the report data out of Automata's
    /// serialized Output at the documented offsets and rejects everything else.
    function test_DcapAdapter_ParsesTdReport() public {
        MockDcapAttestation dcap = new MockDcapAttestation();
        AutomataDcapTdxVerifier ver = new AutomataDcapTdxVerifier(dcap, 1);
        bytes memory mrTd = _fill(48, 0xAA);
        bytes memory rtmrs = _fill(192, 0xBB);
        bytes32 rd = keccak256("executor+enclave-key");

        dcap.set(true, _output(2, 0, mrTd, rtmrs, rd, false));
        (bytes32 m, bytes32 r) = ver.verify{value: 1 wei}(hex"00");
        assertEq(m, keccak256(abi.encodePacked(mrTd, rtmrs)));
        assertEq(r, rd);
        assertEq(dcap.lastValue(), 1);

        // TD 1.5 body and trailing advisory ids are fine; the offsets are the same
        dcap.set(true, _output(3, 1, mrTd, rtmrs, rd, true));
        (m, r) = ver.verify(hex"00");
        assertEq(m, keccak256(abi.encodePacked(mrTd, rtmrs)));
        assertEq(r, rd);

        dcap.set(true, _output(1, 0, mrTd, rtmrs, rd, false)); // SGX enclave report
        vm.expectRevert("Dcap: not a TD report");
        ver.verify(hex"00");

        dcap.set(true, _output(2, 3, mrTd, rtmrs, rd, false)); // TCB out of date
        vm.expectRevert("Dcap: TCB status");
        ver.verify(hex"00");

        dcap.set(false, bytes("bad quote"));
        vm.expectRevert("Dcap: quote rejected");
        ver.verify(hex"00");

        dcap.set(true, hex"0004000200000000000000");
        vm.expectRevert("Dcap: short output");
        ver.verify(hex"00");
    }

    function _fill(uint256 len, uint8 v) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i = 0; i < len; i++) out[i] = bytes1(v);
    }

    /// Automata Output: quoteVersion(2) ‖ bodyType(2) ‖ tcbStatus(1) ‖ fmspc(6) ‖ body(584) ‖ [advisories]
    function _output(uint16 bodyType, uint8 tcb, bytes memory mrTd, bytes memory rtmrs, bytes32 rd, bool advisories)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory body = new bytes(bodyType == 3 ? 648 : 584);
        for (uint256 i = 0; i < 48; i++) body[136 + i] = mrTd[i];
        for (uint256 i = 0; i < 192; i++) body[328 + i] = rtmrs[i];
        for (uint256 i = 0; i < 32; i++) body[520 + i] = rd[i];
        bytes memory tail;
        if (advisories) {
            string[] memory ids = new string[](1);
            ids[0] = "INTEL-SA-00000";
            tail = abi.encode(ids);
        }
        return abi.encodePacked(uint16(4), bodyType, tcb, bytes6(0), body, tail);
    }

    function _slice(bytes memory b, uint256 start, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i = 0; i < len; i++) out[i] = b[start + i];
    }
}
