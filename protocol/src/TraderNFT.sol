// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ITraderNFT, IVenue} from "./interfaces/ITraderNFT.sol";
import {ExecutionGuard} from "./ExecutionGuard.sol";
import {TraderVault} from "./TraderVault.sol";

/// @title TraderNFT
/// @notice Each token is an AI trader: an immutable genome commitment (the
/// hash of its secret prompt + config), public traits, a token-bound account
/// (ERC-6551) that is the trader's own wallet, and an ERC-4626 vault for
/// outside capital. Transferring the token transfers the trader — including
/// everything in its token-bound account ("sell WITH capital") unless the
/// owner sweeps it first ("sell WITHOUT capital").
contract TraderNFT is ERC721, ITraderNFT {
    /// Custody of the plaintext genome — a public trait buyers price on:
    /// 0 AUTHORED: the minter wrote and keeps the prompt; handoff on sale.
    /// 1 SEALED_AUTHORED: the minter wrote the prompt but it was sealed to the
    ///   enclave key at mint — no future owner ever sees it (author still knows it).
    /// 2 SEALED_GENERATED: the prompt was generated inside the enclave from a
    ///   brief and sealed immediately — NO ONE has ever seen the plaintext.
    uint8 public constant CUSTODY_AUTHORED = 0;
    uint8 public constant CUSTODY_SEALED_AUTHORED = 1;
    uint8 public constant CUSTODY_SEALED_GENERATED = 2;

    struct Genome {
        bytes32 commitment; // keccak256 of canonical genome JSON — never changes
        uint64 birthBlock;
        uint8 riskProfile; // 0 conservative / 1 balanced / 2 aggressive
        uint8 cadence; // declared max trades per day (>= 1; the guard enforces it as a minimum interval)
        uint8 custody; // see CUSTODY_* constants
        string model; // pinned model identifier
        string encryptedPromptCID; // pointer to the encrypted genome blob
    }

    IERC6551Registry public immutable registry;
    address public immutable accountImplementation;
    ExecutionGuard public immutable guard;
    IERC20 public immutable baseAsset;
    IVenue public immutable defaultVenue;
    bytes32 public constant TBA_SALT = bytes32(0);

    /// One brain per bit: the collection is hard-capped at 2^12.
    uint256 public constant MAX_SUPPLY = 4096;

    uint256 public nextId;
    mapping(uint256 => Genome) private _genomes;
    mapping(uint256 => address) private _vaults;
    mapping(uint256 => string) private _names;

    /// A name is cosmetic and public; it is set once by the owner and then
    /// frozen, so a track record cannot be laundered by renaming.
    uint256 public constant MAX_NAME_BYTES = 32;

    event TraderBorn(
        uint256 indexed tokenId, address indexed minter, bytes32 commitment, address account, address vault
    );
    event Christened(uint256 indexed tokenId, string name);
    /// The sealed genome envelope, published as calldata so the enclave can
    /// find it by scanning logs. It is ciphertext only the enclave key opens;
    /// the plaintext still never touches the chain.
    event EnvelopePublished(uint256 indexed tokenId, bytes envelope);

    uint256 public constant MAX_ENVELOPE_BYTES = 16 * 1024;

    constructor(
        IERC6551Registry registry_,
        address accountImplementation_,
        ExecutionGuard guard_,
        IERC20 baseAsset_,
        IVenue defaultVenue_
    ) ERC721("Brokners", "BRKNR") {
        registry = registry_;
        accountImplementation = accountImplementation_;
        guard = guard_;
        baseAsset = baseAsset_;
        defaultVenue = defaultVenue_;
    }

    /// @notice Mint a trader. The plaintext genome never touches the chain:
    /// only its hash (provenance) and an encrypted-blob pointer are stored.
    function mint(
        bytes32 commitment,
        uint8 riskProfile,
        uint8 cadence,
        uint8 custody,
        string calldata model,
        string calldata encryptedPromptCID,
        address[] calldata universe,
        uint16 managementFeeBps,
        uint16 performanceFeeBps
    ) external returns (uint256 tokenId) {
        require(commitment != bytes32(0), "Trader: empty commitment");
        require(custody <= CUSTODY_SEALED_GENERATED, "Trader: bad custody");
        require(cadence > 0, "Trader: cadence"); // the guard divides a day by it
        require(nextId < MAX_SUPPLY, "Trader: sold out");
        tokenId = ++nextId;
        _safeMint(msg.sender, tokenId);

        _genomes[tokenId] = Genome({
            commitment: commitment,
            birthBlock: uint64(block.number),
            riskProfile: riskProfile,
            cadence: cadence,
            custody: custody,
            model: model,
            encryptedPromptCID: encryptedPromptCID
        });

        address account =
            registry.createAccount(accountImplementation, TBA_SALT, block.chainid, address(this), tokenId);

        TraderVault vault = new TraderVault(
            baseAsset, this, tokenId, address(guard), defaultVenue, universe, managementFeeBps, performanceFeeBps
        );
        _vaults[tokenId] = address(vault);

        guard.initPolicy(tokenId, address(defaultVenue), universe);

        emit TraderBorn(tokenId, msg.sender, commitment, account, address(vault));
    }

    function genomeOf(uint256 tokenId) external view returns (Genome memory) {
        _requireOwned(tokenId);
        return _genomes[tokenId];
    }

    function ownerOf(uint256 tokenId) public view override(ERC721, ITraderNFT) returns (address) {
        return super.ownerOf(tokenId);
    }

    function accountOf(uint256 tokenId) public view returns (address) {
        return registry.account(accountImplementation, TBA_SALT, block.chainid, address(this), tokenId);
    }

    function vaultOf(uint256 tokenId) external view returns (address) {
        return _vaults[tokenId];
    }

    /// @notice The declared cadence trait (max trades per day). The guard
    /// reads it on every trade and turns it into a minimum interval.
    function cadenceOf(uint256 tokenId) external view returns (uint8) {
        return _genomes[tokenId].cadence;
    }

    /// @notice Give a brain its name. Owner-only, once, at most 32 bytes.
    function christen(uint256 tokenId, string calldata name) external {
        require(msg.sender == ownerOf(tokenId), "Trader: not owner");
        require(bytes(_names[tokenId]).length == 0, "Trader: already named");
        require(bytes(name).length > 0 && bytes(name).length <= MAX_NAME_BYTES, "Trader: name length");
        _names[tokenId] = name;
        emit Christened(tokenId, name);
    }

    /// @notice The brain's name, or "" if it has none yet.
    function nameOf(uint256 tokenId) external view returns (string memory) {
        return _names[tokenId];
    }

    /// @notice On-chain metadata: name, public traits, and a brain in a jar,
    /// so any marketplace renders the token without a server of ours.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Genome memory g = _genomes[tokenId];
        string memory name_ = bytes(_names[tokenId]).length > 0 ? _names[tokenId] : string.concat("Brain #", Strings.toString(tokenId));
        string[3] memory custody = ["authored", "sealed", "sealed-generated"];
        string[3] memory risk = ["conservative", "balanced", "aggressive"];
        string[3] memory tiers = ["Intern", "Associate", "Partner"];
        uint8 tier = guard.tierOf(tokenId);
        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
            '<rect width="64" height="64" fill="#fff0f6"/>',
            '<rect x="15" y="3" width="34" height="10" rx="3" fill="#343a40"/>',
            '<rect x="11" y="12" width="42" height="49" rx="10" fill="#a5d8ff" fill-opacity=".38" stroke="#74c0fc" stroke-width="3"/>',
            '<ellipse cx="25.5" cy="38" rx="11" ry="13" fill="#f06595"/><ellipse cx="38.5" cy="38" rx="11" ry="13" fill="#f06595"/>',
            '<ellipse cx="32" cy="36" rx="9" ry="11" fill="#f06595"/><path d="M32 26V50" stroke="#c2255c" stroke-width="2.2" stroke-linecap="round"/>',
            '<text x="32" y="58" font-family="monospace" font-size="5" text-anchor="middle" fill="#343a40">#', Strings.toString(tokenId), "</text></svg>"
        );
        string memory json = string.concat(
            '{"name":"', name_, '","description":"A Brokner: a sealed AI trading brain with an immutable on-chain track record. One brain per bit.",',
            '"image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)), '",',
            '"attributes":[{"trait_type":"Custody","value":"', custody[g.custody], '"},',
            '{"trait_type":"Risk","value":"', risk[g.riskProfile < 3 ? g.riskProfile : 1], '"},',
            '{"trait_type":"Seat","value":"', tiers[tier < 3 ? tier : 0], '"},',
            '{"trait_type":"Cadence (per day)","value":', Strings.toString(g.cadence), '},',
            '{"trait_type":"Model","value":"', g.model, '"},',
            '{"trait_type":"Birth block","value":', Strings.toString(g.birthBlock), '}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @notice Publish the sealed envelope so an enclave can run the brain
    /// without anyone handing it a file. Owner-only; sealed custody only (an
    /// authored envelope opens with the owner's key, so publishing it would
    /// be pointless). May be re-published, e.g. re-sealed to a new enclave
    /// key: the latest event wins, and the commitment the enclave verifies
    /// against never changes.
    function publishEnvelope(uint256 tokenId, bytes calldata envelope) external {
        require(msg.sender == ownerOf(tokenId), "Trader: not owner");
        require(_genomes[tokenId].custody != CUSTODY_AUTHORED, "Trader: not sealed");
        require(envelope.length > 0 && envelope.length <= MAX_ENVELOPE_BYTES, "Trader: envelope size");
        emit EnvelopePublished(tokenId, envelope);
    }

    /// @dev On every real transfer: crystallize accrued vault fees under the
    /// seller's watch, and block the ownership cycle where the token would be
    /// sent into its own token-bound account (which would brick it).
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        address vault = _vaults[tokenId];
        if (vault != address(0)) {
            require(to != accountOf(tokenId), "Trader: cannot own itself");
            TraderVault(vault).checkpoint();
        }
        return super._update(to, tokenId, auth);
    }
}
