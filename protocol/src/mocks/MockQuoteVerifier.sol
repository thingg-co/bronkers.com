// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IQuoteVerifier} from "../interfaces/ITraderNFT.sol";

/// @notice Test stand-in for a DCAP verifier: returns whatever the test set,
/// records what it was paid, and can be told to reject.
contract MockQuoteVerifier is IQuoteVerifier {
    bytes32 public measurement;
    bytes32 public reportData;
    bool public reject;
    bytes public lastQuote;
    uint256 public lastValue;

    function set(bytes32 measurement_, bytes32 reportData_) external {
        measurement = measurement_;
        reportData = reportData_;
    }

    function setReject(bool reject_) external {
        reject = reject_;
    }

    function verify(bytes calldata quote) external payable returns (bytes32, bytes32) {
        require(!reject, "MockQuoteVerifier: invalid quote");
        lastQuote = quote;
        lastValue = msg.value;
        return (measurement, reportData);
    }
}
