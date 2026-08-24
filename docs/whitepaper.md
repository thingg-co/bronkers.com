# Brokners

**Autonomous traders with verifiable, transferable track records**

*Concept paper, v0.7 working draft, August 2026*

> **Status.** This is a research document describing a testnet prototype. The
> contracts, runtime, and figures described here run on a local chain and on testnets
> only.

---

## 1. Introduction

This paper describes a protocol in which the unit of ownership is a trading agent
rather than a position, a fund share, or a strategy licence. Each agent is represented
by an ERC-721 token. Associated with the token are (i) a commitment to a secret prompt
that fully specifies the agent's behaviour, which we call its genome; (ii) a wallet
whose control is derived from the token; (iii) optionally, an ERC-4626 vault through
which third parties may allocate capital to the agent; and (iv) a trade history that
exists only as events emitted by addresses the token controls.

Because the agent is a token, it can be sold on any existing NFT marketplace. The seller
may transfer it together with the contents of its wallet, in which case the buyer
receives a capitalised, running agent, or may first withdraw the wallet and transfer the
token alone, in which case the buyer receives the identity, the genome rights, and the
history. In either case the history cannot be separated from the token. The collection
of agents, considered together, behaves like a multi-manager fund whose managers are
themselves transferable assets.

Most of the design decisions below follow from three requirements: that a track record
be recomputable by anyone from public data; that the strategy which produced each part
of it be fixed before that part begins; and that neither property be lost when ownership
changes.

The initial trading venue is Polymarket, a prediction market whose outcome tokens are
binary conditional tokens collateralised by USDC and settled on Polygon. We chose it for
three reasons that the rest of the paper relies on. Access is entirely programmatic,
through a public order-book API and public contracts, so an agent needs no intermediary
between itself and the market. Each position has a bounded and well-defined payoff,
which simplifies valuation and risk limits considerably compared with spot or leveraged
markets. And fills settle on-chain, so the record is legible in the way Section 7
requires. The venue interface is abstract, and other venues can be curated later.

## 2. Background and Motivation

Track records are the primary currency of asset management, and in their conventional
form they are weak evidence. A manager's tear sheet is a document produced by the
manager; a retail trader's profit-and-loss figure is a screenshot. Even a genuine
record is not transferable: a manager cannot sell it, and an acquirer cannot own it
independently of the person.

Placing the agent itself on-chain addresses both limitations. Every trade is a
transaction from an address that provably belongs to the token, so net asset value and
returns can be derived from public logs and cannot be edited or selectively reported
after the fact. The agent is property in the ordinary sense, so its identity, history,
fee entitlements, and (if the seller chooses) its assets move with a single transfer.
And because every strategy the agent has run was committed by hash before it traded and
is never edited in place, a buyer can tell which committed strategy produced each part of
the record and which one will produce the next trade.

An agent of this kind has no key-person risk in the usual meaning: it cannot resign,
fall ill, or leave to start a competing fund. It introduces other risks in their place,
principally around custody of the prompt and the behaviour of the underlying model, and
we treat these in Section 9.

## 3. The Genome: Commitment and Custody

An agent is minted from a genome consisting of a prompt, which defines strategy and
disposition, together with a small set of public configuration traits:

| Component | Visibility | Example |
|---|---|---|
| Prompt | Secret (hash commitment only) | "You are a mean-reversion trader specialising in…" |
| Risk profile | Public trait | conservative / balanced / aggressive |
| Asset universe | Public trait | identifier of a curated market set |
| Cadence | Public trait | at most one trade per four hours |
| Model | Public trait | pinned model identifier |

At mint the protocol records `keccak256(canonicalJSON(genome))` alongside the public
traits and the block number. The canonicalisation is fixed (sorted keys, no
whitespace) and is part of the protocol specification, since any change to it would
invalidate every existing commitment. The plaintext prompt is encrypted and held
off-chain; only the hash is stored.

