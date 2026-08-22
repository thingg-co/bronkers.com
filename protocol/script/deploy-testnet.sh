#!/usr/bin/env bash
# Deploy the protocol to a public testnet (Polygon Amoy by default) and print the
# js/config.js block. Needs a funded deployer key; nothing here touches mainnet.
#   DEPLOYER_KEY=0x… ./protocol/script/deploy-testnet.sh [rpc-url]
# The canonical ERC-6551 registry is used when it exists on the chain.
set -euo pipefail
cd "$(dirname "$0")/../.."
RPC=${1:-https://rpc-amoy.polygon.technology}
: "${DEPLOYER_KEY:?set DEPLOYER_KEY to a funded testnet key}"
CANONICAL_6551=0x000000006551c19487814612e58FE06813775758
if [ "$(cast code --rpc-url "$RPC" $CANONICAL_6551 2>/dev/null | wc -c)" -gt 3 ]; then
  export ERC6551_REGISTRY=$CANONICAL_6551; echo "using canonical ERC-6551 registry"
fi
OUT=$(cd protocol && forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --broadcast 2>&1)
echo "$OUT" | grep -E "mWBTC|mUSDC|mWETH|Router|Guard|TraderNFT|RuntimeReg|6551 Registry|Account impl"
addr() { echo "$OUT" | grep "$1" | grep -oE '0x[0-9a-fA-F]{40}' | head -1; }
cat <<CFG

── js/config.js block for chain $(cast chain-id --rpc-url "$RPC") ──
      traderNFT: "$(addr 'TraderNFT:')",
      guard: "$(addr 'Guard:')",
      router: "$(addr 'Router:')",
      usdc: "$(addr 'mUSDC:')",
      weth: "$(addr 'mWETH:')",
      wbtc: "$(addr 'mWBTC:')",
      registry: "$(addr 'RuntimeReg:')",
      // then: run the farm (agent: npm run farm) with FARM_HTTP_PORT, and fill
      // enclavePublicKey / enclaveExecutor / enclaveUrl from its /health output.
CFG
