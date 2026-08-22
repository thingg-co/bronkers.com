// Brokners Terminal — chain configuration.
// No backend: the Terminal reads the chain over a public RPC and writes
// through your wallet. Every field here can be overridden at runtime from the
// Developer panel (stored in localStorage, per chain, this browser only).
//
// Anvil addresses are the deterministic CREATE addresses of Deploy.s.sol
// from a fresh `anvil` with the default deployer (account #0); re-run
// protocol/script/seed-dev.sh and compare if they ever drift.
window.BROKNERS_CONFIG = {
  defaultChainId: 31337,
  chains: {
    31337: {
      name: "anvil (local)",
      rpc: "http://127.0.0.1:8545",
      explorer: "",
      currency: "ETH",
      testnet: true,
      traderNFT: "0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0",
      guard: "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e",
      router: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
      usdc: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      weth: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
      wbtc: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
      // base64 SPKI of the dev enclave's X25519 key; seed-dev.sh prints a
      // fresh one each run — paste it in the Developer panel to mint sealed
      // brains from the browser against your local chain.
      enclavePublicKey: "MCowBQYDK2VuAyEAGWOriBPnhAgTFYARud38SLx+hUeVZK0K+acwUiVBCi0",
      // The enclave's executor address. "Enrolling" a brain means setting its
      // executor to this key; the farm (agent: npm run farm) then runs it.
      enclaveExecutor: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      // RuntimeRegistry: executor key -> (measurement, enclave key); "attested" when the
      // protocol has approved the measurement (self-reported today, TEE later).
      registry: "0x610178dA211FEF7D417bC0e6FeD39F05609AD788",
      // The machine market the farm pays its lease into (the mock Oyster market here;
      // Marlin's on Arbitrum One in production). Informational: the farm reads it.
      hostMarket: "0x3Aa5ebB10DC797CAC828524e59A333d0A371443c",
      // The enclave endpoint (the farm's FARM_HTTP_PORT): /compose writes and seals a
      // prompt from a brief for sealed-generated brains; /health reports identity and
      // the farm's books; /ledger?tokenId= the account it keeps for one brain.
      enclaveUrl: "http://127.0.0.1:8787",
      // Runtime fee (mUSDC per trade) this operator asks brains to pay; the wizard sets it.
      enclaveMinFee: "1",
      // Marketplace URL template for "list it" links ({nft}, {id}); none on a local chain.
      marketplace: "",
    },
    80002: {
      name: "Polygon Amoy",
      rpc: "https://rpc-amoy.polygon.technology",
      explorer: "https://amoy.polygonscan.com",
      currency: "POL",
      testnet: true,
      traderNFT: "",
      guard: "",
      router: "",
      usdc: "",
      weth: "",
      wbtc: "",
      enclavePublicKey: "",
      enclaveExecutor: "",
      registry: "",
      hostMarket: "",
      enclaveUrl: "",
      enclaveMinFee: "0",
      marketplace: "https://testnets.opensea.io/assets/amoy/{nft}/{id}",
    },
  },
};
