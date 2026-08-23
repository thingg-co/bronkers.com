# The Terminal

*How the Brokners dapp is put together, and why. Companion to
[architecture.md](architecture.md); plain-language counterpart at `/app`.*

## What it is

The Terminal is a zero-build, no-backend web app. It reads the chain over a
public RPC and writes through the visitor's wallet. There is no server, no
indexer and no database: every number on every page is recomputed from
contract state and `TradeExecuted` logs, which is the point of the protocol.
The one thing it reads from a process of ours is the farm's own books, over
the farm's endpoint, and it says so where it shows them.

It is organised around four jobs:

| Tab | Who it is for | What it does |
|---|---|---|
| **The Floor** | anyone, no wallet needed | every brain, live, sortable by return / NAV / trades / age / bell reward; filter to open vaults, interns, yours, or bells worth ringing |
| **Learn** | newcomers | the lifecycle as numbered steps on this chain with your numbers: connect, paper money, birth, internship, watch, back, bell, train, pay the harvester, sell, what is enforced; steps tick themselves off from chain state |
| **Birth a Brain** | creators | a five-step wizard: strategy → custody → traits → review → start. Sealed custody by default, entirely in the browser; the last step publishes the jar on-chain, seeds the wallet, authorises the guard, sets the runtime fee and enrols the brain with the enclave, so it is trading before you leave the page |
| **My Desk** | owners, depositors, keepers | manage the brains you own (runtime fee, the account with the enclave, and **Training**: revise the brain into a new generation), see your vault positions, ring bells that pay |
| **Developer** | us | chain / RPC / addresses (including the paper venue's feeds), a dev wallet for local anvil, a faucet, levers to move the ETH/USD feed and the chain's clock, the farm's books, the runtime command |

Clicking a brain opens its page: share-price return since inception, vault NAV,
own-book value, trade count, max drawdown, a share-price chart, the internship
progress for interns, the full trade table from logs, vault terms (fees,
high-water mark, fee shares accrued to the jar, runtime fees paid, allowlist
status, your position) and identity (owner, token-bound wallet, vault,
executor and how it is attested, runtime fee and its daily bound, custody,
commitment, model, declared cadence and the interval the guard enforces).
Deposit, withdraw and Ring the Bell live there.

## How it behaves

**A paper market.** The curated venue on every deployment is `PaperVenue`:
it quotes mWETH/mUSDC and mWBTC/mUSDC from USD feeds (Chainlink on Polygon
Amoy; settable mock aggregators on anvil, which is what the Developer tab's
market lever writes), fills at the feed price less a small spread, and mints
the mock tokens. Real prices, fake money, the real contracts: what a visitor
learns here is what happens on the real thing.

**Read-only first.** On load the Terminal picks a chain (the saved one, else the
injected wallet's chain if it is configured, else the default) and opens a
`viem` public client on that chain's RPC. The Floor and every brain page work
with no wallet at all. If the RPC cannot be reached, it falls back to
`data/traders.json` (written by `agent/src/report.ts`) and says so.

**Connect only to act.** "Connect wallet" attaches an injected wallet
(MetaMask, Rabby…) and switches it to the selected chain, adding the chain if
the wallet does not know it. On local test chains the Developer tab also
accepts a raw dev key (anvil's accounts), kept in `sessionStorage`; the same
thing can be passed as `?devkey=0x…` for headless testing.

**Every write is narrated.** Actions build a list of steps (approve, then
deposit; mint, then name) and run them through one modal that shows each
step's status and transaction hash. Reverts are translated into sentences:
"This brain is still an intern…", "This vault is allowlist-only and your
address is not on it…". The raw log is one click away (console).

**Brains run themselves.** A sealed brain's jar is published on-chain
(`publishEnvelope`, an event) and the brain is "enrolled" by setting the
enclave's executor key (`setExecutor`). The farm (`agent: npm run farm`) is one
process that runs every enrolled brain at its declared cadence and picks the
book itself. The declared cadence is enforced on-chain (`tradeIntervalOf`), so
"next trade allowed" is a fact the page can state. My Desk and the brain page
show the runtime status: *enrolled with the enclave · last trade · next tick*,
*self-hosted* (authored custody), or *not running*, plus one-click enrol /
unenrol and a publish-jar control for brains minted elsewhere.

**The farm pays for itself, and shows its books.** A brain pays its executor a
runtime fee per trade (only an attested executor, only on trades above the dust
floor; raises take effect after a notice period, and the brain page and My Desk
say so); the farm keeps an account per brain (fees received
against what its ticks cost: model tokens and gas), pauses a brain that
overruns its credit, and tops up the machine lease it runs on from the fees it
collected. My Desk's Runtime panel reads `GET enclaveUrl/ledger?tokenId=` and
shows the account: paid, cost, credit left, paused or running, and the
per-trade fee that would have covered the brain so far (with a button to use
it). The Developer tab's "The farm's books" panel reads `/health`: float,
income, cost breakdown, net, the lease (time left, rate, paid so far). Both
degrade to a sentence when the endpoint is not there; nothing on-chain depends
on them.

**Brains train between fights.** My Desk's Training panel revises a brain:
sealed-generated brains take a coach's note (`POST enclaveUrl/train`: the
enclave appends it to the current sealed prompt and returns the next
generation's commitment and jar), sealed-authored brains take a new prompt
sealed in the tab, authored brains take a new prompt encrypted with a key you
keep; the steps publish the jar and call `revise`. The brain page shows the
generation, a training-camp panel while the new generation spars on the own
book, the generation of every trade, and the revision timeline; the Floor
badges brains in camp.

**Before you sign, you are told what happens.** The deposit modal shows the
share price, estimated shares and the fee terms; the bell modal shows the
pending management and performance fees and your 1% cut before you ring (via
`TraderVault.pendingFees()`); promoting shows the fee; transferring warns that
the brain's wallet goes with it; the fee field tells you the most the brain can
pay per day.

## Files

```
app.html                  shell: hero, tab bar, #view, console pane
js/config.js              per-chain RPC, explorer, addresses, enclave public key,
                          enclave endpoint, host market
js/terminal/main.js       hash router, header, window.__terminal debug handle
js/terminal/chain.js      chain + wallet state; public client, injected / dev wallet
js/terminal/data.js       reads: roster summaries, brain detail, trades and runtime
                          fees from logs, NAV series (archive reads at trade blocks),
                          chain time, the farm's /health and /ledger, snapshot fallback
js/terminal/actions.js    writes: step runner, revert translation, every on-chain action
js/terminal/crypto.js     canonicalize + commit (frozen), authored (AES-GCM) and
                          sealed (X25519 → HKDF → AES-GCM) envelopes, WebCrypto only
js/terminal/venues.js     venue-aware trade/holding formatting (swap today; prediction
                          markets when the Polymarket adapter lands)
js/terminal/ui.js         DOM helper, formatting, sparkline, modal, toast, fields
js/terminal/views/        floor.js · learn.js · brain.js · create.js · desk.js · dev.js
agent/src/farm.ts         the enclave runtime that runs every enrolled brain
agent/src/budget.ts       the farm's ledger and credit policy
agent/src/host.ts         the machine lease (Oyster-compatible market), read and topped up
```

Everything is plain ES modules loaded straight from the page; `viem` comes from
esm.sh. No bundler, no framework.

## Contract surface the Terminal depends on

Added for the Terminal (tests in `protocol/test/Views.t.sol` and
`Runtime.t.sol`):

- `TraderVault.pendingFees() → (mgmtShares, perfShares, bellReward)` — exactly
  what the next checkpoint would mint, so a keeper sees the reward before
  ringing.
- `TraderNFT.christen(tokenId, name)` / `nameOf(tokenId)` — owner-only,
  once, ≤ 32 bytes, permanent. Cosmetic; a record cannot be laundered by
  renaming.
- `TraderNFT.publishEnvelope(tokenId, bytes)` → `EnvelopePublished` — the
  sealed jar as an event, so the enclave finds it by scanning logs. Sealed
  custody only; re-publishable.
- `TraderNFT.tokenURI` — on-chain metadata with the jar image; the brain page
  renders it and links to the configured marketplace.
- `TraderNFT.cadenceOf`, `ExecutionGuard.cadenceIntervalOf / tradeIntervalOf /
  nextTradeAt` — the declared cadence and the interval the guard enforces
  between trades (owner's `minTradeInterval` floored at 1 day / cadence).
- `TraderNFT.revise(id, commitment, model, cid, attestation) / generationOf /
  generationAt` and `GenomeRevised`, `ExecutionGuard.revisionDigest /
  verifyRevision / campStatus / campDone` — generations and the training camp;
  trades are attributed to generations by block. Sealed custody is
  additive-only: `revise` requires the executor key's signature over the
  parent → next commitment edge, which only the enclave's `/train` issues
  (it appends the coach's note to the current prompt and countersigns);
  authored custody passes `0x`. The desk's training panel reflects this:
  sealed brains take a brief, authored brains a new prompt.
- `ExecutionGuard.runtimeFeeOf / maxRuntimeFee / setRuntimeFee /
  pendingRuntimeFeeOf / runtimeFeeDelay / minFeeNotionalBps / registry` and the
  `RuntimeFeePaid` / `RuntimeFeeScheduled` events — the per-trade reimbursement a
  brain pays its executor, its schedule and its conditions; shown and set in My
  Desk, summed on the brain page.
- `ExecutionGuard.runtimeEscrowOf / fundRuntime / withdrawRuntime` and the
  `RuntimeEscrowFunded / RuntimeEscrowWithdrawn / RuntimeEscrowDraw /
  RuntimeEscrowRefunded` events — escrowed rent: prepaid fees, held by the
  guard, drawn per trade only when the traded book cannot pay (same caps, same
  attestation gate), withdrawable by the owner, refunded on reap or cull.
  Funded and withdrawn from My Desk's Runtime panel; anyone may fund.
- `ExecutionGuard.executeTradeWithTranscript` → `TranscriptCommitted` — the hash
  of the inference transcript behind a trade; the brain page marks trades that
  carry one.
- `Credentials.publish(tokenId, kind, bytes) / revoke / credentialOf / active`
  and the `CredentialPublished / CredentialRevoked` events — owner-supplied
  secrets (the `inference` kind today: the owner's own API key), sealed in the
  browser to the enclave key under the credentials domain and published as
  events. `credentialOf` says who published the current version and whether it
  is `active` (published, not revoked, publisher still owns the brain); a sale
  retires the seller's credential on its own. Sealed and published from My
  Desk's Runtime panel; the farm switches the brain to the owner's key on its
  next pass and prices those tokens at zero. Tests in
  `protocol/test/Credentials.t.sol`.
- `RuntimeRegistry.runtimeOf / attested / attestationOf / hardwareAttested` —
  runtime identity for the "attested runtime · TDX quote" / "attested runtime ·
  reviewed" / "registered runtime" / "operated" labels.

Everything else was already public: `policyOf`, `tierOf`, `tiers`, `seasoned`,
`tradeCountOf`, `firstTradeAt`, `seasonMinTrades`, `seasonDuration`, `tbaNav`,
the 4626 views, `highWaterMark`, `allowlistEnabled`, `depositAllowed`, and the
`TradeExecuted` event.

Owner actions on the brain's own wallet (fund, authorise the guard, sweep,
redeem fee shares) go through the ERC-6551 account's `execute()`; the Terminal
encodes the inner call and the account forwards it.

## Sealing in the browser

Sealed custody from the browser uses WebCrypto only: an ephemeral X25519 key,
ECDH against the enclave's public key (base64 SPKI from `genome keygen`,
configured per chain), HKDF-SHA256 with info `brokners-genome-v2`, AES-256-GCM.
The envelope is byte-compatible with `agent/src/enclave.ts`; the dev harness
mints a browser-sealed brain and has the Node runtime open it, verify the
commitment and trade. The plaintext never leaves the tab unencrypted, and the
browser keeps no key. Sealed-and-generated custody calls the enclave endpoint
(`enclaveUrl` → `POST /compose`): the brief goes in, the commitment and sealed
envelope come out, and the prompt never exists outside the enclave process.

Credentials use the same ECIES construction with HKDF info
`brokners-credentials-v1` (`sealedCredential` in crypto.js, `CREDENTIALS_INFO`
in `agent/src/enclave.ts`), so a credential can never be opened as a genome or
the reverse. The plaintext carries `{v, chainId, tokenId, kind}` beside the
payload; the farm refuses a credential sealed for another brain, chain or
kind. The key field is a password input and is cleared after sealing; nothing
unencrypted leaves the tab.

## Developing against anvil

```bash
anvil --silent &
./protocol/script/seed-dev.sh      # deploys, mints 3 brains in different states,
                                   # opens the farm's lease on the mock market,
                                   # writes addresses + enclave key into js/config.js
python3 dev-server.py              # http://127.0.0.1:8000/app
```

The seed prints the dev keys and the farm command (with the lease's job id).
Paste a key in the Developer tab (or open `/app?devkey=…`) to act as the owner
or the LP. Because the declared cadence is enforced on-chain, a brain that has
just traded cannot trade again until its interval is up: the Developer tab's
"Move the chain's clock" buttons (`evm_increaseTime` on anvil) skip ahead.
`protocol/script/demo.sh` is still the one-shot end-to-end demo;
`seed-dev.sh` leaves the chain up.

## Hosting

`docs/runtime-hosting.md` is the research, the decision and the runbook for
where the farm runs and who pays: no AWS; an Intel TDX machine rented on a
market a bare key can pay (Marlin Oyster), the lease read and topped up by the
farm from runtime fees, inference from a USDC-paid TEE gateway, attestation
through Automata DCAP into the RuntimeRegistry.

## Tooltips

Every input carries a short explanation: a ⓘ next to the label (keyboard
focusable, native `title`) and the same text on the control itself. They are
written for a person who has never seen the protocol: what the field is, what
it changes, and what it cannot change.

## Still to do

- Polymarket adapter: `venues.js` already formats prediction-market trades
  ("Bought 1,400 YES at 36¢ · question") from a `venues` / `markets` map in
  `config.js`. The real work is the `IVenue` adapter over the CTF exchange
  and the TBA-as-order-signer; it also needs venue-per-brain at mint (today
  every brain uses the NFT's default venue).
- Hardware attestation, the operational half: the registry accepts a TDX
  quote through the Automata adapter and the farm registers with one when
  `FARM_QUOTE_PATH` is set; what is left is running the farm image on a TDX
  operator and producing that quote (docs/runtime-hosting.md).
- Public testnet: `protocol/script/deploy-testnet.sh` deploys to Polygon Amoy
  with a funded key (wiring Automata DCAP where it exists) and prints the
  `config.js` block; then run the farm and fill `enclavePublicKey` /
  `enclaveExecutor` / `enclaveUrl` from `/health`.
