# BROKNERS — project conventions and state

Read README.md first for layout and run commands. This file is what a fresh
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
   internship, Ring the Bell, "sell the whole guy"). Contracts, tests, and
   docs stay rigorous and deadpan. The "Silly Copy. Serious Code." table on
   index.html maps every meme claim to its enforcing invariant — keep it true.
2. **Testnet only — legal gate.** Open vaults are the Howey fact pattern.
   Nothing deploys to mainnet and no real deposits are taken without
   securities counsel first. This gate has been explicitly maintained even
   when shortcuts were suggested; hold it. ("Others do it" ≠ legal.)
3. **No backend for the app.** app.html (The Terminal) is a zero-build dapp:
   ES modules in js/terminal/ (chain, data, actions, crypto, venues, ui,
   views/{floor,brain,create,desk,dev}), viem via esm.sh, reads over the
   chain's public RPC (works with no wallet), writes through the wallet.
   Config lives in js/config.js (`chains: {id: {rpc, explorer, addresses,
   enclavePublicKey}}`) with per-chain localStorage overrides from the
   Developer tab. The only off-chain processes are the agent runtime (the
   "enclave") and the optional static data/traders.json from agent report.ts
   (the Terminal's offline snapshot). docs/terminal.md is the spec. Dev loop:
   `anvil` + protocol/script/seed-dev.sh (rewrites the anvil block of
   js/config.js). Keep it that way.
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
   breaks every on-chain commitment.

## Protocol invariants (tests enforce all of these — protocol/test/, 55 green)
- Executor key can only call ExecutionGuard.executeTrade; proceeds always
  return to source; fuzz-tested no-extraction invariant.
- 4,096 supply cap ("one brain per bit").
- Venues/tokens protocol-curated (two markets: mWETH/mUSDC, mWBTC/mUSDC);
  owners narrow, never add.
- Paper season gates vault deposits (own-book trades first, fromVault=false).
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
  executor, skipped if no base left — cannot extract); `RuntimeRegistry`
  (executor key → self-reported measurement + enclave key; deployer approves;
  `attested()` = registered + approved — labelled "self-reported, not
  hardware-attested" everywhere); `TraderNFT.tokenURI` on-chain JSON + jar SVG.
  The farm self-registers (`agent/src/measure.ts`), serves `/compose` +
  `/health` on FARM_HTTP_PORT (sealed-generated from the browser), honours
  FARM_MIN_FEE. `protocol/script/deploy-testnet.sh` for Polygon Amoy.

## Related, outside this repo
- Whitepaper artifact (private share link, same content as
  docs/whitepaper.html): https://claude.ai/code/artifact/2287404c-5a78-4766-9d09-0a53f06f6d56
  docs/whitepaper.html is the editable source of truth for the styled paper
  (keep whitepaper.md in sync); docs/architecture.html client-renders
  architecture.md via marked+mermaid CDN — the .md is the single source there.

## v2 backlog (agreed direction, not started)
- TWAP/oracle NAV pricing + fee-crystallization delay (spot quote is
  manipulable — biggest known protocol weakness).
- Vault auto-unwind / in-kind redemption so LP withdrawals never block on
  base-asset liquidity.
- Executor auto-reset on NFT transfer; timelocked executor change as LP
  notice.
- Daily notional budget on top of the per-trade cap.
- Buyback/AMM floor pool (base-asset denominated — NO native token, no
  burns, no stock distributions; deliberately rejected from StonkBrokers).
- Terminal leaderboard page ("The Floor") fed by report.ts.
- Real TEE for the enclave: **no AWS**; Intel TDX on a provider a bare EVM
  key can rent and extend in USDC (Marlin Oyster CVM first, Phala Cloud as
  dev/fallback), model calls via a USDC-paid TEE inference gateway, quotes
  verified through Automata DCAP into RuntimeRegistry; the farm pays its own
  lease from runtime fees (docs/runtime-hosting.md). Lit Protocol for
  authored-custody
  handoff.
- Proof of Brain: attestation registry binding executor keys to reproducible
  runtime measurements, so "AI-traded" is verifiable, not claimed.
- Realized-only performance fees.
- First live venue is **Polymarket** (Polygon; CTF Exchange, USDC collateral,
  binary outcome tokens) via a thin IVenue adapter — decided Aug 2026, replaces
  the earlier Uniswap-on-Base-Sepolia plan. Testnet pilot on Polygon Amoy
  against a mock conditional-token exchange; canonical 6551 registry
  0x000000006551c19487814612e58FE06813775758. Open integration question: the
  TBA must be the off-chain order signer and must refuse anything the guard
  would reject (signing policy in the enclave + approvals to the exchange only).
  The protocol tests still use the two mock spot markets; that is fine for the
  invariants but the paper now describes Polymarket as the target.
- The whitepaper (docs/whitepaper.*) is design/theory only — legal and
  regulatory discussion was removed at the owner's request (Aug 2026). The
  testnet-only gate above is still an operating rule; it just isn't argued in
  the paper.
