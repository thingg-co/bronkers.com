// One brain: its record, its terms, its identity, and what you can do with it.
import { formatUnits, parseUnits } from "https://esm.sh/viem@2.21.19";
import * as act from "../actions.js";
import { CUSTODY, RISK, TIERS } from "../abi.js";
import { explorerAddr, isMe, state } from "../chain.js";
import { invalidate, loadBrain, loadSnapshot, ringable } from "../data.js";
import { describe as describeVenueTrade, describeHolding } from "../venues.js";
import { addrChip, amountField, append, badge, clear, el, emptyState, fmt, kv, modal, progress, sparkline, spinner, toast } from "../ui.js";
import { custodyBadge, jar, statusBadge } from "./floor.js";

const WAD = 10n ** 18n;


function tradesTable(brain) {
  if (!brain.trades.length) return emptyState("No trades yet.");
  const rows = brain.trades.slice().reverse().map((t) =>
    el("tr", {},
      el("td", { title: fmt.date(t.ts) }, fmt.when(t.ts)),
      el("td", {}, (() => { const d = describeVenueTrade(t); return [d.text, d.detail ? el("span", { class: "muted small" }, " · ", d.detail) : null]; })()),
      el("td", {}, badge(t.fromVault ? "vault" : "own book", t.fromVault ? "accent" : "muted"), t.transcript ? [" ", el("span", { class: "badge muted", title: `The runtime committed the hash of the inference transcript behind this trade: ${t.transcript}` }, "transcript")] : null),
      el("td", { class: "mono" }, t.hash ? (explorerAddr(t.hash) ? el("a", { href: `${state.cfg.explorer}/tx/${t.hash}`, target: "_blank", rel: "noopener" }, fmt.hash(t.hash)) : fmt.hash(t.hash)) : `block ${t.block}`)));
  return el("div", { class: "tablewrap" }, el("table", { class: "table trades" },
    el("thead", {}, el("tr", {}, el("th", {}, "When"), el("th", {}, "Trade"), el("th", {}, "Book"), el("th", {}, "Tx"))),
    el("tbody", {}, rows)));
}

function chart(brain) {
  const hasLp = brain.supply > 0n;
  const series = brain.series || [];
  const vals = hasLp ? series.map((p) => Number(p.pps) / 1e18) : series.map((p) => Number(p.own) / 1e18);
  const title = hasLp ? "Vault share price" : "Own book (paper season)";
  const first = vals[0];
  const last = vals[vals.length - 1];
  return el("div", { class: "chart" },
    el("div", { class: "chart-head" },
      el("span", { class: "chart-title" }, title),
      vals.length > 1 ? el("span", { class: `chart-delta ${last >= first ? "up" : "down"}` }, hasLp ? fmt.pct(last / first - 1) : `${fmt.num(first)} → ${fmt.num(last)}`) : null),
    vals.length > 1 ? sparkline(vals, { width: 640, height: 120, cls: "large" }) : el("p", { class: "muted" }, "Not enough history to chart yet."),
    series.length > 1 ? el("div", { class: "chart-axis" }, el("span", {}, fmt.when(series[0].ts)), el("span", {}, "now")) : null);
}

function internship(brain) {
  if (brain.seasoned) return null;
  const { minTrades, duration } = brain.season;
  const tradesRatio = minTrades ? brain.tradeCount / minTrades : 1;
  const elapsed = brain.firstTradeAt ? Math.floor(Date.now() / 1000) - brain.firstTradeAt : 0;
  const timeRatio = duration ? Math.min(1, elapsed / duration) : 1;
  return el("div", { class: "panel" },
    el("h4", {}, "The internship"),
    el("p", { class: "muted" }, "A new brain trades its own wallet first. Outside deposits open once it has ",
      el("strong", {}, `${minTrades} trade${minTrades === 1 ? "" : "s"}`), duration ? [" over at least ", el("strong", {}, fmt.duration(duration))] : null, " on its own book."),
    progress(tradesRatio, `${brain.tradeCount} / ${minTrades} trades`),
    duration ? progress(timeRatio, brain.firstTradeAt ? `${fmt.duration(elapsed)} / ${fmt.duration(duration)} since first trade` : "clock starts at the first trade") : null);
}

// ---- action modals ----

