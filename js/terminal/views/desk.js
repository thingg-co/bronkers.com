// My Desk: what you own, what you've deposited, and which bells are worth ringing.
import { formatUnits } from "https://esm.sh/viem@2.21.19";
import * as act from "../actions.js";
import { TIERS } from "../abi.js";
import { state } from "../chain.js";
import { invalidate, loadBrain, loadRoster, ringable } from "../data.js";
import { addrChip, amountField, badge, clear, el, emptyState, fmt, kv, modal, spinner, textField, tip, toast } from "../ui.js";

const TIPS = {
  fund: "mUSDC sent here is the brain's own book. It trades this during the internship; you can sweep it back any time.",
  executor: "The hot key the runtime signs with. It can only call executeTrade and can never move funds out. Enrolling sets it to the enclave's key; rotate it after buying a brain.",
  name: "Permanent and public. 32 bytes max.",
  allow: "Addresses allowed to deposit while the vault is allowlist-only.",
  notional: "Largest single trade as a share of NAV, in basis points (2500 = 25%). Capped by the seat.",
  slippage: "How far below the venue quote the executor may accept, in basis points (100 = 1%).",
  interval: "Minimum seconds between trades, enforced on-chain. 0 = no limit beyond the declared cadence.",
  transfer: "Sends the token. Everything in the brain's wallet goes with it; sweep first to keep the capital.",
  jar: "The sealed envelope (.sealed.json) this brain was minted with. Publishing puts the ciphertext on-chain so an enclave can run the brain.",
};
import { custodyBadge, jar, statusBadge } from "./floor.js";

const ZERO = "0x0000000000000000000000000000000000000000";

async function run(title, steps, refresh, summary) {
  const ok = await act.runSteps(title, steps, { summary });
  if (ok) await refresh();
}

