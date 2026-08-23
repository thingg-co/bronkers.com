// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IQuoteVerifier} from "./interfaces/ITraderNFT.sol";

/// @title NitroAttestationVerifier
/// @notice IQuoteVerifier for AWS Nitro Enclaves, transitive-attestation
/// style (the Marlin Oyster model). Verifying a raw Nitro attestation
/// document on-chain (COSE Sign1 over P-384, an X.509 chain to the AWS
/// Nitro root) costs tens of millions of gas, so an approved ATTESTOR — an
/// off-chain verifier, itself an enclave whose job is checking Nitro
/// documents — verifies the document and signs a compact statement with a
/// secp256k1 key this contract knows. The trust root is therefore "the
/// deployer approved this attestor key": one link longer than DCAP through
/// Automata, honestly disclosed. The registry still records the result as
/// hardware-attested because the measurement is bound to the executor key by
/// an attestation document a verifier checked, not by the key's own claim.
///
/// The statement (the `quote` bytes handed to RuntimeRegistry.registerAttested):
///
///   abi.encode(bytes32 measurement, bytes32 reportData, uint64 issuedAt, bytes signature)
///
/// where measurement = keccak256(PCR0 ‖ PCR1 ‖ PCR2) of the enclave image as
/// the attestor read them from the document, reportData = the document's
/// user data (the enclave puts keccak256(executor ‖ enclave public key)
/// there, and the registry checks it), issuedAt = the attestor's clock, and
/// signature = the attestor's 65-byte secp256k1 signature over
/// digest(measurement, reportData, issuedAt). Statements go stale after
/// maxAge; replaying a fresh one only re-registers the same binding.
contract NitroAttestationVerifier is IQuoteVerifier {
    bytes32 public constant TAG = keccak256("BROKNERS_NITRO_ATTESTATION_V1");
    uint64 public constant MAX_SKEW = 300; // attestor clock may run this far ahead of the chain

    address public immutable deployer;
    uint64 public immutable maxAge;
    mapping(address => bool) public attestor;

    event AttestorSet(address indexed attestor, bool approved);

    constructor(uint64 maxAge_) {
        require(maxAge_ > 0, "Nitro: max age");
        deployer = msg.sender;
        maxAge = maxAge_;
    }

    function setAttestor(address key, bool approved) external {
        require(msg.sender == deployer, "Nitro: not deployer");
        attestor[key] = approved;
        emit AttestorSet(key, approved);
    }

    /// @notice What the attestor signs. Chain-bound so a statement issued for
    /// one deployment cannot be replayed onto another.
    function digest(bytes32 measurement, bytes32 reportData, uint64 issuedAt) public view returns (bytes32) {
        return keccak256(abi.encode(TAG, block.chainid, measurement, reportData, issuedAt));
    }

    function verify(bytes calldata quote) external payable returns (bytes32 measurement, bytes32 reportData) {
        require(msg.value == 0, "Nitro: no fee"); // nothing here charges; refuse value rather than strand it
        (bytes32 m, bytes32 rd, uint64 issuedAt, bytes memory sig) = abi.decode(quote, (bytes32, bytes32, uint64, bytes));
        require(m != bytes32(0), "Nitro: empty measurement");
        require(issuedAt <= block.timestamp + MAX_SKEW, "Nitro: from the future");
        require(block.timestamp <= uint256(issuedAt) + maxAge, "Nitro: stale statement");
        require(attestor[ECDSA.recover(digest(m, rd, issuedAt), sig)], "Nitro: unknown attestor");
        return (m, rd);
    }
}
