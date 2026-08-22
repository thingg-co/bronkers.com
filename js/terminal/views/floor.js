// The Floor: every brain, live from the chain, sortable. Read-only; no wallet needed.
import { CUSTODY, TIERS } from "../abi.js";
import { state } from "../chain.js";
import { loadRoster, loadSnapshot, loadTrades, navSeries, ringable } from "../data.js";
import { badge, clear, el, emptyState, fmt, progress, sparkline, spinner } from "../ui.js";

const SORTS = {
  return: { label: "Return", fn: (a, b) => b.sharePriceReturn - a.sharePriceReturn },
  nav: { label: "NAV", fn: (a, b) => Number(b.nav - a.nav) },
  trades: { label: "Trades", fn: (a, b) => b.tradeCount - a.tradeCount },
  newest: { label: "Newest", fn: (a, b) => b.id - a.id },
  bell: { label: "Bell reward", fn: (a, b) => Number(b.pending.reward - a.pending.reward) },
};

const prefs = { sort: localStorage.getItem("brokners-floor-sort") || "return", filter: localStorage.getItem("brokners-floor-filter") || "all" };

/** Every jar's fluid is tinted from the genome commitment: hue, saturation and
 *  lightness each come from different bytes, so brains differ on three axes. */
export function fluidTint(commitment) {
  const hex = String(commitment || "").replace(/^0x/, "");
  if (hex.length < 12) return { h: 205, s: 65, l: 78 };
  return {
    h: parseInt(hex.slice(0, 8), 16) % 360,
    s: 50 + (parseInt(hex.slice(8, 10), 16) % 31),   // 50–80%
    l: 68 + (parseInt(hex.slice(10, 12), 16) % 17),  // 68–84%
  };
}

export function jar(b) {
  const { h, s, l } = fluidTint(b && b.genome && b.genome.commitment);
  const sealed = Boolean(b && b.genome && Number(b.genome.custody) > 0); // sealed jars are corked
  return el("div", { class: sealed ? "jar sealed" : "jar", "aria-hidden": "true", style: { "--fluid-h": String(h), "--fluid-s": `${s}%`, "--fluid-l": `${l}%` } },
    el("span", { class: "jar-fluid" }),
    el("span", { class: "jar-wave w1" }), el("span", { class: "jar-wave w2" }),
    el("span", { class: "jar-lid" }), el("span", { class: "jar-brain" }, "🧠"),
    el("span", { class: "bubble b1" }), el("span", { class: "bubble b2" }), el("span", { class: "bubble b3" }));
}

export function statusBadge(b) {
  if (b.seasoned) return badge("seasoned", "good");
  return badge("intern", "muted");
}

export function custodyBadge(b) {
  const c = CUSTODY[b.genome.custody] || CUSTODY[0];
  return badge(c.label, b.genome.custody > 0 ? "accent" : "");
}

function returnBadge(b) {
  if (b.snapshot || b.supply === 0n) return el("span", { class: "pnl-badge flat", title: "No outside capital yet; share price has no history" }, "no LPs yet");
  const r = b.sharePriceReturn;
  return el("span", { class: `pnl-badge ${r >= 0 ? "pnl-up" : "pnl-down"}`, title: "Vault share price since inception" }, fmt.pct(r));
}

export function card(b) {
  const c = el("a", { class: "feature-card trader-card brain-card", href: `#/brain/${b.id}` },
    jar(b),
    el("div", { class: "trader-head" }, el("h3", {}, b.label), el("span", { class: "tier-chip" }, TIERS[b.tier])),
    el("p", { class: "card-badges" }, returnBadge(b), statusBadge(b), custodyBadge(b), b.mine ? badge("yours", "accent") : null),
    el("div", { class: "card-spark" }),
    el("dl", { class: "trader-stats" },
      el("div", {}, el("dt", {}, "Vault NAV"), el("dd", { class: "stat-inline" }, fmt.amt(b.nav))),
      el("div", {}, el("dt", {}, "Own book"), el("dd", { class: "stat-inline" }, fmt.amt(b.tbaNav))),
      el("div", {}, el("dt", {}, "Trades"), el("dd", { class: "stat-inline" }, String(b.tradeCount)))),
    !b.seasoned && b.season
      ? progress(b.season.minTrades ? b.tradeCount / b.season.minTrades : 1, `internship: ${b.tradeCount}/${b.season.minTrades} trades`)
      : null,
    ringable(b) ? el("p", { class: "card-foot" }, "🔔 ring for ", el("strong", {}, fmt.amt(b.pending.reward, 18, 4)), " shares") : null,
    el("p", { class: "hash-chip", title: "genome commitment" }, `${b.genome.commitment.slice(0, 10)}…${b.genome.commitment.slice(-6)}`));
  return c;
}

