# BROKNERS — project conventions and state

Read README.md first for layout and run commands, docs/quickstart.md for the
end-to-end dev loop, and TODO.md for what is left. This file is what a fresh
session needs to know that the code doesn't say.

## Naming
- Everything is **Brokners** ("like brokers, but misspelled") — site, docs,
  contracts, on-chain collection name ("Brokners"/"BRKNR", vault shares
  "Brokner Vault #N"/"bknrN"). Never introduce a second product name.
- Brokners stands alone. No references to any parent fund, studio, or
  holding company anywhere in the repo: not in copy, footers, licences,
  package names, identifiers, protocol constants, or comments (scrubbed Aug
  2026 at the owner's request). The git remote's org name is the one thing
  we cannot change from here.

## Non-negotiable conventions
1. **Silly copy, serious code.** Page copy is memes (brains in jars, the
   internship, Ring the Bell, "sell them whole", "they pay their own rent"). A
   Brokner's pronouns are they/them (declared with a joke in the landing hero;
   "the whole guy" is retired); docs and the paper say "agent".
   Contracts, tests, and docs stay rigorous and deadpan. The "Silly Copy.
   Serious Code." table on index.html maps every meme claim to its enforcing
   invariant — keep it true.
2. **Testnet only — legal gate.** Open vaults are the Howey fact pattern.
   Nothing deploys to mainnet and no real deposits are taken without
   securities counsel first. This gate has been explicitly maintained even
   when shortcuts were suggested; hold it. ("Others do it" ≠ legal.)
