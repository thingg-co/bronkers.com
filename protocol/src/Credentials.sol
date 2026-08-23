// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ITraderNFT} from "./interfaces/ITraderNFT.sol";

/// @title Credentials — owner-supplied secrets for a brain, sealed to the enclave.
/// @notice An owner may give their brain credentials of their own (an inference
/// API key, a paid data feed, whatever the runtime knows how to use) without
/// anyone else reading them. Each credential is a sealed envelope, encrypted in
/// the owner's browser to the enclave's public key under a domain separated
/// from the genome, published here as an event, and opened only inside the
/// enclave. The plaintext never touches the chain or the operator.
///
/// Custody follows the token. A credential is *active* only while its
/// publisher still owns the brain: a sale silently retires the seller's
/// credentials (the buyer never spends the seller's key, the seller's key is
/// never used for the buyer's brain) and the buyer publishes their own. The
/// owner can revoke at any time. Credentials are keyed by a `kind` the runtime
/// understands ("inference" today); the contract is agnostic to what is inside.
///
/// Kept out of TraderNFT on purpose: that contract sits near the size limit,
/// and credentials are runtime configuration, not protocol state. Nothing in
/// the guard or the vault reads this contract.
contract Credentials {
    struct Credential {
        address publisher; // who sealed it; active only while this is ownerOf(tokenId)
        uint32 version; // bumps on every publish; 0 = never published
        uint64 publishedAt;
        bool revoked;
    }

    ITraderNFT public immutable nft;

    uint256 public constant MAX_ENVELOPE_BYTES = 16 * 1024;

    mapping(uint256 => mapping(bytes32 => Credential)) private _creds;

    /// A sealed credential envelope, as calldata: the runtime scans for the
    /// latest one whose `version` matches `credentialOf` and whose publisher
    /// still owns the brain.
    event CredentialPublished(uint256 indexed tokenId, bytes32 indexed kind, address indexed publisher, uint32 version, bytes envelope);
    event CredentialRevoked(uint256 indexed tokenId, bytes32 indexed kind, uint32 version);

    constructor(ITraderNFT nft_) {
        nft = nft_;
    }

    modifier onlyOwner(uint256 tokenId) {
        require(msg.sender == nft.ownerOf(tokenId), "Credentials: not owner");
        _;
    }

    /// @notice Publish (or replace) a sealed credential for this brain. Owner-only.
    function publish(uint256 tokenId, bytes32 kind, bytes calldata envelope) external onlyOwner(tokenId) {
        require(envelope.length > 0 && envelope.length <= MAX_ENVELOPE_BYTES, "Credentials: envelope size");
        Credential storage c = _creds[tokenId][kind];
        c.publisher = msg.sender;
        c.version += 1;
        c.publishedAt = uint64(block.timestamp);
        c.revoked = false;
        emit CredentialPublished(tokenId, kind, msg.sender, c.version, envelope);
    }

    /// @notice Retire the current credential. Owner-only; the runtime stops using it on its next pass.
    function revoke(uint256 tokenId, bytes32 kind) external onlyOwner(tokenId) {
        Credential storage c = _creds[tokenId][kind];
        require(c.version > 0 && !c.revoked, "Credentials: nothing to revoke");
        c.revoked = true;
        emit CredentialRevoked(tokenId, kind, c.version);
    }

    /// @notice The credential record and whether the runtime may use it:
    /// published, not revoked, and the publisher still owns the brain.
    function credentialOf(uint256 tokenId, bytes32 kind)
        external
        view
        returns (address publisher, uint32 version, uint64 publishedAt, bool revoked, bool usable)
    {
        Credential storage c = _creds[tokenId][kind];
        usable = c.version > 0 && !c.revoked && c.publisher == nft.ownerOf(tokenId);
        return (c.publisher, c.version, c.publishedAt, c.revoked, usable);
    }

    /// @notice True while the runtime may use the credential of this kind.
    function active(uint256 tokenId, bytes32 kind) external view returns (bool) {
        Credential storage c = _creds[tokenId][kind];
        return c.version > 0 && !c.revoked && c.publisher == nft.ownerOf(tokenId);
    }
}
