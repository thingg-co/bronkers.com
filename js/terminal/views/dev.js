// Developer panel: network, RPC and addresses, dev wallet (local chains only),
// faucet, and a lever to move the mock market. Nothing here is needed by a
// normal visitor; it is how we run the Terminal against anvil.
import { parseUnits } from "https://esm.sh/viem@2.21.19";
import * as act from "../actions.js";
import { aggregatorAbi, erc20Abi, venueAbi } from "../abi.js";
import { chains, clearOverride, connectDev, disconnect, reload, saveOverride, selectChain, state } from "../chain.js";
import { invalidate, loadFarmHealth } from "../data.js";
import { badge, clear, el, fmt, kv, textField, toast } from "../ui.js";

const FIELDS = [
  ["rpc", "RPC URL", "JSON-RPC endpoint the Terminal reads from (and a dev wallet writes to). Public RPCs are fine; archive reads make the charts richer."],
  ["explorer", "Explorer URL (optional)", "Base URL for address/tx links, e.g. https://amoy.polygonscan.com"],
  ["traderNFT", "TraderNFT", "The brain collection. Printed by Deploy.s.sol."],
  ["guard", "ExecutionGuard", "The trust boundary: the only contract the executor key can usefully call."],
  ["router", "Venue (paper market)", "The curated venue brains trade through: the paper venue quotes from USD feeds and fills at that price less a spread, minting the mock tokens."],
  ["ethFeed", "ETH/USD feed", "The paper venue's price feed for mWETH (a settable mock here; Chainlink on a public testnet). The market lever writes it."],
  ["btcFeed", "BTC/USD feed", "The paper venue's price feed for mWBTC."],
  ["usdc", "mUSDC", "Base asset and vault collateral."],
  ["weth", "mWETH", "Curated market token."],
  ["wbtc", "mWBTC", "Curated market token."],
  ["enclavePublicKey", "Enclave public key (base64 SPKI)", "X25519 key sealed brains are encrypted to. From `npm run genome -- keygen` (seed-dev.sh writes it here)."],
  ["enclaveExecutor", "Enclave executor address", "The farm's hot key. Enrolling a brain means setting this as its executor; the farm then runs it."],
  ["registry", "RuntimeRegistry", "Executor key → (runtime measurement, enclave key). 'Attested' when the protocol has approved the measurement; 'TDX quote' when a verified quote bound the key to it."],
  ["credentials", "Credentials", "Owner-supplied secrets for a brain (an inference API key), sealed in this browser to the enclave key and published as events. Active only while the publisher still owns the brain; revocable from My Desk."],
  ["hostMarket", "Host market (the farm's lease)", "The machine market the farm pays its lease into: the mock Oyster market here, Marlin's on Arbitrum One in production. The farm reads it; this is informational."],
  ["enclaveUrl", "Enclave endpoint URL", "The farm's HTTP endpoint (FARM_HTTP_PORT): /compose for sealed-generated brains, /health for identity."],
  ["enclaveMinFee", "Enclave runtime fee (mUSDC per trade)", "What this operator asks brains to pay per trade; the wizard pre-fills it."],
  ["marketplace", "Marketplace URL template", "For 'list it' links; use {nft} and {id}. Leave empty on a local chain."],
];

