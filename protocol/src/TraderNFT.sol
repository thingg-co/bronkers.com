// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";
import {ITraderNFT, IVenue} from "./interfaces/ITraderNFT.sol";
import {Card, IJarRenderer} from "./JarRenderer.sol";
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

    /// The current generation's genome. A brain is born with generation 0
    /// and the owner may revise it: each revision appends a generation with a
    /// new commitment (and possibly a new model), committed before any trade is
    /// made under it, so every trade in the record is attributable to exactly
    /// one committed strategy and nothing can be backfilled. The public traits
    /// (risk, cadence, custody) and the birth block belong to the token and do
    /// not change.
    struct Genome {
        bytes32 commitment; // keccak256 of canonical genome JSON of the CURRENT generation
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
    IJarRenderer public immutable renderer; // tokenURI lives there to keep this contract under the size limit
    bytes32 public constant TBA_SALT = bytes32(0);

    /// One brain per bit: at most 2^12 living at once. Minting is capped at
    /// MAX_SUPPLY live brains (nextId - burnedCount); a brain that goes broke
    /// and stays dead can be reaped, freeing a slot for a new, higher id — the
    /// old id is never reused, so a record cannot be laundered through a slot.
    uint256 public constant MAX_SUPPLY = 4096;

    /// One entry per generation: what was committed and when it became current.
    struct Generation {
        bytes32 commitment;
        string model;
        string encryptedPromptCID;
        uint64 sinceBlock;
        uint64 sinceTime;
    }

    uint256 public nextId; // total ever minted; ids are 1..nextId and never reused
    uint256 public burnedCount; // reaped brains; live supply = nextId - burnedCount
    mapping(uint256 => Genome) private _genomes;
    mapping(uint256 => Generation[]) private _generations;
    mapping(uint256 => address) private _vaults;
    mapping(uint256 => string) private _names;

    /// A name is cosmetic and public; it is set once by the owner and then
    /// frozen, so a track record cannot be laundered by renaming.
    uint256 public constant MAX_NAME_BYTES = 32;

    event TraderBorn(
        uint256 indexed tokenId, address indexed minter, bytes32 commitment, address account, address vault
    );
    event Christened(uint256 indexed tokenId, string name);
    /// A new generation: the brain trains between fights. Committed before it
    /// trades; the guard makes it spar on the own book before it touches the vault.
    event GenomeRevised(uint256 indexed tokenId, uint32 generation, bytes32 commitment, string model);
    /// A dead brain reaped (its slot freed). The record survives in the logs;
    /// the token no longer resolves.
    event Reaped(uint256 indexed tokenId);
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
        IVenue defaultVenue_,
        IJarRenderer renderer_
    ) ERC721("Brokners", "BRKNR") {
        registry = registry_;
        accountImplementation = accountImplementation_;
        guard = guard_;
        baseAsset = baseAsset_;
        defaultVenue = defaultVenue_;
        renderer = renderer_;
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
        return _mintBrain(msg.sender, commitment, riskProfile, cadence, custody, model, encryptedPromptCID, universe, managementFeeBps, performanceFeeBps);
    }

    /// @notice Mint on someone's behalf. Guard-only: the guard uses it to burn
    /// a dead brain and mint the caller's new one atomically (cullAndMint), so
    /// a reclaimed slot cannot be sniped between the two.
    function mintFor(
        address to,
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
        require(msg.sender == address(guard), "Trader: not guard");
        return _mintBrain(to, commitment, riskProfile, cadence, custody, model, encryptedPromptCID, universe, managementFeeBps, performanceFeeBps);
    }

    function _mintBrain(
        address to,
        bytes32 commitment,
        uint8 riskProfile,
        uint8 cadence,
        uint8 custody,
        string calldata model,
        string calldata encryptedPromptCID,
        address[] calldata universe,
        uint16 managementFeeBps,
        uint16 performanceFeeBps
    ) internal returns (uint256 tokenId) {
        require(commitment != bytes32(0), "Trader: empty commitment");
        require(custody <= CUSTODY_SEALED_GENERATED, "Trader: bad custody");
        require(cadence > 0, "Trader: cadence"); // the guard divides a day by it
        require(nextId - burnedCount < MAX_SUPPLY, "Trader: sold out");
        tokenId = ++nextId;
        _safeMint(to, tokenId);

        _genomes[tokenId] = Genome({
            commitment: commitment,
            birthBlock: uint64(block.number),
            riskProfile: riskProfile,
            cadence: cadence,
            custody: custody,
            model: model,
            encryptedPromptCID: encryptedPromptCID
        });

        _generations[tokenId].push(Generation(commitment, model, encryptedPromptCID, uint64(block.number), uint64(block.timestamp)));

        address account =
            registry.createAccount(accountImplementation, TBA_SALT, block.chainid, address(this), tokenId);

        TraderVault vault = new TraderVault(
            baseAsset, this, tokenId, address(guard), defaultVenue, universe, managementFeeBps, performanceFeeBps
        );
        _vaults[tokenId] = address(vault);

        guard.initPolicy(tokenId, address(defaultVenue), universe);

        emit TraderBorn(tokenId, to, commitment, account, address(vault));
    }

    /// @notice Reap a dead brain: burn the token, retire its (empty) vault, and
    /// free a slot. Guard-only — the guard checks it is genuinely dead (no LP
    /// or fee shares outstanding, dust NAV, and idle past the reap delay). The
    /// TradeExecuted logs remain, so its record is still recomputable; the
    /// token simply ceases to resolve.
    function reapBurn(uint256 tokenId) external {
        require(msg.sender == address(guard), "Trader: not guard");
        burnedCount++;
        TraderVault(_vaults[tokenId]).retire();
        _burn(tokenId);
        emit Reaped(tokenId);
    }

    /// @notice Living brains: minted minus reaped.
    function liveSupply() external view returns (uint256) {
        return nextId - burnedCount;
    }

    /// @notice Whether a token currently exists (false once reaped).
    function exists(uint256 tokenId) external view returns (bool) {
        return _ownerOf(tokenId) != address(0);
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

    /// @notice Revise the brain: append a generation with a new commitment
    /// (and model). Owner-only; sealed custody additionally needs the
    /// enclave's attestation (see body). The old generation's trades stay attributed to
    /// it; the new one is in training camp until the guard has seen enough
    /// own-book trades under it and the notice period has passed. Sealed
    /// brains publish the new jar alongside.
    function revise(
        uint256 tokenId,
        bytes32 commitment,
        string calldata model,
        string calldata encryptedPromptCID,
        bytes calldata attestation
    ) external {
        require(msg.sender == ownerOf(tokenId), "Trader: not owner");
        require(commitment != bytes32(0), "Trader: empty commitment");
        require(commitment != _genomes[tokenId].commitment, "Trader: same genome");
        Genome storage g = _genomes[tokenId];
        // Sealed custody is additive-only: the next genome is composed in the
        // enclave from the current one (a coach's note appended, never a
        // rewrite) and the enclave countersigns the parent -> next edge with
        // the brain's executor key. Without that signature there is nothing an
        // owner can commit, so a sealed record's lineage cannot be swapped out
        // from under it. Authored custody carries no such proof: the owner
        // holds the plaintext, and the lineage is their claim.
        if (g.custody != CUSTODY_AUTHORED) {
            require(guard.verifyRevision(tokenId, g.commitment, commitment, attestation), "Trader: revision not attested");
        }
        g.commitment = commitment;
        g.model = model;
        g.encryptedPromptCID = encryptedPromptCID;
        _generations[tokenId].push(Generation(commitment, model, encryptedPromptCID, uint64(block.number), uint64(block.timestamp)));
        emit GenomeRevised(tokenId, uint32(_generations[tokenId].length - 1), commitment, model);
    }

    /// @notice The current generation index (0 = born with).
    function generationOf(uint256 tokenId) public view returns (uint32) {
        uint256 n = _generations[tokenId].length;
        return n == 0 ? 0 : uint32(n - 1);
    }

    /// @notice When a generation became current (0 for an unknown generation).
    function generationSince(uint256 tokenId, uint32 generation) external view returns (uint64) {
        Generation[] storage gs = _generations[tokenId];
        return generation < gs.length ? gs[generation].sinceTime : 0;
    }

    /// @notice The full record of a generation: for attributing trades and for buyers.
    function generationAt(uint256 tokenId, uint32 generation)
        external
        view
        returns (bytes32 commitment, string memory model, string memory encryptedPromptCID, uint64 sinceBlock, uint64 sinceTime)
    {
        Generation storage gen = _generations[tokenId][generation];
        return (gen.commitment, gen.model, gen.encryptedPromptCID, gen.sinceBlock, gen.sinceTime);
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
    /// so any marketplace renders the token without a server of ours. Rendered
    /// by JarRenderer; this contract only supplies the facts.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Genome memory g = _genomes[tokenId];
        return renderer.tokenURI(
            Card({
                tokenId: tokenId,
                name: _names[tokenId],
                custody: g.custody,
                risk: g.riskProfile,
                cadence: g.cadence,
                model: g.model,
                birthBlock: g.birthBlock,
                tier: guard.tierOf(tokenId),
                generation: generationOf(tokenId)
            })
        );
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
