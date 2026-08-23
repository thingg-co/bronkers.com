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
      traderNFT: "0x2E2Ed0Cfd3AD2f1d34481277b3204d807Ca2F8c2",
      guard: "0x4C4a2f8c81640e47606d3fd77B353E87Ba015584",
      router: "0xB0D4afd8879eD9F52b28595d31B441D079B2Ca07",
      usdc: "0x7bc06c482DEAd17c0e297aFbC32f6e63d3846650",
      weth: "0xc351628EB244ec633d5f21fBD6621e1a683B1181",
      wbtc: "0xFD471836031dc5108809D173A067e8486B9047A3",
      // base64 SPKI of the dev enclave's X25519 key; seed-dev.sh prints a
      // fresh one each run — paste it in the Developer panel to mint sealed
      // brains from the browser against your local chain.
      enclavePublicKey: "MCowBQYDK2VuAyEAzmkej2ix+3ED8/G8KeVNN5sSVqU73IVcgN/Yn+sE/m4",
      // The enclave's executor address. "Enrolling" a brain means setting its
      // executor to this key; the farm (agent: npm run farm) then runs it.
      enclaveExecutor: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      // RuntimeRegistry: executor key -> (measurement, enclave key); "attested" when the
      // protocol has approved the measurement (self-reported today, TEE later).
      registry: "0x04C89607413713Ec9775E14b954286519d836FEf",
      // The machine market the farm pays its lease into (the mock Oyster market here;
      // Marlin's on Arbitrum One in production). Informational: the farm reads it.
      hostMarket: "0xBEc49fA140aCaA83533fB00A2BB19bDdd0290f25",
      // Credentials: owner-supplied secrets (an inference key) sealed to the enclave
      // key and published as events; active only while the publisher owns the brain.
      // seed-dev.sh fills this in on each deploy.
      credentials: "",
      // The paper venue's USD feeds (mock aggregators here; Chainlink on a public testnet).
      // The Developer tab's market lever writes the ETH feed.
      ethFeed: "0xcbEAF3BDe82155F56486Fb5a1072cb8baAf547cc",
      btcFeed: "0x1429859428C0aBc9C2C47C8Ee9FBaf82cFA0F20f",
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
      credentials: "",
      ethFeed: "0xF0d50568e3A7e8259E16663972b11910F89BD8e7",
      btcFeed: "0xe7656e23fE8077D438aEfbec2fAbDf2D8e070C4f",
      enclaveUrl: "",
      enclaveMinFee: "0",
      marketplace: "https://testnets.opensea.io/assets/amoy/{nft}/{id}",
    },
  },
};
