#!/usr/bin/env bash
# Seed a freshly deployed public testnet (Polygon Amoy) with the three demo
# brains and everything the farm needs to run them. Companion to
# deploy-testnet.sh: run that first, then this with its printed addresses.
#
#   DEPLOYER_KEY=0x… EXECUTOR_KEY=0x… \
#   NFT=0x… GUARD=0x… ROUTER=0x… USDC=0x… WETH=0x… WBTC=0x… REG=0x… MARKET=0x… CREDENTIALS=0x… \
#   ./protocol/script/seed-testnet.sh [rpc-url]
#
# Unlike seed-dev.sh it never moves the clock or ticks a brain: the farm trades
# in real time at each brain's declared cadence, and one own-book trade seasons
# a brain (Deploy.s.sol: 0 duration, 1 trade). The deployer owns the brains;
# EXECUTOR_KEY is the farm's (a second funded key). Enclave keys are generated
# here and written to agent/.testnet-enclave.env (gitignored); keep that file,
# the jars are sealed to it.
set -euo pipefail
cd "$(dirname "$0")/../.."
RPC=${1:-https://rpc-amoy.polygon.technology}
: "${DEPLOYER_KEY:?set DEPLOYER_KEY (owns the demo brains)}"
: "${EXECUTOR_KEY:?set EXECUTOR_KEY (the farm key, funded for gas)}"
for v in NFT GUARD ROUTER USDC WETH WBTC REG MARKET; do
  if [ -z "${!v:-}" ]; then echo "set $v from the deploy-testnet.sh output"; exit 1; fi
done
OWNER_ADDR=$(cast wallet address --private-key "$DEPLOYER_KEY")
EXECUTOR_ADDR=$(cast wallet address --private-key "$EXECUTOR_KEY")
LANDLORD_ADDR=${LANDLORD_ADDR:-$OWNER_ADDR}   # who the mock lease is paid to
CHAIN=$(cast chain-id --rpc-url "$RPC")
echo "chain $CHAIN · owner $OWNER_ADDR · farm $EXECUTOR_ADDR"

send() { cast send --rpc-url "$RPC" "$@" >/dev/null; }
call() { cast call --rpc-url "$RPC" "$@"; }

echo "── enclave keygen (agent/.testnet-enclave.env) ──"
KEYS=$(cd agent && npm run --silent genome -- keygen)
ENCLAVE_PUB=$(echo "$KEYS" | grep ENCLAVE_PUBLIC_KEY | cut -d= -f2 | awk '{print $1}')
ENCLAVE_PRIV=$(echo "$KEYS" | grep ENCLAVE_PRIVATE_KEY | cut -d= -f2 | awk '{print $1}')
printf 'ENCLAVE_PUBLIC_KEY=%s\nENCLAVE_PRIVATE_KEY=%s\n' "$ENCLAVE_PUB" "$ENCLAVE_PRIV" > agent/.testnet-enclave.env

echo "── runtime registry: register the farm's measurement and approve it ──"
MEASUREMENT=$(cd agent && ENCLAVE_PRIVATE_KEY="$ENCLAVE_PRIV" EXECUTOR_PRIVATE_KEY=$EXECUTOR_KEY RPC_URL=$RPC TRADER_NFT_ADDRESS=$NFT GUARD_ADDRESS=$GUARD ROUTER_ADDRESS=$ROUTER npm run --silent farm -- --measure)
ENCLAVE_PUB_HEX=0x$(echo "$ENCLAVE_PUB" | base64 -d | xxd -p | tr -d '\n')
send --private-key $EXECUTOR_KEY $REG "register(bytes32,bytes)" "$MEASUREMENT" "$ENCLAVE_PUB_HEX"
send --private-key $DEPLOYER_KEY $REG "approveMeasurement(bytes32,bool)" "$MEASUREMENT" true
echo "   $MEASUREMENT (self-reported; the TDX quote path is registerAttested)"

mint_brain() { # commitment risk cadence custody
  send --private-key $DEPLOYER_KEY $NFT \
    "mint(bytes32,uint8,uint8,uint8,string,string,address[],uint16,uint16)" \
    "$1" "$2" "$3" "$4" "claude-sonnet-5" "onchain:EnvelopePublished" "[$WETH,$WBTC]" 200 2000
}
publish() { send --private-key $DEPLOYER_KEY $NFT "publishEnvelope(uint256,bytes)" "$1" "0x$(xxd -p "agent/$2" | tr -d '\n')"; }
fund_and_authorise_tba() { # tokenId amount
  local tba; tba=$(call $NFT "accountOf(uint256)(address)" "$1")
  send --private-key $DEPLOYER_KEY $USDC "mint(address,uint256)" "$tba" "$2"
  local approve; approve=$(cast calldata "approve(address,uint256)" $GUARD "$(cast max-uint)")
  send --private-key $DEPLOYER_KEY "$tba" "execute(address,uint256,bytes,uint8)" $USDC 0 "$approve" 0
}
enrol() { # tokenId name fee(ether) escrow(ether)
  send --private-key $DEPLOYER_KEY $GUARD "setExecutor(uint256,address)" "$1" $EXECUTOR_ADDR
  send --private-key $DEPLOYER_KEY $NFT "christen(uint256,string)" "$1" "$2"
  send --private-key $DEPLOYER_KEY $GUARD "setRuntimeFee(uint256,uint256)" "$1" "$3"
  if [ "$4" != "0" ]; then
    send --private-key $DEPLOYER_KEY $USDC "mint(address,uint256)" $OWNER_ADDR "$4"
    send --private-key $DEPLOYER_KEY $USDC "approve(address,uint256)" $GUARD "$4"
    send --private-key $DEPLOYER_KEY $GUARD "fundRuntime(uint256,uint256)" "$1" "$4"
  fi
}
NEXT=$(call $NFT "nextId()(uint256)")
[ "$NEXT" = "0" ] || echo "note: $NEXT brains already minted; the new ones get ids from $((NEXT+1))"

echo "── Umbra: sealed-generated, hourly, 1 mUSDC per trade, rent escrowed ──"
G1=$(cd agent && ENCLAVE_PUBLIC_KEY="$ENCLAVE_PUB" npm run --silent genome -- generate \
  "Trade the two curated markets with discipline; protect capital first." '{"markets":["WETH/USDC","WBTC/USDC"]}' ./genome.amoy1.json)
C1=$(echo "$G1" | grep commitment | grep -oE '0x[0-9a-fA-F]{64}')
mint_brain "$C1" 1 24 2; ID1=$(call $NFT "nextId()(uint256)")
publish $ID1 genome.amoy1.json; enrol $ID1 "Umbra" 1ether 25ether; fund_and_authorise_tba $ID1 1000ether

echo "── Nocturne: sealed-authored, four a day, mean reversion ──"
G2=$(cd agent && ENCLAVE_PUBLIC_KEY="$ENCLAVE_PUB" npm run --silent genome -- seal \
  "You are a patient mean-reversion trader. Buy weakness, sell strength, size small." '{"style":"mean-reversion"}' ./genome.amoy2.json)
C2=$(echo "$G2" | grep commitment | grep -oE '0x[0-9a-fA-F]{64}')
mint_brain "$C2" 0 4 1; ID2=$(call $NFT "nextId()(uint256)")
publish $ID2 genome.amoy2.json; enrol $ID2 "Nocturne" 500000000000000000 10ether; fund_and_authorise_tba $ID2 500ether
VAULT2=$(call $NFT "vaultOf(uint256)(address)" $ID2)
send --private-key $DEPLOYER_KEY $VAULT2 "setAllowlistEnabled(bool)" false

echo "── Vesper: sealed-authored, hourly, aggressive ──"
G3=$(cd agent && ENCLAVE_PUBLIC_KEY="$ENCLAVE_PUB" npm run --silent genome -- seal \
  "You are a volatility hunter. Aggressive, hourly. Take the trade when the market moves." '{"style":"volatility"}' ./genome.amoy3.json)
C3=$(echo "$G3" | grep commitment | grep -oE '0x[0-9a-fA-F]{64}')
mint_brain "$C3" 2 24 1; ID3=$(call $NFT "nextId()(uint256)")
publish $ID3 genome.amoy3.json; enrol $ID3 "Vesper" 1ether 10ether; fund_and_authorise_tba $ID3 500ether

echo "── machine lease: a prepaid job on the mock Oyster market, topped up by the farm's key ──"
RATE=$(python3 -c 'print(120000000000000000 * 10**12 // 3600)')   # 0.12 mUSDC/h, per second, 12 extra decimals
send --private-key $DEPLOYER_KEY $USDC "mint(address,uint256)" $EXECUTOR_ADDR 50ether
send --private-key $EXECUTOR_KEY $USDC "approve(address,uint256)" $MARKET "$(cast max-uint)"
JOB=$(cast send --rpc-url "$RPC" --private-key $EXECUTOR_KEY --json $MARKET "jobOpen(string,address,uint256,uint256)" "brokners-farm" $LANDLORD_ADDR "$RATE" 2880000000000000000 \
  | python3 -c 'import json,sys; r=json.load(sys.stdin); print([l for l in r["logs"] if len(l["topics"])==4][-1]["topics"][1])')
echo "   job $JOB · 0.12 mUSDC/h · 24h prepaid"

cat <<EOF

── seeded: brains #$ID1 Umbra, #$ID2 Nocturne, #$ID3 Vesper. Put these in js/config.js ($CHAIN) ──
      enclavePublicKey: "$ENCLAVE_PUB",
      enclaveExecutor: "$EXECUTOR_ADDR",

── the farm (keep it running; it trades each brain at its cadence and pays the lease) ──
  cd agent && set -a && . ./.testnet-enclave.env && set +a && \\
  RPC_URL=$RPC TRADER_NFT_ADDRESS=$NFT GUARD_ADDRESS=$GUARD ROUTER_ADDRESS=$ROUTER REGISTRY_ADDRESS=$REG CREDENTIALS_ADDRESS=${CREDENTIALS:-<Credentials>} \\
  FARM_HOST=market FARM_HOST_MARKET=$MARKET FARM_HOST_JOB_ID=$JOB FARM_NATIVE_PRICE=0.5 \\
  FARM_HTTP_PORT=8787 FARM_LEDGER_PATH=./.farm-ledger.amoy.json FARM_TRANSCRIPTS_DIR=./.farm-transcripts.amoy \\
  ANTHROPIC_API_KEY=<key> EXECUTOR_PRIVATE_KEY=$EXECUTOR_KEY npm run farm
EOF
