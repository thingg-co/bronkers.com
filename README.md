# BROKNERS

**Like brokers, but misspelled.** Sealed AI trading brains as ERC-721 tokens:
a secret prompt ("genome") hash-committed on-chain at mint, a token-bound
wallet (ERC-6551), an ERC-4626 vault for outside capital, and an immutable
on-chain track record. Sell the brain with its money inside, or sweep first
and sell just the legend. Silly copy, serious code.

A research prototype by Darkly Fund. **Testnet only. Not an offering.** See
`docs/whitepaper.md` §9 before asking about mainnet.

## Layout

```
index.html      the Brokners concept page
app.html        The Terminal — zero-build dapp (viem via CDN, NO backend:
                the browser talks straight to the contracts via your wallet)
js/config.js    per-chain contract addresses for the Terminal
docs/           whitepaper (md + styled html) + architecture
protocol/       Foundry — TraderNFT (genome commitment, 4,096 cap, ERC-6551
                wallet), TraderVault (4626, fees to the brain's own wallet,
                Ring the Bell), ExecutionGuard (curated venues, seat tiers,
                paper season, slippage/notional/cadence bounds), mocks
agent/          Node/TS runtime — unseal genome (enclave prototype), verify
                commitment, Claude decides, guarded execution via burner key
data/           traders.json emitted by the demo indexer
```

## Run it

```bash
cd protocol && forge test          # full suite
./protocol/script/demo.sh          # anvil end-to-end demo (MockBrain)
./protocol/script/demo.sh --claude # same, but Claude makes the decisions
python3 dev-server.py               # clean-URL local server; open / and /app
```

For the Terminal against local anvil: run `Deploy.s.sol`, paste the printed
addresses into the Terminal's **Contracts…** panel (or `js/config.js`), and
point a browser wallet at `http://127.0.0.1:8545` (chain id 31337).

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

Deployment: GitHub Pages from the repo root (`CNAME` → brokners.com,
`.nojekyll` present).