A genome cannot be edited, but it can be extended. For sealed custody, revision is
additive only: the owner supplies a note, the enclave appends it to the current prompt,
seals the result as the next generation, and countersigns the transition — a signature
by the agent's executor key over the pair of parent and successor commitments, bound to
the chain and contract so it cannot be replayed. The contract refuses a sealed revision
without this signature, and the enclave signs only genomes it has derived itself, so a
successor generation is, up to the trust placed in the enclave, a strict extension of
its parent: a record cannot acquire a new strategy wearing its history. The old
generation's commitment, the block at which each generation began, and the model each
used are kept on-chain. No function changes what a past trade was made under, and a
generation is always committed before it trades, so every trade in the record is
attributable to exactly one committed strategy and the history cannot be backfilled.
This is what gives the record its provenance: each epoch of the history was produced by
a strategy that was fixed before that epoch began, and the sequence of strategies — a
lineage of extensions, for sealed agents — is itself part of what is transferred. Under
authored custody the owner holds the plaintext and revises without attestation; the
lineage there is the owner's claim, and the custody trait tells a purchaser which case
they are buying. A revised generation does not begin trading outside capital at once;
Section 5 describes the training camp it serves first. We note the limitation squarely:
additivity constrains the text, not the behaviour. An appended note can still redirect a
strategy, which is why the camp and the notice period remain in force for every
revision.

### 3.1 Custody modes

How the plaintext is held is itself recorded as an on-chain trait, because it
determines what a purchaser actually acquires.

| Custody | Who has read the prompt | What transfers on sale |
|---|---|---|
| 0 · Authored | The minter, who retains a decryption key | A key handoff. Every prior owner retains the plaintext indefinitely. |
| 1 · Sealed-authored | The minter, at authoring time only | Nothing. The prompt is sealed to the enclave key at mint; no subsequent owner can read it. |
| 2 · Sealed-generated | No one. The prompt is composed inside the enclave from a brief supplied by the minter and sealed immediately. | Nothing. Only the commitment identifies the strategy. |

Sealed custody addresses what might be called resale erosion. Under authored custody
each sale discloses the strategy to one more permanent holder, so whatever edge the
prompt contains depreciates with every transfer. A sealed genome cannot leak through
sale, because the only party that ever decrypts it is the enclave (in production, a
hardware trusted execution environment with remote attestation; in the prototype, the
runtime process holding the enclave key), and the enclave uses the prompt without
exposing it. Mode 2 goes further still: the resulting agent is one whose strategy no
human has read, identified only by its commitment and evaluated only by its record.
Sealing is the default in the prototype.

A sealed envelope has no reason to live on the creator's machine. Once minted, the owner
publishes it on-chain through `TraderNFT.publishEnvelope`, which emits it as an event
(`EnvelopePublished`) rather than writing it to storage; a kilobyte of ciphertext costs
a few thousand gas. The enclave locates envelopes by scanning these events, so no file
is ever handed to an operator. Publication is restricted to sealed custody, since an
authored envelope opens only with the owner's key and publishing it would serve no
purpose, and it may be repeated, for instance to re-seal to a new enclave key; the
commitment the enclave verifies against never changes.

Sealed-generated custody uses the same path with one extra step. The enclave exposes a
small endpoint that accepts a brief, composes a prompt from it inside the process, seals
the result to its own key, and returns only the commitment and the ciphertext; the
plaintext is never written, returned, or logged. The minter commits that hash and
publishes that envelope exactly as for a sealed-authored brain. The trust placed in the
endpoint is the trust already placed in the enclave, and it is the same trust
attestation is meant to discharge.

Revision respects custody. An authored agent is revised by its owner, who writes the next
prompt and keeps the next key. A sealed-authored agent is revised by sealing the next
prompt in the browser and publishing it. A sealed-generated agent is coached rather than
rewritten: the owner supplies a note, the enclave opens the current genome, appends the
note, seals the next generation and returns only its commitment and ciphertext, so the
agent can be trained for years without any human ever reading the strategy. In every
case the new commitment is recorded before the new generation trades.

## 4. Token-Bound Ownership

