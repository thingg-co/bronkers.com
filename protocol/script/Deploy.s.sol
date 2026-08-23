// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ERC6551Registry} from "erc6551/ERC6551Registry.sol";
import {ERC6551Account} from "erc6551/examples/simple/ERC6551Account.sol";
import {IERC6551Registry} from "erc6551/interfaces/IERC6551Registry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TraderNFT} from "../src/TraderNFT.sol";
import {JarRenderer} from "../src/JarRenderer.sol";
import {ExecutionGuard} from "../src/ExecutionGuard.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {PaperVenue} from "../src/PaperVenue.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {MockOysterMarket} from "../src/mocks/MockOysterMarket.sol";
import {RuntimeRegistry} from "../src/RuntimeRegistry.sol";
import {AutomataDcapTdxVerifier, IAutomataDcapAttestation} from "../src/AutomataDcapTdxVerifier.sol";
import {NitroAttestationVerifier} from "../src/NitroAttestationVerifier.sol";
import {QuoteVerifierRouter} from "../src/QuoteVerifierRouter.sol";
import {Credentials} from "../src/Credentials.sol";
import {ITraderNFT} from "../src/interfaces/ITraderNFT.sol";
import {IQuoteVerifier, IVenue} from "../src/interfaces/ITraderNFT.sol";

