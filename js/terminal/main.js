// The Terminal. Hash router + header; views live in ./views.
import * as act from "./actions.js";
import { bus, connect, disconnect, init, state } from "./chain.js";
import { $, clear, el, fmt, toast } from "./ui.js";

const views = {
  floor: () => import("./views/floor.js"),
  brain: () => import("./views/brain.js"),
  create: () => import("./views/create.js"),
  desk: () => import("./views/desk.js"),
  dev: () => import("./views/dev.js"),
};

const TABS = [
  ["floor", "The Floor", "#/"],
  ["create", "Birth a Brain", "#/create"],
  ["desk", "My Desk", "#/desk"],
  ["dev", "Developer", "#/dev"],
];

// console pane: every action writes a line; it is a developer aid, hidden by default
const logLines = [];
window.terminalLog = (msg, cls) => {
  const pane = $("console");
  if (!pane) return;
  const line = el("div", { class: cls || "" }, `> ${String(msg).replace(/[\x00-\x1f\x7f]/g, " ")}`);
  pane.appendChild(line);
  pane.scrollTop = pane.scrollHeight;
  logLines.push(msg);
};

function route() {
  const h = (location.hash || "#/").replace(/^#\/?/, "");
  const [name, ...rest] = h.split("/");
  if (!name) return { view: "floor", params: {} };
  if (name === "brain" && rest[0]) return { view: "brain", params: { id: rest[0] } };
  if (name === "desk") return { view: "desk", params: { id: rest[0] } };
  if (views[name]) return { view: name, params: {} };
  return { view: "floor", params: {} };
}

function renderHeader() {
  const net = $("netLabel");
  const acct = $("acctLabel");
  const btn = $("connectBtn");
  if (!net) return;
  const cfg = state.cfg || {};
  net.textContent = cfg.name || "–";
  net.className = `net ${state.mode}`;
  net.title = state.mode === "offline" ? "RPC unreachable" : `block ${state.blockNumber ?? "?"}`;
  if (state.account) {
    acct.textContent = `${fmt.addr(state.account)}${state.walletKind === "dev" ? " · dev" : ""}`;
    acct.hidden = false;
    btn.textContent = "Disconnect";
    btn.onclick = () => disconnect();
  } else {
    acct.hidden = true;
    btn.textContent = "Connect wallet";
    btn.onclick = async () => {
      try { await connect(); toast("Connected", "ok"); } catch (e) { toast(act.explain(e), "err"); }
    };
  }
}

let current = null;
async function render() {
  const { view, params } = route();
  current = view;
  for (const a of document.querySelectorAll(".tabs a")) a.classList.toggle("active", a.dataset.tab === view || (view === "brain" && a.dataset.tab === "floor"));
  // a fresh root per render: if another render starts meanwhile, this one
  // keeps writing into a detached node and never doubles up on screen
  const host = $("view");
  const root = el("div", { class: "view-root" });
  clear(host);
  host.append(root);
  try {
    const mod = await views[view]();
    if (!root.isConnected) return;
    await mod.render(root, params);
  } catch (e) {
    clear(root);
    root.append(el("div", { class: "empty" }, el("p", {}, "This view failed to load."), el("p", { class: "muted" }, act.explain(e))));
    console.error(e);
  }
}

async function boot() {
  // debugging handle: window.__terminal.act / .data / .chain / .crypto
  const [chainMod, dataMod, cryptoMod] = await Promise.all([import("./chain.js"), import("./data.js"), import("./crypto.js")]);
  window.__terminal = { act, chain: chainMod, data: dataMod, crypto: cryptoMod, render: () => render() };
  const tabs = $("tabs");
  for (const [key, label, href] of TABS) tabs.appendChild(el("a", { href, dataset: { tab: key } }, label));
  $("consoleToggle").onclick = () => { const c = $("console"); c.hidden = !c.hidden; };
  await init();
  renderHeader();
  bus.addEventListener("change", () => { renderHeader(); render(); });
  window.addEventListener("hashchange", render);
  window.terminalLog(`terminal ready · ${state.cfg?.name} · ${state.mode}`);
  render();
}

boot();