async function manage(brain, refresh) {
  const mk = (title, ...children) => el("div", { class: "panel" }, el("h4", {}, title), ...children);
  const ex = state.cfg.explorer;

  // wallet (own book)
  const fundField = amountField({ label: "Fund the brain's wallet", max: formatUnits(brain.my.usdc, 18), maxLabel: `balance ${fmt.amt(brain.my.usdc)}`, tip: TIPS.fund });
  const walletPanel = mk("The brain's wallet (its own book)",
    kv([
      ["Address", addrChip(brain.tba, { explorer: ex })],
      ["mUSDC", fmt.amt(brain.tbaUsdc)],
      ...brain.holdings.map((h) => [h.sym, fmt.amt(h.tbaBal, 18, 4)]),
      ["Guard authorised", brain.tbaAuthorised ? badge("yes", "good") : badge("no", "bad")],
    ]),
    !brain.tbaAuthorised ? el("p", { class: "muted" }, "The guard needs a one-time approval from the brain's wallet before the runtime can trade its own book.") : null,
    el("div", { class: "btn-row" },
      !brain.tbaAuthorised ? el("button", { class: "btn primary", onclick: () => run("Authorise the guard", act.authoriseGuard(brain), refresh) }, "Authorise the guard") : null,
      [brain.tbaUsdc > 0n ? el("button", { class: "btn", onclick: () => run("Sweep", act.sweep(brain, state.cfg.usdc, brain.tbaUsdc, "mUSDC"), refresh) }, `Sweep ${fmt.amt(brain.tbaUsdc)} mUSDC to me`) : null],
      brain.holdings.filter((h) => h.tbaBal > 0n).map((h) => el("button", { class: "btn", onclick: () => run("Sweep", act.sweep(brain, h.token, h.tbaBal, h.sym), refresh) }, `Sweep ${fmt.amt(h.tbaBal, 18, 4)} ${h.sym}`))),
    el("div", { class: "inline-form" }, fundField.el, el("button", { class: "btn", onclick: async () => { try { await run("Fund", act.fundTba(brain, fundField.value()), refresh); } catch (e) { toast(act.explain(e), "err"); } } }, "Send")));

  // runtime: who runs this brain, and the one-click way to hand it to the enclave
  const rt = brain.runtime;
  const sealed = brain.genome.custody !== 0;
  const enclaveCfg = state.cfg.enclaveExecutor;
  const rtBadge = rt.kind === "enclave" ? badge("Enrolled with the enclave", "good") : rt.kind === "self" ? badge("Self-hosted", "accent") : badge("Not running", "bad");
  const now = Math.floor(Date.now() / 1000);
  const nextText = rt.nextDue ? (rt.nextDue > now ? `in about ${fmt.duration(rt.nextDue - now)}` : "due on the next pass") : "on the next pass";
  const execField = textField({ label: "Executor key (advanced)", value: brain.policy.executor === ZERO ? "" : brain.policy.executor, placeholder: "0x…", mono: true, tip: TIPS.executor });
  const jarInput = el("input", { type: "file", accept: ".json,application/json", class: "jarfile", title: TIPS.jar });
  const runtimePanel = mk("Runtime",
    el("div", { class: "runtime-status" }, rtBadge, rt.kind !== "none" ? el("span", { class: "muted" }, `last trade ${rt.lastTradeAt ? fmt.when(rt.lastTradeAt) : "never"} · next tick ${nextText}`) : el("span", { class: "muted" }, "nobody is running this brain")),
    kv([
      ["Executor", brain.policy.executor === ZERO ? badge("not set", "muted") : addrChip(brain.policy.executor, { explorer: ex })],
      ["Declared cadence", `${brain.genome.cadence}/day (every ${fmt.duration(rt.intervalSec)})`],
      ["Jar", sealed ? (brain.envelopePublished ? badge("published on-chain", "good") : badge("not published", "bad")) : "with you (authored custody — you run it)"],
    ]),
    sealed && !brain.envelopePublished ? el("div", { class: "inline-form" }, el("label", { class: "field" }, el("span", { class: "field-label" }, el("span", {}, "Publish the sealed jar ", tip(TIPS.jar))), jarInput), el("button", { class: "btn", onclick: async () => {
      const f = jarInput.files && jarInput.files[0]; if (!f) return toast("Choose the .sealed.json file first.", "err");
      const text = await f.text();
      try { const o = JSON.parse(text); if (o.v !== 2 || o.mode !== "sealed") throw new Error("not a sealed envelope"); } catch (e) { return toast("That file is not a sealed jar.", "err"); }
      run("Publish the jar", act.publishEnvelope(brain.id, text), refresh);
    } }, "Publish")) : null,
    el("div", { class: "btn-row" },
      sealed && enclaveCfg && rt.kind !== "enclave" ? el("button", { class: "btn primary", disabled: !brain.envelopePublished, title: brain.envelopePublished ? "Set the enclave's key as executor; it starts running the brain on its next pass" : "Publish the jar first", onclick: () => run("Enrol", act.enrol(brain.id), refresh) }, "Enrol with the enclave") : null,
      rt.kind === "enclave" ? el("button", { class: "btn", onclick: () => run("Unenrol", act.unenrol(brain.id), refresh) }, "Unenrol") : null,
      !sealed ? el("a", { class: "btn", href: "#/dev" }, "Self-host command (Developer tab)") : null),
    el("details", { class: "adv" }, el("summary", {}, "Set the executor by hand"),
      el("div", { class: "inline-form" }, execField.el, el("button", { class: "btn", onclick: () => { const a = execField.value(); if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return toast("Enter an address.", "err"); run("Set executor", act.setExecutor(brain.id, a), refresh); } }, "Set"))));

  // identity: name + seat
  const nameField = textField({ label: "Name (permanent)", placeholder: "Umbra", tip: TIPS.name });
  const seatPanel = mk("Seat & name",
    kv([["Seat", `${TIERS[brain.tier]} · per-trade cap ${fmt.bps(brain.policy.maxNotionalBps)} of NAV`], ["Name", brain.name || badge("unnamed", "muted")]]),
    el("div", { class: "btn-row" },
      brain.tier < 2 ? el("button", { class: "btn", onclick: async () => {
        const { steps, fee } = await act.promote(brain);
        const m = modal({ title: `Promote to ${TIERS[brain.tier + 1]}`, body: el("div", {}, el("p", {}, `A ${TIERS[brain.tier + 1]} seat raises the per-trade ceiling. Upgrades are one-way.`), kv([["One-time fee", fmt.usd(fee)], ["Paid to", "protocol treasury"]])),
          actions: [{ label: "Cancel" }, { label: "Promote", kind: "primary", onClick: async () => { m.close(); await run("Promote", steps, refresh); } }] });
      } }, `Promote to ${TIERS[brain.tier + 1]}`) : null),
    !brain.name ? el("div", { class: "inline-form" }, nameField.el, el("button", { class: "btn", onclick: () => { const n = nameField.value(); if (!n) return; run("Name", act.christen(brain.id, n), refresh); } }, "Christen")) : null);

  // depositors
  const addrField = textField({ label: "Allow a depositor", placeholder: "0x…", mono: true, tip: TIPS.allow });
  const depositorsPanel = mk("Depositors",
    kv([["Vault", brain.allowlistEnabled ? "allowlist only" : "open to anyone"], ["AUM", fmt.usd(brain.nav)], ["Season", brain.seasoned ? "seasoned — accepting deposits" : "intern — deposits closed"]]),
    el("div", { class: "btn-row" },
      el("button", { class: "btn", onclick: () => run(brain.allowlistEnabled ? "Open the vault" : "Close the vault", act.setAllowlistEnabled(brain, !brain.allowlistEnabled), refresh) }, brain.allowlistEnabled ? "Open to anyone" : "Restrict to allowlist")),
    brain.allowlistEnabled ? el("div", { class: "inline-form" }, addrField.el, el("button", { class: "btn", onclick: () => { const a = addrField.value(); if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return toast("Enter an address.", "err"); run("Allow depositor", act.setDepositAllowed(brain, a, true), refresh); } }, "Allow")) : null);

  // limits + markets
  const notional = el("input", { type: "number", min: 0, max: 10000, value: brain.policy.maxNotionalBps, title: TIPS.notional });
  const slippage = el("input", { type: "number", min: 0, max: 10000, value: brain.policy.maxSlippageBps, title: TIPS.slippage });
  const interval = el("input", { type: "number", min: 0, value: brain.policy.minTradeInterval, title: TIPS.interval });
  const limitsPanel = mk("Trading limits",
    el("p", { class: "muted small" }, "You can tune below your seat's ceiling, never above. Markets can be switched off, and only curated ones switched back on."),
    el("div", { class: "three-col" },
      el("label", { class: "field" }, el("span", { class: "field-label" }, "Per-trade cap (bps of NAV)"), notional),
      el("label", { class: "field" }, el("span", { class: "field-label" }, "Max slippage (bps)"), slippage),
      el("label", { class: "field" }, el("span", { class: "field-label" }, "Min seconds between trades"), interval)),
    el("div", { class: "btn-row" }, el("button", { class: "btn", onclick: () => run("Update limits", act.setPolicy(brain.id, Number(notional.value), Number(slippage.value), Number(interval.value)), refresh) }, "Save limits")),
    el("div", { class: "btn-row" }, brain.holdings.map((h) => el("button", { class: "btn", onclick: async () => {
      const allowed = await state.pub.readContract({ address: state.cfg.guard, abi: (await import("../abi.js")).guardAbi, functionName: "tokenAllowed", args: [BigInt(brain.id), h.token] });
      run(allowed ? "Disable market" : "Enable market", act.setTokenAllowed(brain.id, h.token, !allowed), refresh);
    } }, `Toggle ${h.sym}`))));

  // fees + sell
  const toField = textField({ label: "Transfer to (sell the whole guy)", placeholder: "0x…", mono: true, hint: "Whatever is in the brain's wallet goes with it. Sweep first to sell without capital.", tip: TIPS.transfer });
  const feesPanel = mk("Fees & sale",
    kv([["Fee shares in the jar", `${fmt.amt(brain.fees.feeShares, 18, 4)} shares ≈ ${fmt.usd(brain.fees.feeSharesValue)}`], ["Pending (unminted)", `${fmt.amt(brain.pending.mgmt + brain.pending.perf, 18, 4)} shares`]]),
    el("div", { class: "btn-row" },
      brain.fees.feeShares > 0n ? el("button", { class: "btn", onclick: () => run("Redeem fee shares", act.redeemFeeShares(brain), refresh) }, "Redeem fee shares to me") : null,
      ringable(brain) ? el("button", { class: "btn", onclick: () => run("Ring the bell", act.ring(brain), refresh) }, "🔔 Ring the bell") : null),
    el("div", { class: "inline-form" }, toField.el, el("button", { class: "btn danger", onclick: () => {
      const a = toField.value(); if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return toast("Enter an address.", "err");
      const m = modal({ title: "Transfer this brain?", body: el("p", {}, `${brain.label} and everything in its wallet (${fmt.amt(brain.tbaUsdc)} mUSDC and any holdings) will belong to ${fmt.addr(a)}. The track record goes with it. This cannot be undone.`),
        actions: [{ label: "Cancel" }, { label: "Transfer", kind: "danger", onClick: async () => { m.close(); await run("Transfer", act.transferBrain(brain, a), refresh); } }] });
    } }, "Transfer")));

  return el("section", { class: "desk-brain", id: `brain-${brain.id}` },
    el("header", { class: "brain-head compact" }, jar(), el("div", { class: "brain-title" },
      el("h3", {}, el("a", { href: `#/brain/${brain.id}` }, brain.label), " ", el("span", { class: "tier-chip" }, TIERS[brain.tier])),
      el("p", { class: "card-badges" }, statusBadge(brain), custodyBadge(brain)))),
    el("div", { class: "two-col" }, walletPanel, runtimePanel),
    el("div", { class: "two-col" }, seatPanel, depositorsPanel),
    limitsPanel, feesPanel);
}

