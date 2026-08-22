// Developer panel: network, RPC and addresses, dev wallet (local chains only),
// faucet, and a lever to move the mock market. Nothing here is needed by a
// normal visitor; it is how we run the Terminal against anvil.
import { parseUnits } from "https://esm.sh/viem@2.21.19";
import * as act from "../actions.js";
import { erc20Abi, venueAbi } from "../abi.js";
import { chains, clearOverride, connectDev, disconnect, reload, saveOverride, selectChain, state } from "../chain.js";
import { invalidate } from "../data.js";
import { clear, el, fmt, kv, textField, toast } from "../ui.js";

const FIELDS = [
  ["rpc", "RPC URL", "JSON-RPC endpoint the Terminal reads from (and a dev wallet writes to). Public RPCs are fine; archive reads make the charts richer."],
  ["explorer", "Explorer URL (optional)", "Base URL for address/tx links, e.g. https://amoy.polygonscan.com"],
  ["traderNFT", "TraderNFT", "The brain collection. Printed by Deploy.s.sol."],
  ["guard", "ExecutionGuard", "The trust boundary: the only contract the executor key can usefully call."],
  ["router", "Venue / router", "The curated venue brains trade through (MockSwapRouter locally)."],
  ["usdc", "mUSDC", "Base asset and vault collateral."],
  ["weth", "mWETH", "Curated market token."],
  ["wbtc", "mWBTC", "Curated market token."],
  ["enclavePublicKey", "Enclave public key (base64 SPKI)", "X25519 key sealed brains are encrypted to. From `npm run genome -- keygen` (seed-dev.sh writes it here)."],
  ["enclaveExecutor", "Enclave executor address", "The farm's hot key. Enrolling a brain means setting this as its executor; the farm then runs it."],
  ["registry", "RuntimeRegistry", "Executor key → (runtime measurement, enclave key). 'Attested' when the protocol has approved the measurement."],
  ["enclaveUrl", "Enclave endpoint URL", "The farm's HTTP endpoint (FARM_HTTP_PORT): /compose for sealed-generated brains, /health for identity."],
  ["enclaveMinFee", "Enclave runtime fee (mUSDC per trade)", "What this operator asks brains to pay per trade; the wizard pre-fills it."],
  ["marketplace", "Marketplace URL template", "For 'list it' links; use {nft} and {id}. Leave empty on a local chain."],
];

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
      priceInfo.textContent = `1 mWETH = ${fmt.amt(q)} mUSDC on the mock venue`;
      return q;
    } catch { priceInfo.textContent = "Venue quote unavailable."; return null; }
  }
  const nudge = (pct) => el("button", { class: "btn", disabled: !state.account || !cfg.testnet, onclick: async () => {
    const q = await showPrice();
    if (q == null) return;
    const next = (q * BigInt(100 + pct)) / 100n;
    const inv = (10n ** 36n) / next;
    const ok = await act.runSteps(`Move mWETH ${pct > 0 ? "+" : ""}${pct}%`, [
      { label: `Set mWETH/mUSDC to ${fmt.amt(next)}`, run: () => act.tx({ address: cfg.router, abi: venueAbi, functionName: "setPrice", args: [cfg.weth, cfg.usdc, next] }) },
      { label: "Set the inverse quote", run: () => act.tx({ address: cfg.router, abi: venueAbi, functionName: "setPrice", args: [cfg.usdc, cfg.weth, inv] }) },
    ]);
    if (ok) { invalidate(); showPrice(); }
  } }, `${pct > 0 ? "+" : ""}${pct}%`);
  priceRow.append(nudge(-10), nudge(-3), nudge(3), nudge(10));
  showPrice();

  root.append(
    el("h3", { class: "section-sub" }, "Developer"),
    el("p", { class: "muted" }, "Everything on this tab is stored in this browser only. The Terminal has no backend: reads go to the RPC below, writes go through your wallet."),
    el("div", { class: "panel" }, el("h4", {}, "Network"), el("label", { class: "field" }, el("span", { class: "field-label" }, "Chain"), chainSel), status),
    el("div", { class: "panel" }, el("h4", {}, "Addresses & RPC"), el("p", { class: "muted" }, "Printed by ", el("code", {}, "Deploy.s.sol"), " (or ", el("code", {}, "seed-dev.sh"), ", which also writes them into ", el("code", {}, "js/config.js"), ")."), form, el("div", { class: "btn-row" }, save, reset)),
    el("div", { class: "panel" }, el("h4", {}, "Dev wallet"), el("p", { class: "muted" }, cfg.testnet ? "Sign with a raw key instead of a browser wallet. Anvil's account #0 owns the seeded brains." : "Disabled: this chain is not marked as a test chain."), keyField.el, devBtns),
    el("div", { class: "panel" }, el("h4", {}, "Testnet helpers"), el("div", { class: "two-col" },
      el("div", {}, faucetAmt.el, faucetBtn),
      el("div", {}, el("p", { class: "field-label" }, "Move the mock market"), priceInfo, priceRow))),
    el("div", { class: "panel" }, el("h4", {}, "Runtime"),
      el("p", { class: "muted" }, "The farm is the enclave process that runs every brain enrolled with its key (sealed custody, jar published on-chain). One process, all brains:"),
      el("pre", {}, el("code", {}, `cd agent && RPC_URL=${cfg.rpc} TRADER_NFT_ADDRESS=${cfg.traderNFT} \\\n  GUARD_ADDRESS=${cfg.guard} ROUTER_ADDRESS=${cfg.router} REGISTRY_ADDRESS=${cfg.registry || "<RuntimeRegistry>"} \\\n  EXECUTOR_PRIVATE_KEY=<key for ${cfg.enclaveExecutor || "the enclave executor"}> ENCLAVE_PRIVATE_KEY=<enclave sealing key> \\\n  FARM_HTTP_PORT=8787 FARM_MIN_FEE=${cfg.enclaveMinFee || "0"} npm run farm -- --mock-brain`)),
      el("p", { class: "muted" }, "Authored brains are self-hosted by their owner, one process per brain, with the jar file and GENOME_KEY:"),
      el("pre", {}, el("code", {}, `cd agent && RPC_URL=${cfg.rpc} TOKEN_ID=<id> TRADER_NFT_ADDRESS=${cfg.traderNFT} \\\n  GUARD_ADDRESS=${cfg.guard} ROUTER_ADDRESS=${cfg.router} GENOME_PATH=./brain-<hash>.authored.json \\\n  GENOME_KEY=<key> EXECUTOR_PRIVATE_KEY=<executor key> npm run loop -- --mock-brain`))));
}
