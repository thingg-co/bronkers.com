#!/usr/bin/env bash
# Deploy the protocol to a public testnet (Polygon Amoy by default) and print the
# js/config.js block. Needs a funded deployer key; nothing here touches mainnet.
#   DEPLOYER_KEY=0x… ./protocol/script/deploy-testnet.sh [rpc-url]
# The canonical ERC-6551 registry is used when it exists on the chain, and on
# chains where Automata DCAP is deployed (Polygon, Amoy, Arbitrum, Base and
# their testnets) the RuntimeRegistry gets a TDX quote verifier.
set -euo pipefail
cd "$(dirname "$0")/../.."
RPC=${1:-https://rpc-amoy.polygon.technology}
: "${DEPLOYER_KEY:?set DEPLOYER_KEY to a funded testnet key}"
CHAIN=$(cast chain-id --rpc-url "$RPC")
CANONICAL_6551=0x000000006551c19487814612e58FE06813775758
if [ "$(cast code --rpc-url "$RPC" $CANONICAL_6551 2>/dev/null | wc -c)" -gt 3 ]; then
  export ERC6551_REGISTRY=$CANONICAL_6551; echo "using canonical ERC-6551 registry"
fi
# Automata DCAP attestation entrypoint (v1.1), same address on every chain it is on
AUTOMATA_DCAP=0xaDdeC7e85c2182202b66E331f2a4A0bBB2cEEa1F
if [ -z "${DCAP_ATTESTATION:-}" ] && [ "$(cast code --rpc-url "$RPC" $AUTOMATA_DCAP 2>/dev/null | wc -c)" -gt 3 ]; then
  export DCAP_ATTESTATION=$AUTOMATA_DCAP; echo "using Automata DCAP at $AUTOMATA_DCAP for attested registration"
fi
OUT=$(cd protocol && forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --broadcast 2>&1)
echo "$OUT" | grep -E "mWBTC|mUSDC|mWETH|Router|Guard|TraderNFT|RuntimeReg|Market|DcapVerifier|6551 Registry|Account impl"
addr() { echo "$OUT" | grep "$1" | grep -oE '0x[0-9a-fA-F]{40}' | head -1; }
cat <<CFG

── js/config.js block for chain $CHAIN ──
      traderNFT: "$(addr 'TraderNFT:')",
      guard: "$(addr 'Guard:')",
      router: "$(addr 'Router:')",
      usdc: "$(addr 'mUSDC:')",
      weth: "$(addr 'mWETH:')",
      wbtc: "$(addr 'mWBTC:')",
      registry: "$(addr 'RuntimeReg:')",
      hostMarket: "$(addr 'Market:')",
      // then: run the farm (agent: npm run farm) with FARM_HTTP_PORT, and fill
      // enclavePublicKey / enclaveExecutor / enclaveUrl from its /health output.
      // Lease on this testnet: open a job on hostMarket from the farm's key (see
      // seed-dev.sh) and pass FARM_HOST=market FARM_HOST_MARKET FARM_HOST_JOB_ID.
CFG
