# Where the enclave runs, and who pays for it

*Research memo, August 2026. Constraint set by the owner: no AWS; the runtime
must be paid for out of the crypto that seeds a brain; the owner should have
to do as little as possible.*

## The requirement, precisely

The farm (`agent/src/farm.ts`) is one long-lived process that runs every
enrolled brain: it holds the enclave sealing key and the executor key, opens
published jars, calls a model, and signs `executeTrade`. To satisfy the
constraint it needs four things, each payable in crypto by a program, not a
person:

1. **A TEE host** (Intel TDX or AMD SEV-SNP; not AWS Nitro) that an EVM wallet
   can rent and extend, with a remote-attestation quote we can verify.
2. **Model inference** payable per request in USDC, since Anthropic's API
   takes cards only (third-party crypto cards and gift-subscription resellers
   exist, but they are manual and off-policy).
3. **A payment path from the brain's money to the host.** Brains pay a
   per-trade runtime fee (already built: `ExecutionGuard.runtimeFeeOf`) in the
   base asset on our chain; the farm's executor key accumulates it.
4. **On-chain attestation verification** so `RuntimeRegistry.attested()` can
   mean "hardware says so" instead of "self-reported".

## Providers evaluated

| Provider | TEE | How you pay | Programmatic? | Attestation | Fit |
|---|---|---|---|---|---|
| **Marlin Oyster CVM** | Intel TDX operators (also Nitro operators; pin TDX) | USDC + a little ETH on **Arbitrum One**, per minute, from a plain EVM key: `oyster-cvm deploy --wallet-private-key … --duration-in-minutes …` | Yes, no account: the key is the identity | `oyster-cvm verify`; TDX quotes verifiable on-chain via Automata DCAP | **Best match** for "the brain pays": a script with a funded key rents and extends a machine |
| **Phala Cloud** | Intel TDX CVMs (also SGX/SEV/GPU TEE) | USD credits: Stripe, **crypto via Coinbase Commerce (any ERC-20 on Base swappable to USDC)**, wire; tdx.small $0.06/h, tdx.medium $0.12/h, $20 free credits | TS/Python/Go SDKs + CLI with API key; credit top-up is a checkout, not a contract call | dstack; TDX quote; ERC-8004 TEE-agent reference verifies TDX on-chain; KMS with in-TEE key derivation | **Best tooling and attestation story**; payment is account-based credits, so one human step per top-up unless they ship on-chain pay |
| **Oasis ROFL** | Intel TDX/SGX | Rent from a marketplace provider on **Sapphire** (playground 2 vCPU/4 GB at 5 TEST/h on testnet; mainnet in ROSE); on-chain billing, KMS, app registry | Yes (`oasis rofl deploy`, EVM-compatible chain) | Quote endorsed by the node and registered on Sapphire; Sapphire contracts can verify ROFL origin | Strongest trustless-registry design; payment needs ROSE (swap/bridge) and attestation lives on Sapphire, not our chain |
| **Akash** | TDX or SEV-SNP, provider's choice; confidential compute GA 29 Jul 2026 | **USDC or AKT** on the Akash (Cosmos) chain; one SDL line (`params.tee: cpu`) | Yes (CLI/SDK), but Cosmos wallet + IBC to get USDC there | Attestation sidecar, evidence in Console | Cheap and decentralised; payment plumbing is the weakest for an EVM-native enclave |
| **Secret Network SecretVM** | TDX / SEV | Per-hour billing; SCRT (with bonus credits), other crypto via Cryptomus, cards; **USDC x402 "add-funds" for agents** covers VM management *and* confidential LLM inference on one balance | Yes; wallet signature is the agent identity | Attestations posted to Automata / zkVerify; KMS | Notable for pairing host + inference under one USDC balance paid by signature |
| **iExec** | TDX iApps | **RLC on Arbitrum**, per task; RLC is staked for the task duration | Yes (SDK) | SGX/TDX tasks | Task model suits "a tick is a task", but no long-lived endpoint and a protocol-specific token |
| **Lit Protocol v3** | TEE node network | Credits: $0.01 per second of Lit Action execution; funded by card, crypto (ETH/USDC/SOL), later $LITKEY | Yes; anyone can trigger an action and pay | Network-level | Not a host; **the right tool for the Polymarket question** (a PKP signs orders only when a Lit Action says policy allows) |
| **Fleek Machines** | TEE VMs, Docker | Stripe billing; USDC mentioned across services | SDK/CLI | Reproducible builds + remote attestation | Early access; payment least autonomous |
| **Super Protocol** | TEE (GPU-centric), orchestrated by contracts **on Polygon** | TEE token | SPCTL CLI | Marketplace attestation | On our chain, but token-specific and GPU-first; docs were unreachable during this pass |
| **Automata DCAP** | (verifier, not a host) | — | `verifyAndAttestOnChain(quote)` or ZK-proof path, deployed on 20+ EVM networks (v1.1, Nov 2025); Polygon not confirmed in this pass | Intel SGX/TDX, SEV-SNP, Nitro | The piece that turns `RuntimeRegistry.register` into a real check |