/// Local/testnet deployment: a paper market. The curated venue is PaperVenue,
/// which quotes mWETH/mUSDC and mWBTC/mUSDC from USD feeds (ETH_USD_FEED /
/// BTC_USD_FEED, Chainlink on a public testnet; settable MockAggregators when
/// unset), fills at the feed less a spread and mints the mock tokens.
/// On public testnets the canonical ERC-6551
/// registry (0x000000006551c19487814612e58FE06813775758) replaces the local
/// one, and where Automata DCAP is deployed (Polygon, Polygon Amoy, Arbitrum,
/// Base, and their testnets: 0xaDdeC7e85c2182202b66E331f2a4A0bBB2cEEa1F) the
/// RuntimeRegistry gets a TDX quote verifier so the farm can register
/// hardware-attested. Env: ERC6551_REGISTRY, DCAP_ATTESTATION, DCAP_MAX_TCB.
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();

        MockERC20 usdc = new MockERC20("Mock USDC", "mUSDC");
        MockERC20 weth = new MockERC20("Mock WETH", "mWETH");
        MockERC20 wbtc = new MockERC20("Mock WBTC", "mWBTC");
        // feeds: Chainlink where configured (Amoy: ETH/USD 0xF0d50568e3A7e8259E16663972b11910F89BD8e7,
        // BTC/USD 0xe7656e23fE8077D438aEfbec2fAbDf2D8e070C4f), mock aggregators otherwise
        address ethFeed = vm.envOr("ETH_USD_FEED", address(0));
        address btcFeed = vm.envOr("BTC_USD_FEED", address(0));
        if (ethFeed == address(0)) ethFeed = address(new MockAggregator("ETH / USD", 8, 2_000e8));
        if (btcFeed == address(0)) btcFeed = address(new MockAggregator("BTC / USD", 8, 60_000e8));
        PaperVenue router = new PaperVenue();
        router.setFixedUsd(address(usdc), 1e18);
        router.setFeed(address(weth), ethFeed);
        router.setFeed(address(wbtc), btcFeed);
        if (vm.envOr("PAPER_MAX_STALE", uint256(0)) > 0) router.setMaxStale(vm.envOr("PAPER_MAX_STALE", uint256(0)));

        // On public testnets the canonical 6551 registry already exists:
        // ERC6551_REGISTRY=0x000000006551c19487814612e58FE06813775758 forge script …
        address registryAddr = vm.envOr("ERC6551_REGISTRY", address(0));
        if (registryAddr == address(0)) registryAddr = address(new ERC6551Registry());
        ERC6551Registry registry = ERC6551Registry(registryAddr);
        ERC6551Account accountImpl = new ERC6551Account();
        RuntimeRegistry runtimeRegistry = new RuntimeRegistry();
        // demo paper season: one own-book trade required before outside deposits
        ExecutionGuard guard = new ExecutionGuard(0, 1);
        JarRenderer renderer = new JarRenderer(); // tokenURI rendering, kept out of the collection contract
        TraderNFT nft = new TraderNFT(
            IERC6551Registry(address(registry)),
            address(accountImpl),
            guard,
            IERC20(address(usdc)),
            IVenue(address(router)),
            renderer
        );
        guard.setNFT(address(nft), address(usdc));
        guard.setMaxRuntimeFee(5e18); // a brain may pay its executor at most 5 mUSDC per trade
        guard.setRegistry(address(runtimeRegistry)); // fees only to attested executors
        // notice period for fee raises; 0 locally so the dev seed's flows stay immediate,
        // RUNTIME_FEE_DELAY=86400 on public testnets (deploy-testnet.sh sets it)
        guard.setRuntimeFeeDelay(uint64(vm.envOr("RUNTIME_FEE_DELAY", uint256(0))));
        // training camp for revised genomes: one own-book trade, and a notice period
        // (0 locally; REVISION_NOTICE=86400 on public testnets)
        guard.setCamp(1, uint64(vm.envOr("REVISION_NOTICE", uint256(0))));
        // reaping: a dead brain (no shares, <= 1 base of NAV) idle this long can be
        // reaped free or culled for a fee. Default 1h locally so the Developer
        // clock lever can cross it and reaping is demonstrable; REAP_DELAY=2592000
        // (30d) on public testnets; 0 disables reaping. cullFee 10 base, dust 1 base.
        guard.setReap(uint64(vm.envOr("REAP_DELAY", uint256(3600))), vm.envOr("CULL_FEE", uint256(10e18)), vm.envOr("DUST_NAV", uint256(1e18)));

        // "a couple of markets": exactly two curated pairs (WETH/USDC,
        // WBTC/USDC) on one curated venue — owners cannot add more
        guard.setCuratedVenue(address(router), true);
        guard.setCuratedToken(address(usdc), true);
        guard.setCuratedToken(address(weth), true);
        guard.setCuratedToken(address(wbtc), true);

        // The machine market the farm pays its lease into: a stand-in for the
        // Marlin Oyster market, same job/deposit/settle surface, priced in the
        // base asset. Deployed last so the addresses above stay put.
        MockOysterMarket market = new MockOysterMarket(IERC20(address(usdc)));

        address dcap = vm.envOr("DCAP_ATTESTATION", address(0));
        address verifier = address(0);
        if (dcap != address(0)) {
            uint8 maxTcb = uint8(vm.envOr("DCAP_MAX_TCB", uint256(1)));
            verifier = address(new AutomataDcapTdxVerifier(IAutomataDcapAttestation(dcap), maxTcb));
        }
        // Nitro path: an approved attestor key (an off-chain verifier, itself
        // an enclave) signs compact statements this adapter checks; approve
        // attestor keys post-deploy (setAttestor). The router lets TDX quotes
        // and Nitro statements share the registry's one verifier slot.
        NitroAttestationVerifier nitro = new NitroAttestationVerifier(uint64(vm.envOr("NITRO_MAX_AGE", uint256(3600))));
        IQuoteVerifier[] memory vs = new IQuoteVerifier[](verifier == address(0) ? 1 : 2);
        if (verifier != address(0)) vs[0] = IQuoteVerifier(verifier);
        vs[vs.length - 1] = IQuoteVerifier(address(nitro));
        QuoteVerifierRouter quoteRouter = new QuoteVerifierRouter(vs);
        runtimeRegistry.setVerifier(quoteRouter);

        // Owner-supplied credentials (an inference key, say), sealed to the
        // enclave key and published as events; active only while the publisher
        // owns the brain. Runtime configuration, so it lives beside the NFT,
        // not in it. Deployed last so the addresses above stay put.
        Credentials credentials = new Credentials(ITraderNFT(address(nft)));

        vm.stopBroadcast();

        console.log("mWBTC:        ", address(wbtc));
        console.log("mUSDC:        ", address(usdc));
        console.log("mWETH:        ", address(weth));
        console.log("Router:       ", address(router));
        console.log("EthFeed:      ", ethFeed);
        console.log("BtcFeed:      ", btcFeed);
        console.log("6551 Registry:", address(registry));
        console.log("Account impl: ", address(accountImpl));
        console.log("Guard:        ", address(guard));
        console.log("TraderNFT:    ", address(nft));
        console.log("RuntimeReg:   ", address(runtimeRegistry));
        console.log("Market:       ", address(market));
        console.log("DcapVerifier: ", verifier);
        console.log("NitroVerifier:", address(nitro));
        console.log("QuoteRouter:  ", address(quoteRouter));
        console.log("Credentials:  ", address(credentials));
    }
}
