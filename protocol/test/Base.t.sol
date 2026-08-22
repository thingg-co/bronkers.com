// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC6551Registry} from "erc6551/ERC6551Registry.sol";
import {ERC6551Account} from "erc6551/examples/simple/ERC6551Account.sol";
import {TraderNFT} from "../src/TraderNFT.sol";
import {JarRenderer} from "../src/JarRenderer.sol";
import {TraderVault} from "../src/TraderVault.sol";
import {ExecutionGuard} from "../src/ExecutionGuard.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";
import {IVenue} from "../src/interfaces/ITraderNFT.sol";

abstract contract BaseTest is Test {
    MockERC20 usdc;
    MockERC20 weth;
    MockSwapRouter router;
    ERC6551Registry registry;
    ERC6551Account accountImpl;
    ExecutionGuard guard;
    TraderNFT nft;

    address owner = makeAddr("owner");
    address executor = makeAddr("executor");
    address lp = makeAddr("lp");
    address buyer = makeAddr("buyer");
    address stranger = makeAddr("stranger");

    uint256 constant WETH_PRICE = 2_000e18; // usdc per weth

    function setUp() public virtual {
        usdc = new MockERC20("Mock USDC", "mUSDC");
        weth = new MockERC20("Mock WETH", "mWETH");
        router = new MockSwapRouter();
        router.setPrice(address(weth), address(usdc), WETH_PRICE);
        router.setPrice(address(usdc), address(weth), 1e36 / WETH_PRICE);

        registry = new ERC6551Registry();
        accountImpl = new ERC6551Account();
        (uint64 seasonDuration, uint32 seasonMinTrades) = seasonParams();
        guard = new ExecutionGuard(seasonDuration, seasonMinTrades);
        nft = new TraderNFT(
            IERC6551Registry(address(registry)),
            address(accountImpl),
            guard,
            IERC20(address(usdc)),
            IVenue(address(router)),
            new JarRenderer()
        );
        guard.setNFT(address(nft), address(usdc));
        guard.setCuratedVenue(address(router), true);
        guard.setCuratedToken(address(usdc), true);
        guard.setCuratedToken(address(weth), true);
    }

    /// Paper-season config; most suites disable it, Integrity.t.sol overrides.
    function seasonParams() internal pure virtual returns (uint64 duration, uint32 minTrades) {
        return (0, 0);
    }

    function mintTrader(uint16 mgmtBps, uint16 perfBps) internal returns (uint256 tokenId) {
        address[] memory universe = new address[](1);
        universe[0] = address(weth);
        vm.prank(owner);
        tokenId = nft.mint(
            keccak256("genome-fixture"), 1, 4, 1, "claude-sonnet-5", "bafy-mock-cid", universe, mgmtBps, perfBps
        );
        vm.prank(owner);
        guard.setExecutor(tokenId, executor);
    }

    function lpDeposit(uint256 tokenId, uint256 amount) internal {
        TraderVault vault = TraderVault(nft.vaultOf(tokenId));
        vm.prank(owner);
        vault.setDepositAllowed(lp, true);
        usdc.mint(lp, amount);
        vm.startPrank(lp);
        usdc.approve(address(vault), amount);
        vault.deposit(amount, lp);
        vm.stopPrank();
    }

    function execTrade(uint256 tokenId, address tokenIn, address tokenOut, uint256 amountIn)
        internal
        returns (uint256)
    {
        uint256 quoted = router.quote(tokenIn, tokenOut, amountIn);
        vm.prank(executor);
        return guard.executeTrade(tokenId, address(router), tokenIn, tokenOut, amountIn, quoted, true);
    }
}