function depositModal(brain, refresh) {
  if (!state.account) return modal({ title: "Deposit", body: el("p", {}, "Connect a wallet to deposit."), actions: [{ label: "Close" }] });
  if (!brain.seasoned) return modal({ title: "Deposit", body: el("p", {}, "This brain is still an intern and cannot take outside money yet."), actions: [{ label: "Close" }] });
  if (brain.allowlistEnabled && !brain.depositAllowed) {
    return modal({ title: "Deposit", body: el("div", {},
      el("p", {}, "This vault is allowlist-only and your address is not on it."),
      el("p", { class: "muted" }, "The owner can add you (My Desk → Depositors) or open the vault to anyone.")), actions: [{ label: "Close" }] });
  }
  const maxStr = formatUnits(brain.my.usdc, 18);
  const field = amountField({ label: "Amount", max: Number(maxStr) > 0 ? maxStr : null, maxLabel: `balance ${fmt.amt(brain.my.usdc)}`, tip: "mUSDC to deposit. You receive vault shares at the current share price and can redeem them any time." });
  const est = el("p", { class: "muted est" });
  const update = () => {
    const v = Number(field.value() || 0);
    const shares = brain.pps > 0n ? v / (Number(brain.pps) / 1e18) : v;
    est.textContent = v > 0 ? `≈ ${fmt.num(shares, 4)} shares at ${fmt.num(Number(brain.pps) / 1e18, 4)} mUSDC each` : "";
  };
  field.input.addEventListener("input", update);
  const body = el("div", {},
    el("p", {}, `You are allocating to `, el("strong", {}, brain.label), ". Withdraw any time at the prevailing share price; the executor key cannot touch or block withdrawals."),
    field.el, est,
    kv([
      ["Management fee", `${fmt.bps(brain.fees.mgmtBps)} per year, streamed`],
      ["Performance fee", `${fmt.bps(brain.fees.perfBps)} of gains above the high-water mark`],
      ["Share price", `${fmt.num(Number(brain.pps) / 1e18, 4)} mUSDC`],
    ]));
  const m = modal({ title: `Deposit into ${brain.label}`, body, actions: [
    { label: "Cancel" },
    { label: "Deposit", kind: "primary", onClick: async () => {
      try {
        const steps = await act.deposit(brain, field.value());
        m.close();
        const ok = await act.runSteps("Deposit", steps, { summary: el("p", {}, `${field.value()} mUSDC → ${brain.label}`) });
        if (ok) refresh();
      } catch (e) { toast(act.explain(e), "err"); }
    } },
  ] });
}

function withdrawModal(brain, refresh) {
  const field = amountField({ label: "Amount", max: formatUnits(brain.my.assets, 18), maxLabel: `position ${fmt.amt(brain.my.assets)}`, tip: "mUSDC to take out. Paid from the vault's cash; shares are burned at the current share price." });
  const body = el("div", {},
    el("p", {}, "Your position in ", el("strong", {}, brain.label), ": ", el("strong", {}, fmt.usd(brain.my.assets)), ` (${fmt.amt(brain.my.shares, 18, 4)} shares).`),
    field.el,
    el("p", { class: "muted" }, "Withdrawals pay mUSDC. If the vault is heavily deployed the brain may need to unwind first (prototype limitation)."));
  const m = modal({ title: `Withdraw from ${brain.label}`, body, actions: [
    { label: "Cancel" },
    { label: "Withdraw all", onClick: async () => { m.close(); const ok = await act.runSteps("Withdraw", act.withdrawAll(brain)); if (ok) refresh(); } },
    { label: "Withdraw amount", kind: "primary", onClick: async () => {
      try { const steps = act.withdrawAmount(brain, field.value()); m.close(); const ok = await act.runSteps("Withdraw", steps); if (ok) refresh(); } catch (e) { toast(act.explain(e), "err"); }
    } },
  ] });
}

