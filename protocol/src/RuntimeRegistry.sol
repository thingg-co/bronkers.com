// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title RuntimeRegistry
/// @notice Proof-of-Brain plumbing, honestly labelled. An executor key
/// registers the runtime it belongs to: a measurement (hash of the runtime's
/// source bundle) and the enclave public key genomes are sealed to. The
/// protocol deployer can approve measurements it has reproduced. Until a
/// hardware TEE signs the measurement this is self-reported plus reviewed,
/// not attested; the Terminal says so. When attestation arrives, `register`
/// grows a signature check and nothing else has to move.
contract RuntimeRegistry {
    struct Runtime {
        bytes32 measurement;
        bytes enclavePublicKey;
        uint64 registeredAt;
    }

    address public immutable deployer;
    mapping(address => Runtime) private _runtimes; // executor key -> runtime
    mapping(bytes32 => bool) public approvedMeasurement;

    event RuntimeRegistered(address indexed executor, bytes32 measurement, bytes enclavePublicKey);
    event MeasurementApproved(bytes32 indexed measurement, bool approved);

    constructor() {
        deployer = msg.sender;
    }

    /// @notice Called by the executor key itself; binds key -> runtime -> enclave key.
    function register(bytes32 measurement, bytes calldata enclavePublicKey) external {
        require(measurement != bytes32(0), "Registry: empty measurement");
        require(enclavePublicKey.length > 0 && enclavePublicKey.length <= 128, "Registry: key length");
        _runtimes[msg.sender] = Runtime(measurement, enclavePublicKey, uint64(block.timestamp));
        emit RuntimeRegistered(msg.sender, measurement, enclavePublicKey);
    }

    function approveMeasurement(bytes32 measurement, bool approved) external {
        require(msg.sender == deployer, "Registry: not deployer");
        approvedMeasurement[measurement] = approved;
        emit MeasurementApproved(measurement, approved);
    }

    function runtimeOf(address executor) external view returns (bytes32 measurement, bytes memory enclavePublicKey, uint64 registeredAt) {
        Runtime storage r = _runtimes[executor];
        return (r.measurement, r.enclavePublicKey, r.registeredAt);
    }

    /// @notice Registered and running an approved measurement.
    function attested(address executor) external view returns (bool) {
        Runtime storage r = _runtimes[executor];
        return r.registeredAt != 0 && approvedMeasurement[r.measurement];
    }
}
