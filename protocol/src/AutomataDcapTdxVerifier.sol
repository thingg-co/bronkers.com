// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IQuoteVerifier} from "./interfaces/ITraderNFT.sol";

/// @notice Automata's DCAP attestation entrypoint (v1.1), deployed at the
/// same address on Polygon, Polygon Amoy, Arbitrum One and Base:
/// 0xaDdeC7e85c2182202b66E331f2a4A0bBB2cEEa1F. Payable: it charges a
/// gas-proportional fee in the native token and refunds the excess.
interface IAutomataDcapAttestation {
    function verifyAndAttestOnChain(bytes calldata rawQuote) external payable returns (bool success, bytes memory output);
}

/// @title AutomataDcapTdxVerifier
/// @notice IQuoteVerifier over Automata DCAP for Intel TDX quotes. Verifies
/// the quote on-chain, then reads the TD report body out of the verifier's
/// serialized Output:
///
///   Output = quoteVersion(2) ‖ quoteBodyType(2) ‖ tcbStatus(1) ‖ fmspc(6) ‖ quoteBody ‖ [advisoryIDs]
///   quoteBody (TD 1.0, 584 bytes) = teeTcbSvn(16) mrSeam(48) mrsignerSeam(48)
///     seamAttributes(8) tdAttributes(8) xFAM(8) mrTd(48) mrConfigId(48)
///     mrOwner(48) mrOwnerConfig(48) rtMr0..3(4×48) reportData(64)
///
/// The runtime measurement is keccak256(mrTd ‖ rtMr0 ‖ rtMr1 ‖ rtMr2 ‖ rtMr3):
/// firmware plus the measured boot chain, which is what a confidential-VM
/// image id pins. The report data's first 32 bytes are returned for the
/// registry to check against keccak256(executor ‖ enclave key); the enclave
/// puts that hash there when it requests the quote. Layout per Automata's
/// CommonStruct/TDXStruct (v1.1); confirm against a live Amoy quote before
/// approving a measurement obtained through this adapter.
contract AutomataDcapTdxVerifier is IQuoteVerifier {
    IAutomataDcapAttestation public immutable dcap;
    /// Highest TCB status accepted (Automata enum: 0 UpToDate, 1 SWHardeningNeeded,
    /// 2 ConfigurationAndSWHardeningNeeded, 3 OutOfDate, ... 5 Revoked).
    uint8 public immutable maxTcbStatus;

    uint256 private constant HEADER = 11;
    uint256 private constant TD10_BODY = 584;
    uint256 private constant MRTD_OFFSET = 136;
    uint256 private constant RTMR_OFFSET = 328; // rtMr0..3, 192 bytes
    uint256 private constant REPORT_DATA_OFFSET = 520;
    uint16 private constant BODY_TD10 = 2;
    uint16 private constant BODY_TD15 = 3;

    constructor(IAutomataDcapAttestation dcap_, uint8 maxTcbStatus_) {
        dcap = dcap_;
        maxTcbStatus = maxTcbStatus_;
    }

    function verify(bytes calldata quote) external payable returns (bytes32 measurement, bytes32 reportData) {
        (bool ok, bytes memory out) = dcap.verifyAndAttestOnChain{value: msg.value}(quote);
        require(ok, "Dcap: quote rejected");
        require(out.length >= HEADER + TD10_BODY, "Dcap: short output");
        uint16 bodyType = (uint16(uint8(out[2])) << 8) | uint16(uint8(out[3]));
        require(bodyType == BODY_TD10 || bodyType == BODY_TD15, "Dcap: not a TD report");
        require(uint8(out[4]) <= maxTcbStatus, "Dcap: TCB status");
        bytes memory mrTd = _slice(out, HEADER + MRTD_OFFSET, 48);
        bytes memory rtMrs = _slice(out, HEADER + RTMR_OFFSET, 192);
        measurement = keccak256(abi.encodePacked(mrTd, rtMrs));
        reportData = bytes32(_slice(out, HEADER + REPORT_DATA_OFFSET, 32));
    }

    function _slice(bytes memory b, uint256 start, uint256 len) private pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i = 0; i < len; i++) out[i] = b[start + i];
    }
}
