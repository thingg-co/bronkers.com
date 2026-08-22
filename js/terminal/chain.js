// Chain + wallet state for the Terminal.
//
// Reads always go over the chain's public RPC (so the Floor works with no
// wallet at all). Writes go through a wallet: an injected one (MetaMask,
// Rabby…) or, on a local anvil, a dev key pasted into the Developer panel.
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
} from "https://esm.sh/viem@2.21.19";
import { privateKeyToAccount } from "https://esm.sh/viem@2.21.19/accounts";

export const state = {
  chainId: null,
  cfg: null,
  pub: null,
  wallet: null,
  account: null,
  mode: "boot", // boot | offline | readonly | wallet
  walletKind: null, // injected | dev | null
  blockNumber: null,
};

export const bus = new EventTarget();
const emit = () => bus.dispatchEvent(new Event("change"));

const LS_CHAIN = "brokners-chain";
const lsCfg = (id) => `brokners-cfg-${id}`;
const ssDevKey = (id) => `brokners-devkey-${id}`;

export function chains() {
  const base = (window.BROKNERS_CONFIG && window.BROKNERS_CONFIG.chains) || {};
  const out = {};
  for (const id of Object.keys(base)) out[Number(id)] = cfgFor(Number(id));
  return out;
}

export function cfgFor(id) {
  const base = ((window.BROKNERS_CONFIG || {}).chains || {})[id] || { name: `chain ${id}` };
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(lsCfg(id)) || "{}");
  } catch {}
  return { ...base, ...saved, id: Number(id) };
}

export function saveOverride(id, partial) {
  const cur = (() => {
    try {
      return JSON.parse(localStorage.getItem(lsCfg(id)) || "{}");
    } catch {
      return {};
    }
  })();
  const next = { ...cur };
  for (const [k, v] of Object.entries(partial)) {
    if (v === "" || v == null) delete next[k];
    else next[k] = v;
  }
  localStorage.setItem(lsCfg(id), JSON.stringify(next));
}

export function clearOverride(id) {
  localStorage.removeItem(lsCfg(id));
}

export const configured = (cfg) => Boolean(cfg && cfg.traderNFT && cfg.guard && cfg.usdc);

export function viemChain(cfg) {
  return defineChain({
    id: cfg.id,
    name: cfg.name,
    nativeCurrency: { name: cfg.currency || "ETH", symbol: cfg.currency || "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpc] } },
    blockExplorers: cfg.explorer ? { default: { name: "explorer", url: cfg.explorer } } : undefined,
  });
}

async function injectedChainId() {
  try {
    if (!window.ethereum) return null;
    return Number(await window.ethereum.request({ method: "eth_chainId" }));
  } catch {
    return null;
  }
}

function pickChainId(preferred) {
  const all = chains();
  if (preferred && configured(all[preferred])) return preferred;
  const def = (window.BROKNERS_CONFIG || {}).defaultChainId;
  if (configured(all[def])) return def;
  const first = Object.values(all).find(configured);
  return first ? first.id : def || Number(Object.keys(all)[0]) || 31337;
}

/** Boot: choose a chain, open a read-only client, reattach a wallet if one is already authorised. */
export async function init() {
  const saved = Number(localStorage.getItem(LS_CHAIN)) || null;
  const injected = await injectedChainId();
  const id = pickChainId(saved || (configured(cfgFor(injected)) ? injected : null));
  await selectChain(id, { silent: true });

  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", () => location.reload());
    window.ethereum.on?.("chainChanged", () => location.reload());
  }

  const qp = new URLSearchParams(location.search).get("devkey");
  if (qp && state.cfg.testnet) sessionStorage.setItem(ssDevKey(id), qp.startsWith("0x") ? qp : `0x${qp}`);
  const devKey = sessionStorage.getItem(ssDevKey(id));
  if (devKey) {
    try {
      await connectDev(devKey);
      return;
    } catch {}
  }
  if (window.ethereum && state.mode !== "offline") {
    try {
      const accts = await window.ethereum.request({ method: "eth_accounts" });
      if (accts && accts.length && injected === id) await attachInjected(accts[0]);
    } catch {}
  }
  emit();
}