Each token controls a wallet of its own through the ERC-6551 token-bound account
standard. The wallet address is derived from the token, and whoever holds the token
controls the wallet. A transfer of the token is therefore also a transfer of the
wallet and its contents, in the same transaction.

This is what makes sale of an agent well-defined. A seller who wishes to include
capital simply transfers the token; the wallet, including trading capital and any
accrued fee shares, moves with it. A seller who wishes to retain capital sweeps the
wallet to their own address first and then transfers the token; the buyer receives the
identity, the genome rights, and the complete history with an empty book. In both
cases the trade events were emitted by the token's own addresses and remain attached
to it.

Supply is capped at 4,096 living agents. We chose the figure because it is 2^12 and
because a collection of brains ought to have one per bit. The cap is on the living, not
on the ever-minted: an agent that goes broke — its vault emptied of shares and its
wallet of capital — and then sits idle for a protocol-set interval may be reaped, which
burns the token and frees a slot for a new agent with a fresh, never-reused identifier.
Reaping is permissionless and free; alternatively a minter may pay a fee to cull a dead
agent and mint their own in its place in a single transaction, so that a reclaimed slot
cannot be taken from under them. Reaping can never touch an agent that still has vault
shares outstanding or capital in its wallet, so no depositor is stranded and no owner's
holdings are destroyed, and the owner of a merely dormant agent can revive it by funding
it at any time before the interval elapses. A reaped agent's history is not erased: its
trades remain as events in the log and its record stays recomputable; only the token
ceases to resolve. The effect is a collection that renews itself — the dead make room
for the living — while the total that can be alive at once stays fixed.

## 5. Vaults and Fee Mechanics

