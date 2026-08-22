#!/usr/bin/env bash
# End-to-end Brokners demo on a local anvil chain:
#   deploy (curated markets) -> sealed-generated genome -> mint ->
#   LP deposit BLOCKED (paper season) -> trader trades its own book ->
#   seasoned -> LP deposit accepted -> agent trades the vault -> indexer.
# MockBrain by default; pass --claude to let Claude make the decisions.
# Run from the repo root: ./protocol/script/demo.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

BRAIN_FLAG="--mock-brain"
[ "${1:-}" = "--claude" ] && BRAIN_FLAG=""

# anvil's well-known dev keys (local only, never real funds)
OWNER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
EXECUTOR_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
EXECUTOR_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
LP_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
LP_ADDR=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
RPC=http://127.0.0.1:8545

command -v anvil >/dev/null || { echo "anvil not found — install Foundry"; exit 1; }

echo "── starting anvil ──"
anvil --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
sleep 2

echo "── deploying protocol (two curated markets: WETH/USDC, WBTC/USDC) ──"
DEPLOY_OUT=$(cd protocol && forge script script/Deploy.s.sol --rpc-url $RPC \
  --private-key $OWNER_KEY --broadcast 2>&1)
addr() { echo "$DEPLOY_OUT" | grep "$1" | grep -oE '0x[0-9a-fA-F]{40}' | head -1; }
USDC=$(addr "mUSDC:"); WETH=$(addr "mWETH:"); WBTC=$(addr "mWBTC:"); ROUTER=$(addr "Router:")
GUARD=$(addr "Guard:"); NFT=$(addr "TraderNFT:")
echo "TraderNFT: $NFT"

echo "── enclave keygen + sealed-generated genome (custody 2) ──"
KEYS=$(cd agent && npm run --silent genome -- keygen)
ENCLAVE_PUB=$(echo "$KEYS" | grep ENCLAVE_PUBLIC_KEY | cut -d= -f2 | awk '{print $1}')
ENCLAVE_PRIV=$(echo "$KEYS" | grep ENCLAVE_PRIVATE_KEY | cut -d= -f2 | awk '{print $1}')
GENOME_OUT=$(cd agent && ENCLAVE_PUBLIC_KEY="$ENCLAVE_PUB" npm run --silent genome -- generate \
  "Trade the two curated markets with discipline; protect capital first." \
  '{"markets":["WETH/USDC","WBTC/USDC"]}' ./genome.local.json)
echo "$GENOME_OUT"
COMMIT=$(echo "$GENOME_OUT" | grep commitment | grep -oE '0x[0-9a-fA-F]{64}')

echo "── minting trader #1 (sealed-generated: nobody has seen the prompt) ──"
cast send --rpc-url $RPC --private-key $OWNER_KEY $NFT \
  "mint(bytes32,uint8,uint8,uint8,string,string,address[],uint16,uint16)" \
  "$COMMIT" 1 24 2 "claude-sonnet-5" "local:genome.local.json" "[$WETH,$WBTC]" 200 2000 >/dev/null
cast send --rpc-url $RPC --private-key $OWNER_KEY $GUARD \
  "setExecutor(uint256,address)" 1 $EXECUTOR_ADDR >/dev/null
VAULT=$(cast call --rpc-url $RPC $NFT "vaultOf(uint256)(address)" 1)
TBA=$(cast call --rpc-url $RPC $NFT "accountOf(uint256)(address)" 1)
echo "vault: $VAULT   TBA: $TBA"

echo "── LP tries to deposit before the paper season — must be blocked ──"
cast send --rpc-url $RPC --private-key $OWNER_KEY $VAULT \
  "setDepositAllowed(address,bool)" $LP_ADDR true >/dev/null
cast send --rpc-url $RPC --private-key $LP_KEY $USDC "mint(address,uint256)" $LP_ADDR 10000ether >/dev/null
cast send --rpc-url $RPC --private-key $LP_KEY $USDC "approve(address,uint256)" $VAULT 10000ether >/dev/null
if cast send --rpc-url $RPC --private-key $LP_KEY $VAULT "deposit(uint256,address)" 10000ether $LP_ADDR >/dev/null 2>&1; then
  echo "ERROR: unseasoned trader accepted outside capital"; exit 1
else
  echo "blocked: 'Vault: trader not seasoned' — as designed"
fi

echo "── paper season: the trader funds and trades its OWN book ──"
cast send --rpc-url $RPC --private-key $OWNER_KEY $USDC "mint(address,uint256)" $TBA 1000ether >/dev/null
APPROVE_CALL=$(cast calldata "approve(address,uint256)" $GUARD $(cast max-uint))
cast send --rpc-url $RPC --private-key $OWNER_KEY $TBA \
  "execute(address,uint256,bytes,uint8)" $USDC 0 "$APPROVE_CALL" 0 >/dev/null
(cd agent && RPC_URL=$RPC EXECUTOR_PRIVATE_KEY=$EXECUTOR_KEY \
  TOKEN_ID=1 TRADER_NFT_ADDRESS=$NFT GUARD_ADDRESS=$GUARD ROUTER_ADDRESS=$ROUTER \
  GENOME_PATH=./genome.local.json ENCLAVE_PRIVATE_KEY="$ENCLAVE_PRIV" \
  npm run --silent loop -- --once --own-book $BRAIN_FLAG)
echo "seasoned: $(cast call --rpc-url $RPC $GUARD "seasoned(uint256)(bool)" 1)"

echo "── LP deposits 10,000 mUSDC into the seasoned trader's vault ──"
cast send --rpc-url $RPC --private-key $LP_KEY $VAULT "deposit(uint256,address)" 10000ether $LP_ADDR >/dev/null
echo "NAV: $(cast call --rpc-url $RPC $VAULT "totalAssets()(uint256)")"

echo "── an hour passes (declared cadence 24/day is enforced on-chain) ──"
cast rpc --rpc-url $RPC evm_increaseTime 3600 >/dev/null; cast rpc --rpc-url $RPC evm_mine >/dev/null

echo "── agent tick on the LP vault: decrypt in-enclave -> verify -> trade ──"
(cd agent && RPC_URL=$RPC EXECUTOR_PRIVATE_KEY=$EXECUTOR_KEY \
  TOKEN_ID=1 TRADER_NFT_ADDRESS=$NFT GUARD_ADDRESS=$GUARD ROUTER_ADDRESS=$ROUTER \
  GENOME_PATH=./genome.local.json ENCLAVE_PRIVATE_KEY="$ENCLAVE_PRIV" \
  npm run --silent loop -- --once $BRAIN_FLAG)

echo "── indexing track record -> data/traders.json ──"
mkdir -p data
(cd agent && RPC_URL=$RPC EXECUTOR_PRIVATE_KEY=$EXECUTOR_KEY \
  TOKEN_ID=1 TRADER_NFT_ADDRESS=$NFT GUARD_ADDRESS=$GUARD ROUTER_ADDRESS=$ROUTER \
  npm run --silent report)

echo "── demo complete ──"