/** The farm's books, from its /health: income, costs, float, the lease. */
function farmPanel() {
  const body = el("div", {}, el("p", { class: "muted" }, state.cfg.enclaveUrl ? "Reading the farm's books…" : "No enclave endpoint configured for this chain."));
  const panel = el("div", { class: "panel" }, el("h4", {}, "The farm's books"), body);
  if (!state.cfg.enclaveUrl) return panel;
  const fill = async () => {
    const h = await loadFarmHealth();
    if (!h) { body.replaceChildren(el("p", { class: "muted" }, `The farm at ${state.cfg.enclaveUrl} did not answer. Is it running?`)); return; }
    const b = h.budget || {};
    const d = Number(b.decimals ?? 18); const sym = b.symbol || "mUSDC"; const B = (x) => `${fmt.amt(BigInt(x || 0), d, 4)} ${sym}`;
    const host = b.host;
    const hostText = !host ? "not read yet" : host.kind === "none" ? "none configured (machine paid for outside the farm)" : host.remainingSeconds == null ? `${host.kind}: ${host.detail}` : `${host.kind} · ${fmt.duration(host.remainingSeconds)} left · ${host.ratePerHour != null ? `${fmt.amt(BigInt(host.ratePerHour), d, 4)} ${sym}/h` : "rate unknown"} · balance ${host.balance != null ? B(host.balance) : "?"}`;
    body.replaceChildren(
      el("p", { class: "muted" }, `Executor ${fmt.addr(h.executor)} · ${h.backend || ""} · running ${(h.running || []).length} brain${(h.running || []).length === 1 ? "" : "s"}${b.paused ? `, ${b.paused} paused by the budget` : ""}.`),
      kv([
        ["Float (fees collected, unspent)", `${B(b.float)} · gas balance ${fmt.amt(BigInt(b.nativeBalance || 0), 18, 4)} ${state.cfg.currency || "ETH"}`, "The executor key's base-asset balance: runtime fees land here and lease payments leave from here."],
        ["Income (runtime fees)", B(b.income)],
        ["Cost", `${B(b.cost)} · model ${B(b.inference)}, gas ${B(b.gas)}, lease accrued ${B(b.hostAccrued)}`],
        ["Net", [BigInt(b.net || 0) >= 0n ? badge("covering its costs", "good") : badge("running at a loss", "bad"), " ", B(b.net)]],
        ["Lease", hostText, "Read from the machine market the farm is rented on; the farm tops it up before it runs out and logs every payment."],
        ["Lease paid so far", B(b.hostPaid)],
        ["Operator minimum fee", `${B(b.minFee)} per trade · grace ${B(b.grace)} per brain`],
        ["Since", b.since ? fmt.date(Math.floor(Number(b.since) / 1000)) : "–"],
      ]),
      el("div", { class: "btn-row" }, el("button", { class: "btn tiny", onclick: fill }, "Refresh"), el("a", { class: "btn tiny", href: `${state.cfg.enclaveUrl.replace(/\/$/, "")}/ledger`, target: "_blank", rel: "noopener" }, "Full ledger (JSON)")));
  };
  fill();
  return panel;
}