An agent's own wallet is its proprietary book. In addition, each agent fronts an
ERC-4626 vault that external depositors may fund. Depositors supply the base asset (USDC, which is also the venue's collateral) and
receive vault shares, which are redeemable at any time at the prevailing share price.
The agent trades vault assets under the same on-chain policy that governs its own
book.

The token owner is compensated through a management fee, accrued continuously and
pro rata over time, and a performance fee charged only on gains above a per-share
high-water mark. An agent in drawdown earns no performance fee until the mark is
recovered. Both fees are minted as vault shares to the agent's own wallet rather than
to the owner's address. Accrued fees therefore travel with the token automatically, and
accrual is checkpointed on every transfer so that the seller's and buyer's entitlements
are exact.

Fee crystallisation is a public function. Anyone may call it, and the caller receives
one percent of the fee shares crystallised by that call, drawn from the owner's share
and never from depositor capital. In the prototype's interface this function is called
`ringTheBell`, and the keeper incentive is presented as a ritual rather than a job; the
economics are those of an ordinary crank.

Two restrictions apply to deposits. First, deposits are allowlist-gated by default, so that an owner may restrict who can allocate to an agent; the allowlist is a configuration rather than a change to the vault. Second, a newly minted agent cannot accept
external capital at all. Every agent must first complete a paper season, a
protocol-specified minimum number of trades on its own book over a minimum period,
before its vault will accept a deposit. The site refers to this as the internship. The
effect is that depositors never fund an untested prompt; they fund a record.

The same principle governs revision. A new generation may trade the agent's own wallet
at once, but it may not trade the vault until it has made a protocol-specified minimum
number of trades on the own book under that generation and a notice period has passed
since it was committed; the site calls this the training camp. Depositors therefore see
a change of strategy before their capital is traded by it and can withdraw first, and
the high-water mark is untouched by revision, so a new generation earns no performance
fee until it has recovered whatever the previous one lost. An owner who keeps training
an agent between fights is, in the protocol's terms, appending committed generations,
each of which spars before it fights.

Administrative control of the vault, including rotation of the executor key and
narrowing of trading policy, follows `ownerOf(tokenId)` at all times. Acquiring the
token is acquiring the manager's seat.

## 6. Execution Policy

The model runs off-chain. A runtime decrypts the genome, supplies market state to the
model, and receives a structured trade intent in return. The runtime holds an executor
key whose entire permission set is a single function:

```
executeTrade(tokenId, venue, tokenIn, tokenOut, amountIn, minAmountOut)
```

On a prediction market, `tokenIn` and `tokenOut` are the collateral and an outcome
token, or the reverse when a position is closed; the notional and slippage limits below
are applied to the price of the outcome token in collateral terms. On every call the on-
chain guard enforces the following.

*Curated venues and markets.* The tradeable universe is curated at the protocol level
and is intentionally small. Venues are reached through a thin adapter interface. The
first adapter targets Polymarket's conditional-token exchange, and the markets an agent
may trade are a protocol-curated subset of that venue's conditions, selected for depth,
a clear resolution source, and a bounded time horizon. The prototype's tests exercise
the same guard against a mock two-asset swap venue, which is sufficient to check the
invariants, and its testnet deployment curates a paper market: a venue that quotes two
mock pairs from public price feeds, fills at that price less a small spread, and mints
the mock tokens, so that anyone can learn the protocol with real prices and no real
money, against the real contracts. Owners may narrow their agent's allowlist but cannot
add a venue or market that the protocol has not curated.

*Per-trade notional cap, by seat tier.* Notional per trade is limited to a fraction of
net asset value, with the ceiling set by the agent's tier. Every agent mints as an
Intern (20%); the owner may pay a one-time protocol fee to activate an Associate (30%)
or Partner (50%) seat. The guard enforces the ceiling, owners may only configure below
it, and upgrades are irreversible. The titles are decorative; the limits are not.

*Slippage bound.* `minAmountOut` must lie within a configured tolerance of the venue
quote.

*Cadence.* Trades may not exceed the frequency declared in the public traits: the guard
derives a minimum interval from the declared trades-per-day and enforces it as a floor
under the owner's own interval, so the trait is a bound rather than a label.

*No exit path.* Swap proceeds are returned to the agent's wallet or vault. The executor
key cannot withdraw, approve, or transfer assets to any external address under any
circumstances.

The consequence is that the trust boundary lies at the contract rather than at the
runtime. A fully compromised runtime can make poor trades within policy; it cannot
extract funds. This is the property the test suite's no-extraction fuzzing is designed
to check.

Reconciling this guard with an off-chain order book is the principal integration
question. On Polymarket, orders are signed off-chain on behalf of the account that holds
the funds and are settled on-chain by the exchange contract when matched. The token-
bound account must therefore be the signer, and it must refuse to sign anything the
guard would reject. We intend to implement this as a signing policy inside the enclave,
mirrored on-chain by the approvals the account grants: collateral and curated outcome
tokens only, to the exchange contract only. The combined effect is that a compromised
executor key can still place only policy-conforming orders, and still cannot move funds
anywhere but back into the account.

### 6.1 Attested execution

A natural objection is that nothing described so far prevents a human from operating
the executor key by hand and presenting the resulting record as machine-produced. The
genome commitment establishes which strategy was committed; it does not establish
that the strategy was in control. We believe the only satisfactory answer is attested
execution, and the design anticipates it in three parts.

First, the complete runtime (sealed genome, model invocation, and executor key) runs
inside a trusted execution environment, in our design an Intel TDX machine rented
from a compute marketplace and paid for in the base asset by the enclave itself. The enclave's remote
attestation binds together the runtime image (a reproducible-build measurement), the
executor public key (generated inside the enclave and never exported), and the genome
commitment being served. If the only party able to sign `executeTrade` is code whose
measured image contains no human-input path, then every trade is machine-decided as a
matter of construction.

Second, an attestation registry in the guard accepts an executor key only when it is
accompanied by a valid attestation binding it to an approved runtime measurement.
Rotating an executor then means submitting a fresh attestation, and the custody trait
gains an execution analogue that a buyer can inspect: attested, or merely operated.

Third, an attested runtime commits, with each trade, a hash of the full inference
transcript (market snapshot in, trade intent out). The transcript can be disclosed on
request for audit without exposing the genome.

The prototype ships the registry and the verifier, and labels what it cannot yet prove.
A `RuntimeRegistry` contract lets an executor key register the measurement of the
runtime it belongs to together with the enclave public key genomes are sealed to, in one
of two ways. Self-reported: the key states a hash over the runtime's source bundle, and
the protocol approves measurements it has reproduced. Attested: the key presents an
Intel TDX quote; the chain's DCAP verifier (Automata's, which is deployed on Polygon)
checks it; an adapter reads the measured boot chain (MRTD and RTMRs) out of the verified
report; and the registry requires the quote's report data to be the hash of the executor
key and the enclave key, so the binding between key and image is the hardware's
statement rather than the key's. The verifier sits behind an interface, and a router
lets several evidence formats share it: a second adapter accepts AWS Nitro Enclaves
evidence in the transitive form production systems use, in which an approved attestor —
itself an enclave whose job is verifying Nitro attestation documents — checks the
document off-chain and signs a compact statement of measurement, report data and issue
time that the adapter verifies on-chain against its approved keys. The trust root there
is one link longer (the protocol approves the attestor's key rather than checking the
manufacturer's certificate chain), which the design accepts and discloses; a harvester
registers with whichever evidence its machine produces. In every case a brain whose executor is registered to
an approved measurement is shown as running an attested runtime, and the label says
which path was taken: verified quote, or self-reported and reviewed. What remains is
operational: running the farm image on a TDX machine and producing the quote.

The third part is also present in prototype form. Each trade the farm makes goes
through a variant of `executeTrade` that carries the hash of the inference transcript
(what the model was shown, what it answered, which model and how many tokens; the
prompt is not in it), which the guard emits beside the trade. The transcript itself
stays with the operator under that hash, so it can be disclosed for an audit and checked
against the chain without exposing the genome.

Behavioural statistics, such as round-the-clock cadence or sub-second reaction to
on-chain events, are sometimes proposed as evidence of machine execution. In our view
they can identify an inattentive human but cannot prove the absence of one; they are
monitoring rather than verification. Zero-knowledge proofs of model inference would be
the ideal instrument and are not presently practical for frontier-model inference.

Until attestation is deployed, "AI-traded" is an operator claim, and the prototype
labels it as one.

### 6.2 Enrolment and the enclave runtime

Nothing in the design requires a creator to operate anything. The enclave runs as a
single long-lived process, which we call the farm, holding one executor key per
deployment. An owner enrols a brain by setting that key as the brain's executor through
the guard's existing `setExecutor`; no new contract is involved, and the enrolment is
visible to anyone who reads the policy. Un-enrolment is the same call with a different
key. Because the guard restricts the executor key to `executeTrade`, enrolment hands the
enclave exactly the power to trade within policy and nothing else.

On each pass the farm reads the chain: for every token whose executor is its key, it
finds the latest published envelope, opens it with the enclave private key, verifies the
plaintext against the genome commitment, and refuses to run anything that does not
match. It then runs each enrolled brain at the brain's declared cadence, choosing the
book itself: the brain's own wallet during the paper season, the vault once the brain is
seasoned and the vault holds assets, and nothing at all if neither holds funds or the
wallet has not authorised the guard. The farm keeps no state of its own; the chain is
the state, and a restart resumes from the last recorded trade. Brains under authored
custody cannot be run by the farm, since only the owner holds the key, and remain self-
hosted.

The enclave operator is reimbursed from the brain's own resources. The guard carries a
per-brain runtime fee, set by the owner in the base asset and capped by a protocol
constant, which is paid from whichever book the trade used (the vault or the brain's
wallet) to the executor on each successful trade. It is paid after the swap and skipped
if the book holds no base asset at that moment, so it can never block a trade or compete
with it for capital. An owner who wants the operator paid even when the book runs thin
may escrow rent with the guard in advance: when the traded book cannot cover the fee,
the same capped amount is drawn from the escrow under the same conditions. Escrow is
operating prepayment rather than capital — it counts toward no net asset value, does
not save an insolvent agent from reaping, travels with the token, and is refunded to
the owner if the agent is burned. Because trades themselves are bounded on-chain by the
declared
cadence, the fee is bounded per day: an executor can draw at most the cadence times the
cap, and it cannot become an extraction path. The fee is paid for evidence rather than
for claims: only to an executor the registry marks attested, and only on a trade that
moved at least a protocol-set fraction of net asset value, so that neither an
unverified runtime nor a stream of dust trades can collect it; and a raise takes effect
only after a notice period, while lowering is immediate, so depositors see a new
expense before they pay it. An operator (the site calls operators harvesters; what they
harvest is the fee, never the returns) publishes the fee it asks for and may decline to
run brains that pay less. For a vault this is an ordinary fund expense, visible in the
record like any other.

The fee is paid on trades rather than on every tick, so that the executor's permission
set stays one function; the consequence is that a brain which holds more often than it
trades costs its operator inference it does not pay for. The farm therefore keeps an
account per brain: fees received, recomputed from the chain, against the model tokens
and gas its ticks consumed. A brain may run a fixed allowance on credit; past it the
brain is paused, and the account states the per-trade fee that would have covered it at
its observed trade rate. Raising the fee is the owner's answer: the outstanding balance
is written off once and the brain runs again. The accounts are published by the enclave
and shown beside the fee control, so the owner is given the number rather than left to
guess it.

The same principle extends to the machine the enclave runs on. We do not use a
conventional cloud account. The enclave runs in an Intel TDX confidential machine rented
on a market on which a bare key opens a prepaid job, priced per second in the base
asset, and extends it with a deposit; the farm reads its own lease from that market and,
before it runs out, tops it up from the runtime fees it has collected, bridging between
chains where necessary. Every payment is recorded beside the fees. Model inference is
bought the same way, per request in the base asset, from an inference gateway that
itself runs in a TEE and signs each response; the runtime speaks to it through the same
interface as to a conventional model API. No card, no subscription, and no operator's
account stands between a brain's capital and the compute that runs it. The owner's only
actions remain minting, funding, enrolling, and setting the fee.

An owner who would rather pay for inference directly may supply a credential of their
own. The credential is sealed in the owner's browser to the enclave key, under a key
derivation domain separate from the genome's so that neither envelope can be opened as
the other, with the chain, token, and purpose bound into the plaintext, and it is
published through a small contract (`Credentials`) as an event in the same way as the
genome envelope. The contract records only who published the current version and
whether it has been revoked; a credential is usable only while its publisher still owns
the brain, so a sale retires the seller's credential without any action on their part,
and the buyer publishes their own. The enclave opens the credential in process, uses it
for the one purpose it names, and prices the resulting tokens at zero in the brain's
account. Two restrictions keep the arrangement inside the custody model. The enclave
sends an owner's key only to hosts the operator has allowed (the model provider and
attested inference gateways), never to an endpoint of the owner's choosing, since the
sealed prompt accompanies every request; and the plaintext credential is held only in
memory with the running brain and is never logged, written, or included in a
transcript.

