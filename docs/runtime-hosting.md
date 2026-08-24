# Where the enclave runs, and who pays for it

*Research memo and runbook, August 2026. Constraint set by the owner: no AWS;
the runtime must be paid for out of the crypto that seeds a brain; the owner
should have to do as little as possible.*

## The requirement, precisely

The farm (`agent/src/farm.ts`) is one long-lived process that runs every
enrolled brain: it holds the enclave sealing key and the executor key, opens
published jars, calls a model, and signs `executeTrade`. To satisfy the
constraint it needs four things, each payable in crypto by a program, not a
person:

1. **A TEE host** (Intel TDX or AMD SEV-SNP for the farm we run; AWS Nitro
   cannot be rented by a bare key, though a harvester with an AWS account can
   register through the Nitro attestor path below) that an EVM wallet can rent
   and extend, with a remote-attestation quote we can verify.
2. **Model inference** payable per request in USDC, since Anthropic's API
   takes cards only (third-party crypto cards and gift-subscription resellers
   exist, but they are manual and off-policy).
3. **A payment path from the brain's money to the host.** Brains pay a
   per-trade runtime fee (`ExecutionGuard.runtimeFeeOf`) in the base asset on
   our chain; the farm's executor key accumulates it.
4. **On-chain attestation verification** so `RuntimeRegistry.attested()` can
   mean "hardware says so" instead of "self-reported".

## Providers evaluated

