// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {RuntimeRegistry} from "../src/RuntimeRegistry.sol";
import {NitroAttestationVerifier} from "../src/NitroAttestationVerifier.sol";
import {QuoteVerifierRouter} from "../src/QuoteVerifierRouter.sol";
import {MockQuoteVerifier} from "../src/mocks/MockQuoteVerifier.sol";
import {IQuoteVerifier} from "../src/interfaces/ITraderNFT.sol";

/// The Nitro path: an approved attestor (an off-chain verifier, itself an
/// enclave) signs a compact statement over (measurement, report data,
/// issued-at); the adapter checks signer, freshness and chain binding; the
/// router lets TDX quotes and Nitro statements share the registry's one
/// verifier slot.
contract NitroVerifierTest is Test {
    address executor = makeAddr("executor");
    address stranger = makeAddr("stranger");

    NitroAttestationVerifier ver;
    address attestor;
    uint256 attestorPk;

    function setUp() public {
        ver = new NitroAttestationVerifier(1 hours);
        (attestor, attestorPk) = makeAddrAndKey("attestor");
        ver.setAttestor(attestor, true);
    }

    function statement(uint256 pk, bytes32 m, bytes32 rd, uint64 issuedAt) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ver.digest(m, rd, issuedAt));
        return abi.encode(m, rd, issuedAt, abi.encodePacked(r, s, v));
    }

    function test_Nitro_StatementRegistersHardwareAttested() public {
        RuntimeRegistry reg = new RuntimeRegistry();
        reg.setVerifier(ver);
        bytes memory key = hex"0102";
        bytes32 m = keccak256("nitro-pcr0-1-2");
        bytes32 rd = keccak256(abi.encodePacked(executor, key));
        bytes memory q = statement(attestorPk, m, rd, uint64(vm.getBlockTimestamp()));

        vm.prank(executor);
        reg.registerAttested(q, key);
        assertEq(reg.attestationOf(executor), reg.ATTESTATION_HARDWARE());
        (bytes32 mm,,) = reg.runtimeOf(executor);
        assertEq(mm, m);
        assertFalse(reg.attested(executor)); // the measurement still needs protocol approval
        reg.approveMeasurement(m, true);
        assertTrue(reg.attested(executor));
        assertTrue(reg.hardwareAttested(executor));
    }

    function test_Nitro_RejectsUnknownStaleTamperedAndValue() public {
        bytes32 m = keccak256("pcrs");
        bytes32 rd = keccak256("rd");
        uint64 t0 = uint64(vm.getBlockTimestamp());

        (, uint256 otherPk) = makeAddrAndKey("other");
        bytes memory q = statement(otherPk, m, rd, t0);
        vm.expectRevert("Nitro: unknown attestor");
        ver.verify(q);

        // tampering re-derives a different signer
        q = statement(attestorPk, m, rd, t0);
        (,, uint64 ia, bytes memory sig) = abi.decode(q, (bytes32, bytes32, uint64, bytes));
        bytes memory tampered = abi.encode(keccak256("other measurement"), rd, ia, sig);
        vm.expectRevert("Nitro: unknown attestor");
        ver.verify(tampered);

        vm.warp(t0 + 1 hours + 1);
        vm.expectRevert("Nitro: stale statement");
        ver.verify(q);

        bytes memory future = statement(attestorPk, m, rd, uint64(vm.getBlockTimestamp()) + 600);
        vm.expectRevert("Nitro: from the future");
        ver.verify(future);

        bytes memory fresh = statement(attestorPk, m, rd, uint64(vm.getBlockTimestamp()));
        vm.deal(address(this), 1 ether);
        vm.expectRevert("Nitro: no fee");
        ver.verify{value: 1 wei}(fresh);

        bytes memory zero = statement(attestorPk, bytes32(0), rd, uint64(vm.getBlockTimestamp()));
        vm.expectRevert("Nitro: empty measurement");
        ver.verify(zero);

        vm.prank(stranger);
        vm.expectRevert("Nitro: not deployer");
        ver.setAttestor(stranger, true);
    }

    function test_Router_FirstAcceptingVerifierWins() public {
        MockQuoteVerifier mock = new MockQuoteVerifier();
        IQuoteVerifier[] memory vs = new IQuoteVerifier[](2);
        vs[0] = IQuoteVerifier(address(mock));
        vs[1] = IQuoteVerifier(address(ver));
        QuoteVerifierRouter router = new QuoteVerifierRouter(vs);
        assertEq(router.verifiers().length, 2);

        bytes memory key = hex"0102";
        bytes32 m = keccak256("nitro-image");
        bytes32 rd = keccak256(abi.encodePacked(executor, key));
        bytes memory q = statement(attestorPk, m, rd, uint64(vm.getBlockTimestamp()));

        // the first verifier rejects; the Nitro statement lands on the second
        mock.setReject(true);
        RuntimeRegistry reg = new RuntimeRegistry();
        reg.setVerifier(router);
        vm.prank(executor);
        reg.registerAttested(q, key);
        assertEq(reg.attestationOf(executor), reg.ATTESTATION_HARDWARE());

        // an accepting first verifier wins, whatever the bytes
        mock.setReject(false);
        mock.set(keccak256("tdx-image"), rd);
        vm.prank(executor);
        reg.registerAttested(hex"aa", key);
        (bytes32 mm,,) = reg.runtimeOf(executor);
        assertEq(mm, keccak256("tdx-image"));

        // nobody accepts
        mock.setReject(true);
        vm.warp(vm.getBlockTimestamp() + 2 hours); // the Nitro statement is stale too
        vm.prank(executor);
        vm.expectRevert("Router: no verifier accepted");
        reg.registerAttested(q, key);

        // list management is deployer-only
        vm.prank(stranger);
        vm.expectRevert("Router: not deployer");
        router.setVerifiers(vs);
        IQuoteVerifier[] memory one = new IQuoteVerifier[](1);
        one[0] = IQuoteVerifier(address(mock));
        router.setVerifiers(one);
        assertEq(router.verifiers().length, 1);
    }
}
