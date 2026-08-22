# The Terminal

*How the Brokners dapp is put together, and why. Companion to
[architecture.md](architecture.md); plain-language counterpart at `/app`.*

## What it is

The Terminal is a zero-build, no-backend web app. It reads the chain over a
public RPC and writes through the visitor's wallet. There is no server, no
indexer and no database: every number on every page is recomputed from
contract state and `TradeExecuted` logs, which is the point of the protocol.

It is organised around four jobs:

| Tab | Who it is for | What it does |
|---|---|---|
| **The Floor** | anyone, no wallet needed | every brain, live, sortable by return / NAV / trades / age / bell reward; filter to open vaults, interns, yours, or bells worth ringing |
| **Birth a Brain** | creators | a five-step wizard: strategy → custody → traits → review → start. Sealed custody by default, entirely in the browser; the last step publishes the jar on-chain, seeds the wallet, authorises the guard and enrols the brain with the enclave, so it is trading before you leave the page |
| **My Desk** | owners, depositors, keepers | manage the brains you own, see your vault positions, ring bells that pay |
| **Developer** | us | chain / RPC / addresses, a dev wallet for local anvil, a faucet, a lever to move the mock market, the runtime command |

Clicking a brain opens its page: share-price return since inception, vault NAV,
own-book value, trade count, max drawdown, a share-price chart, the internship
progress for interns, the full trade table from logs, vault terms (fees,
high-water mark, fee shares accrued to the jar, allowlist status, your
position) and identity (owner, token-bound wallet, vault, executor, custody,
commitment, model, traits). Deposit, withdraw and Ring the Bell live there.

## How it behaves

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
book itself. My Desk and the brain page show the runtime status: *enrolled
with the enclave · last trade · next tick*, *self-hosted* (authored custody),
or *not running*, plus one-click enrol / unenrol and a publish-jar control for
brains minted elsewhere.

**Before you sign, you are told what happens.** The deposit modal shows the
share price, estimated shares and the fee terms; the bell modal shows the
pending management and performance fees and your 1% cut before you ring (via
`TraderVault.pendingFees()`); promoting shows the fee; transferring warns that
the brain's wallet goes with it.

## Files

```
app.html                  shell: hero, tab bar, #view, console pane
js/config.js              per-chain RPC, explorer, addresses, enclave public key
js/terminal/main.js       hash router, header, window.__terminal debug handle
js/terminal/chain.js      chain + wallet state; public client, injected / dev wallet
js/terminal/data.js       reads: roster summaries, brain detail, trades from logs,
                          NAV series (archive reads at trade blocks), snapshot fallback
js/terminal/actions.js    writes: step runner, revert translation, every on-chain action
js/terminal/crypto.js     canonicalize + commit (frozen), authored (AES-GCM) and
                          sealed (X25519 → HKDF → AES-GCM) envelopes, WebCrypto only
js/terminal/venues.js     venue-aware trade/holding formatting (swap today; prediction
                          markets when the Polymarket adapter lands)
js/terminal/ui.js         DOM helper, formatting, sparkline, modal, toast, fields
js/terminal/views/        floor.js · brain.js · create.js · desk.js · dev.js
agent/src/farm.ts         the enclave runtime that runs every enrolled brain
```

Everything is plain ES modules loaded straight from the page; `viem` comes from
esm.sh. No bundler, no framework.

## Contract surface the Terminal depends on

Added for the Terminal (tests in `protocol/test/Views.t.sol`):

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
- `ExecutionGuard.runtimeFeeOf / maxRuntimeFee / setRuntimeFee` — the
  per-trade reimbursement a brain pays its executor; shown and set in My Desk.
- `RuntimeRegistry.runtimeOf / attested` — runtime identity for the
  "attested runtime" / "registered runtime" / "operated" labels.

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

## Developing against anvil

```bash
anvil --silent &
./protocol/script/seed-dev.sh      # deploys, mints 3 brains in different states,
                                   # writes addresses + enclave key into js/config.js
python3 dev-server.py              # http://127.0.0.1:8000/app
```

The seed prints the dev keys. Paste one in the Developer tab (or open
`/app?devkey=…`) to act as the owner or the LP. `protocol/script/demo.sh` is
still the one-shot end-to-end demo; `seed-dev.sh` leaves the chain up.

## Hosting

`docs/runtime-hosting.md` is the research and decision on where the farm runs
and who pays: no AWS; Intel TDX rented and extended in USDC by the farm's own
key, inference via a USDC-paid TEE gateway, attestation via Automata DCAP.

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
- Hardware attestation: the registry, labels and farm self-measurement are in
  place; a TDX host (no AWS; see docs/runtime-hosting.md) adds the quote, verified
  on-chain through Automata DCAP, over the same fields.
- Public testnet: `protocol/script/deploy-testnet.sh` deploys to Polygon Amoy
  with a funded key and prints the `config.js` block; then run the farm and
  fill `enclavePublicKey` / `enclaveExecutor` / `enclaveUrl` from `/health`.
