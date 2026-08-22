// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice What TraderNFT.tokenURI hands the renderer: the token's public
/// face. Kept out of TraderNFT so the collection contract stays under the
/// code-size limit (it also embeds the vault it deploys per mint).
struct Card {
    uint256 tokenId;
    string name;
    uint8 custody;
    uint8 risk;
    uint8 cadence;
    string model;
    uint64 birthBlock;
    uint8 tier;
    uint32 generation;
}

interface IJarRenderer {
    function tokenURI(Card calldata card) external pure returns (string memory);
}

/// @title JarRenderer
/// @notice On-chain metadata for a Brokner: name, public traits, and a brain
/// in a jar, so any marketplace renders the token without a server of ours.
/// Sealed jars are corked; authored jars have a plain lid.
contract JarRenderer is IJarRenderer {
    function tokenURI(Card calldata c) external pure returns (string memory) {
        string memory name_ = bytes(c.name).length > 0 ? c.name : string.concat("Brain #", Strings.toString(c.tokenId));
        string[3] memory custody = ["authored", "sealed", "sealed-generated"];
        string[3] memory risk = ["conservative", "balanced", "aggressive"];
        string[3] memory tiers = ["Intern", "Associate", "Partner"];
        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
            '<rect width="64" height="64" fill="#fff0f6"/>',
            c.custody == 0
                ? '<rect x="15" y="3" width="34" height="10" rx="3" fill="#343a40"/>'
                : '<rect x="14" y="2" width="36" height="11" rx="2.5" fill="#c69a6d"/><rect x="14" y="2" width="36" height="3" rx="2.5" fill="#e2c29a"/><path d="M20 3v9M26 3v9M32 3v9M38 3v9M44 3v9" stroke="#8b5a2b" stroke-width="1" opacity=".5"/><rect x="14" y="11" width="36" height="2" fill="#8b5a2b" opacity=".55"/>',
            '<rect x="11" y="12" width="42" height="49" rx="10" fill="#a5d8ff" fill-opacity=".38" stroke="#74c0fc" stroke-width="3"/>',
            '<ellipse cx="25.5" cy="38" rx="11" ry="13" fill="#f06595"/><ellipse cx="38.5" cy="38" rx="11" ry="13" fill="#f06595"/>',
            '<ellipse cx="32" cy="36" rx="9" ry="11" fill="#f06595"/><path d="M32 26V50" stroke="#c2255c" stroke-width="2.2" stroke-linecap="round"/>',
            '<text x="32" y="58" font-family="monospace" font-size="5" text-anchor="middle" fill="#343a40">#', Strings.toString(c.tokenId), "</text></svg>"
        );
        string memory json = string.concat(
            '{"name":"', name_, '","description":"A Brokner: a sealed AI trading brain with an immutable on-chain track record. One brain per bit.",',
            '"image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)), '",',
            '"attributes":[{"trait_type":"Custody","value":"', custody[c.custody < 3 ? c.custody : 0], '"},',
            '{"trait_type":"Risk","value":"', risk[c.risk < 3 ? c.risk : 1], '"},',
            '{"trait_type":"Seat","value":"', tiers[c.tier < 3 ? c.tier : 0], '"},',
            '{"trait_type":"Cadence (per day)","value":', Strings.toString(c.cadence), '},',
            '{"trait_type":"Model","value":"', c.model, '"},',
            '{"trait_type":"Generation","value":', Strings.toString(c.generation), '},',
            '{"trait_type":"Birth block","value":', Strings.toString(c.birthBlock), '}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }
}
