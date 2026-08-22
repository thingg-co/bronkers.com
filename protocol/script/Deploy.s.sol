// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ERC6551Registry} from "erc6551/ERC6551Registry.sol";
import {ERC6551Account} from "erc6551/examples/simple/ERC6551Account.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TraderNFT} from "../src/TraderNFT.sol";
import {ExecutionGuard} from "../src/ExecutionGuard.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";
import {RuntimeRegistry} from "../src/RuntimeRegistry.sol";
import {IVenue} from "../src/interfaces/ITraderNFT.sol";

/// Local/testnet deployment. On Base Sepolia the canonical 6551 registry
/// (0x000000006551c19487814612e58FE06813775758) should replace the local one.
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();

        MockERC20 usdc = new MockERC20("Mock USDC", "mUSDC");
        MockERC20 weth = new MockERC20("Mock WETH", "mWETH");
        MockERC20 wbtc = new MockERC20("Mock WBTC", "mWBTC");
        MockSwapRouter router = new MockSwapRouter();
        router.setPrice(address(weth), address(usdc), 2_000e18);
        router.setPrice(address(usdc), address(weth), 1e36 / 2_000e18);
        router.setPrice(address(wbtc), address(usdc), 60_000e18);
        router.setPrice(address(usdc), address(wbtc), uint256(1e36) / 60_000e18);

        // On public testnets the canonical 6551 registry already exists:
        // ERC6551_REGISTRY=0x000000006551c19487814612e58FE06813775758 forge script …
        address registryAddr = vm.envOr("ERC6551_REGISTRY", address(0));
        if (registryAddr == address(0)) registryAddr = address(new ERC6551Registry());
        ERC6551Registry registry = ERC6551Registry(registryAddr);
        ERC6551Account accountImpl = new ERC6551Account();
        RuntimeRegistry runtimeRegistry = new RuntimeRegistry();
        // demo paper season: one own-book trade required before outside deposits
        ExecutionGuard guard = new ExecutionGuard(0, 1);
        TraderNFT nft = new TraderNFT(
            IERC6551Registry(address(registry)),
            address(accountImpl),
            guard,
            IERC20(address(usdc)),
            IVenue(address(router))
        );
        guard.setNFT(address(nft), address(usdc));
        guard.setMaxRuntimeFee(5e18); // a brain may pay its executor at most 5 mUSDC per trade

        // "a couple of markets": exactly two curated pairs (WETH/USDC,
        // WBTC/USDC) on one curated venue — owners cannot add more
        guard.setCuratedVenue(address(router), true);
        guard.setCuratedToken(address(usdc), true);
        guard.setCuratedToken(address(weth), true);
        guard.setCuratedToken(address(wbtc), true);

        vm.stopBroadcast();

        console.log("mWBTC:        ", address(wbtc));
        console.log("mUSDC:        ", address(usdc));
        console.log("mWETH:        ", address(weth));
        console.log("Router:       ", address(router));
        console.log("6551 Registry:", address(registry));
        console.log("Account impl: ", address(accountImpl));
        console.log("Guard:        ", address(guard));
        console.log("TraderNFT:    ", address(nft));
        console.log("RuntimeReg:   ", address(runtimeRegistry));
    }
}