export async function selectChain(id, { silent } = {}) {
  state.chainId = id;
  state.cfg = cfgFor(id);
  state.wallet = null;
  state.account = null;
  state.walletKind = null;
  localStorage.setItem(LS_CHAIN, String(id));
  state.pub = createPublicClient({ chain: viemChain(state.cfg), transport: http(state.cfg.rpc, { timeout: 8_000 }) });
  try {
    state.blockNumber = await state.pub.getBlockNumber();
    state.mode = "readonly";
  } catch {
    state.mode = "offline";
  }
  if (!silent) emit();
}

/** Re-read config overrides and reconnect the read client (after a Developer-panel save). */
export async function reload() {
  const dev = state.walletKind === "dev" ? sessionStorage.getItem(ssDevKey(state.chainId)) : null;
  await selectChain(state.chainId, { silent: true });
  if (dev) await connectDev(dev);
  emit();
}

async function attachInjected(account) {
  state.wallet = createWalletClient({ account, chain: viemChain(state.cfg), transport: custom(window.ethereum) });
  state.account = account;
  state.walletKind = "injected";
  state.mode = "wallet";
  // if the RPC is unreachable but the wallet is here, read through the wallet instead
  if (state.blockNumber == null) {
    state.pub = createPublicClient({ chain: viemChain(state.cfg), transport: custom(window.ethereum) });
    try {
      state.blockNumber = await state.pub.getBlockNumber();
    } catch {}
  }
}

/** Connect an injected wallet, switching it to the selected chain if needed. */
export async function connect() {
  if (!window.ethereum) throw new Error("No wallet found. Install a browser wallet, or use a dev key on a local chain (Developer tab).");
  const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
  const current = Number(await window.ethereum.request({ method: "eth_chainId" }));
  if (current !== state.chainId) await switchInjectedChain(state.cfg);
  await attachInjected(account);
  emit();
}

async function switchInjectedChain(cfg) {
  const hexId = "0x" + cfg.id.toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (e) {
    if (e && (e.code === 4902 || /unrecognized|not added|4902/i.test(String(e.message)))) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hexId,
            chainName: cfg.name,
            rpcUrls: [cfg.rpc],
            nativeCurrency: { name: cfg.currency || "ETH", symbol: cfg.currency || "ETH", decimals: 18 },
            blockExplorerUrls: cfg.explorer ? [cfg.explorer] : undefined,
          },
        ],
      });
    } else throw e;
  }
}

/** Local-chain convenience: sign with a raw private key (anvil's dev accounts). */
export async function connectDev(privateKey) {
  if (!state.cfg.testnet) throw new Error("Dev keys are only allowed on test chains.");
  const pk = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(pk);
  state.wallet = createWalletClient({ account, chain: viemChain(state.cfg), transport: http(state.cfg.rpc) });
  state.account = account.address;
  state.walletKind = "dev";
  state.mode = "wallet";
  sessionStorage.setItem(ssDevKey(state.chainId), pk);
  emit();
}

export function disconnect() {
  sessionStorage.removeItem(ssDevKey(state.chainId));
  state.wallet = null;
  state.account = null;
  state.walletKind = null;
  state.mode = state.blockNumber == null ? "offline" : "readonly";
  emit();
}

export const explorerAddr = (a) => (state.cfg && state.cfg.explorer ? `${state.cfg.explorer}/address/${a}` : null);
export const explorerTx = (h) => (state.cfg && state.cfg.explorer ? `${state.cfg.explorer}/tx/${h}` : null);
export const isMe = (a) => Boolean(state.account && a && a.toLowerCase() === state.account.toLowerCase());
