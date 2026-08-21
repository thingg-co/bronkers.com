// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";
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
        uint8 cadence; // declared max trades per day (informational trait)
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

    event TraderBorn(
        uint256 indexed tokenId, address indexed minter, bytes32 commitment, address account, address vault
    );

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
