// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {Credentials} from "../src/Credentials.sol";
import {ITraderNFT} from "../src/interfaces/ITraderNFT.sol";

/// Owner-supplied credentials: sealed envelopes published as events, active
/// only while their publisher still owns the brain, revocable by the owner.
contract CredentialsTest is BaseTest {
    Credentials creds;
    bytes32 constant INFERENCE = keccak256("inference");
    bytes envelope = bytes('{"v":1,"mode":"sealed","epk":"...","iv":"...","tag":"...","ciphertext":"..."}');

    function setUp() public override {
        super.setUp();
        creds = new Credentials(ITraderNFT(address(nft)));
    }

    function test_PublishIsOwnerOnly() public {
        uint256 id = mintTrader(200, 2_000);
        vm.prank(stranger);
        vm.expectRevert("Credentials: not owner");
        creds.publish(id, INFERENCE, envelope);
    }

    function test_PublishActivatesAndVersions() public {
        uint256 id = mintTrader(200, 2_000);
        (, uint32 v0,,, bool a0) = creds.credentialOf(id, INFERENCE);
        assertEq(v0, 0);
        assertFalse(a0);

        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit Credentials.CredentialPublished(id, INFERENCE, owner, 1, envelope);
        creds.publish(id, INFERENCE, envelope);
        (address p, uint32 v, uint64 at, bool revoked, bool a) = creds.credentialOf(id, INFERENCE);
        assertEq(p, owner);
        assertEq(v, 1);
        assertEq(at, uint64(block.timestamp));
        assertFalse(revoked);
        assertTrue(a);

        vm.prank(owner);
        creds.publish(id, INFERENCE, envelope);
        (, v,,, a) = creds.credentialOf(id, INFERENCE);
        assertEq(v, 2);
        assertTrue(a);
    }

    function test_RevokeAndRepublish() public {
        uint256 id = mintTrader(200, 2_000);
        vm.prank(owner);
        vm.expectRevert("Credentials: nothing to revoke");
        creds.revoke(id, INFERENCE);

        vm.prank(owner);
        creds.publish(id, INFERENCE, envelope);
        vm.prank(stranger);
        vm.expectRevert("Credentials: not owner");
        creds.revoke(id, INFERENCE);

        vm.prank(owner);
        vm.expectEmit(true, true, false, true);
        emit Credentials.CredentialRevoked(id, INFERENCE, 1);
        creds.revoke(id, INFERENCE);
        assertFalse(creds.active(id, INFERENCE));
        (,,, bool revoked,) = creds.credentialOf(id, INFERENCE);
        assertTrue(revoked);

        vm.prank(owner);
        vm.expectRevert("Credentials: nothing to revoke");
        creds.revoke(id, INFERENCE);

        // publishing again clears the revocation and bumps the version
        vm.prank(owner);
        creds.publish(id, INFERENCE, envelope);
        (, uint32 v,, bool r2, bool a) = creds.credentialOf(id, INFERENCE);
        assertEq(v, 2);
        assertFalse(r2);
        assertTrue(a);
    }

    function test_SaleRetiresSellersCredential() public {
        uint256 id = mintTrader(200, 2_000);
        vm.prank(owner);
        creds.publish(id, INFERENCE, envelope);
        assertTrue(creds.active(id, INFERENCE));

        vm.prank(owner);
        nft.transferFrom(owner, buyer, id);
        // the record is still there, but it is not the buyer's and so not active
        (address p, uint32 v,,, bool a) = creds.credentialOf(id, INFERENCE);
        assertEq(p, owner);
        assertEq(v, 1);
        assertFalse(a);

        // the seller can no longer touch it
        vm.prank(owner);
        vm.expectRevert("Credentials: not owner");
        creds.revoke(id, INFERENCE);

        // the buyer publishes their own; the version keeps counting
        vm.prank(buyer);
        creds.publish(id, INFERENCE, envelope);
        (p, v,,, a) = creds.credentialOf(id, INFERENCE);
        assertEq(p, buyer);
        assertEq(v, 2);
        assertTrue(a);

        // and selling it back does not revive the original owner's record
        vm.prank(buyer);
        nft.transferFrom(buyer, owner, id);
        assertFalse(creds.active(id, INFERENCE));
    }

    function test_KindsAreIndependent() public {
        uint256 id = mintTrader(200, 2_000);
        bytes32 data = keccak256("data");
        vm.startPrank(owner);
        creds.publish(id, INFERENCE, envelope);
        assertFalse(creds.active(id, data));
        creds.publish(id, data, envelope);
        creds.revoke(id, INFERENCE);
        vm.stopPrank();
        assertFalse(creds.active(id, INFERENCE));
        assertTrue(creds.active(id, data));
    }

    function test_EnvelopeSizeBounds() public {
        uint256 id = mintTrader(200, 2_000);
        uint256 max = creds.MAX_ENVELOPE_BYTES();
        vm.startPrank(owner);
        vm.expectRevert("Credentials: envelope size");
        creds.publish(id, INFERENCE, "");
        vm.expectRevert("Credentials: envelope size");
        creds.publish(id, INFERENCE, new bytes(max + 1));
        creds.publish(id, INFERENCE, new bytes(max));
        vm.stopPrank();
        assertTrue(creds.active(id, INFERENCE));
    }
}
