// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ERC6551Registry} from "erc6551/ERC6551Registry.sol";
import {ERC6551Account} from "erc6551/examples/simple/ERC6551Account.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TraderNFT} from "../src/TraderNFT.sol";
import {TraderVault} from "../src/TraderVault.sol";
import {ExecutionGuard} from "../src/ExecutionGuard.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";
import {IVenue} from "../src/interfaces/ITraderNFT.sol";

/// The whitepaper's "worked example" as a runnable script (vs a live anvil
/// node use Deploy.s.sol + the agent runtime; this variant is self-contained):
/// mint -> LP deposit -> guarded trade -> market gain -> fee accrual ->
/// sell WITH capital -> the buyer inherits book + fee stream.
contract Demo is Script {
    function run() external {
        uint256 ownerKey = 0xA11CE;
        uint256 executorKey = 0xE8EC;
        uint256 lpKey = 0x11D0;
        uint256 buyerKey = 0xB0B;
        address owner = vm.addr(ownerKey);
        address executor = vm.addr(executorKey);
        address lp = vm.addr(lpKey);
        address buyer = vm.addr(buyerKey);

        // --- deployment (protocol operator) ---
        vm.startBroadcast();
        MockERC20 usdc = new MockERC20("Mock USDC", "mUSDC");
        MockERC20 weth = new MockERC20("Mock WETH", "mWETH");
        MockSwapRouter router = new MockSwapRouter();
        router.setPrice(address(weth), address(usdc), 2_000e18);
        router.setPrice(address(usdc), address(weth), 1e36 / 2_000e18);
        ERC6551Registry registry = new ERC6551Registry();
        ERC6551Account accountImpl = new ERC6551Account();
        // season disabled here to keep the worked example short; demo.sh and
        // Integrity.t.sol exercise the paper-season gate
        ExecutionGuard guard = new ExecutionGuard(0, 0);
        TraderNFT nft = new TraderNFT(
            IERC6551Registry(address(registry)),
            address(accountImpl),
            guard,
            IERC20(address(usdc)),
            IVenue(address(router))
        );
        guard.setNFT(address(nft), address(usdc));
        guard.setCuratedVenue(address(router), true);
        guard.setCuratedToken(address(usdc), true);
        guard.setCuratedToken(address(weth), true);
        usdc.mint(lp, 10_000e18);
        vm.stopBroadcast();

        // --- 1. mint a trader (genome hash only; prompt stays secret) ---
        vm.startBroadcast(ownerKey);
        address[] memory universe = new address[](1);
        universe[0] = address(weth);
        uint256 id = nft.mint(
            keccak256('{"prompt":"<secret>","tweaks":{"style":"momentum"}}'),
            1, // balanced
            4, // <= 4 trades/day declared
            2, // sealed-generated custody: no one has ever seen the prompt
            "claude-sonnet-5",
            "bafy-demo-cid",
            universe,
            200, // 2% management
            2_000 // 20% performance
        );
        guard.setExecutor(id, executor);
        TraderVault vault = TraderVault(nft.vaultOf(id));
        vault.setDepositAllowed(lp, true);
        vm.stopBroadcast();
        console.log("1. Trader #%d born. TBA %s vault %s", id, nft.accountOf(id), address(vault));

        // --- 2. an LP funds the vault ---
        vm.startBroadcast(lpKey);
        usdc.approve(address(vault), 10_000e18);
        vault.deposit(10_000e18, lp);
        vm.stopBroadcast();
        console.log("2. LP deposited 10,000 mUSDC. NAV: %e", vault.totalAssets());

        // --- 3. the AI (executor key) makes a guarded trade ---
        vm.startBroadcast(executorKey);
        uint256 quoted = router.quote(address(usdc), address(weth), 2_000e18);
        guard.executeTrade(id, address(router), address(usdc), address(weth), 2_000e18, quoted, true);
        vm.stopBroadcast();
        console.log("3. Agent swapped 2,000 mUSDC -> mWETH inside the guardrails.");

        // --- 4. the market moves; fees accrue to the trader's own wallet ---
        vm.startBroadcast();
        router.setPrice(address(weth), address(usdc), 3_000e18);
        vm.stopBroadcast();
        vault.checkpoint();
        address tba = nft.accountOf(id);
        console.log("4. mWETH +50%%. NAV: %e. Fee shares in TBA: %e", vault.totalAssets(), vault.balanceOf(tba));

        // --- 5. sell the trader WITH its capital ---
        vm.startBroadcast(ownerKey);
        nft.safeTransferFrom(owner, buyer, id);
        vm.stopBroadcast();
        console.log("5. Trader sold WITH capital. New owner: %s", nft.ownerOf(id));

        // --- 6. the buyer rotates the executor key (due-diligence step) ---
        vm.startBroadcast(buyerKey);
        guard.setExecutor(id, buyer);
        vm.stopBroadcast();
        console.log("6. Buyer rotated executor. Fee shares still in TBA: %e", vault.balanceOf(tba));
        console.log("   Track record, genome commitment, book, and fee stream all travelled.");
    }
}