| Provider | TEE | How you pay | Programmatic? | Attestation | Fit |
|---|---|---|---|---|---|
| **Marlin Oyster CVM** | Intel TDX operators (also Nitro operators; pin TDX) | USDC + a little ETH on **Arbitrum One**, per second, from a plain EVM key; a job on an on-chain market (`MarketV1` at `0x9d95D61eA056721E358BC49fE995caBF3B86A34B`, USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`): `oyster-cvm deploy --wallet-private-key … --duration-in-minutes …` opens it, `jobDeposit` extends it | Yes, no account: the key is the identity; the market's `jobs()`/`jobDeposit()` are plain contract calls | `oyster-cvm verify`; TDX quotes verifiable on-chain via Automata DCAP | **Best match** for "the brain pays": a funded key rents, verifies and extends a machine |
| **Phala Cloud** | Intel TDX CVMs (also SGX/SEV/GPU TEE) | USD credits: Stripe, **crypto via Coinbase Commerce (any ERC-20 on Base swappable to USDC)**, wire; tdx.small $0.06/h, tdx.medium $0.12/h, $20 free credits | TS/Python/Go SDKs + CLI with API key; credit top-up is a checkout, not a contract call | dstack; TDX quote; ERC-8004 TEE-agent reference verifies TDX on-chain; KMS with in-TEE key derivation | **Best tooling and attestation story**; payment is account-based credits, so one human step per top-up unless they ship on-chain pay |
| **Oasis ROFL** | Intel TDX/SGX | Rent from a marketplace provider on **Sapphire** (playground 2 vCPU/4 GB at 5 TEST/h on testnet; mainnet in ROSE); on-chain billing, KMS, app registry | Yes (`oasis rofl deploy`, EVM-compatible chain) | Quote endorsed by the node and registered on Sapphire; Sapphire contracts can verify ROFL origin | Strongest trustless-registry design; payment needs ROSE (swap/bridge) and attestation lives on Sapphire, not our chain |
| **Akash** | TDX or SEV-SNP, provider's choice; confidential compute GA 29 Jul 2026 | **USDC or AKT** on the Akash (Cosmos) chain; one SDL line (`params.tee: cpu`) | Yes (CLI/SDK), but Cosmos wallet + IBC to get USDC there | Attestation sidecar, evidence in Console | Cheap and decentralised; payment plumbing is the weakest for an EVM-native enclave |
| **Secret Network SecretVM** | TDX / SEV | Per-hour billing; SCRT (with bonus credits), other crypto via Cryptomus, cards; **USDC x402 "add-funds" for agents** covers VM management *and* confidential LLM inference on one balance | Yes; wallet signature is the agent identity | Attestations posted to Automata / zkVerify; KMS | Notable for pairing host + inference under one USDC balance paid by signature |
| **iExec** | TDX iApps | **RLC on Arbitrum**, per task; RLC is staked for the task duration | Yes (SDK) | SGX/TDX tasks | Task model suits "a tick is a task", but no long-lived endpoint and a protocol-specific token |
| **Lit Protocol v3** | TEE node network | Credits: $0.01 per second of Lit Action execution; funded by card, crypto (ETH/USDC/SOL), later $LITKEY | Yes; anyone can trigger an action and pay | Network-level | Not a host; **the right tool for the Polymarket question** (a PKP signs orders only when a Lit Action says policy allows) |
| **Fleek Machines** | TEE VMs, Docker | Stripe billing; USDC mentioned across services | SDK/CLI | Reproducible builds + remote attestation | Early access; payment least autonomous |
| **Super Protocol** | TEE (GPU-centric), orchestrated by contracts **on Polygon** | TEE token | SPCTL CLI | Marketplace attestation | On our chain, but token-specific and GPU-first; docs were unreachable during this pass |
| **Automata DCAP** | (verifier, not a host) | — | `verifyAndAttestOnChain(quote)` (payable, gas-proportional fee, excess refunded) or a ZK-proof path; v1.1 deployed at `0xaDdeC7e85c2182202b66E331f2a4A0bBB2cEEa1F` on **Polygon, Polygon Amoy**, Arbitrum One and Sepolia, Base and Base Sepolia, Optimism, BSC, Avalanche, World Chain, Unichain, HyperEVM | Intel SGX/TDX, SEV-SNP, Nitro | The piece that turns `RuntimeRegistry.register` into a real check; confirmed on our chain |

Inference, separately: **Phala / RedPill** expose an OpenAI-compatible gateway
served from GPU TEEs with a signed receipt per response, priced around $0.30
per M input and $1.50 per M output tokens and payable in crypto; **SecretAI**
does the same over x402 with USDC by wallet signature. Either replaces the
Anthropic key for a fully crypto-paid stack; `GatewayBrain` in
`agent/src/brain.ts` speaks that interface.

## Recommendation

**Host the farm on Marlin Oyster CVM, pinned to Intel TDX operators, and let
the farm pay for itself.** It is the only option where a bare EVM key rents,
verifies and extends a confidential machine with no account, which is what
"the brain's crypto pays, minimal interaction" actually requires. Keep
**Phala Cloud** as the development and fallback host (best SDK, $0.06/h,
attestation already proven on-chain by the ERC-8004 reference), accepting
that its top-ups are a checkout step. Use a **TEE inference gateway paid in
USDC** (Phala/RedPill or SecretAI x402) for the model calls. Verify TDX quotes
through **Automata DCAP** and feed the result into `RuntimeRegistry`.

The money loop:

```
brain's wallet / vault ──runtime fee (base asset, per trade)──▶ executor key (farm)
executor key ──Circle CCTP v2 (USDC, programmatic)──▶ same key on Arbitrum One
executor key ──jobDeposit on the Oyster market (USDC/sec)──▶ the TDX machine the farm runs in
executor key ──USDC per request──▶ TEE inference gateway
```

The owner's only actions remain the ones the Terminal already has: mint,
fund, enrol, set the runtime fee. Nothing else is asked of them.

### Numbers (order of magnitude)

- Host: one small TDX CVM ($0.06–0.15/h on Phala; Oyster operators are priced
  per second in the same range) ≈ **$1.5–4 a day for the whole farm**, shared
  across every enrolled brain.
- Inference: a tick is ~1–2k tokens ≈ **$0.002–0.01**; at 24 ticks/day ≈
  $0.05–0.25 per brain per day.
- Gas on Polygon: negligible at current fees; on anvil with gas priced at
  2,000 per native token a trade books at ≈ 0.3 base units, which is why the
  dev seed asks 1 per trade.
- A runtime fee of 1 mUSDC per trade at 24 trades/day is $24/brain/day, so the
  default asked fee is generous; on mainnet it should be set from measured
  cost with a margin, not guessed — and the farm now measures it.

### Why not the others as primary

Oasis ROFL has the cleanest on-chain registration, but rent is in ROSE and the
attestation record lives on Sapphire, so our Polygon contracts would need a
relay to read it. Akash is cheapest but paying it from an EVM enclave means a
Cosmos wallet and IBC. iExec's per-task model and RLC staking fit a serverless
tick but not the long-lived `/compose` endpoint. Lit is not a host, but it is
the answer to "the TBA must sign Polymarket orders under policy" and should be
picked up there.

## What is built

1. **Farm self-funding** (`agent/src/budget.ts`, `agent/src/host.ts`). The farm
   keeps a ledger per brain: runtime fees received (the `RuntimeFeePaid` logs to
   its key, recomputed from the chain) against what the brain's ticks cost it
   (model tokens at a per-model price, gas priced through `FARM_NATIVE_PRICE`);
   a brain may run `FARM_GRACE` of cost on credit, after which it is paused and
   the log states the per-trade fee that would have covered it; raising the
   fee writes the debt off once and resumes it. The machine lease is read from
   an Oyster-compatible market (`jobs`, rate per second scaled by
   `EXTRA_DECIMALS`) and topped up with `jobDeposit` from the executor key's
   float when fewer than `FARM_HOST_MIN_SECONDS` remain; every payment is
   logged with its transaction and recorded. `FARM_HOST=oyster` points at
   Marlin's market on Arbitrum One; `FARM_HOST=market` runs the identical code
   against `MockOysterMarket`, deployed with the protocol and given a prepaid
   job by `seed-dev.sh`, which is how the loop is exercised on anvil (it was:
   lease read at 119 minutes left, 2.88 mUSDC paid for 24 hours more, trades
   priced, a fee-0 brain paused past its credit with the covering fee printed,
   resumed on a fee raise). `/health` and `/ledger` expose the books; the
   Terminal shows them in My Desk and the Developer tab.
   **Harvesters.** Anyone can run a farm; an owner chooses one by setting its
   key as executor, and the site calls whoever runs a farm a harvester. The
   guard pays the runtime fee only for evidence: only to an executor the
   RuntimeRegistry marks attested, only on trades of at least
   `minFeeNotionalBps` of NAV (dust cannot be churned for fees), with raises
   taking effect after `runtimeFeeDelay` (a day on public testnets) and every
   trade carrying the keccak256 of its inference transcript
   (`executeTradeWithTranscript`); the farm keeps the transcripts under their
   hashes (`FARM_TRANSCRIPTS_DIR`) for audit. A farm whose measurement is not
   approved runs its brains but is not paid, and says so at start. Owners can
   also escrow rent with the guard (`fundRuntime`): when a traded book cannot
   cover the fee, the guard draws the same capped amount from the escrow
   (`RuntimeEscrowDraw`), so a thin book keeps paying its way instead of
   running up credit; owner-withdrawable, refunded on reap or cull.
2. **Inference backend.** `GatewayBrain` next to `ClaudeBrain`: OpenAI-compatible
   chat completions with a forced tool call, `INFERENCE_BASE_URL` /
   `INFERENCE_API_KEY`, usage priced by `INFERENCE_PRICE_IN/OUT`. Selected
   automatically when the URL is set; the on-chain model trait names the model.
   Owners may also bring their own key: a sealed `inference` credential
   published through `Credentials` (set `CREDENTIALS_ADDRESS`) puts the brain on
   the owner's Anthropic or gateway account; the farm prices those tokens at
   zero. `FARM_INFERENCE_HOSTS` lists extra gateway hosts an owner's key may be
   sent to (Anthropic and `INFERENCE_BASE_URL` are always allowed); anything
   else is refused, since the sealed prompt travels with the request.
3. **Attested registration.** `RuntimeRegistry.registerAttested(quote, enclaveKey)`
   through `IQuoteVerifier`; `AutomataDcapTdxVerifier` wraps Automata's
   entrypoint and reads the TD report (MRTD, RTMRs, report data) out of its
   serialized output; the registry requires the report data to commit to the
   executor key and the enclave key, so the binding is the hardware's claim.
   `attestationOf` distinguishes self-reported from hardware; `attested()`
   still requires a deployer-approved measurement either way. Wired by
   `deploy-testnet.sh` on chains where the entrypoint exists (Amoy included).
   The farm registers attested when `FARM_QUOTE_PATH` holds a quote, and prints
   at start the report data the quote must carry. `NitroAttestationVerifier`
   adds a second evidence format for harvesters on AWS Nitro: an approved
   attestor (an off-chain verifier, itself an enclave) checks the raw
   attestation document and signs a compact statement — measurement over the
   PCRs, report data, issued-at — that the adapter checks with ecrecover
   against approved keys and a freshness bound; `QuoteVerifierRouter` tries
   DCAP first, then Nitro, so both formats register through the registry's one
   verifier slot. The trust root is one link longer (the deployer approves
   attestor keys), disclosed; it still counts as hardware because the binding
   comes from an attestation document, not the key's claim. The farm we run
   stays on TDX — a bare key cannot rent Nitro — but an operator with an AWS
   account can harvest from one.
4. **Bridge.** `agent/src/bridge.ts` (`npm run bridge`): CCTP v2 burn on the
   protocol chain, Iris attestation, mint on Arbitrum; mainnet addresses and
   testnet addresses, domains 7 → 3. The farm prints the command when it cannot
   extend the lease for lack of float. On testnet the base asset is a mock, so
   the bridge has meaning on mainnet only.
5. **Docs and paper.** The paper's §6.2 describes the fee, the escrow
   backstop, the credit policy and the lease; §6.1 the evidence formats (TDX
   quote, Nitro attestor statement); the declared cadence is now enforced
   on-chain, which is what bounds the fee per day.

## Runbook

**Locally.** `anvil --silent &`, `./protocol/script/seed-dev.sh`, then the farm
command the seed prints (it includes `FARM_HOST=market`, the mock market, the
job id and `FARM_NATIVE_PRICE=2000`). Watch `/health` on the endpoint or the
Developer tab. The job starts with two hours prepaid so the first extension
happens within the first lease check.

**On Marlin Oyster.**

1. Build the farm image (a Docker compose with `npm run farm` and the env
   below; `oyster-cvm build` for a reproducible image, `oyster-cvm upload`).
2. From the executor key, funded with USDC and a little ETH on Arbitrum One:
   `oyster-cvm deploy --wallet-private-key <executor key> --duration-in-minutes
   1440 --docker-compose compose.yml --arch amd64` on a TDX operator. Note the
   job id from the logs. `oyster-cvm list --address <executor address>` shows
   rate (USDC/hour), balance and time left.
3. Keys inside the CVM: the enclave sealing key and the executor key should be
   derived in-enclave (Oyster's KMS derive server, port 1100, keys that persist
   across redeploys of the same image id) rather than passed in; until that is
   wired, pass them as init parameters and treat the image as operator-trusted.
4. Farm env on the machine: `FARM_HOST=oyster OYSTER_JOB_ID=<job id>`, the
   protocol addresses and `RPC_URL` for Polygon, `REGISTRY_ADDRESS`,
   `FARM_MIN_FEE`, `FARM_GRACE`, `FARM_NATIVE_PRICE` (POL in USDC),
   `INFERENCE_BASE_URL` + `INFERENCE_API_KEY` (or an Anthropic key for the
   interim), `FARM_HTTP_PORT`. The lease loop then keeps the job topped up
   from the key's USDC on Arbitrum; `npm run bridge -- --amount <usdc> --to
   42161` moves fee income across when the float runs low (the farm prints the
   exact command).
5. Attestation: have the enclave request a TDX quote whose report data is the
   hash the farm prints at start (`keccak256(executor ‖ enclave public key)`),
   put it in `FARM_QUOTE_PATH`, set `FARM_QUOTE_FEE` (the verifier's native
   fee), restart; the farm calls `registerAttested`. Reproduce the image and
   `approveMeasurement` the measurement the verifier reports; brains running
   under that key then show "attested runtime · TDX quote".

**On Phala Cloud (fallback).** Same image via the Phala CLI; the lease is
credits, so run with `FARM_HOST=none FARM_HOST_RATE=0.12` to price the machine
in the ledger, and top credits up by hand.

## What remains

Running the image on a TDX operator and producing the quote (the operational
half of attestation); in-enclave key derivation; a funded inference gateway
account; and, on mainnet only, the bridge in earnest. The Marlin market's
`EXTRA_DECIMALS` and settlement arithmetic were taken from the Oyster CLI's
source (rate per second, balance scaled to 1e18) and should be confirmed
against a live job before the first real extension; the mock follows the same
convention so the farm's arithmetic is the same in both places.

Sources consulted: Marlin docs (Oyster CVM quickstart, deposit/withdraw,
persistent keys, contract addresses) and the `oyster-cvm` source in
`oyster-monorepo` (market ABI, Arbitrum configuration, list/deploy
arithmetic); Phala Cloud pricing/billing/API docs and the ERC-8004 TEE-agent
repo; Oasis ROFL docs (overview, marketplace, deploy); Akash 2026 roadmap and
confidential-compute AEP; Secret Network SecretVM and x402 docs; iExec RLC
docs; Lit v3 announcement and pricing docs; Fleek Machines announcement; Super
Protocol docs (403 during this pass); the Automata DCAP repository (EVM README,
`CommonStruct.sol`, `TDXStruct.sol`, `QuoteVerifierBase.sol`,
`FeeManagerBase.sol`, v1.1 deployment registry); Circle's CCTP v2 contract
and API references and USDC address list; RedPill/Phala inference pricing
pages.