function bellModal(brain, refresh) {
  const p = brain.pending;
  const total = p.mgmt + p.perf;
  const rewardValue = (p.reward * brain.pps) / WAD;
  const body = el("div", {},
    el("p", {}, "Fee crystallisation is a public crank. Whoever rings takes 1% of the fee shares it mints, out of the owner's cut. Never from depositors."),
    kv([
      ["Management fees due", `${fmt.amt(p.mgmt, 18, 4)} shares`],
      ["Performance fees due", `${fmt.amt(p.perf, 18, 4)} shares`],
      ["Your reward", total > 0n ? `${fmt.amt(p.reward, 18, 4)} shares ≈ ${fmt.usd(rewardValue)}` : "nothing right now"],
    ]),
    total === 0n ? el("p", { class: "muted" }, "Nothing to crystallise yet. Fees accrue over time and above the high-water mark.") : null);
  const m = modal({ title: `Ring the bell on ${brain.label}`, body, actions: [
    { label: "Close" },
    { label: "🔔 Ring it", kind: "primary", disabled: !state.account || total === 0n, onClick: async () => { m.close(); const ok = await act.runSteps("Ring the bell", act.ring(brain)); if (ok) refresh(); } },
  ] });
}

function actionsPanel(brain, refresh) {
  const btns = [];
  const connected = Boolean(state.account);
  btns.push(el("button", { class: "btn primary", disabled: brain.snapshot, onclick: () => depositModal(brain, refresh) }, "Deposit"));
  if (connected && brain.my && brain.my.shares > 0n) btns.push(el("button", { class: "btn", onclick: () => withdrawModal(brain, refresh) }, `Withdraw (${fmt.amt(brain.my.assets)} mUSDC)`));
  btns.push(el("button", { class: "btn bell", disabled: brain.snapshot, onclick: () => bellModal(brain, refresh) }, ringable(brain) ? `🔔 Ring the bell · +${fmt.amt(brain.pending.reward, 18, 4)} shares` : "🔔 Ring the bell"));
  if (brain.mine) btns.push(el("a", { class: "btn", href: `#/desk/${brain.id}` }, "Manage (My Desk)"));
  const hint = !connected ? el("p", { class: "muted" }, "Connect a wallet to deposit, withdraw, or ring. Browsing is free.") : null;
  return el("div", { class: "panel actions-panel" }, el("div", { class: "btn-row" }, btns), hint);
}

function vaultTerms(brain) {
  const me = state.account;
  return el("div", { class: "panel" },
    el("h4", {}, "Vault"),
    kv([
      ["Assets under management", fmt.usd(brain.nav)],
      ["Share price", `${fmt.num(Number(brain.pps) / 1e18, 4)} mUSDC`],
      ["High-water mark", `${fmt.num(Number(brain.fees.hwm) / 1e18, 4)} mUSDC / share`],
      ["Management fee", `${fmt.bps(brain.fees.mgmtBps)} / year`],
      ["Performance fee", `${fmt.bps(brain.fees.perfBps)} above the mark`],
      ["Fees accrued to the jar", `${fmt.amt(brain.fees.feeShares, 18, 4)} shares ≈ ${fmt.usd(brain.fees.feeSharesValue)}`, "Fee shares are minted to the brain's own wallet, so they travel with the token."],
      ["Deposits", brain.allowlistEnabled ? (me ? (brain.depositAllowed ? "allowlist · you're on it" : "allowlist · you're not on it") : "allowlist only") : "open to anyone"],
      brain.runtimeFeePayments ? ["Runtime fees paid", `${fmt.amt(brain.runtimeFeesPaid || 0n, 18, 4)} mUSDC over ${brain.runtimeFeePayments} trade${brain.runtimeFeePayments === 1 ? "" : "s"}`, "What the brain has paid its executor to run it, from whichever book traded. A fund expense, on-chain (RuntimeFeePaid), like any other."] : null,
      me ? ["Your position", brain.my.shares > 0n ? `${fmt.usd(brain.my.assets)} (${fmt.amt(brain.my.shares, 18, 4)} shares)` : "none"] : null,
      ["Holdings", [...brain.holdings.map((h) => describeHolding(h).text), `${fmt.amt(brain.vaultUsdc ?? 0n)} mUSDC cash`].join(" · ")],
    ]));
}

