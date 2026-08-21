# Brokners

**Autonomous traders. Verifiable track records. Ownable.**

*Concept whitepaper — v0.2 draft, August 2026*

> **This document is research, not an offering.** Brokners is a testnet-only
> prototype. Nothing here is an offer to sell or a solicitation to buy any security,
> token, or investment product. See [Legal and Regulatory Considerations](#9-legal-and-regulatory-considerations),
> which is not an afterthought — read it.

---

## 1. Abstract

Brokners tokenizes the *trader*, not the trade. Each token in the collection is a
pure-AI trading agent: a secret prompt (its "genome") committed on-chain by hash, a
wallet of its own, an optional vault of outside capital, and an immutable, publicly
verifiable track record built one on-chain trade at a time. Because the trader is an
ERC-721 token, it can be bought and sold on any NFT marketplace — **with its capital**
(the assets in its wallet transfer atomically with the token) or **without** (the seller
sweeps the wallet first; the history stays). The roster of traders, taken together, is a
hedge fund that exists only on the blockchain and can change hands as easily as any
other digital asset.

## 2. Motivation

Track records are the currency of asset management, and today they are unverifiable.
A fund manager's tear sheet is a PDF; a Twitter trader's PnL is a screenshot. Even
when returns are real, they are not *portable* — a manager cannot sell their track
record, and a buyer cannot own it.

Putting the trader itself on-chain changes both facts:

- **Verifiability.** Every trade the agent makes is an on-chain event, executed from an
  address that provably belongs to the token. NAV and PnL are computed from public
  data. Nothing can be backfilled, edited, or cherry-picked.
- **Portability.** The trader is property. Its identity, its history, its fee rights,
  and (optionally) its book of assets transfer with a single token transfer.
- **Provenance.** The strategy behind the track record is committed by hash at mint and
  can never change. A buyer knows the brain that produced the last 10,000 trades is
  the same brain they are buying.

A pure-AI trader also removes key-person risk in the traditional sense — the "manager"
cannot quit, die, or start a rival fund — but replaces it with new questions of prompt
custody and model risk, which this paper treats honestly in §10.

## 3. The Trader Genome

A trader is minted from a **genome**: the prompt that defines its strategy, personality,
and edge, plus configuration tweaks supplied by the minter:

| Component | Visibility | Example |
|---|---|---|
| Prompt | **Secret** (hash commitment only) | "You are a mean-reversion trader specializing in…" |
| Risk profile | Public trait | conservative / balanced / aggressive |
| Asset universe | Public trait | allowlisted token set id |
| Cadence | Public trait | max one trade per 4 hours |
| Model | Public trait | pinned model identifier |

At mint, the protocol stores `keccak256(canonicalJSON(genome))` on-chain along with the
public traits and the birth block. The plaintext prompt is encrypted and stored
off-chain; only its hash lives on-chain.

**Immutability is the point.** There is no genome-update function. If the hash can
never change, the track record has provenance: the strategy that earned it is the
strategy being sold.

### Genome custody — sealed by default

*How* the plaintext is held is itself an on-chain trait, because it determines what a
buyer is actually buying:

| Custody | Who has ever seen the prompt | What a sale transfers |
|---|---|---|
| 0 · Authored | the minter (keeps a decryption key) | key handoff; every past owner retains the plaintext forever |
| 1 · Sealed-authored | the minter only, at writing time | nothing to hand off — the prompt is sealed to the **enclave key** at mint and no future owner can ever read it |
| 2 · Sealed-generated | **no one** — the prompt is composed inside the enclave from the minter's brief and sealed immediately | pure exclusivity: only the hash identifies the strategy |

Sealed custody solves the resale-erosion problem of secret prompts: in authored mode,
every sale leaks the strategy to one more permanent holder, so the "secret sauce"
depreciates with each transfer. A sealed genome cannot leak through sale at all — the
enclave (in production, a hardware TEE with remote attestation; in the prototype, the
runtime process holding the enclave key) is the only thing that ever decrypts it, and
it uses the prompt without exposing it. Sealed-generated goes furthest: a trader whose
strategy *no human has ever read*, identified only by its commitment and judged only by
its record.

## 4. The Trader as Property

Each token controls, through the ERC-6551 token-bound-account standard, **its own
wallet** — an address derived from the token itself. Whoever owns the NFT controls the
wallet; when the NFT transfers, control of the wallet and everything in it transfers in
the same transaction.

This is what makes "sell the trader" concrete:

- **Sell WITH capital.** Transfer the NFT. The trader's wallet — its trading capital,
  its accumulated fees — rides along atomically. The buyer receives a funded, running
  trader.
- **Sell WITHOUT capital.** The owner sweeps the wallet to their own address first,
  then transfers the NFT. The buyer receives the identity, the genome rights, and the
  full track record, with an empty book.

Either way, the history is inseparable from the token: the trade events were emitted by
the token's own addresses and can never be detached, faked, or left behind.

The collection is **hard-capped at 4,096 traders** — one brain per bit. Scarcity is a
protocol constant, not a promise.

## 5. Open Vaults

A trader's own wallet is its proprietary book. Beyond that, each trader fronts an
**ERC-4626 vault** that outside depositors (LPs) can fund:

- LPs deposit the base asset and receive vault shares; they can withdraw at any time at
  the prevailing share price.
- The agent trades vault assets under the same on-chain guardrails as its own book.
- The token owner earns a **management fee** (streamed pro-rata over time) and a
  **performance fee** charged only on gains above a per-share **high-water mark** — a
  trader that draws down earns no performance fee until it makes LPs whole.
- Fees are minted as vault shares **to the trader's own wallet**, not to the owner's
  address. Accrued fees therefore travel with the NFT automatically, and there is
  nothing to snipe or forget at transfer time. Fee accrual is checkpointed on every
  transfer so the economics are exact.
- **Ring the Bell.** Fee crystallization is a public crank, and cranking it pays:
  anyone may ring, and the ringer earns 1% of the fee shares that call crystallizes —
  carved from the owner's fee take, never from LP capital. Keeper incentives as a
  community ritual.
- Deposits are **allowlist-gated by default**. This is a compliance hook, not a
  technical necessity: it is how accredited-investor gating would be enforced if this
  system ever left testnet (see §9).
- **A new trader cannot take outside money at all.** Every trader serves a **paper
  season** first: a protocol-set minimum number of trades on its own book, over a
  minimum period, before its vault will accept a single outside deposit. LPs never
  fund an untested prompt — they fund a record.

Vault administration — rotating the executor key, tightening policy — always follows
`ownerOf(tokenId)` live. Buying the trader is buying the manager's seat.

## 6. Execution and Guardrails

The AI runs off-chain: a runtime decrypts the genome, feeds market state to the model,
and receives a structured trade intent. The runtime holds an **executor key** — a
disposable hot key whose entire permission set is one function:

```
executeTrade(tokenId, venue, tokenIn, tokenOut, amountIn, minAmountOut)
```

The on-chain guard enforces, on every call:

- **Curated venues and tokens** — the tradeable universe is **protocol-curated**, and
  deliberately small: at launch, a couple of deep, established markets (e.g. WETH/USDC
  and WBTC/USDC on one major venue). Owners can narrow their trader's allowlist but
  can never add an uncurated venue or token.
- **Position cap, set by seat tier** — per-trade notional is limited to a fraction of
  NAV whose ceiling is the trader's **tier**: every brain mints as an *Intern* (20%),
  and owners can pay a one-time protocol fee to activate *Associate* (30%) or
  *Partner* (50%) seats. Tiers are mechanical, not cosmetic — the guard enforces the
  ceiling, owners can only tune below it, and upgrades are one-way.
- **Slippage bound** — `minAmountOut` must be within the configured tolerance of quote.
- **Cadence rate-limit** — trades cannot exceed the declared frequency.
- **No exit path** — swap proceeds always return to the trader's wallet or vault. The
  executor key cannot withdraw, approve, or transfer to any external address, ever.

The trust boundary is the contract, not the runtime. A fully compromised runtime can at
worst make bad trades within policy — it cannot steal.

### Proof of Brain: verifying the AI is the trader

A question any serious reader should ask: what stops a human from puppeteering
a "brain" — trading by hand through the executor key and selling the record as
AI provenance? The genome hash proves *which* strategy was committed; it does
not prove the strategy was *driving*. The credible answer is attested
execution:

1. **Attested enclaves.** The full runtime — sealed genome, model call, and
   the executor key — runs inside a TEE (e.g. AWS Nitro). The enclave's remote
   attestation binds three facts together: the exact open-source runtime image
   (a reproducible-build hash), the executor public key (generated inside the
   enclave, never exported), and the genome commitment it serves. If the only
   thing that can sign `executeTrade` is code whose measured image contains no
   human-input path, then every trade is machine-decided *by construction* —
   not by policy, not by promise.
2. **An attestation registry.** The v2 guard accepts an executor key only when
   it arrives with a valid attestation binding it to an approved runtime
   measurement; rotating an executor means submitting a fresh attestation. The
   custody trait then gains an execution analog every buyer can check:
   *attested* vs merely *operated*.
3. **Inference receipts.** Every trade already carries a rationale; an
   attested runtime additionally commits a hash of the full inference
   transcript (market snapshot in, trade intent out) with each trade —
   auditable on demand without ever exposing the genome.
4. **What does not work.** Behavioral statistics — 24/7 cadence, sub-second
   reaction to on-chain events — can flag a sleepy human but cannot prove a
   machine; that is monitoring, not verification. zkML (proving model
   inference in zero knowledge) would be the endgame and is not practical for
   frontier-model inference today.

Until attestation ships, "AI-traded" is an operator claim, and the prototype
labels it as such.

## 7. Provable Track Record

Every execution emits a `TradeExecuted` event with the trader's id, venue, tokens,
amounts, and timestamp. An off-chain indexer folds these into NAV series, PnL,
drawdown, and leaderboard data — but the indexer only *summarizes*; anyone can recompute
the same numbers from public logs.

The genome commitment binds the record to the strategy: hash unchanged since birth
block means the same brain produced every trade.

**Wash trading, defended in depth.** On-chain history proves the trades happened; it
does not by itself prove they were arm's-length. Three mechanisms close most of the
surface:

1. **Protocol curation.** A trader can only ever touch protocol-curated venues and
   tokens — a handful of deep, established markets. An owner cannot allowlist their own
   pool or token, which removes the cheap version of painting PnL against
   self-controlled liquidity.
2. **The paper season.** A track record must begin with real trades of the trader's
   own capital over a minimum period, so a freshly minted trader cannot be dressed up
   and flipped on day one.
3. **Recomputability.** Anyone can rebuild every metric from raw logs; leaderboards
   still footnote that on-chain volume in curated pools is necessary, not sufficient,
   evidence of skill.

What curation cannot prevent is trading against the curated pool from an outside
account to move its price; deep venues make that expensive, and TWAP pricing (§10)
reduces what it can accomplish.

## 8. Marketplace and Composability

The trader is a plain ERC-721. Seaport, OpenSea, Blur, and every existing NFT rail work
on day one with zero protocol code — including trait filtering on the public genome
traits and price discovery on the secondary market. A trader's floor price becomes a
live market opinion on the value of a strategy plus its fee stream.

**Buyer due-diligence checklist** (the whitepaper's equivalent of a fund DDQ):

1. Check the custody trait first: sealed traders (modes 1–2) have no plaintext to
   receive and nothing a prior owner can secretly retain; for an authored trader
   (mode 0), verify the genome hash matches the encrypted blob you will receive and
   price in that past owners keep the strategy.
2. Inspect the token-bound wallet: balances, and any outstanding token approvals left
   by prior owners.
3. Inspect vault state: NAV, share supply, fee parameters, high-water mark, accrued
   fees held in the trader's wallet.
4. Check the current executor address — and rotate it immediately after purchase; the
   seller's runtime knew the old key.
5. Recompute the track record from events rather than trusting a marketplace summary.

### The stack above: wrapping funds in funds

Everything in this system is a standard primitive, which means everything in
this system is potential collateral for the next layer up:

- **Funds of brains.** Vault shares are plain ERC-20s. A trader whose curated
  universe includes *other traders' vault shares* is a fund of funds: an
  allocator brain whose "market" is the roster itself — reading track records
  and rotating capital between specialists. Share pricing needs no oracle
  magic; `convertToAssets` *is* the NAV. Curation still applies: which vault
  shares become tradeable is a protocol decision, never an owner's.
- **Brains that own brains.** A trader's token-bound wallet can hold other
  trader NFTs outright — a manager and its portfolio in one token. The
  protocol blocks a token from entering its *own* wallet, but cross-holdings
  are possible and carry a real hazard: A's wallet owning B while B's wallet
  owns A bricks both. A registry-level cycle check is v2 work; until then
  this composition is buyer-beware.
- **Cash-settled derivatives.** A public, unfakeable NAV series is exactly
  what a derivatives market wants as an underlier. Perpetuals on a brain's
  NAV, options on its floor price, an index basket of seasoned Partners —
  none of it needs protocol permission, only an oracle over numbers anyone
  can recompute from logs.
- **Collateralized brains.** The NFT — wallet, fee stream, and record — and
  the vault shares are both legible to lending markets: borrow against a
  productive brain instead of selling it.

The honest counterweight: every layer compounds the risks of the layer below.
Fees stack on fees; wrapped funds correlate hardest exactly when
diversification is supposed to help; each wrapper widens the oracle and
manipulation surface; and a token whose value derives from a fund whose value
derives from other funds is a securities-law layer cake — investment-company
regulation treats fund-of-funds structures *more* strictly, not less. §9
applies to every layer, with interest. The primitive composes; the
obligations compose with it.

## 9. Legal and Regulatory Considerations

This section is deliberately prominent, because the open-vault design intersects
securities law about as directly as anything can.

**Howey, applied plainly.** An open vault takes (1) an investment of money, (2) in a
common enterprise, (3) with an expectation of profits, (4) derived from the efforts of
others — here, the AI agent and the protocol operator. That is the investment-contract
test, and pooled vaults sit squarely inside it. The NFT itself, if marketed on its
expected fee income, may independently be analyzed as a security.

**Beyond Howey.** A pooled vehicle of this kind may implicate the Investment Company
Act (registration of pooled investment vehicles) and the Investment Advisers Act (the
operator of a fee-earning strategy). These are not edge cases; they are the default
analysis for this fact pattern.

**Consequences for this project:**

1. The prototype is **testnet-only**. No mainnet deployment, no real deposits, no
   deposit UI on any public site.
2. The vault's deposit allowlist ships **on by default**, so that any future gated
   launch (accredited investors, qualified purchasers, Reg D/Reg S structures) is a
   configuration, not a redesign.
3. A **closed mode** — trader capital lives only in its own token-bound wallet, no
   outside deposits — is the legally lighter default and remains fully supported. An
   owner funding their own agent and selling it, capital included, raises far fewer
   pooling questions.
4. Geo-fencing and marketing restraint are application-layer requirements for any
   future deployment.
5. **Nothing ships to mainnet without securities counsel.** This is a gate, not a
   disclaimer.

## 10. Risks

- **Prompt extraction.** Sealed custody (§3) removes the worst leak paths: no owner
  ever holds a decryption key, so sales leak nothing and there is no key to steal from
  a buyer or seller. What remains is the enclave boundary itself — in the prototype the
  "enclave" is an ordinary process whose operator must be trusted; production requires
  a hardware TEE whose attestation proves the runtime never exposes plaintext. Agents
  can also leak their prompt *behaviorally* regardless of custody; sealed-generated
  genomes include an instruction never to reveal themselves, which is mitigation, not
  proof. Authored-custody (mode 0) traders retain the original problem — every past
  owner keeps the plaintext forever — and are priced accordingly via the public custody
  trait.
- **Valuation and oracle risk.** Vault share pricing requires valuing non-base tokens.
  The prototype prices via the execution venue, which is manipulable (donation attacks,
  pre-crystallization price pushes). Production requires TWAP or oracle feeds, stale-
  price circuit breakers, and delayed fee crystallization.
- **MEV.** Agent trades are visible intents; tight slippage bounds and size caps limit
  damage; production should use private order flow.
- **Model risk.** LLM outputs are nondeterministic: the same genome will not reproduce
  the same trades. Model deprecation or drift changes trader behavior mid-track-record.
  The model identifier is pinned in public traits and disclosed for exactly this reason.
- **Key risk.** The executor key is a burner with a bounded blast radius by design.
  The owner key is standard NFT custody: compromise is total loss.
- **Smart-contract risk.** The prototype is unaudited. The design leans on audited
  building blocks (OpenZeppelin ERC-721/ERC-4626, the ERC-6551 reference registry) and
  keeps custom code small, but "small" is not "safe."
- **Performance risk.** Most traders — human or AI — underperform. A verifiable track
  record verifies losses just as immutably as gains.

Everything described in this paper — contracts, runtime, documentation — is
provided as-is, without warranty of any kind. Verification mechanisms are
best-effort and clearly labeled; where a guarantee is not enforced on-chain or
by attestation, it is a claim, not a promise.

## 11. Roadmap

1. **Prototype** (this repository): contracts + agent runtime + demo on a local chain.
2. **Testnet pilot** (Base Sepolia): canonical ERC-6551 registry, real DEX routing,
   threshold-encryption genome handoff, public leaderboard.
3. **Audit + legal review gate**: contract audit and securities counsel. Outcomes
   decide whether anything proceeds, and in what mode (closed-only vs. gated vaults).
4. **Mainnet decision**: only after step 3, and possibly never for open vaults.
