// Write side. Every on-chain action goes through runSteps(): a small modal
// that narrates each transaction (approve, then deposit…), shows hashes, and
// translates reverts into sentences a person can act on.
import { decodeEventLog, encodeFunctionData, keccak256, maxUint256, parseUnits, stringToHex, toBytes } from "https://esm.sh/viem@2.21.19";
import { credentialsAbi, erc20Abi, guardAbi, nftAbi, tbaAbi, vaultAbi } from "./abi.js";
import { explorerTx, state } from "./chain.js";
import { invalidate } from "./data.js";
import { celebrate, el, modal, toast } from "./ui.js";

const REVERTS = [
  [/Vault: trader not seasoned/, "This brain is still an intern. It cannot take outside money until it finishes its paper season on its own book."],
  [/Vault: depositor not allowed/, "This vault is allowlist-only and your address is not on it. Ask the owner to add you, or pick a brain whose vault is open."],
  [/Guard: not trader owner|Trader: not owner|Vault: not trader owner/, "Only the brain's owner can do that."],
  [/Trader: already named/, "This brain already has a name, and names are permanent."],
  [/Trader: name length/, "Names are 1 to 32 bytes."],
  [/Trader: sold out/, "All 4,096 brains have been minted. One per bit; no more bits."],
  [/Guard: not an upgrade/, "Seats only go up. This brain already holds that tier or higher."],
  [/Guard: exceeds tier/, "That limit is above what this brain's seat allows."],
  [/Guard: token not curated|Guard: venue not curated/, "Only protocol-curated markets can be enabled."],
  [/Guard: in camp/, "This generation is still in training camp: it has to spar on the brain's own wallet (and wait out the notice period) before it may trade the vault."],
  [/Guard: not reapable/, "This brain isn't reapable: it still holds capital or vault shares, or it hasn't been dead long enough. Reaping only ever burns an empty, abandoned brain."],
  [/Vault: retired/, "This brain has been reaped; its vault is closed."],
  [/Trader: same genome/, "That is the genome the brain already has."],
  [/Credentials: not owner/, "Only the brain's owner can publish or revoke its credentials."],
  [/Credentials: nothing to revoke/, "There is no active credential of that kind to revoke."],
  [/ERC20InsufficientAllowance|insufficient allowance/i, "The token approval is too small. Approve first."],
  [/ERC20InsufficientBalance|transfer amount exceeds balance|insufficient balance/i, "Not enough balance for that amount."],
  [/ERC4626ExceededMaxWithdraw|ERC4626ExceededMaxRedeem/, "That is more than your position in this vault."],
  [/ERC4626ExceededMaxDeposit/, "The vault will not accept that deposit right now."],
  [/User rejected|user rejected|denied transaction|4001/i, "You cancelled in your wallet."],
  [/insufficient funds for gas/i, "Your wallet has no gas token on this chain."],
  [/could not detect network|Failed to fetch|fetch failed|ECONNREFUSED/i, "Can't reach the chain's RPC. Is it running?"],
];

export function explain(err) {
  const raw = String(err?.shortMessage || err?.details || err?.message || err);
  for (const [re, msg] of REVERTS) if (re.test(raw) || re.test(String(err?.details || ""))) return msg;
  const m = raw.match(/reverted with the following reason:\s*([^\n]+)/);
  if (m) return m[1];
  return raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
}

export function requireWallet() {
  if (!state.wallet || !state.account) throw new Error("Connect a wallet first.");
}

/** Simulate → sign → wait. Returns the receipt. */
export async function tx({ address, abi, functionName, args = [], value }) {
  requireWallet();
  const { request } = await state.pub.simulateContract({ account: state.wallet.account, address, abi, functionName, args, value });
  const hash = await state.wallet.writeContract(request);
  const receipt = await state.pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Transaction reverted on-chain.");
  window.terminalLog?.(`${functionName} ✓ ${hash}`, "ok");
  return receipt;
}

/**
 * runSteps("Deposit", [{label, run}], {summary}) — opens a progress modal,
 * runs the steps in order, returns true if all succeeded. `summary` is a
 * node shown above the steps (amount, fees, what you'll get).
 */