function identity(brain) {
  const c = CUSTODY[brain.genome.custody] || CUSTODY[0];
  const ex = state.cfg.explorer;
  const executor = brain.policy?.executor;
  return el("div", { class: "panel" },
    el("h4", {}, "Identity"),
    kv([
      ["Owner", addrChip(brain.owner, { explorer: ex })],
      ["Brain's wallet", addrChip(brain.tba, { explorer: ex }), "ERC-6551 token-bound account. Whoever owns the token controls it."],
      ["Vault", addrChip(brain.vault, { explorer: ex })],
      brain.runtime ? ["Runs in", brain.runtime.kind === "enclave" ? [badge("the enclave", "good"), " ", brain.runtime.attested ? badge(brain.runtime.attestation === 2 ? "attested runtime · TDX quote" : "attested runtime · reviewed", "good") : brain.runtime.registered ? badge("registered runtime", "accent") : badge("operated", "muted"), " ", el("span", { class: "muted" }, `last trade ${brain.runtime.lastTradeAt ? fmt.when(brain.runtime.lastTradeAt) : "never"}`)] : brain.runtime.kind === "self" ? [badge("self-hosted", "accent"), " ", el("span", { class: "muted" }, "operated by the owner")] : badge("not running", "bad"), brain.runtime.attested ? (brain.runtime.attestation === 2 ? "The executor key presented a TDX quote that the chain's DCAP verifier accepted; the quote binds this key and the enclave key to a runtime measurement the protocol has approved." : "The executor key is registered to a runtime measurement the protocol has approved. Self-reported and reviewed, not signed by hardware.") : "Attested execution (TEE) is on the roadmap; until then “AI-traded” is an operator claim and “operated” is the honest label."] : null,
      brain.runtime && brain.runtime.registered ? ["Runtime measurement", el("span", { class: "mono small" }, brain.runtime.measurement), brain.runtime.attestation === 2 ? "keccak256 of the TD's MRTD and RTMRs, read from the verified quote" : "sha256 of the runtime's source bundle, registered by the executor key"] : null,
      brain.runtimeFee != null ? ["Runtime fee", `${fmt.amt(brain.runtimeFee, 18, 4)} mUSDC per trade · at most ${brain.genome.cadence} a day (${fmt.amt(brain.maxDailyRuntimeFee || 0n, 18, 4)} mUSDC)${brain.feesGated ? " · paid only to an attested executor" : ""}${brain.minFeeNotionalBps ? `, on trades of at least ${fmt.bps(brain.minFeeNotionalBps)} of NAV` : ""}`, "Paid from the traded book to the executor on each trade, to cover gas and model calls. Protocol-capped, bounded per day because trades are, paid only for evidence: an attested runtime, a trade of real size."] : null,
      brain.pendingRuntimeFee && brain.pendingRuntimeFee.effectiveAt && brain.runtime && brain.pendingRuntimeFee.effectiveAt > brain.runtime.now ? ["Fee raise scheduled", `${fmt.amt(brain.pendingRuntimeFee.fee, 18, 4)} mUSDC per trade in about ${fmt.duration(brain.pendingRuntimeFee.effectiveAt - brain.runtime.now)}`, "Fee raises take effect after a notice period so depositors see them coming; lowering is immediate."] : null,
      executor != null ? ["Executor", executor && executor !== "0x0000000000000000000000000000000000000000" ? addrChip(executor, { explorer: ex }) : badge("not set", "muted"), "The hot key that signs trades. It can only call executeTrade."] : null,
      brain.genome.custody !== 0 ? ["Sealed jar", brain.envelopePublished ? "published on-chain (ciphertext)" : "not published", "The encrypted genome; only the enclave key opens it."] : null,
      ["Custody", [c.label, " — ", el("span", { class: "muted" }, c.blurb)]],
      ["Genome commitment", el("span", { class: "mono small" }, brain.genome.commitment)],
      ["Model", brain.genome.model],
      ["Declared cadence", `${brain.genome.cadence} trades / day · enforced on-chain: one trade every ${fmt.duration(brain.tradeInterval || Math.floor(86400 / Math.max(1, brain.genome.cadence)))}${brain.nextTradeAt && brain.runtime && brain.nextTradeAt > brain.runtime.now ? ` · next allowed in about ${fmt.duration(brain.nextTradeAt - brain.runtime.now)}` : ""}`, "A public trait the guard enforces as a minimum interval between trades. The owner may tighten it, never loosen it."],
      ["Risk profile", RISK[brain.genome.riskProfile] || String(brain.genome.riskProfile)],
      ["Born", `block ${brain.genome.birthBlock}`],
      brain.policy ? ["Per-trade cap", `${fmt.bps(brain.policy.maxNotionalBps)} of NAV (${TIERS[brain.tier]} seat)`] : null,
      brain.policy ? ["Slippage bound", fmt.bps(brain.policy.maxSlippageBps)] : null,
    ]));
}