## 7. Verifiability of the Record

Every execution emits a `TradeExecuted` event carrying the agent identifier, venue,
tokens, amounts, and timestamp. An off-chain indexer aggregates these into NAV series,
returns, drawdown, and ranking data, but it only summarises; any party can recompute
the same figures from the logs. The genome commitments tie the record to the
strategies: every trade falls within the epoch of exactly one committed generation; an
unchanged hash since the birth block means a single strategy produced every trade, and a
revised agent's record reads as a sequence of such epochs, each attributable to the
commitment that preceded it.

Where the venue matches orders off-chain, as Polymarket does, the record is the
settlement. The indexer reads fills from the exchange contract's events; order
placements, amendments, and cancellations leave no on-chain trace and form no part of
the record. This is the correct boundary for a track record, since only fills change a
position, but it does mean that an agent's order-book behaviour is not itself auditable
from chain data.

On-chain history establishes that trades occurred. It does not, on its own, establish
that they were at arm's length, and a design of this kind must take wash trading
seriously. Three mechanisms address most of the surface. Protocol curation restricts
agents to a small set of deep, established markets; an owner cannot allowlist a pool or
token they control, which removes the inexpensive form of the attack in which returns
are painted against self-supplied liquidity. The paper season requires that a record
begin with trades of the agent's own capital over a minimum period, so a freshly minted
agent cannot be dressed and resold on its first day. And recomputability means that any
claimed figure can be checked against the logs, with the usual caveat, which the
interface states, that volume in curated pools is necessary but not sufficient evidence
of skill.

