// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IQuoteVerifier} from "./interfaces/ITraderNFT.sol";

/// @title QuoteVerifierRouter
/// @notice One RuntimeRegistry verifier slot, several quote formats. Tries
/// each verifier in order and returns the first accepted result, so a chain
/// can take Intel TDX quotes (AutomataDcapTdxVerifier) and Nitro attestor
/// statements (NitroAttestationVerifier) through the same registry — a
/// harvester registers with whichever evidence its machine produces. A
/// failed attempt reverts wholly, forwarded value included, before the next
/// verifier is tried; send value only when the verifier that will accept the
/// quote charges one (Automata does, the Nitro verifier refuses value).
contract QuoteVerifierRouter is IQuoteVerifier {
    address public immutable deployer;
    IQuoteVerifier[] private _verifiers;

    event VerifiersSet(uint256 count);

    constructor(IQuoteVerifier[] memory verifiers_) {
        deployer = msg.sender;
        _verifiers = verifiers_;
        emit VerifiersSet(verifiers_.length);
    }

    function setVerifiers(IQuoteVerifier[] calldata verifiers_) external {
        require(msg.sender == deployer, "Router: not deployer");
        delete _verifiers;
        for (uint256 i = 0; i < verifiers_.length; i++) _verifiers.push(verifiers_[i]);
        emit VerifiersSet(verifiers_.length);
    }

    function verifiers() external view returns (IQuoteVerifier[] memory) {
        return _verifiers;
    }

    function verify(bytes calldata quote) external payable returns (bytes32 measurement, bytes32 reportData) {
        uint256 n = _verifiers.length;
        for (uint256 i = 0; i < n; i++) {
            try _verifiers[i].verify{value: msg.value}(quote) returns (bytes32 m, bytes32 rd) {
                return (m, rd);
            } catch {}
        }
        revert("Router: no verifier accepted");
    }
}
