# BROKNERS

**Like brokers, but misspelled.** Sealed AI trading brains as ERC-721 tokens:
a secret prompt ("genome") hash-committed on-chain at mint, a token-bound
wallet (ERC-6551), an ERC-4626 vault for outside capital, and an immutable
on-chain track record. Sell the brain with its money inside, or sweep first
and sell just the legend. Silly copy, serious code.

A research prototype. **Testnet only.** The design is described in
`docs/whitepaper.md`.

## Layout

```
index.html      the Brokners concept page
app.html        The Terminal — zero-build dapp (viem via CDN, NO backend:
                the browser talks straight to the contracts via your wallet)
css/brokners.css  the single stylesheet every page loads (no inline styles)
js/config.js    per-chain contract addresses for the Terminal
docs/           whitepaper (md + styled html) + architecture
protocol/       Foundry — TraderNFT (genome commitment, 4,096 cap, ERC-6551
                wallet), TraderVault (4626, fees to the brain's own wallet,
                Ring the Bell), ExecutionGuard (curated venues, seat tiers,
                paper season, slippage/notional/cadence bounds), mocks
agent/          Node/TS runtime — unseal genome (enclave prototype), verify
                commitment, the model decides (Anthropic API or a TEE inference
                gateway), guarded execution via burner key. farm.ts runs every
                enrolled brain and pays for itself: budget.ts keeps a ledger per
                brain (fees in, model + gas out; pauses brains over their credit),
                host.ts reads and tops up the machine lease on the market it is
                rented on (Marlin Oyster; a mock market locally), bridge.ts moves
                USDC between chains (CCTP v2). docs/runtime-hosting.md.
data/           traders.json emitted by agent report.ts (Terminal's offline snapshot)
docs/terminal.md how the Terminal (app.html + js/terminal/) is put together
```

## Run it

```bash
cd protocol && forge test          # full suite
cd agent && npm test               # ledger, lease and bridge arithmetic
./protocol/script/demo.sh          # anvil end-to-end demo (MockBrain)
./protocol/script/demo.sh --claude # same, but Claude makes the decisions
python3 dev-server.py               # clean-URL local server; open / and /app
```

To develop the Terminal against a local chain that stays up:

```bash
anvil --silent &
./protocol/script/seed-dev.sh      # deploy + three brains in different states;
                                   # writes addresses and the dev enclave key into js/config.js
python3 dev-server.py              # open http://127.0.0.1:8000/app
```

The Floor and every brain page work with no wallet. To act, connect a browser
wallet pointed at `http://127.0.0.1:8545` (chain id 31337), or paste one of the
dev keys the seed prints into the Developer tab. Start the farm (the seed prints
the command, including the lease it opened for it on the mock machine market)
and the enrolled brains trade by themselves at their declared cadence; the
Developer tab has a clock lever because that cadence is enforced on-chain. The
farm's books are on its endpoint (`/health`, `/ledger`) and in the Terminal.
See `docs/terminal.md`.

Public testnet: `DEPLOYER_KEY=0x… ./protocol/script/deploy-testnet.sh` deploys to
Polygon Amoy and prints the `js/config.js` block.

## Payouts, plainly

- **LPs**: standard ERC-4626 — `withdraw`/`redeem` at the current share price,
  any time, no lockup; the executor key cannot touch or block withdrawals.
  Withdrawals pay the base asset, so a heavily-deployed vault may need the
  brain to unwind positions first (prototype limitation, documented).
- **Owners**: your capital lives in the brain's token-bound wallet — sweep it
  whenever you like via the TBA (owner-only). Fee earnings accrue there as
  vault shares; redeem them through the vault, then sweep.
- Fees checkpoint on every deposit, withdrawal, transfer, and bell-ring, so
  every exit settles at exact economics.
- **Operators**: a brain pays its executor an owner-set runtime fee per trade
  (protocol-capped, paid after the swap, skipped when the book has no cash, and
  bounded per day because trades are rate-limited to the declared cadence). It
  is a fund expense and shows in the record.

Deployment: GitHub Pages from the repo root (`CNAME` → brokners.com,
`.nojekyll` present).
