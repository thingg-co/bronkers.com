#!/usr/bin/env bash
# Seed a RUNNING anvil with a small, varied roster for Terminal development:
#   #1 Umbra    sealed-generated, seasoned, LP-funded, several vault trades
#   #2 Nocturne sealed-authored, seasoned (one own-book trade), open to deposits
#   #3 (unnamed) authored, still an intern, no trades
# Leaves the chain up. Start anvil first:  anvil --silent &
# Run from the repo root: ./protocol/script/seed-dev.sh
# Prints a config block for js/config.js and writes the enclave keys to
# agent/.dev-enclave.env (gitignored) so later agent ticks can reuse them.
set -euo pipefail
cd "$(dirname "$0")/../.."

# anvil's well-known dev keys (local only, never real funds)
OWNER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
OWNER_ADDR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
EXECUTOR_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
EXECUTOR_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
LP_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
LP_ADDR=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
RPC=${RPC:-http://127.0.0.1:8545}

cast chain-id --rpc-url $RPC >/dev/null 2>&1 || { echo "no chain at $RPC — run: anvil --silent &"; exit 1; }

echo "── deploying protocol ──"
DEPLOY_OUT=$(cd protocol && forge script script/Deploy.s.sol --rpc-url $RPC --private-key $OWNER_KEY --broadcast 2>&1)
addr() { echo "$DEPLOY_OUT" | grep "$1" | grep -oE '0x[0-9a-fA-F]{40}' | head -1; }
USDC=$(addr "mUSDC:"); WETH=$(addr "mWETH:"); WBTC=$(addr "mWBTC:"); ROUTER=$(addr "Router:")
GUARD=$(addr "Guard:"); NFT=$(addr "TraderNFT:"); REG=$(addr "RuntimeReg:")
[ -n "$NFT" ] || { echo "deploy failed:"; echo "$DEPLOY_OUT" | tail -20; exit 1; }

echo "── enclave keygen ──"
KEYS=$(cd agent && npm run --silent genome -- keygen)
ENCLAVE_PUB=$(echo "$KEYS" | grep ENCLAVE_PUBLIC_KEY | cut -d= -f2 | awk '{print $1}')
ENCLAVE_PRIV=$(echo "$KEYS" | grep ENCLAVE_PRIVATE_KEY | cut -d= -f2 | awk '{print $1}')
printf 'ENCLAVE_PUBLIC_KEY=%s\nENCLAVE_PRIVATE_KEY=%s\n' "$ENCLAVE_PUB" "$ENCLAVE_PRIV" > agent/.dev-enclave.env

send() { cast send --rpc-url $RPC "$@" >/dev/null; }
call() { cast call --rpc-url $RPC "$@"; }
mint_brain() { # commitment risk cadence custody
  send --private-key $OWNER_KEY $NFT \
    "mint(bytes32,uint8,uint8,uint8,string,string,address[],uint16,uint16)" \
    "$1" "$2" "$3" "$4" "claude-sonnet-5" "local:genome.local.json" "[$WETH,$WBTC]" 200 2000
}
tick() { # tokenId genomePath [extra flags]
  (cd agent && RPC_URL=$RPC EXECUTOR_PRIVATE_KEY=$EXECUTOR_KEY TOKEN_ID=$1 \
    TRADER_NFT_ADDRESS=$NFT GUARD_ADDRESS=$GUARD ROUTER_ADDRESS=$ROUTER \
    GENOME_PATH=$2 ENCLAVE_PRIVATE_KEY="$ENCLAVE_PRIV" GENOME_KEY="${GENOME_KEY:-}" \
    npm run --silent loop -- --once --mock-brain ${3:-} >/dev/null)
}
fund_and_authorise_tba() { # tokenId amount
  local tba; tba=$(call $NFT "accountOf(uint256)(address)" "$1")
  send --private-key $OWNER_KEY $USDC "mint(address,uint256)" "$tba" "$2"
  local approve; approve=$(cast calldata "approve(address,uint256)" $GUARD "$(cast max-uint)")
  send --private-key $OWNER_KEY "$tba" "execute(address,uint256,bytes,uint8)" $USDC 0 "$approve" 0
}
set_price() { send --private-key $OWNER_KEY $ROUTER "setPrice(address,address,uint256)" $WETH $USDC "$1"; }
publish() { # tokenId envelopeFile — the sealed jar goes on-chain as an event so the farm can find it
  send --private-key $OWNER_KEY $NFT "publishEnvelope(uint256,bytes)" "$1" "0x$(xxd -p "agent/$2" | tr -d '\n')"
}

echo "── brain #1: sealed-generated, seasoned, LP-funded, traded ──"
G1=$(cd agent && ENCLAVE_PUBLIC_KEY="$ENCLAVE_PUB" npm run --silent genome -- generate \
  "Trade the two curated markets with discipline; protect capital first." '{"markets":["WETH/USDC","WBTC/USDC"]}' ./genome.dev1.json)
C1=$(echo "$G1" | grep commitment | grep -oE '0x[0-9a-fA-F]{64}')
mint_brain "$C1" 1 24 2
send --private-key $OWNER_KEY $GUARD "setExecutor(uint256,address)" 1 $EXECUTOR_ADDR
send --private-key $OWNER_KEY $NFT "christen(uint256,string)" 1 "Umbra"
publish 1 genome.dev1.json
send --private-key $OWNER_KEY $GUARD "setRuntimeFee(uint256,uint256)" 1 1ether   # Umbra pays its executor 1 mUSDC per trade
fund_and_authorise_tba 1 1000ether
tick 1 ./genome.dev1.json --own-book
VAULT1=$(call $NFT "vaultOf(uint256)(address)" 1)
send --private-key $OWNER_KEY $VAULT1 "setDepositAllowed(address,bool)" $LP_ADDR true
send --private-key $OWNER_KEY $VAULT1 "setDepositAllowed(address,bool)" $OWNER_ADDR true
send --private-key $LP_KEY $USDC "mint(address,uint256)" $LP_ADDR 100000ether
send --private-key $LP_KEY $USDC "approve(address,uint256)" $VAULT1 100000ether
send --private-key $LP_KEY $VAULT1 "deposit(uint256,address)" 10000ether $LP_ADDR
tick 1 ./genome.dev1.json
set_price 2200ether;  tick 1 ./genome.dev1.json
set_price 2100ether;  tick 1 ./genome.dev1.json
set_price 2500ether;  tick 1 ./genome.dev1.json
echo "   Umbra: $(call $GUARD "tradeCountOf(uint256)(uint32)" 1) trades, NAV $(call $VAULT1 "totalAssets()(uint256)")"

echo "── brain #2: sealed-authored, seasoned, open to deposits ──"
G2=$(cd agent && ENCLAVE_PUBLIC_KEY="$ENCLAVE_PUB" npm run --silent genome -- seal \
  "You are a patient mean-reversion trader. Buy weakness, sell strength, size small." '{"style":"mean-reversion"}' ./genome.dev2.json)
C2=$(echo "$G2" | grep commitment | grep -oE '0x[0-9a-fA-F]{64}')
mint_brain "$C2" 0 4 1
send --private-key $OWNER_KEY $GUARD "setExecutor(uint256,address)" 2 $EXECUTOR_ADDR
send --private-key $OWNER_KEY $NFT "christen(uint256,string)" 2 "Nocturne"
publish 2 genome.dev2.json
fund_and_authorise_tba 2 500ether
tick 2 ./genome.dev2.json --own-book
VAULT2=$(call $NFT "vaultOf(uint256)(address)" 2)
send --private-key $OWNER_KEY $VAULT2 "setAllowlistEnabled(bool)" false

echo "── brain #3: authored, intern, no trades, unnamed ──"
G3=$(cd agent && npm run --silent genome -- author \
  "You are a volatility hunter. Aggressive, hourly." '{"style":"volatility"}' ./genome.dev3.json)
C3=$(echo "$G3" | grep commitment | grep -oE '0x[0-9a-fA-F]{64}')
mint_brain "$C3" 2 24 0

echo "── runtime registry: approve the farm's self-reported measurement (reviewed, not TEE-attested) ──"
MEASUREMENT=$(cd agent && ENCLAVE_PRIVATE_KEY="$ENCLAVE_PRIV" EXECUTOR_PRIVATE_KEY=$EXECUTOR_KEY RPC_URL=$RPC TRADER_NFT_ADDRESS=$NFT GUARD_ADDRESS=$GUARD ROUTER_ADDRESS=$ROUTER npm run --silent farm -- --measure)
send --private-key $OWNER_KEY $REG "approveMeasurement(bytes32,bool)" "$MEASUREMENT" true
echo "   approved $MEASUREMENT"

echo "── dev balances ──"
send --private-key $OWNER_KEY $USDC "mint(address,uint256)" $OWNER_ADDR 100000ether
send --private-key $EXECUTOR_KEY $USDC "mint(address,uint256)" $EXECUTOR_ADDR 100000ether

cat <<EOF

── seeded. paste into js/config.js (31337) if the addresses differ ──
    traderNFT: "$NFT",
    guard: "$GUARD",
    router: "$ROUTER",
    usdc: "$USDC",
    weth: "$WETH",
    wbtc: "$WBTC",
    enclavePublicKey: "$ENCLAVE_PUB",
    registry: "$REG",

dev wallet (anvil #0, owner of all three brains): $OWNER_KEY
LP wallet  (anvil #2, holds Umbra shares):        $LP_KEY

the farm (enclave runtime that runs every enrolled brain; #1 and #2 are enrolled and published):
  cd agent && set -a && . ./.dev-enclave.env && set +a && \\
  RPC_URL=$RPC TRADER_NFT_ADDRESS=$NFT GUARD_ADDRESS=$GUARD ROUTER_ADDRESS=$ROUTER REGISTRY_ADDRESS=$REG \\
  FARM_HTTP_PORT=8787 EXECUTOR_PRIVATE_KEY=$EXECUTOR_KEY npm run farm -- --mock-brain
EOF

# keep js/config.js's anvil block in sync with what was just deployed
python3 - "$NFT" "$GUARD" "$ROUTER" "$USDC" "$WETH" "$WBTC" "$ENCLAVE_PUB" "$EXECUTOR_ADDR" "$REG" <<'PY'
import re, sys, pathlib
nft, guard, router, usdc, weth, wbtc, epk, enclaveExecutor, registry = sys.argv[1:]
p = pathlib.Path("js/config.js"); t = p.read_text()
start = t.index("    31337: {"); end = t.index("    },", start)
block = t[start:end]
for k, v in dict(traderNFT=nft, guard=guard, router=router, usdc=usdc, weth=weth, wbtc=wbtc, enclavePublicKey=epk, enclaveExecutor=enclaveExecutor, registry=registry).items():
    block = re.sub(rf'(\s{k}: )"[^"]*"', rf'\g<1>"{v}"', block)
p.write_text(t[:start] + block + t[end:])
print("js/config.js anvil block updated")
PY