export async function render(root, { id }) {
  clear(root);
  root.append(el("p", {}, el("a", { href: "#/", class: "back" }, "← The Floor")), spinner("Reading the record…"));
  let brain;
  try {
    if (state.mode === "offline" || !state.cfg.traderNFT) throw new Error("offline");
    brain = await loadBrain(id);
  } catch (e) {
    try {
      const snap = await loadSnapshot();
      brain = snap.brains.find((b) => b.id === Number(id));
      if (!brain) throw e;
      brain.series = [];
      brain.holdings = [];
      brain.fees = { mgmtBps: 0, perfBps: 0, hwm: WAD, feeShares: 0n, feeSharesValue: 0n };
      brain.my = { shares: 0n, assets: 0n, usdc: 0n };
    } catch {
      clear(root);
      root.append(el("p", {}, el("a", { href: "#/", class: "back" }, "← The Floor")), emptyState(`Could not load brain #${id}.`, el("p", { class: "muted" }, act.explain(e))));
      return;
    }
  }
  const refresh = async () => { invalidate(brain.id); await render(root, { id }); };
  clear(root);
  const ageTs = brain.trades.length ? brain.trades[0].ts : null;
  append(root, [
    el("p", {}, el("a", { href: "#/", class: "back" }, "← The Floor")),
    el("header", { class: "brain-head" },
      jar(brain),
      el("div", { class: "brain-title" },
        el("h2", {}, brain.label, " ", el("span", { class: "tier-chip" }, TIERS[brain.tier])),
        el("p", { class: "card-badges" }, statusBadge(brain), custodyBadge(brain), brain.mine ? badge("yours", "accent") : null, brain.snapshot ? badge("snapshot", "muted") : null),
        el("p", { class: "muted" }, "Owned by ", addrChip(brain.owner, { explorer: state.cfg.explorer }), isMe(brain.owner) ? " (you)" : ""))),
    el("div", { class: "stat-grid" },
      stat("Share price return", brain.supply > 0n ? fmt.pct(brain.sharePriceReturn) : "–", brain.supply > 0n ? "since inception" : "no outside capital yet"),
      stat("Vault NAV", fmt.amt(brain.nav), "mUSDC"),
      stat("Own book", fmt.amt(brain.tbaNav), "mUSDC in the brain's wallet"),
      stat("Trades", String(brain.tradeCount), ageTs ? `first ${fmt.when(ageTs)}` : "none yet"),
      stat("Max drawdown", brain.series.length > 1 ? fmt.pct(-brain.drawdown, 1) : "–", "share price, trade-to-trade")),
    chart(brain),
    internship(brain),
    actionsPanel(brain, refresh),
    el("h3", { class: "section-sub" }, "Track record"),
    el("p", { class: "muted" }, "Every row is a ", el("code", {}, "TradeExecuted"), " event from the guard. Recompute it yourself; this page only summarises.", brain.transcripts ? ` ${brain.transcripts} of ${brain.trades.length} trades carry a transcript hash: the runtime's evidence of what the model saw and decided, checkable against a disclosed transcript.` : ""),
    tradesTable(brain),
    el("div", { class: "two-col" }, vaultTerms(brain), identity(brain)),
    tokenPanel(brain)]);
}

function tokenPanel(brain) {
  if (!brain.token) return null;
  const mk = state.cfg.marketplace ? state.cfg.marketplace.replace("{nft}", state.cfg.traderNFT).replace("{id}", String(brain.id)) : null;
  return el("div", { class: "panel token-panel" },
    el("h4", {}, "The token"),
    el("div", { class: "token-row" },
      brain.token.image ? el("img", { src: brain.token.image, alt: `${brain.label} token image`, class: "token-img" }) : null,
      el("div", {},
        el("p", { class: "muted" }, "Metadata lives on-chain (", el("code", {}, "tokenURI"), "): name, public traits, and the jar. Any ERC-721 marketplace renders it; the record, wallet and fee stream travel with it."),
        el("p", { class: "card-badges" }, (brain.token.attributes || []).map((a) => badge(`${a.trait_type}: ${a.value}`))),
        mk ? el("a", { class: "btn", href: mk, target: "_blank", rel: "noopener" }, "View on the marketplace") : null)));
}

function stat(label, value, sub) {
  return el("div", { class: "stat" }, el("span", { class: "stat-label" }, label), el("span", { class: "stat-value" }, value), sub ? el("span", { class: "stat-sub" }, sub) : null);
}
