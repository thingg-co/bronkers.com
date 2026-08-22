# Quick start

*From a clean clone to a brain trading on a local chain, paying its own way,
in about ten minutes. Then the same thing on a public testnet. Companion to
[README.md](../README.md); the why is in [architecture.md](architecture.md)
and the paper.*

## 0. Prerequisites

- [Foundry](https://book.getfoundry.sh/) (`forge`, `anvil`, `cast`). The
  Solidity libraries are vendored under `protocol/lib`; no `forge install`.
- Node 20 or newer, and `npm`.
- Python 3 (only for the local dev server).
- Optional: an Anthropic API key (`ANTHROPIC_API_KEY`) or a TEE inference
  gateway (`INFERENCE_BASE_URL`, `INFERENCE_API_KEY`). Everything below works
  with the deterministic mock brain and no key at all.

```bash
git clone <repo> brokners && cd brokners
cd agent && npm install && cd ..
```

## 1. Make sure it all passes

```bash
cd protocol && forge test && cd ..      # 69 tests: guard, vault, fees, tiers, season, runtime, registry, hosting, generations
cd agent && npm run typecheck && npm test && cd ..   # ledger, lease and bridge arithmetic
```

## 2. A local chain with brains on it

```bash
anvil --silent &                         # local chain on :8545
./protocol/script/seed-dev.sh            # deploys the protocol, mints three brains, opens the farm's lease
```

The seed prints three things you will use: the dev wallet key (anvil #0,
owns the brains), the LP key, and **the farm command**. It also writes the
contract addresses and the dev enclave key into `js/config.js`, and the
enclave keys into `agent/.dev-enclave.env`.

What it left on the chain: Umbra (sealed-generated, seasoned, LP-funded, five
hourly trades), Nocturne (sealed-authored, seasoned, open to deposits, revised
once so its second generation is in training camp), an
unnamed authored intern, and a prepaid two-hour job on the mock machine
market for the farm to keep topped up.

## 3. Start the farm

Paste the command the seed printed. It looks like this:

```bash
cd agent && set -a && . ./.dev-enclave.env && set +a && \
  RPC_URL=http://127.0.0.1:8545 TRADER_NFT_ADDRESS=0x… GUARD_ADDRESS=0x… ROUTER_ADDRESS=0x… REGISTRY_ADDRESS=0x… \
  FARM_HOST=market FARM_HOST_MARKET=0x… FARM_HOST_JOB_ID=0x… FARM_NATIVE_PRICE=2000 \
  FARM_HTTP_PORT=8787 EXECUTOR_PRIVATE_KEY=0x… npm run farm -- --mock-brain
```

Within a few seconds it registers its measurement, enrols Umbra and
Nocturne (it finds their sealed jars on-chain and checks them against the
genome commitments), reads its lease, and pays the first extension:

```
lease: 120 min left; paid 2.88 mUSDC for 24h more (0x…)
```

Drop `--mock-brain` to let a real model decide (Anthropic key in the
environment, or `INFERENCE_BASE_URL` for a TEE gateway). `GET
http://127.0.0.1:8787/health` is the farm's books; `/ledger` the account it
keeps per brain.

## 4. Open the Terminal

```bash
python3 dev-server.py                    # http://127.0.0.1:8000/app
```

- **The Floor** works with no wallet. Click a brain for its record.
- **Developer** → paste the dev wallet key under "Dev wallet" → "Use this
  key". The same tab shows "The farm's books" (float, income, cost, the
  lease) and two levers: move the mock market, and **move the chain's
  clock**. The declared cadence is enforced on-chain, so a brain that has just
  traded cannot trade again until its interval is up; "+1h" lets the farm
  trade Umbra again on its next pass.
- **My Desk** → Umbra → Runtime: the fee schedule (per trade, at most
  cadence × fee a day), "next trade allowed", and the brain's **account with
  the enclave**: paid, cost, credit left, and the per-trade fee that would
  have covered it. Nocturne pays no fee; skip the clock ahead a few times and
  watch it run through its credit and pause, then raise its fee and watch it
  resume.

## 5. Birth a brain of your own

**Birth a Brain** → pick a template or write the prompt → Sealed → traits →
review → mint (the dev wallet signs) → **Start it**: one click publishes the
sealed jar on-chain, seeds the wallet, authorises the guard, sets the runtime
fee and enrols the brain with the farm. The farm picks it up on its next pass
and makes the first own-book trade; after the internship (one own-book trade
on the dev deployment) its vault opens to depositors.

Authored custody instead: you keep the key; run the brain yourself with the
command the wizard prints (`npm run loop`).

**Train it.** My Desk → Training: a sealed-generated brain takes a coach's
note (the enclave applies it inside the jar), a sealed-authored one a new
prompt sealed in the tab. The new generation spars on the brain's wallet first
("in camp" on the Floor); Nocturne is seeded that way so you can watch it.

## 6. The one-shot demo

```bash
./protocol/script/demo.sh                # its own anvil: mint → season → LP deposit → guarded trade → snapshot
./protocol/script/demo.sh --claude       # same, Claude decides (needs ANTHROPIC_API_KEY)
```

## 7. Public testnet (Polygon Amoy)

```bash
DEPLOYER_KEY=0x… ./protocol/script/deploy-testnet.sh
```

It uses the canonical ERC-6551 registry and wires Automata DCAP (present on
Amoy) into the `RuntimeRegistry`, then prints the `js/config.js` block for
chain 80002. Open a lease job on the printed `hostMarket` from the farm's key
(see `seed-dev.sh` for the call), run the farm with `FARM_HOST=market`, and
fill `enclavePublicKey` / `enclaveExecutor` / `enclaveUrl` from its `/health`.
For a real machine, the runbook is in
[runtime-hosting.md](runtime-hosting.md): Marlin Oyster, `FARM_HOST=oyster`,
the TDX quote, `registerAttested`.

## Where things are

| | |
|---|---|
| Contracts | `protocol/src`, tests in `protocol/test` |
| The farm and the self-hosted loop | `agent/src/farm.ts`, `agent/src/index.ts` |
| Budget, lease, bridge | `agent/src/budget.ts`, `host.ts`, `bridge.ts` |
| The Terminal | `app.html`, `js/terminal/`, config in `js/config.js` |
| How the Terminal is built | [terminal.md](terminal.md) |
| Architecture | [architecture.md](architecture.md) |
| Hosting and paying for the runtime | [runtime-hosting.md](runtime-hosting.md) |
| The paper | [whitepaper.md](whitepaper.md) |
| What is left | [../TODO.md](../TODO.md) |