async function lazySparkline(b, holder) {
  if (b.snapshot || !b.seasoned || b.tradeCount === 0) return;
  try {
    const trades = await loadTrades(b.id, b.genome.birthBlock);
    const series = await navSeries(b, trades);
    const vals = b.supply > 0n ? series.map((p) => Number(p.pps) / 1e18) : series.map((p) => Number(p.own) / 1e18);
    if (vals.length >= 2) holder.replaceChildren(sparkline(vals, { width: 240, height: 40 }));
  } catch {}
}

export async function render(root) {
  clear(root);
  const head = el("div", { class: "floor-head" });
  const grid = el("div", { class: "features-grid roster" });
  root.append(head, grid);
  grid.append(spinner("Reading the chain…"));

  let roster;
  let snapshot = false;
  try {
    if (state.mode === "offline" || !state.cfg.traderNFT) throw new Error("offline");
    roster = await loadRoster();
  } catch (e) {
    try {
      roster = await loadSnapshot();
      snapshot = true;
    } catch {
      clear(grid);
      grid.append(emptyState("No chain reachable and no snapshot available.", el("p", { class: "muted" }, "Start a local anvil (see README) or pick another network in the Developer tab.")));
      return;
    }
  }

  const brains = roster.brains.slice();
  const note = snapshot
    ? `Snapshot from block ${roster.generatedAtBlock} (chain unreachable). Numbers are as of that block.`
    : `${roster.count} of ${roster.max.toLocaleString()} brains minted · live from ${state.cfg.name}, block ${state.blockNumber ?? "?"}`;

  const sortSel = el("select", { class: "select", onchange: (e) => { prefs.sort = e.target.value; localStorage.setItem("brokners-floor-sort", prefs.sort); draw(); } },
    Object.entries(SORTS).map(([k, v]) => el("option", { value: k, selected: prefs.sort === k }, v.label)));
  const filterSel = el("select", { class: "select", onchange: (e) => { prefs.filter = e.target.value; localStorage.setItem("brokners-floor-filter", prefs.filter); draw(); } },
    [["all", "All brains"], ["open", "Taking deposits"], ["intern", "Interns"], ["mine", "Mine"], ["bell", "Bell worth ringing"]].map(([k, l]) => el("option", { value: k, selected: prefs.filter === k }, l)));
  head.append(
    el("p", { class: "roster-note" }, note),
    el("div", { class: "toolbar" },
      el("label", { class: "toolbar-item" }, "Sort ", sortSel),
      el("label", { class: "toolbar-item" }, "Show ", filterSel)));

  function draw() {
    clear(grid);
    let list = brains.filter((b) => {
      if (prefs.filter === "open") return b.seasoned;
      if (prefs.filter === "intern") return !b.seasoned;
      if (prefs.filter === "mine") return b.mine;
      if (prefs.filter === "bell") return ringable(b);
      return true;
    });
    list.sort(SORTS[prefs.sort].fn);
    if (!list.length) {
      grid.append(emptyState(brains.length ? "Nothing matches that filter." : "No brains yet. Be the first. Or don't. The cap isn't going anywhere.",
        brains.length ? null : el("a", { class: "btn primary", href: "#/create" }, "Birth a brain")));
      return;
    }
    for (const b of list) {
      const c = card(b);
      grid.append(c);
      lazySparkline(b, c.querySelector(".card-spark"));
    }
  }
  draw();
}
