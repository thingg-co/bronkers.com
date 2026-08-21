// Brokners Terminal — chain configuration.
// No backend: the app talks to the chain through your wallet's RPC.
// Fill these after running protocol/script/Deploy.s.sol (the script prints
// every address). The Terminal also lets you paste addresses at runtime;
// runtime values are kept in localStorage and win over this file.
window.BROKNERS_CONFIG = {
  // anvil (local demo chain)
  31337: {
    name: "anvil",
    traderNFT: "",
    guard: "",
    router: "",
    usdc: "",
    weth: "",
    wbtc: "",
  },
  // Base Sepolia (testnet pilot — fill when deployed)
  84532: {
    name: "Base Sepolia",
    traderNFT: "",
    guard: "",
    router: "",
    usdc: "",
    weth: "",
    wbtc: "",
  },
};
