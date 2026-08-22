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
      traderNFT: "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e",
      guard: "0x610178dA211FEF7D417bC0e6FeD39F05609AD788",
      router: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
      usdc: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      weth: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
      wbtc: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
      // base64 SPKI of the dev enclave's X25519 key; seed-dev.sh prints a
      // fresh one each run — paste it in the Developer panel to mint sealed
      // brains from the browser against your local chain.
      enclavePublicKey: "MCowBQYDK2VuAyEAJWkuhe2QfuVOXNK+TGcbNpuMuYdZFNjljUU1OINhbzo",
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
    },
  },
};
