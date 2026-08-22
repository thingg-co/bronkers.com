// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IAutomataDcapAttestation} from "../AutomataDcapTdxVerifier.sol";

/// @notice Test stand-in for Automata's attestation entrypoint: returns a
/// canned (success, output) so the adapter's parsing can be checked against
/// a synthetic serialized Output.
contract MockDcapAttestation is IAutomataDcapAttestation {
    bool public success;
    bytes public output;
    uint256 public lastValue;

    function set(bool success_, bytes calldata output_) external {
        success = success_;
        output = output_;
    }

    function verifyAndAttestOnChain(bytes calldata) external payable returns (bool, bytes memory) {
        lastValue = msg.value;
        return (success, output);
    }
}