3. **No backend for the app.** app.html (The Terminal) is a zero-build dapp:
   ES modules in js/terminal/ (chain, data, actions, crypto, venues, ui,
   views/{floor,brain,create,desk,dev}), viem via esm.sh, reads over the
   chain's public RPC (works with no wallet), writes through the wallet.
   Config lives in js/config.js (`chains: {id: {rpc, explorer, addresses,
   enclavePublicKey, enclaveUrl, hostMarket}}`) with per-chain localStorage
   overrides from the Developer tab. The only off-chain processes are the
   agent runtime (the "enclave") and the optional static data/traders.json
   from agent report.ts (the Terminal's offline snapshot). The farm's ledger
   file (agent/.farm-ledger.json, gitignored) is operator bookkeeping, not
   protocol state; the Terminal reads it through the farm's endpoint and never
   depends on it. docs/terminal.md is the spec. Dev loop: `anvil` +
   protocol/script/seed-dev.sh (rewrites the anvil block of js/config.js).
   Keep it that way.
4. **Zero build tooling for the site.** Plain HTML/CSS/JS, GitHub Pages from
   repo root (CNAME → brokners.com, .nojekyll). **One stylesheet:
   css/brokners.css**, loaded by every page; no inline `<style>` blocks
   anywhere (consolidated Aug 2026 from base/themes/components/main + three
   per-page inline blocks). Golden-ratio spacing/type scale with the
   Brokners identity baked in: "typo pink"
   accent (#d6336c light / #f06595 dark), Bricolage Grotesque h1–h3, the
   tilted pink N (.typo-n). Horizontal page padding is defined once, on
   `.container`; documents are `<main><div class="container"><article
   class="doc">` and `.doc` only sets reading measure and vertical rhythm.
   New page-specific styles go in the relevant section of brokners.css,
   never inline.
5. **The whitepaper is updated last, every time.** Any technical change
   (contracts, runtime, hosting, custody, fees) ends with docs/whitepaper.md +
   .html (+ the artifact) reflecting it, in the paper's register. Owner's
   standing instruction (Aug 2026).
6. **Genome canonicalization is frozen** (sorted keys, no whitespace —
   agent/src/genome.ts is the reference, mirrored in app.html). Changing it
   breaks every on-chain commitment. Genome *immutability is per generation*
   (Aug 2026): `TraderNFT.revise` appends a committed generation; it never
   changes what a past trade was made under.

## Protocol invariants (tests enforce all of these — protocol/test/, 69 green)
- Executor key can only call ExecutionGuard.executeTrade; proceeds always
  return to source; fuzz-tested no-extraction invariant.
- 4,096 supply cap ("one brain per bit").
- Venues/tokens protocol-curated (two markets: mWETH/mUSDC, mWBTC/mUSDC);
  owners narrow, never add. The curated venue on anvil and testnets is
  `PaperVenue` (Aug 2026): a paper market quoting from USD feeds (Chainlink
  ETH/USD `0xF0d5…8e7` / BTC/USD `0xe765…C4f` on Amoy; `MockAggregator`
  locally, written by the Developer tab's lever), filling at feed less 10 bps,
  minting mock tokens; the test fixture keeps `MockSwapRouter`. The Terminal
  has a Learn tab (views/learn.js) that walks the lifecycle.
- **Declared cadence is enforced on-chain** (Aug 2026): `tradeIntervalOf` =
  max(owner `minTradeInterval`, 1 day / `cadenceOf`), checked in
  executeTrade (first trade exempt); mint requires cadence ≥ 1. Owners
  tighten, never loosen. `nextTradeAt` is the view. The farm and the dev seed
  move the anvil clock (`evm_increaseTime`) between ticks; the Developer tab
  has the lever.
- Paper season gates vault deposits (own-book trades first, fromVault=false).
- **Generations and training camp** (Aug 2026): `revise(id, commitment, model,
  cid)` owner-only, appends; `generationOf/generationAt/GenomeRevised`; the
  guard keys `campTradesOf[id][gen]` on own-book trades and refuses vault trades
  for a revised generation until `campMinTrades` spars and `revisionNotice`
  (`setCamp`; 1 spar + 0 locally, 86400 on testnet); HWM carries (tests in
  Generations.t.sol). Farm re-enrols on commitment change and spars in camp;
  `/train` coaches sealed brains in-enclave (`composeRevision`). Meme: "they
  train between fights". 69 tests.
- Fees: streamed mgmt + perf above per-share HWM, minted to the trader's TBA
  (travel with the NFT), checkpointed in the transfer hook.
- ringTheBell(): caller gets 1% of crystallized fee shares, from the owner's
  take, never LP capital.
- Seat tiers (Intern 20% / Associate 30% / Partner 50% notional ceilings),
  activate() is owner-only, upgrade-only, fee to treasury.
- Custody trait: 0 authored / 1 sealed-authored / 2 sealed-generated (ECIES
  x25519→HKDF→AES-GCM to the enclave key, HKDF info "brokners-genome-v2";
  agent/src/enclave.ts and js/terminal/crypto.js are byte-compatible — the
  browser mints authored and sealed; sealed-generated is CLI-only).
- Read-side views added for the Terminal: `TraderVault.pendingFees()` (what
  the next checkpoint mints + the ringer's cut) and `TraderNFT.christen/nameOf`
  (owner-only, once, ≤32 bytes). `TraderNFT.publishEnvelope` emits the sealed
  jar as `EnvelopePublished` (sealed custody only) so the farm can run a brain
  with no file handoff. Views.t.sol.
- **Brains run themselves:** enrolment = `setExecutor(tokenId, enclaveExecutor)`
  (config.js per chain); `agent: npm run farm` is the one enclave process that
  runs every enrolled brain (own book while unseasoned, vault once seasoned),
  verifying each envelope against its commitment. Authored brains stay
  self-hosted (`npm run loop`). Wizard step 5 = publish + fund + authorise +
  enrol. Whitepaper §3.1 / §6.2 / §9 describe this; keep them in sync.
- Runtime economics + identity (Runtime.t.sol): `ExecutionGuard.runtimeFeeOf`
  (owner-set ≤ `maxRuntimeFee`, paid post-trade from the traded book to the
  executor, skipped if no base left, bounded per day by the enforced cadence:
  at most cadence × cap — cannot extract); `RuntimeRegistry` (executor key →
  measurement + enclave key; `attestationOf` 0 none / 1 self-reported / 2
  hardware; `attested()` = registered + deployer-approved measurement either
  way; `hardwareAttested()` = approved + kind 2). `registerAttested(quote,
  key)` goes through `IQuoteVerifier` (deployer-set): `AutomataDcapTdxVerifier`
  wraps Automata DCAP (deployed on Polygon and Amoy at
  0xaDdeC7e85c2182202b66E331f2a4A0bBB2cEEa1F; deploy-testnet.sh wires it),
  parses the TD report out of the serialized Output (measurement =
  keccak256(mrTd ‖ rtMr0..3), report data must equal keccak256(executor ‖
  enclave key) — the farm prints that hash at start); mocks for tests.
  **Paid for evidence** (Aug 2026): with `ExecutionGuard.registry` set, the
  fee goes only to an executor the registry marks `attested`; no fee on trades
  under `minFeeNotionalBps` (1%) of NAV; raises are scheduled `runtimeFeeDelay`
  ahead (`pendingRuntimeFeeOf`; 0 locally, 86400 on testnet), lowering is
  immediate; `executeTradeWithTranscript(…, bytes32)` emits
  `TranscriptCommitted` with the keccak256 of the inference transcript
  (agent/src/transcript.ts; kept under its hash in FARM_TRANSCRIPTS_DIR). The
  site calls operators **harvesters**; they harvest the fee, never the returns.
  `TraderNFT.tokenURI` on-chain JSON + jar SVG, rendered by `JarRenderer`
  (separate contract: TraderNFT embeds TraderVault's creation code and sits
  ~2 KB under the 24 KB limit; keep new logic out of it). The farm self-registers
  (`agent/src/measure.ts`; FARM_QUOTE_PATH for the hardware path), serves
  `/compose`, `/health`, `/ledger` on FARM_HTTP_PORT, honours FARM_MIN_FEE.
  `protocol/script/deploy-testnet.sh` for Polygon Amoy.
- **The farm pays for itself** (Aug 2026; docs/runtime-hosting.md): budget.ts
  is the ledger (income = RuntimeFeePaid to this key, recomputed from logs;
  costs = model tokens priced per model, gas priced via FARM_NATIVE_PRICE,
  lease accrued at the host's rate; persisted to FARM_LEDGER_PATH). Policy:
  a brain may consume FARM_GRACE (default 1 base unit) beyond what it paid;
  past that it is paused until the owner *raises* the fee (the debt is written
  off once; lowering changes nothing); the ledger reports the per-trade fee
  that would have covered it and My Desk shows it. host.ts reads the machine
  lease from an Oyster-compatible market (`jobs`/`jobDeposit`; Marlin MarketV1
  on Arbitrum One 0x9d95D61eA056721E358BC49fE995caBF3B86A34B, USDC, rate per
  second scaled by EXTRA_DECIMALS) and tops it up from the executor key's
  float before it runs out (FARM_HOST=oyster|market; MockOysterMarket locally,
  Deploy.s.sol deploys it last so the other addresses stay put; seed-dev.sh
  opens a 0.12/h job and prints the farm command). bridge.ts is Circle CCTP
  v2 (Polygon → Arbitrum One; mainnet-only in meaning: the testnet base asset
  is a mock, not Circle's USDC). brain.ts has `GatewayBrain` (OpenAI-compatible
  TEE inference gateway, INFERENCE_BASE_URL) next to `ClaudeBrain`; decide()
  returns usage so ticks can be priced. agent/test/*.test.ts (`npm test`)
  cover the arithmetic; the loop was exercised end to end on anvil.

## Related, outside this repo
- Whitepaper artifact (private share link, same content as
  docs/whitepaper.html): https://claude.ai/code/artifact/2287404c-5a78-4766-9d09-0a53f06f6d56
  docs/whitepaper.html is the editable source of truth for the styled paper
  (keep whitepaper.md in sync); docs/architecture.html client-renders
  architecture.md via marked+mermaid CDN — the .md is the single source there.

## Backlog and the decisions behind it
The item list lives in TODO.md (checkboxes; tick them there). The decisions
that constrain it, which are not up for re-litigation in a session:
- **Real TEE for the enclave: no AWS.** Intel TDX on a provider a bare EVM
  key can rent and extend in USDC: Marlin Oyster CVM first, Phala Cloud as
  dev/fallback; model calls via a USDC-paid TEE inference gateway; quotes
  verified through Automata DCAP into RuntimeRegistry; the farm pays its own
  lease from runtime fees. The contract half (verifier adapter, attested
  registration, labels) and the farm half (lease loop, gateway brain, quote
  registration path) are built; what remains is operational
  (docs/runtime-hosting.md has the runbook). Lit Protocol for authored-custody
  handoff.
- **First live venue is Polymarket** (Polygon; CTF Exchange, USDC collateral,
  binary outcome tokens) via a thin IVenue adapter — decided Aug 2026,
  replaces the earlier Uniswap-on-Base-Sepolia plan. Testnet pilot on Polygon
  Amoy against a mock conditional-token exchange; canonical 6551 registry
  0x000000006551c19487814612e58FE06813775758. Open integration question: the
  TBA must be the off-chain order signer and must refuse anything the guard
  would reject (signing policy in the enclave + approvals to the exchange
  only). The protocol tests still use the two mock spot markets; that is fine
  for the invariants but the paper describes Polymarket as the target.
- **Buyback/AMM floor pool, if ever, is base-asset denominated**: NO native
  token, no burns, no stock distributions (deliberately rejected from
  StonkBrokers).
- **TWAP/oracle NAV pricing + fee-crystallization delay** is the biggest known
  protocol weakness (spot quote is manipulable) and the first protocol item.
- **The whitepaper (docs/whitepaper.*) is design/theory only** — legal and
  regulatory discussion was removed at the owner's request (Aug 2026). The
  testnet-only gate above is still an operating rule; it just isn't argued in
  the paper.