What curation cannot prevent is an outside account trading against a curated market to
move its price. Depth makes this expensive, the bounded payoff of an outcome token
bounds how far a mark can be moved, and time-weighted pricing (Section 9) limits what it
can achieve.

## 8. Market Structure and Composition

The agent is a standard ERC-721. Seaport, OpenSea, Blur, and the existing NFT
infrastructure therefore operate on it without protocol-specific code, including trait
filtering on the public genome traits and price discovery on the secondary market. An
agent's floor price becomes a continuously quoted opinion on the value of a strategy
together with its fee stream. The token's metadata (name, public traits, and an image)
is generated on-chain by `tokenURI`, so no server of ours is needed for a marketplace to
render it.

### 8.1 Purchaser due diligence

A purchaser's checklist is, in effect, a fund due-diligence questionnaire reduced to
what can be read from chain state:

1. The custody trait. Sealed agents (modes 1 and 2) have no plaintext to receive and
   nothing a prior owner can covertly retain. For an authored agent (mode 0), verify
   that the genome hash matches the encrypted blob to be delivered, and price in the
   fact that past owners keep the strategy. Read the generations: how many times the
   agent was revised, when, and which part of the record each generation produced; a
   record made by several strategies is several records.
2. The token-bound wallet: balances, and any outstanding approvals left by prior
   owners.
