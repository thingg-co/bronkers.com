// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {TraderNFT} from "../src/TraderNFT.sol";
import {TraderVault} from "../src/TraderVault.sol";
import {ERC6551Account} from "erc6551/examples/simple/ERC6551Account.sol";

contract TraderNFTTest is BaseTest {
    function test_MintStoresGenome() public {
        uint256 id = mintTrader(200, 2_000);
        TraderNFT.Genome memory g = nft.genomeOf(id);
        assertEq(g.commitment, keccak256("genome-fixture"));
        assertEq(g.birthBlock, uint64(block.number));
        assertEq(g.riskProfile, 1);
        assertEq(g.cadence, 4);
        assertEq(g.custody, nft.CUSTODY_SEALED_AUTHORED());
        assertEq(g.model, "claude-sonnet-5");
        assertEq(g.encryptedPromptCID, "bafy-mock-cid");
        assertEq(nft.ownerOf(id), owner);
    }

    function test_EmptyCommitmentReverts() public {
        address[] memory universe = new address[](0);
        vm.expectRevert("Trader: empty commitment");
        nft.mint(bytes32(0), 0, 1, 0, "m", "cid", universe, 0, 0);
    }

    function test_InvalidCustodyReverts() public {
        address[] memory universe = new address[](0);
        vm.expectRevert("Trader: bad custody");
        nft.mint(keccak256("g"), 0, 1, 3, "m", "cid", universe, 0, 0);
    }

    function test_AccountIsDeterministicAndBoundToToken() public {
        uint256 id = mintTrader(0, 0);
        address tba = nft.accountOf(id);
        assertEq(
            tba, registry.account(address(accountImpl), nft.TBA_SALT(), block.chainid, address(nft), id)
        );
        (uint256 chainId, address tokenContract, uint256 tokenId) = ERC6551Account(payable(tba)).token();
        assertEq(chainId, block.chainid);
        assertEq(tokenContract, address(nft));
        assertEq(tokenId, id);
    }

    function test_VaultWiredAtMint() public {
        uint256 id = mintTrader(200, 2_000);
        TraderVault vault = TraderVault(nft.vaultOf(id));
        assertEq(vault.tokenId(), id);
        assertEq(vault.asset(), address(usdc));
        assertEq(vault.managementFeeBps(), 200);
        assertEq(vault.performanceFeeBps(), 2_000);
        address[] memory u = vault.universe();
        assertEq(u.length, 1);
        assertEq(u[0], address(weth));
    }

    function test_CannotTransferIntoOwnTBA() public {
        uint256 id = mintTrader(0, 0);
        address tba = nft.accountOf(id);
        vm.prank(owner);
        vm.expectRevert("Trader: cannot own itself");
        nft.transferFrom(owner, tba, id);
    }

    function test_GenomeHasNoUpdatePath() public {
        // No setter exists; this asserts the commitment survives a transfer untouched.
        uint256 id = mintTrader(0, 0);
        vm.prank(owner);
        nft.transferFrom(owner, buyer, id);
        assertEq(nft.genomeOf(id).commitment, keccak256("genome-fixture"));
    }
}