Inference, separately: **Phala / RedPill** expose an OpenAI-compatible gateway
(`https://inference.phala.com/v1`) served from GPU TEEs with a signed receipt
per response, priced around $0.30 per M input and $1.50 per M output tokens and
payable in crypto; **SecretAI** does the same over x402 with USDC by wallet
signature. Either replaces the Anthropic key for a fully crypto-paid stack;
the `Brain` interface already abstracts the model call.

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
executor key ──Circle CCTP (USDC, programmatic)──▶ same key on Arbitrum One
executor key ──oyster-cvm extend (USDC/min)──▶ the TDX machine the farm runs in
executor key ──USDC per request──▶ TEE inference gateway
```

The owner's only actions remain the ones the Terminal already has: mint,
fund, enrol, set the runtime fee. Nothing else is asked of them.

### Numbers (order of magnitude)

- Host: one small TDX CVM ($0.06–0.15/h on Phala; Oyster operators are priced
  per minute in the same range) ≈ **$1.5–4 a day for the whole farm**, shared
  across every enrolled brain.
- Inference: a tick is ~1–2k tokens ≈ **$0.002–0.01**; at 24 ticks/day ≈
  $0.05–0.25 per brain per day.
- Gas on Polygon: negligible at current fees.
- A runtime fee of 1 mUSDC per trade at 24 trades/day is $24/brain/day, so the
  default asked fee is generous; on mainnet it should be set from measured
  cost with a margin, not guessed.

### Why not the others as primary

Oasis ROFL has the cleanest on-chain registration, but rent is in ROSE and the
attestation record lives on Sapphire, so our Polygon contracts would need a
relay to read it. Akash is cheapest but paying it from an EVM enclave means a
Cosmos wallet and IBC. iExec's per-task model and RLC staking fit a serverless
tick but not the long-lived `/compose` endpoint. Lit is not a host, but it is
the answer to "the TBA must sign Polymarket orders under policy" and should be
picked up there.

## What changes in Brokners

1. **Farm self-funding.** A `lease` module in the farm: watch the machine's
   remaining rental, keep a USDC float on Arbitrum by bridging from Polygon
   (CCTP), and extend before expiry; log every payment. Until the real host is
   wired, the protocol treasury funds the lease and the runtime fee flows to
   it — the contract side already exists.
2. **Inference backend.** A second `Brain` implementation against an
   OpenAI-compatible TEE gateway (`INFERENCE_BASE_URL`, USDC-funded balance or
   x402 signer) next to `ClaudeBrain`; the model trait on-chain names which.
3. **Attested registration.** `RuntimeRegistry.registerAttested(quote, …)`
   that calls the Automata DCAP verifier when it is deployed on our chain;
   `register` (self-reported) stays as the fallback and the Terminal already
   labels the difference.
4. **Docs and paper.** "AWS Nitro" is gone from the paper, the backlog, and
   the code comments; the attestation text now says Intel TDX on a rented
   machine whose rent is paid in the base asset.

Sources consulted: Marlin docs (Oyster CVM quickstart, protocol, attestation
verification), Phala Cloud pricing/billing/API docs and the ERC-8004 TEE-agent
repo, Oasis ROFL docs (overview, marketplace, deploy), Akash 2026 roadmap and
confidential-compute AEP, Secret Network SecretVM and x402 docs, iExec RLC
docs, Lit v3 announcement and pricing docs, Fleek Machines announcement,
Super Protocol docs (403 during this pass), Automata DCAP repository and v1.1
release notes, and RedPill/Phala inference pricing pages.