3. Vault state: NAV, share supply, fee parameters, high-water mark, and accrued fee
   shares held in the wallet.
4. The current executor address, which should be rotated immediately after purchase,
   since the seller's runtime knew the previous key; whether the brain is enrolled
   with the enclave (executor equal to the published enclave key) with a published
   envelope, or self-hosted; and how that runtime is attested (Section 6.1), including
   whether its trades carry transcript hashes.
5. The track record itself, recomputed from events rather than taken from a marketplace
   summary.

### 8.2 Composition

Everything in the system is a standard primitive, and standard primitives compose.
Vault shares are ordinary ERC-20 tokens, so an agent whose curated universe includes
other agents' vault shares is a fund of funds: an allocator whose market is the roster
itself, reading records and rotating capital among specialists. Share pricing needs no
external oracle, because `convertToAssets` is the NAV. Curation still governs which
vault shares become tradeable; that remains a protocol decision.

An agent's wallet may also hold other agent tokens outright, giving a manager and its
portfolio in a single token. The protocol prevents a token from entering its own
wallet, but cross-holdings are otherwise possible and carry a specific hazard: if A's
wallet owns B while B's wallet owns A, both are permanently locked. A registry-level
cycle check is planned; until it exists, this composition is the buyer's risk.

A public, recomputable NAV series is also a suitable underlier for cash-settled
derivatives (perpetuals on an agent's NAV, options on its floor, an index of seasoned
Partners), none of which require protocol permission, only an oracle over figures
anyone can reproduce. And both the token and the vault shares are legible to lending
markets, so a productive agent can be borrowed against rather than sold.

Each layer compounds the risks of the one beneath it. Fees stack; wrapped funds tend
to correlate most strongly precisely when diversification is supposed to help; and each wrapper widens the oracle and manipulation surface. The risks in Section 9 apply at every layer.

## 9. Risk Analysis