export async function render(root, { id } = {}) {
  clear(root);
  root.append(el("h3", { class: "section-sub" }, "My Desk"));
  if (!state.account) {
    root.append(emptyState("Connect a wallet to see your brains, positions, and bells.", el("p", { class: "muted" }, "On a local anvil you can use a dev key from the Developer tab.")));
    return;
  }
  const loading = spinner("Reading your desk…");
  root.append(loading);
  let roster;
  try { roster = await loadRoster(); } catch (e) { loading.replaceWith(emptyState("Could not read the chain.", el("p", { class: "muted" }, act.explain(e)))); return; }
  loading.remove();
  const refresh = async () => { invalidate(); await render(root, { id }); };

  const mine = roster.brains.filter((b) => b.mine);
  const positions = roster.brains.filter((b) => b.myShares > 0n);
  const bells = roster.brains.filter(ringable);

  // owned brains
  root.append(el("h4", { class: "desk-h" }, `Your brains (${mine.length})`));
  if (!mine.length) root.append(emptyState("You don't own a brain yet.", el("a", { class: "btn primary", href: "#/create" }, "Birth one")));
  const target = id ? mine.find((b) => b.id === Number(id)) : null;
  const show = target ? [target] : mine;
  if (target) root.append(el("p", { class: "muted" }, el("a", { href: "#/desk" }, "← all your brains")));
  for (const b of show) {
    const holder = el("div", {}, spinner(`Loading ${b.label}…`));
    root.append(holder);
    loadBrain(b.id).then(async (full) => holder.replaceWith(await manage(full, refresh))).catch((e) => holder.replaceWith(emptyState(`Could not load ${b.label}: ${act.explain(e)}`)));
  }

  // positions
  root.append(el("h4", { class: "desk-h" }, `Your positions (${positions.length})`));
  if (!positions.length) root.append(el("p", { class: "muted" }, "No vault positions. Pick a seasoned brain on the Floor."));
  else root.append(el("div", { class: "tablewrap" }, el("table", { class: "table" },
    el("thead", {}, el("tr", {}, el("th", {}, "Brain"), el("th", {}, "Shares"), el("th", {}, "Value"), el("th", {}, "Return"), el("th", {}, ""))),
    el("tbody", {}, positions.map((b) => el("tr", {},
      el("td", {}, el("a", { href: `#/brain/${b.id}` }, b.label)),
      el("td", {}, fmt.amt(b.myShares, 18, 4)),
      el("td", {}, fmt.usd((b.myShares * b.pps) / 10n ** 18n)),
      el("td", {}, fmt.pct(b.sharePriceReturn)),
      el("td", {}, el("button", { class: "btn tiny", onclick: () => run("Withdraw", act.withdrawAll(b), refresh) }, "Withdraw all"))))))));

  // bells
  root.append(el("h4", { class: "desk-h" }, `Bells worth ringing (${bells.length})`));
  if (!bells.length) root.append(el("p", { class: "muted" }, "Nothing to crystallise right now."));
  else root.append(el("div", { class: "btn-row" }, bells.map((b) => el("button", { class: "btn bell", onclick: () => run("Ring the bell", act.ring(b), refresh) }, `🔔 ${b.label} · +${fmt.amt(b.pending.reward, 18, 4)} shares`))));
}
