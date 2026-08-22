// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IQuoteVerifier} from "./interfaces/ITraderNFT.sol";

/// @title RuntimeRegistry
/// @notice Proof-of-Brain plumbing, honestly labelled. An executor key
/// registers the runtime it belongs to: a measurement (hash of the runtime
/// image) and the enclave public key genomes are sealed to. The protocol
/// deployer approves measurements it has reproduced; `attested()` means
/// "registered and running an approved measurement".
///
/// Two ways in. `register` is self-reported: the key says what it runs and a
/// reviewer approves it. `registerAttested` is hardware-attested: the key
/// presents a TEE quote, the chain's DCAP verifier (behind IQuoteVerifier)
/// checks it, and the quote's report data must commit to this executor key
/// and enclave key, so the measurement is bound to the key by the hardware
/// rather than by a claim. `attestationOf` says which path a runtime took;
/// the Terminal labels the difference.
contract RuntimeRegistry {
    struct Runtime {
        bytes32 measurement;
        bytes enclavePublicKey;
        uint64 registeredAt;
        uint8 attestation; // ATTESTATION_*
    }

    uint8 public constant ATTESTATION_NONE = 0;
    uint8 public constant ATTESTATION_SELF_REPORTED = 1;
    uint8 public constant ATTESTATION_HARDWARE = 2;

    address public immutable deployer;
    IQuoteVerifier public verifier; // zero until a verifier exists on this chain
    mapping(address => Runtime) private _runtimes; // executor key -> runtime
    mapping(bytes32 => bool) public approvedMeasurement;

    event RuntimeRegistered(address indexed executor, bytes32 measurement, bytes enclavePublicKey);
    event RuntimeAttested(address indexed executor, bytes32 measurement);
    event MeasurementApproved(bytes32 indexed measurement, bool approved);
    event VerifierSet(address verifier);

    constructor() {
        deployer = msg.sender;
    }

    modifier onlyDeployer() {
        require(msg.sender == deployer, "Registry: not deployer");
        _;
    }

    /// @notice Self-reported: called by the executor key itself; binds key -> runtime -> enclave key.
    function register(bytes32 measurement, bytes calldata enclavePublicKey) external {
        require(measurement != bytes32(0), "Registry: empty measurement");
        require(enclavePublicKey.length > 0 && enclavePublicKey.length <= 128, "Registry: key length");
        _runtimes[msg.sender] = Runtime(measurement, enclavePublicKey, uint64(block.timestamp), ATTESTATION_SELF_REPORTED);
        emit RuntimeRegistered(msg.sender, measurement, enclavePublicKey);
    }

    /// @notice Hardware-attested: the executor key presents a TEE quote whose
    /// report data is keccak256(executor key ‖ enclave public key). The
    /// verifier checks the quote and extracts the measurement; this contract
    /// checks the binding. Any native value is forwarded to the verifier
    /// (Automata's charges a gas-proportional fee and refunds the excess).
    function registerAttested(bytes calldata quote, bytes calldata enclavePublicKey) external payable {
        require(address(verifier) != address(0), "Registry: no verifier");
        require(enclavePublicKey.length > 0 && enclavePublicKey.length <= 128, "Registry: key length");
        (bytes32 measurement, bytes32 reportData) = verifier.verify{value: msg.value}(quote);
        require(measurement != bytes32(0), "Registry: empty measurement");
        require(reportData == keccak256(abi.encodePacked(msg.sender, enclavePublicKey)), "Registry: report data");
        _runtimes[msg.sender] = Runtime(measurement, enclavePublicKey, uint64(block.timestamp), ATTESTATION_HARDWARE);
        emit RuntimeRegistered(msg.sender, measurement, enclavePublicKey);
        emit RuntimeAttested(msg.sender, measurement);
    }

    function setVerifier(IQuoteVerifier verifier_) external onlyDeployer {
        verifier = verifier_;
        emit VerifierSet(address(verifier_));
    }

    function approveMeasurement(bytes32 measurement, bool approved) external onlyDeployer {
        approvedMeasurement[measurement] = approved;
        emit MeasurementApproved(measurement, approved);
    }

    function runtimeOf(address executor) external view returns (bytes32 measurement, bytes memory enclavePublicKey, uint64 registeredAt) {
        Runtime storage r = _runtimes[executor];
        return (r.measurement, r.enclavePublicKey, r.registeredAt);
    }

    /// @notice How the runtime got here: 0 not registered, 1 self-reported, 2 hardware-attested.
    function attestationOf(address executor) external view returns (uint8) {
        return _runtimes[executor].attestation;
    }

    /// @notice Registered and running an approved measurement (either path).
    function attested(address executor) public view returns (bool) {
        Runtime storage r = _runtimes[executor];
        return r.registeredAt != 0 && approvedMeasurement[r.measurement];
    }

    /// @notice Approved measurement, bound to the key by a verified TEE quote.
    function hardwareAttested(address executor) external view returns (bool) {
        return attested(executor) && _runtimes[executor].attestation == ATTESTATION_HARDWARE;
    }
}
