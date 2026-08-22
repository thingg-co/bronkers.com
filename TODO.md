# What is left

The tracking list. Tick items here; the decisions that constrain them live in
[CLAUDE.md](CLAUDE.md) (testnet only; no AWS; Polymarket first; no native
token; the paper is updated last). Where an item has a runbook or a spec,
it is linked.

## Runtime and hosting

- [ ] **Run the farm on a TDX machine.** Build the farm image
      (`oyster-cvm build`, `upload`), `oyster-cvm deploy` it on a Marlin Oyster
      TDX operator from the executor key (USDC + a little ETH on Arbitrum One),
      run with `FARM_HOST=oyster OYSTER_JOB_ID=…`. Done when the lease loop has
      extended a real job at least once. Runbook: docs/runtime-hosting.md.
- [ ] **In-enclave keys.** Derive the executor key and the enclave sealing key
      inside the CVM (Oyster KMS derive, port 1100; keys persist across
      redeploys of the same image id) instead of passing them in as init
      parameters.
- [ ] **Attested registration, the hardware half.** Have the enclave request a
      TDX quote whose report data is the hash the farm prints at start
      (`keccak256(executor ‖ enclave key)`), set `FARM_QUOTE_PATH` /
      `FARM_QUOTE_FEE`, confirm `registerAttested` succeeds against Automata on
      Amoy, reproduce the image and `approveMeasurement`. Done when a brain
      shows "attested runtime · TDX quote". Confirm the adapter's offsets
      against the live quote (`AutomataDcapTdxVerifier`).
- [ ] **Measurement and approval flow.** Every edit to `agent/src` changes the
      self-reported measurement; the seed approves once. Decide the
      reproducible-build and approval procedure (who approves, how it is
      recorded) before testnet.
- [ ] **TEE inference gateway.** Pick and fund a USDC-paid gateway
      (Phala/RedPill or SecretAI x402), run the farm with
      `INFERENCE_BASE_URL` + `INFERENCE_API_KEY`, set `INFERENCE_PRICE_IN/OUT`
      from its price sheet. Done when a sealed brain trades through it.
- [ ] **Marlin market arithmetic check.** Confirm `EXTRA_DECIMALS` and the
      settlement arithmetic against a live job before the first real extension
      (the mock follows the CLI's convention; host.ts reads the value on-chain).
- [ ] **Bridge rehearsal.** `npm run bridge -- --amount 1 --to 421614 --dry-run`
      then for real, Amoy → Arbitrum Sepolia with faucet USDC. Mainnet-only in
      meaning (the testnet base asset is a mock); rehearse anyway.
- [ ] **Phala Cloud as fallback host.** Same image, `FARM_HOST=none
      FARM_HOST_RATE=0.12`, credits topped up by hand.
- [ ] **Lit Protocol for authored-custody handoff** (threshold release of the
      genome key gated on `ownerOf`).

## Protocol

- [ ] **Polymarket adapter.** `IVenue` over the CTF exchange (USDC collateral,
      binary outcome tokens as `tokenIn`/`tokenOut`), the TBA as off-chain order
      signer with the guard's policy applied in the enclave (approvals to the
      exchange only), venue-per-brain at mint. Testnet pilot against a mock
      conditional-token exchange on Amoy. `venues.js` already formats
      prediction-market trades from a `venues`/`markets` map in config.
- [ ] **TWAP/oracle NAV pricing + fee-crystallization delay.** The spot quote
      is manipulable; the biggest known protocol weakness.
- [ ] **Vault auto-unwind / in-kind redemption** so LP withdrawals never block
      on base-asset liquidity.
- [ ] **Executor auto-reset on NFT transfer; timelocked executor change** as LP
      notice.
- [ ] **Daily notional budget** on top of the per-trade cap.
- [ ] **Realized-only performance fees.**
- [ ] **Buyback/AMM floor pool** in the base asset (no native token, no burns,
      no distributions).
- [ ] **Sealed training by model call.** `/train` appends a coach's note to the
      sealed prompt (deterministic). Production should rewrite the prompt with a
      model call inside the TEE; same outputs (commitment, jar).
- [ ] **Reap keeper + bounty?** Reaping is free and permissionless today; a
      small keeper bounty (from the treasury, since a dead brain has nothing)
      would pay someone to tidy the roster at the cap. Decide if it is needed.
- [ ] **Cull UI in the wizard.** The contract has `cullAndMint`; when the
      collection is at the live cap, Birth a Brain should let the minter pick a
      reapable brain to cull and pay the fee in the same flow.
- [ ] **Revision on sale.** Decide whether a transfer should force a new
      generation (a buyer's own strategy) or forbid one for a period (a buyer
      paid for the record); today neither.
- [ ] **Decide: fee on hold ticks?** Today the fee is paid on trades only (the
      executor's permission set stays one function) and the farm's credit
      policy absorbs holds. A per-tick fee would be a second executor entry
      point; decide and, if no, close the question in architecture.md §8.
- [ ] **Audit** of the contracts and the enclave runtime; outcome decides
      closed-only vs open vaults.

## Terminal

- [ ] **The Floor as a leaderboard** fed by `report.ts` (ranking, returns,
      drawdown across the roster).
- [ ] **Harvester directory.** List registered executors from the
      RuntimeRegistry: attestation kind, brains run, trades and fees earned
      (from logs), the ask they publish, so owners can choose one.
- [ ] **Transcript check.** Paste a disclosed transcript JSON, hash it, and
      match it against the `TranscriptCommitted` hash on the brain page; define
      the disclosure procedure (docs/architecture.md §8).
- [ ] **Prediction-market formatting live** once the adapter lands (fill
      `venues`/`markets` in `js/config.js`).

## Testnet and operations

- [ ] **Polygon Amoy deploy: the public paper market.** `DEPLOYER_KEY=…
      ./protocol/script/deploy-testnet.sh` (the paper venue quotes Chainlink
      ETH/USD and BTC/USD there), fill the 80002 block of `js/config.js`, open a
      lease job on the printed `hostMarket`, run one public farm (harvester),
      fill the enclave fields from `/health`, point brokners.com's Terminal at
      it, marketplace links. Then anyone can learn on it with faucet money.
- [ ] **Snapshot refresh.** Regenerate `data/traders.json` from the testnet
      once brains exist there (`npm run report`), so the offline fallback on
      brokners.com shows real records.

## Standing rules (not todos)

- The whitepaper (md + html + artifact) is updated last after any technical
  change.
- Nothing deploys to mainnet and no real deposits are taken without
  securities counsel.
- Keep the "Silly Copy. Serious Code." table on index.html true.