export async function runSteps(title, steps, { summary, onDone } = {}) {
  const list = el("ol", { class: "steps" }, steps.map((s) => el("li", { class: "step pending" }, el("span", { class: "step-dot" }), el("span", { class: "step-label" }, s.label), el("span", { class: "step-meta" }))));
  const m = modal({ title, body: el("div", {}, summary || null, list), actions: [] });
  const items = [...list.children];
  let ok = true;
  for (let i = 0; i < steps.length; i++) {
    const li = items[i];
    li.className = "step running";
    try {
      const receipt = await steps[i].run();
      li.className = "step done";
      if (receipt?.transactionHash) {
        const h = receipt.transactionHash;
        const url = explorerTx(h);
        li.querySelector(".step-meta").replaceChildren(url ? el("a", { href: url, target: "_blank", rel: "noopener" }, h.slice(0, 10) + "…") : h.slice(0, 10) + "…");
      }
    } catch (e) {
      ok = false;
      li.className = "step failed";
      li.querySelector(".step-meta").textContent = explain(e);
      window.terminalLog?.(`${steps[i].label} ✗ ${explain(e)}`, "err");
      break;
    }
  }
  m.setActions([{ label: ok ? "Done" : "Close", kind: ok ? "primary" : "", onClick: () => { m.close(); onDone && onDone(ok); } }]);
  if (ok) {
    toast(`${title}: done`, "ok");
    celebrate();
    setTimeout(() => { m.close(); onDone && onDone(true); }, 1200);
  }
  return ok;
}

// ---- building blocks ----

export async function allowanceStep(token, spender, amount, label) {
  const cur = await state.pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [state.account, spender] });
  if (cur >= amount) return null;
  return { label: label || "Approve mUSDC", run: () => tx({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] }) };
}

const viaTba = (tba, to, data) => tx({ address: tba, abi: tbaAbi, functionName: "execute", args: [to, 0n, data, 0] });

// ---- depositor actions ----

export async function deposit(brain, amountStr) {
  const assets = parseUnits(amountStr || "0", 18);
  if (assets <= 0n) throw new Error("Enter an amount.");
  const steps = [await allowanceStep(state.cfg.usdc, brain.vault, assets, "Approve the vault to take your mUSDC")].filter(Boolean);
  steps.push({ label: `Deposit ${amountStr} mUSDC into ${brain.label}`, run: () => tx({ address: brain.vault, abi: vaultAbi, functionName: "deposit", args: [assets, state.account] }) });
  return steps;
}

export function withdrawAll(brain) {
  return [{
    label: `Withdraw everything from ${brain.label}`,
    run: async () => {
      const shares = await state.pub.readContract({ address: brain.vault, abi: vaultAbi, functionName: "maxRedeem", args: [state.account] });
      return tx({ address: brain.vault, abi: vaultAbi, functionName: "redeem", args: [shares, state.account, state.account] });
    },
  }];
}

export function withdrawAmount(brain, amountStr) {
  const assets = parseUnits(amountStr || "0", 18);
  if (assets <= 0n) throw new Error("Enter an amount.");
  return [{ label: `Withdraw ${amountStr} mUSDC from ${brain.label}`, run: () => tx({ address: brain.vault, abi: vaultAbi, functionName: "withdraw", args: [assets, state.account, state.account] }) }];
}

export function ring(brain) {
  return [{ label: `Ring the bell on ${brain.label}`, run: () => tx({ address: brain.vault, abi: vaultAbi, functionName: "ringTheBell" }) }];
}

// ---- owner actions ----

export async function promote(brain) {
  const next = brain.tier + 1;
  const [, fee] = await state.pub.readContract({ address: state.cfg.guard, abi: guardAbi, functionName: "tiers", args: [BigInt(next)] });
  const steps = [];
  if (fee > 0n) {
    const a = await allowanceStep(state.cfg.usdc, state.cfg.guard, fee, "Approve the seat fee");
    if (a) steps.push(a);
  }
  steps.push({ label: `Activate the new seat`, run: () => tx({ address: state.cfg.guard, abi: guardAbi, functionName: "activate", args: [BigInt(brain.id), next] }) });
  return { steps, fee };
}

