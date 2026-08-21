# BROKNERS — project conventions and state

Read README.md first for layout and run commands. This file is what a fresh
session needs to know that the code doesn't say.

## Naming
- Everything is **Brokners** ("like brokers, but misspelled") — site, docs,
  contracts, on-chain collection name ("Brokners"/"BRKNR", vault shares
  "Brokner Vault #N"/"bknrN"). Never introduce a second product name.
- **Darkly Fund** appears only as plain-text attribution in footers and legal
  disclosures — never as a link, never as branding.

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
   viem via esm.sh CDN, wallet talks straight to contracts, addresses in
   js/config.js + localStorage. The only off-chain processes are the agent
   runtime (the "enclave") and the optional static data/traders.json from
   agent report.ts. Keep it that way.
4. **Zero build tooling for the site.** Plain HTML/CSS/JS, GitHub Pages from
   repo root (CNAME → brokners.com, .nojekyll). Design system: darkly.fund
   tokens (css/base.css golden-ratio scale, css/themes.css light/dark) with
   the Brokners identity layered in css/main.css — "typo pink" accent
   (#d6336c light / #f06595 dark) overriding the fund blue on body tokens,
   Bricolage Grotesque display headings, the tilted pink N in the wordmark.
5. **Genome canonicalization is frozen** (sorted keys, no whitespace —
   agent/src/genome.ts is the reference, mirrored in app.html). Changing it
   breaks every on-chain commitment.

## Protocol invariants (tests enforce all of these — protocol/test/, 42 green)
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
  x25519→HKDF→AES-GCM to the enclave key; agent/src/enclave.ts; browser mint
  does authored only).

## Related, outside this repo
- darkly.fund repo (../darkly.fund) links here from its nav; keep it
  institutional — no Brokners content there beyond the link.
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
- Real TEE (AWS Nitro) for the enclave; Lit Protocol for authored-custody
  handoff.
- Proof of Brain: attestation registry binding executor keys to reproducible
  runtime measurements, so "AI-traded" is verifiable, not claimed.
- Realized-only performance fees.
- Base Sepolia deployment (canonical 6551 registry
  0x000000006551c19487814612e58FE06813775758; Uniswap v3 via a thin IVenue
  adapter).
