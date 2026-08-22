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
      traderNFT: "0x4c5859f0F772848b2D91F1D83E2Fe57935348029",
      guard: "0x36C02dA8a0983159322a80FFE9F24b1acfF8B570",
      router: "0x70e0bA845a1A0F2DA3359C97E0285013525FFC49",
      usdc: "0x1613beB3B2C4f22Ee086B2b38C1476A3cE7f78E8",
      weth: "0x851356ae760d987E095750cCeb3bC6014560891C",
      wbtc: "0xf5059a5D33d5853360D16C683c16e67980206f36",
      // base64 SPKI of the dev enclave's X25519 key; seed-dev.sh prints a
      // fresh one each run — paste it in the Developer panel to mint sealed
      // brains from the browser against your local chain.
      enclavePublicKey: "MCowBQYDK2VuAyEAQZ1VlKuI5B1Cj3A/+3yBZcXyVQuHchBumhTUGh9ncUg",
      // The enclave's executor address. "Enrolling" a brain means setting its
      // executor to this key; the farm (agent: npm run farm) then runs it.
      enclaveExecutor: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      // RuntimeRegistry: executor key -> (measurement, enclave key); "attested" when the
      // protocol has approved the measurement (self-reported today, TEE later).
      registry: "0x5eb3Bc0a489C5A8288765d2336659EbCA68FCd00",
      // The machine market the farm pays its lease into (the mock Oyster market here;
      // Marlin's on Arbitrum One in production). Informational: the farm reads it.
      hostMarket: "0xFD471836031dc5108809D173A067e8486B9047A3",
      // The paper venue's USD feeds (mock aggregators here; Chainlink on a public testnet).
      // The Developer tab's market lever writes the ETH feed.
      ethFeed: "0x95401dc811bb5740090279Ba06cfA8fcF6113778",
      btcFeed: "0x998abeb3E57409262aE5b751f60747921B33613E",
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
      ethFeed: "0xF0d50568e3A7e8259E16663972b11910F89BD8e7",
      btcFeed: "0xe7656e23fE8077D438aEfbec2fAbDf2D8e070C4f",
      enclaveUrl: "",
      enclaveMinFee: "0",
      marketplace: "https://testnets.opensea.io/assets/amoy/{nft}/{id}",
    },
  },
};