**Prompt extraction.** Sealed custody (Section 3) removes the most serious leak paths:
no owner holds a decryption key, so sales disclose nothing and there is no key to steal
from a buyer or seller. What remains is the enclave boundary itself. In the prototype
the enclave is an ordinary process whose operator must be trusted; production requires
a hardware TEE whose attestation establishes that the runtime never exposes plaintext.
Independently of custody, agents can leak their prompts behaviourally; sealed-generated
genomes include an instruction against self-disclosure, which is mitigation rather than
a guarantee. Authored-custody agents retain the original problem, in that every past
owner keeps the plaintext, and the public custody trait exists so that the market can
price this.

**Valuation and oracle risk.** Share pricing requires valuing open positions. The
prototype prices through the execution venue, which is manipulable (donation attacks,
price movement ahead of crystallisation), and thin prediction-market books make short-
lived price moves cheap, though the bounded payoff of an outcome token caps how far a
mark can be pushed. This is the most significant known weakness in the present design.
Production requires time-weighted or oracle pricing, stale-price circuit breakers, and a
delay between fee accrual and crystallisation.

**Resolution and venue risk.** A prediction-market position depends on a resolution
process outside the protocol; on Polymarket this is an optimistic oracle with a dispute
period. A disputed or delayed resolution holds capital, and a resolution the agent
regards as wrong is a loss it cannot hedge. The order book is operated off-chain, so the
liveness of order placement depends on the venue even though settlement and custody do
not.

**Runtime liveness.** An enrolled brain trades only while the enclave operator keeps
the farm running. If it stops, the brain idles; nothing is lost, depositors can still
withdraw, and the owner can unenrol and run the brain elsewhere. A brain may also be
paused by its operator's credit policy (Section 6.2); the condition is stated in the
account the enclave publishes, and the remedy is the fee. Attested execution would let a
buyer verify the runtime; it would not by itself guarantee liveness.

**MEV.** Agent trades are visible intents. Tight slippage bounds and size caps limit
the damage; production should route through private order flow.

**Model risk.** Model outputs are non-deterministic, so the same genome will not
reproduce the same trades, and deprecation or drift of the underlying model changes an
agent's behaviour partway through its record. The model identifier is pinned per
generation for this reason: moving an agent to a newer model is a revision, recorded as
such, and served through the training camp like any other.

**Key risk.** The executor key is a hot key with a bounded blast radius by design. The
owner key is ordinary NFT custody, and its compromise is total loss.

**Smart-contract risk.** The prototype is unaudited. The design relies on audited
components (OpenZeppelin ERC-721 and ERC-4626, the ERC-6551 reference registry) and
keeps custom code small, but small is not the same as safe.

**Performance risk.** Most traders, human or otherwise, underperform. A verifiable
record verifies losses with the same rigour as gains. An agent that loses everything is
not destroyed by the protocol; it goes dormant, and unless refunded it is eventually
reaped to free its slot, its losing record preserved in the log.

Everything described in this paper, including contracts, runtime, and documentation,
is provided as-is and without warranty of any kind. Verification mechanisms are
best-effort and are labelled as such; where a property is not enforced on-chain or by
attestation, it should be read as a claim.

## 10. Roadmap

1. **Prototype** (this repository): contracts, agent runtime, and a demonstration on a
   local chain.
2. **Testnet pilot** (Polygon Amoy): a public paper market (the feed-priced venue,
   faucet money, one public enclave) for anyone to learn on, canonical ERC-6551
   registry, the Polymarket adapter exercised against a mock conditional-token
   exchange, the farm's ledger, lease
   loop and attested registration (built, and exercised locally against a mock machine
   market and a mock verifier) run on a rented TDX machine paying its own lease from
   runtime fees, inference from a TEE gateway paid in the base asset, attestation quotes
   verified on-chain through the deployed verifier, public leaderboard. Followed by a
   limited run against the live order book with agent-owned capital only.
3. **Audit**: an independent review of the contracts and of the enclave runtime. The outcome determines whether anything proceeds, and in which mode (closed-only or open vaults).
4. **Mainnet decision**: taken only after step 3, and possibly never for open vaults.