export async function render(root) {
  clear(root);
  const cfg = state.cfg;
  const all = chains();

  const chainSel = el("select", { class: "select", onchange: async (e) => { await selectChain(Number(e.target.value)); render(root); } },
    Object.values(all).map((c) => el("option", { value: c.id, selected: c.id === state.chainId }, `${c.name} (${c.id})`)));

  const inputs = {};
  const form = el("div", { class: "dev-grid" }, FIELDS.map(([k, label, tipText]) => {
    const f = textField({ label, value: cfg[k] || "", mono: true, tip: tipText });
    inputs[k] = f;
    return f.el;
  }));

  const status = kv([
    ["Mode", state.mode],
    ["Latest block", state.blockNumber == null ? "unreachable" : String(state.blockNumber)],
    ["Wallet", state.account ? `${fmt.addr(state.account)} (${state.walletKind})` : "none"],
  ]);

  const save = el("button", { class: "btn primary", onclick: async () => {
    const partial = {};
    for (const k of Object.keys(inputs)) partial[k] = inputs[k].value();
    saveOverride(state.chainId, partial);
    invalidate();
    await reload();
    toast("Saved for this browser", "ok");
    render(root);
  } }, "Save & reconnect");
  const reset = el("button", { class: "btn", onclick: async () => { clearOverride(state.chainId); invalidate(); await reload(); toast("Reset to config.js", "ok"); render(root); } }, "Reset to defaults");

  // dev wallet
  const keyField = textField({ label: "Dev private key (local test chains only; kept in sessionStorage)", placeholder: "0x…", mono: true, type: "password", tip: "A raw private key to sign with instead of a browser wallet. Anvil prints ten at startup. Never use a key that holds real funds." });
  const devBtns = el("div", { class: "btn-row" },
    el("button", { class: "btn", disabled: !cfg.testnet, onclick: async () => {
      try { await connectDev(keyField.value()); toast("Dev wallet connected", "ok"); render(root); } catch (e) { toast(act.explain(e), "err"); }
    } }, "Use this key"),
    state.account ? el("button", { class: "btn", onclick: () => { disconnect(); render(root); } }, "Disconnect") : null);

  // faucet + market lever
  const faucetAmt = textField({ label: "Faucet amount (mUSDC)", value: "10000", tip: "Mints mock USDC to your connected address. Test chains only." });
  const faucetBtn = el("button", { class: "btn", disabled: !state.account || !cfg.testnet, onclick: async () => {
    const ok = await act.runSteps("Faucet", act.faucet(faucetAmt.value() || "10000"));
    if (ok) { invalidate(); }
  } }, "Mint test mUSDC to me");

  const priceRow = el("div", { class: "btn-row" });
  const priceInfo = el("p", { class: "muted" });
  async function showPrice() {
    try {
      const q = await state.pub.readContract({ address: cfg.router, abi: venueAbi, functionName: "quote", args: [cfg.weth, cfg.usdc, parseUnits("1", 18)] });
      priceInfo.textContent = `1 mWETH = ${fmt.amt(q)} mUSDC on the paper venue (feed price less the spread on fills)`;
      return q;
    } catch { priceInfo.textContent = "Venue quote unavailable."; return null; }
  }
  // the paper venue quotes from the ETH/USD feed; moving the market means writing the feed (mock only)
  const nudge = (pct) => el("button", { class: "btn", disabled: !state.account || !cfg.testnet || !cfg.ethFeed, title: cfg.ethFeed ? "" : "No ETH/USD feed configured", onclick: async () => {
    try {
      const [, answer] = await state.pub.readContract({ address: cfg.ethFeed, abi: aggregatorAbi, functionName: "latestRoundData" });
      const next = (answer * BigInt(100 + pct)) / 100n;
      const ok = await act.runSteps(`Move ETH/USD ${pct > 0 ? "+" : ""}${pct}%`, [
        { label: `Set the ETH/USD feed to ${fmt.amt(next, 8)}`, run: () => act.tx({ address: cfg.ethFeed, abi: aggregatorAbi, functionName: "setAnswer", args: [next] }) },
      ]);
      if (ok) { invalidate(); showPrice(); }
    } catch (e) { toast(act.explain(e), "err"); }
  } }, `${pct > 0 ? "+" : ""}${pct}%`);
  priceRow.append(nudge(-10), nudge(-3), nudge(3), nudge(10));
  showPrice();

  // move the chain's clock (anvil only): the declared cadence is enforced on-chain, so
  // a brain that just traded cannot trade again until its interval has passed
  const isAnvil = state.chainId === 31337;
  const clockInfo = el("p", { class: "muted" }, isAnvil ? "Trades are rate-limited on-chain by the declared cadence; skip ahead to let the farm trade again." : "Only on a local anvil.");
  const skip = (sec, label) => el("button", { class: "btn", disabled: !isAnvil || state.mode === "offline", onclick: async () => {
    try {
      await state.pub.request({ method: "evm_increaseTime", params: [sec] });
      await state.pub.request({ method: "evm_mine", params: [] });
      invalidate();
      toast(`Chain clock moved ${label} ahead`, "ok");
    } catch (e) { toast(act.explain(e), "err"); }
  } }, `+${label}`);
  const clockRow = el("div", { class: "btn-row" }, skip(3600, "1h"), skip(6 * 3600, "6h"), skip(86400, "1d"));

  root.append(
    el("h3", { class: "section-sub" }, "Developer"),
    el("p", { class: "muted" }, "Everything on this tab is stored in this browser only. The Terminal has no backend: reads go to the RPC below, writes go through your wallet."),
    el("div", { class: "panel" }, el("h4", {}, "Network"), el("label", { class: "field" }, el("span", { class: "field-label" }, "Chain"), chainSel), status),
    el("div", { class: "panel" }, el("h4", {}, "Addresses & RPC"), el("p", { class: "muted" }, "Printed by ", el("code", {}, "Deploy.s.sol"), " (or ", el("code", {}, "seed-dev.sh"), ", which also writes them into ", el("code", {}, "js/config.js"), ")."), form, el("div", { class: "btn-row" }, save, reset)),
    el("div", { class: "panel" }, el("h4", {}, "Dev wallet"), el("p", { class: "muted" }, cfg.testnet ? "Sign with a raw key instead of a browser wallet. Anvil's account #0 owns the seeded brains." : "Disabled: this chain is not marked as a test chain."), keyField.el, devBtns),
    el("div", { class: "panel" }, el("h4", {}, "Testnet helpers"), el("div", { class: "two-col" },
      el("div", {}, faucetAmt.el, faucetBtn),
      el("div", {}, el("p", { class: "field-label" }, "Move the mock market"), priceInfo, priceRow, el("p", { class: "field-label" }, "Move the chain's clock"), clockInfo, clockRow))),
    farmPanel(),
    el("div", { class: "panel" }, el("h4", {}, "Runtime"),
      el("p", { class: "muted" }, "The farm is the enclave process that runs every brain enrolled with its key (sealed custody, jar published on-chain) and pays its own lease from the runtime fees it collects. One process, all brains:"),
      el("pre", {}, el("code", {}, `cd agent && RPC_URL=${cfg.rpc} TRADER_NFT_ADDRESS=${cfg.traderNFT} \\\n  GUARD_ADDRESS=${cfg.guard} ROUTER_ADDRESS=${cfg.router} REGISTRY_ADDRESS=${cfg.registry || "<RuntimeRegistry>"} CREDENTIALS_ADDRESS=${cfg.credentials || "<Credentials>"} \\\n  EXECUTOR_PRIVATE_KEY=<key for ${cfg.enclaveExecutor || "the enclave executor"}> ENCLAVE_PRIVATE_KEY=<enclave sealing key> \\\n  FARM_HOST=market FARM_HOST_MARKET=${cfg.hostMarket || "<host market>"} FARM_HOST_JOB_ID=<job id from seed-dev.sh> FARM_NATIVE_PRICE=2000 \\\n  FARM_HTTP_PORT=8787 FARM_MIN_FEE=${cfg.enclaveMinFee || "0"} npm run farm -- --mock-brain`)),
      el("p", { class: "muted small" }, "FARM_HOST=oyster with OYSTER_JOB_ID points the same loop at Marlin's market on Arbitrum One; FARM_GRACE sets the credit a brain gets before it is paused; INFERENCE_BASE_URL swaps Anthropic for a TEE inference gateway. GET /health and /ledger on the endpoint show the books."),
      el("p", { class: "muted" }, "Authored brains are self-hosted by their owner, one process per brain, with the jar file and GENOME_KEY:"),
      el("pre", {}, el("code", {}, `cd agent && RPC_URL=${cfg.rpc} TOKEN_ID=<id> TRADER_NFT_ADDRESS=${cfg.traderNFT} \\\n  GUARD_ADDRESS=${cfg.guard} ROUTER_ADDRESS=${cfg.router} GENOME_PATH=./brain-<hash>.authored.json \\\n  GENOME_KEY=<key> EXECUTOR_PRIVATE_KEY=<executor key> npm run loop -- --mock-brain`))));
}