export const christen = (id, name) => [{ label: `Name brain #${id} “${name}”`, run: () => tx({ address: state.cfg.traderNFT, abi: nftAbi, functionName: "christen", args: [BigInt(id), name] }) }];
export const setExecutor = (id, addr) => [{ label: `Set executor key`, run: () => tx({ address: state.cfg.guard, abi: guardAbi, functionName: "setExecutor", args: [BigInt(id), addr] }) }];
export const ZERO = "0x0000000000000000000000000000000000000000";
/** Enrolling with the enclave is nothing more than making its key the executor. */
export function enrol(id) {
  const ex = state.cfg.enclaveExecutor;
  if (!ex) throw new Error("No enclave executor is configured for this chain (Developer tab).");
  return [{ label: "Enrol with the enclave (set its key as executor)", run: () => tx({ address: state.cfg.guard, abi: guardAbi, functionName: "setExecutor", args: [BigInt(id), ex] }) }];
}
/** Reap a dead brain: burn it to free a slot. Anyone may; the guard checks it is genuinely dead and idle. */
export const reap = (id) => [{ label: `Reap brain #${id} (free its slot)`, run: () => tx({ address: state.cfg.guard, abi: guardAbi, functionName: "reap", args: [BigInt(id)] }) }];

export const unenrol = (id) => [{ label: "Unenrol (clear the executor)", run: () => tx({ address: state.cfg.guard, abi: guardAbi, functionName: "setExecutor", args: [BigInt(id), ZERO] }) }];
export const setRuntimeFee = (id, amountStr) => [{ label: `Set the runtime fee to ${amountStr} mUSDC per trade`, run: () => tx({ address: state.cfg.guard, abi: guardAbi, functionName: "setRuntimeFee", args: [BigInt(id), parseUnits(amountStr || "0", 18)] }) }];

/** Ask the enclave to compose and seal a prompt from a brief (sealed-generated custody). The prompt never leaves the enclave. */
export async function composeWithEnclave(brief, tweaks) {
  const url = (state.cfg.enclaveUrl || "").replace(/\/$/, "");
  if (!url) throw new Error("No enclave endpoint is configured for this chain (Developer tab).");
  const res = await fetch(`${url}/compose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brief, tweaks: tweaks || {} }) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `enclave returned ${res.status}`);
  if (!json.commitment || !json.envelope || !json.attestation) throw new Error("enclave returned an incomplete answer");
  return json;
}

/** Append a generation: a new commitment (and model) the brain will trade under once it has sparred. */
export const revise = (id, commitment, model, cid, attestation = "0x") => [{ label: `Revise brain #${id}: commit the next generation`, run: () => tx({ address: state.cfg.traderNFT, abi: nftAbi, functionName: "revise", args: [BigInt(id), commitment, model, cid, attestation] }) }];

/** Coach a sealed brain: the enclave appends the note to the current genome, seals the next generation, and returns only the commitment and the ciphertext. */
export async function trainWithEnclave(id, brief) {
  const url = (state.cfg.enclaveUrl || "").replace(/\/$/, "");
  if (!url) throw new Error("No enclave endpoint is configured for this chain (Developer tab).");
  const res = await fetch(`${url}/train`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenId: Number(id), brief }) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `enclave returned ${res.status}`);
  if (!json.commitment || !json.envelope) throw new Error("enclave returned an incomplete answer");
  return json;
}

/** Put the sealed jar on-chain (as an event) so the enclave can find it without a file handoff. */
export function publishEnvelope(id, envelopeObj) {
  const bytes = stringToHex(typeof envelopeObj === "string" ? envelopeObj : JSON.stringify(envelopeObj));
  return [{ label: "Publish the sealed jar on-chain", run: () => tx({ address: state.cfg.traderNFT, abi: nftAbi, functionName: "publishEnvelope", args: [BigInt(id), bytes] }) }];
}
/** Credential kinds are keccak256 of a short name; the farm knows "inference". */
export const credentialKind = (name) => keccak256(toBytes(name));

/** Publish a credential the owner sealed in this tab (Credentials.publish); the farm picks it up on its next pass. */
export function publishCredential(id, kindName, envelopeObj) {
  if (!state.cfg.credentials) throw new Error("No Credentials contract is configured for this chain (Developer tab).");
  const bytes = stringToHex(JSON.stringify(envelopeObj));
  return [{ label: `Publish the sealed ${kindName} credential on-chain`, run: () => tx({ address: state.cfg.credentials, abi: credentialsAbi, functionName: "publish", args: [BigInt(id), credentialKind(kindName), bytes] }) }];
}
export function revokeCredential(id, kindName) {
  if (!state.cfg.credentials) throw new Error("No Credentials contract is configured for this chain (Developer tab).");
  return [{ label: `Revoke the ${kindName} credential`, run: () => tx({ address: state.cfg.credentials, abi: credentialsAbi, functionName: "revoke", args: [BigInt(id), credentialKind(kindName)] }) }];
}

export const setPolicy = (id, notionalBps, slippageBps, interval) => [{ label: `Update trading limits`, run: () => tx({ address: state.cfg.guard, abi: guardAbi, functionName: "setPolicy", args: [BigInt(id), notionalBps, slippageBps, BigInt(interval)] }) }];
export const setTokenAllowed = (id, token, allowed) => [{ label: `${allowed ? "Enable" : "Disable"} a market`, run: () => tx({ address: state.cfg.guard, abi: guardAbi, functionName: "setTokenAllowed", args: [BigInt(id), token, allowed] }) }];
export const setAllowlistEnabled = (brain, enabled) => [{ label: enabled ? "Close the vault to the allowlist" : "Open the vault to anyone", run: () => tx({ address: brain.vault, abi: vaultAbi, functionName: "setAllowlistEnabled", args: [enabled] }) }];
export const setDepositAllowed = (brain, addr, allowed) => [{ label: `${allowed ? "Allow" : "Remove"} depositor ${addr.slice(0, 8)}…`, run: () => tx({ address: brain.vault, abi: vaultAbi, functionName: "setDepositAllowed", args: [addr, allowed] }) }];
export const transferBrain = (brain, to) => [{ label: `Transfer ${brain.label} to ${to.slice(0, 8)}…`, run: () => tx({ address: state.cfg.traderNFT, abi: nftAbi, functionName: "safeTransferFrom", args: [state.account, to, BigInt(brain.id)] }) }];

export function fundTba(brain, amountStr) {
  const amt = parseUnits(amountStr || "0", 18);
  if (amt <= 0n) throw new Error("Enter an amount.");
  return [{ label: `Send ${amountStr} mUSDC to ${brain.label}'s wallet`, run: () => tx({ address: state.cfg.usdc, abi: erc20Abi, functionName: "transfer", args: [brain.tba, amt] }) }];
}

export function authoriseGuard(brain) {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [state.cfg.guard, maxUint256] });
  return [{ label: `Let the guard trade ${brain.label}'s own wallet`, run: () => viaTba(brain.tba, state.cfg.usdc, data) }];
}

export function sweep(brain, token, amount, sym) {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [state.account, amount] });
  return [{ label: `Sweep ${sym} from ${brain.label}'s wallet to you`, run: () => viaTba(brain.tba, token, data) }];
}

export function redeemFeeShares(brain) {
  const data = encodeFunctionData({ abi: vaultAbi, functionName: "redeem", args: [brain.fees.feeShares, state.account, brain.tba] });
  return [{ label: `Redeem accrued fee shares to you`, run: () => viaTba(brain.tba, brain.vault, data) }];
}

// ---- testnet ----

export async function fundRuntimeEscrow(brain, amountStr) {
  const amount = parseUnits(amountStr || "0", 18);
  if (amount <= 0n) throw new Error("Enter an amount.");
  const steps = [await allowanceStep(state.cfg.usdc, state.cfg.guard, amount, "Approve the guard to take your mUSDC")].filter(Boolean);
  steps.push({ label: `Escrow ${amountStr} mUSDC of rent for ${brain.label}`, run: () => tx({ address: state.cfg.guard, abi: guardAbi, functionName: "fundRuntime", args: [BigInt(brain.id), amount] }) });
  return steps;
}

export function withdrawRuntimeEscrow(brain, amountStr) {
  const amount = parseUnits(amountStr || "0", 18);
  if (amount <= 0n) throw new Error("Enter an amount.");
  return [{ label: `Take ${amountStr} mUSDC of escrowed rent back from ${brain.label}`, run: () => tx({ address: state.cfg.guard, abi: guardAbi, functionName: "withdrawRuntime", args: [BigInt(brain.id), amount] }) }];
}

export function faucet(amountStr = "10000") {
  const amt = parseUnits(amountStr, 18);
  return [{ label: `Mint ${amountStr} test mUSDC to you`, run: () => tx({ address: state.cfg.usdc, abi: erc20Abi, functionName: "mint", args: [state.account, amt] }) }];
}

// ---- mint ----

export async function mintBrain({ commitment, risk, cadence, custody, model, cid, universe, mgmtBps, perfBps }) {
  const receipt = await tx({
    address: state.cfg.traderNFT, abi: nftAbi, functionName: "mint",
    args: [commitment, risk, cadence, custody, model, cid, universe, mgmtBps, perfBps],
  });
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: nftAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "TraderBorn") return Number(ev.args.tokenId);
    } catch {}
  }
  return null;
}

export function afterWrite(id) {
  invalidate(id);
}
