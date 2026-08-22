// Birth a Brain: a five-step wizard. Plain words, sealed by default, the
// secret never leaves the browser unencrypted, and a sealed brain can be
// started in the same sitting: publish the jar on-chain, fund its wallet,
// authorise the guard, enrol it with the enclave. No files to hand anyone.
import * as act from "../actions.js";
import { CUSTODY, RISK } from "../abi.js";
import { state } from "../chain.js";
import { authoredEnvelope, canSeal, commit, downloadJson, sealedEnvelope } from "../crypto.js";
import { invalidate, loadBrain } from "../data.js";
import { amountField, badge, clear, el, fmt, kv, modal, textField, tip, toast } from "../ui.js";

const TEMPLATES = [
  { key: "momentum", label: "Momentum", prompt: "You are a patient momentum trader. You buy strength and sell weakness, never chase, and size every position small. You would rather miss a move than force one. Protect capital first." },
  { key: "meanrev", label: "Mean reversion", prompt: "You are a disciplined mean-reversion trader. You buy weakness and sell strength against a slow moving average, scale in gradually, and take profits early. You never add to a loser more than once." },
  { key: "contrarian", label: "Contrarian", prompt: "You are a contrarian. You fade crowded moves and consensus narratives, but only when price has already overshot. You hold cash most of the time and act rarely, with conviction." },
  { key: "conservative", label: "Capital preservation", prompt: "You are a capital-preservation trader. Your first job is to not lose money; your second job is to compound slowly. Trade only when the setup is obvious, size tiny, and hold cash otherwise." },
];

const TIPS = {
  name: "Shown on the Floor and in marketplaces. Set once at birth and never changeable, so a record can't be laundered by renaming.",
  prompt: "The brain's instructions. Hashed in this tab (the hash is what gets minted) and encrypted in this tab. Sealed: only the enclave can ever read it. Authored: only someone with your key can.",
  tweaks: "Optional JSON the runtime hands to the model alongside the prompt (style, universe hints, risk notes). Secret, like the prompt; part of the commitment.",
  risk: "A public trait. It is advertised, not enforced; the enforced limits are the seat's per-trade cap and the slippage bound.",
  cadence: "How often the enclave wakes the brain: 4/day is every 6 hours. Public. The guard can also rate-limit on-chain (My Desk → limits).",
  markets: "Protocol-curated markets only. You can switch one off later; you can never add one the protocol hasn't curated. This is the wash-trading defence.",
  mgmt: "Charged on vault assets, streamed over time, minted as vault shares to the brain's own wallet. Max 5%/year.",
  perf: "Charged only on share-price gains above the high-water mark. Max 30%. Also minted to the brain's wallet, so it travels with the token.",
  fund: "The brain trades its own wallet first (the internship). Send it some mUSDC to trade with; you can sweep it back any time.",
  fee: "What the brain pays its executor per trade, from the book it traded, to cover gas and model calls. Owner-set, capped by the protocol, skipped if the book has no cash. The enclave operator publishes the fee it asks for.",
};

const draft = {
  name: "", prompt: "", tweaks: "", custody: 1, risk: 1, cadence: 4,
  markets: { weth: true, wbtc: true }, mgmtBps: 200, perfBps: 2000, model: "claude-sonnet-5",
  result: null,
};

let step = 1;

function stepper() {
  const names = ["Strategy", "Custody", "Traits", "Review", "Start"];
  return el("ol", { class: "stepper" }, names.map((n, i) => el("li", { class: i + 1 === step ? "current" : i + 1 < step ? "done" : "" }, el("span", { class: "stepper-no" }, String(i + 1)), n)));
}

function nav(root, { back = true, next = "Next", onNext, disabled } = {}) {
  return el("div", { class: "btn-row wizard-nav" },
    back ? el("button", { class: "btn", onclick: () => { step--; render(root); } }, "Back") : el("span"),
    el("button", { class: "btn primary", disabled, onclick: async () => { if (!onNext || (await onNext()) !== false) { step++; render(root); } } }, next));
}

// ---- steps ----

function step1(root) {
  const name = textField({ label: "Name (optional, permanent, ≤ 32 bytes)", value: draft.name, placeholder: "Umbra", tip: TIPS.name });
  const prompt = textField({ label: "The strategy prompt — this is the secret", value: draft.prompt, rows: 7, placeholder: "You are a patient momentum trader…", hint: "This text is hashed and encrypted in your browser. Only the hash goes on-chain.", tip: TIPS.prompt });
  const tmpl = el("div", { class: "chips" }, TEMPLATES.map((t) => el("button", { type: "button", class: "chip", title: "Replace the prompt with this template", onclick: () => { prompt.input.value = t.prompt; } }, t.label)));
  const tweaks = textField({ label: "Tweaks (optional JSON, also secret)", value: draft.tweaks, placeholder: '{"style":"momentum"}', mono: true, tip: TIPS.tweaks });
  return el("div", {},
    el("p", { class: "muted" }, "Start from a template or write your own. Templates are starting points; the words are yours."),
    tmpl, name.el, prompt.el,
    el("details", { class: "adv" }, el("summary", {}, "Advanced"), tweaks.el),
    nav(root, { back: false, onNext: () => {
      draft.name = name.value(); draft.prompt = prompt.value(); draft.tweaks = tweaks.value();
      if (!draft.prompt) { toast("Write a strategy prompt first.", "err"); return false; }
      if (new TextEncoder().encode(draft.name).length > 32) { toast("Name must be 32 bytes or fewer.", "err"); return false; }
      if (draft.tweaks) { try { JSON.parse(draft.tweaks); } catch { toast("Tweaks must be valid JSON.", "err"); return false; } }
    } }));
}

function step2(root) {
  const enclaveOk = Boolean(state.cfg?.enclavePublicKey);
  const opts = [
    { v: 1, title: "Sealed (recommended)", body: "Encrypted to the enclave's key before it leaves this page, and published on-chain as ciphertext so the enclave can run it with no file handoff. No owner, now or later, can read it. You know it because you wrote it; a buyer never will.", ok: enclaveOk, why: enclaveOk ? null : "Needs the enclave public key for this chain (Developer tab)." },
    { v: 0, title: "Authored", body: "Encrypted with a key you keep. You run the brain yourself (or hand the key to an operator), you hand the key to a buyer on sale, and every past owner keeps a copy. Simplest; leaks on resale.", ok: true },
    { v: 2, title: "Sealed & generated", body: "Your text above is treated as a brief. The enclave composes the actual prompt from it, seals it, and returns only the commitment and the ciphertext. No human ever reads the prompt, including you.", ok: Boolean(state.cfg?.enclaveUrl), why: state.cfg?.enclaveUrl ? null : "Needs an enclave endpoint for this chain (Developer tab)." },
  ];
  const list = el("div", { class: "choice-list" }, opts.map((o) => el("label", { class: `choice ${o.ok ? "" : "disabled"} ${draft.custody === o.v ? "selected" : ""}` },
    el("input", { type: "radio", name: "custody", value: o.v, checked: draft.custody === o.v, disabled: !o.ok, onchange: () => { draft.custody = o.v; render(root); } }),
    el("span", { class: "choice-body" }, el("strong", {}, o.title), el("span", {}, o.body), o.why ? el("span", { class: "muted small" }, o.why) : null))));
  return el("div", {},
    el("p", { class: "muted" }, "Custody is a public trait. It tells a buyer what they are actually buying, and it decides who can run the brain."),
    list,
    nav(root, { onNext: () => { if (draft.custody === 2 && !state.cfg.enclaveUrl) { toast("No enclave endpoint configured for this chain.", "err"); return false; } } }));
}

function step3(root) {
  const risk = el("select", { class: "select", title: TIPS.risk, onchange: (e) => { draft.risk = Number(e.target.value); } }, RISK.map((r, i) => el("option", { value: i, selected: draft.risk === i }, r)));
  const cadence = el("input", { type: "number", min: 1, max: 255, value: draft.cadence, title: TIPS.cadence, onchange: (e) => { draft.cadence = Math.max(1, Math.min(255, Number(e.target.value) || 1)); } });
  const mk = (key, label) => el("label", { class: "check" }, el("input", { type: "checkbox", checked: draft.markets[key], onchange: (e) => { draft.markets[key] = e.target.checked; } }), ` ${label}`);
  const mgmt = el("input", { type: "range", min: 0, max: 500, step: 25, value: draft.mgmtBps, title: TIPS.mgmt, oninput: (e) => { draft.mgmtBps = Number(e.target.value); mgmtOut.textContent = fmt.bps(draft.mgmtBps); } });
  const mgmtOut = el("output", {}, fmt.bps(draft.mgmtBps));
  const perf = el("input", { type: "range", min: 0, max: 3000, step: 100, value: draft.perfBps, title: TIPS.perf, oninput: (e) => { draft.perfBps = Number(e.target.value); perfOut.textContent = fmt.bps(draft.perfBps); } });
  const perfOut = el("output", {}, fmt.bps(draft.perfBps));
  return el("div", {},
    el("p", { class: "muted" }, "Public traits. They go on-chain in the clear and can be filtered on in any marketplace."),
    el("div", { class: "two-col" },
      el("div", {},
        el("label", { class: "field" }, el("span", { class: "field-label" }, el("span", {}, "Risk profile ", tip(TIPS.risk))), risk),
        el("label", { class: "field" }, el("span", { class: "field-label" }, el("span", {}, "Declared cadence (trades per day) ", tip(TIPS.cadence))), cadence),
        el("div", { class: "field" }, el("span", { class: "field-label" }, el("span", {}, "Markets ", tip(TIPS.markets))), mk("weth", "mWETH / mUSDC"), mk("wbtc", "mWBTC / mUSDC"))),
      el("div", {},
        el("label", { class: "field" }, el("span", { class: "field-label" }, el("span", {}, "Management fee (per year) ", tip(TIPS.mgmt)), mgmtOut), mgmt),
        el("label", { class: "field" }, el("span", { class: "field-label" }, el("span", {}, "Performance fee (above high-water mark) ", tip(TIPS.perf)), perfOut), perf),
        el("p", { class: "muted small" }, "Fees mint as vault shares to the brain's own wallet, so they travel with the token."))),
    nav(root, { onNext: () => { if (!draft.markets.weth && !draft.markets.wbtc) { toast("Pick at least one market.", "err"); return false; } } }));
}

function universe() {
  const { weth, wbtc } = state.cfg;
  return [draft.markets.weth ? weth : null, draft.markets.wbtc ? wbtc : null].filter(Boolean);
}

function genomeObj() {
  return { prompt: draft.prompt, tweaks: draft.tweaks ? JSON.parse(draft.tweaks) : {} };
}

function step4(root) {
  const c = draft.custody === 2 ? "computed by the enclave at mint" : commit(genomeObj());
  const custody = CUSTODY[draft.custody];
  return el("div", {},
    el("div", { class: "two-col" },
      el("div", { class: "panel" }, el("h4", {}, "Goes on-chain (public)"), kv([
        ["Genome commitment", el("span", { class: "mono small" }, c)],
        ["Custody", custody.label],
        ["Risk / cadence", `${RISK[draft.risk]} · ${draft.cadence}/day`],
        ["Markets", universe().length === 2 ? "mWETH, mWBTC" : draft.markets.weth ? "mWETH" : "mWBTC"],
        ["Fees", `${fmt.bps(draft.mgmtBps)} mgmt · ${fmt.bps(draft.perfBps)} perf`],
        ["Model", draft.model],
        draft.name ? ["Name", draft.name] : null,
        draft.custody === 1 ? ["Sealed jar", "published on-chain as ciphertext (next step)"] : null,
      ])),
      el("div", { class: "panel" }, el("h4", {}, "Stays with you (secret)"), kv([
        [draft.custody === 2 ? "Brief" : "Prompt", `${draft.prompt.length} characters${draft.custody === 2 ? " (the enclave writes the prompt from it; nobody reads the result)" : ""}`],
        ["Tweaks", draft.tweaks ? "yes" : "none"],
        draft.custody === 0 ? ["Decryption key", "shown once after minting; keep it"] : ["Decryption key", "none — only the enclave can open the jar"],
      ]))),
    el("p", { class: "muted" }, state.account ? `Minting from ${fmt.addr(state.account)} on ${state.cfg.name}.` : "Connect a wallet to mint."),
    nav(root, { next: "Mint this brain", disabled: !state.account, onNext: () => mint(root) }));
}

async function mint(root) {
  try {
    act.requireWallet();
    const genome = genomeObj();
    const commitment = commit(genome);
    const short = commitment.slice(2, 10);
    let cid;
    let keyHex = null;
    let envelope = null;
    let commitmentFinal = commitment;
    if (draft.custody === 2) {
      const composed = await act.composeWithEnclave(draft.prompt, genome.tweaks);
      commitmentFinal = composed.commitment;
      envelope = composed.envelope;
      cid = `onchain:EnvelopePublished`;
    } else if (draft.custody === 1) {
      if (!(await canSeal())) throw new Error("This browser cannot do X25519 in WebCrypto; use Authored custody or the CLI.");
      envelope = await sealedEnvelope(genome, state.cfg.enclavePublicKey);
      cid = `onchain:EnvelopePublished`;
    } else {
      const { envelope: env, keyHex: k } = await authoredEnvelope(genome);
      keyHex = k;
      envelope = env;
      downloadJson(env, `brain-${short}.authored.json`);
      cid = `local:brain-${short}.authored.json`;
    }
    let tokenId = null;
    const steps = [{ label: "Mint the brain (commitment + traits on-chain)", run: async () => {
      tokenId = await act.mintBrain({ commitment: commitmentFinal, risk: draft.risk, cadence: draft.cadence, custody: draft.custody, model: draft.model, cid, universe: universe(), mgmtBps: draft.mgmtBps, perfBps: draft.perfBps });
      return { transactionHash: null };
    } }];
    if (draft.name) steps.push({ label: `Name it “${draft.name}”`, run: async () => act.christen(tokenId, draft.name)[0].run() });
    const ok = await act.runSteps("Birth a brain", steps, { summary: el("p", {}, draft.custody !== 0 ? "The sealed jar stays in this tab until you publish it in the next step." : "Your encrypted jar has downloaded. Keep it: the runtime needs it to think.") });
    if (!ok) return false;
    invalidate();
    draft.result = { tokenId, keyHex, cid, commitment: commitmentFinal, envelope, started: false };
    if (keyHex) {
      await new Promise((resolve) => {
        const m = modal({ title: "Your genome key", body: el("div", {},
          el("p", {}, el("strong", {}, "Copy this now."), " It is not stored anywhere. Without it, nobody can ever open the jar — including you."),
          el("pre", { class: "keybox" }, el("code", {}, keyHex)),
          el("p", { class: "muted" }, "The runtime needs it as GENOME_KEY. A buyer needs it if you sell the brain.")),
          actions: [
            { label: "Copy", onClick: async () => { try { await navigator.clipboard.writeText(keyHex); toast("Copied", "ok"); } catch {} } },
            { label: "I have saved it", kind: "primary", onClick: () => { m.close(); resolve(); } },
          ], onClose: resolve });
      });
    }
  } catch (e) {
    toast(act.explain(e), "err");
    return false;
  }
}

function step5(root) {
  const r = draft.result || {};
  const id = r.tokenId;
  const sealed = draft.custody !== 0;
  const enclave = state.cfg.enclaveExecutor;
  const minFee = state.cfg.enclaveMinFee && Number(state.cfg.enclaveMinFee) > 0 ? String(state.cfg.enclaveMinFee) : null;
  const fund = amountField({ label: "Seed its wallet with", value: "100", tip: TIPS.fund });
  const fee = amountField({ label: "Runtime fee per trade", value: minFee || "0", tip: TIPS.fee });

  const startSealed = async () => {
    try {
      const brain = await loadBrain(id, { force: true });
      const steps = [
        ...act.publishEnvelope(id, r.envelope),
        ...(Number(fund.value()) > 0 ? act.fundTba(brain, fund.value()) : []),
        ...act.authoriseGuard(brain),
        ...(Number(fee.value()) > 0 ? act.setRuntimeFee(id, fee.value()) : []),
        ...(enclave ? act.enrol(id) : []),
      ];
      const ok = await act.runSteps("Start the brain", steps, { summary: el("p", {}, enclave ? "Four signatures: the jar goes on-chain, the wallet is funded, the guard is authorised, the enclave is enrolled. Then it trades by itself." : "No enclave executor is configured for this chain, so this publishes, funds and authorises; enrol later from My Desk.") });
      if (ok) { r.started = true; invalidate(); render(root); }
    } catch (e) { toast(act.explain(e), "err"); }
  };
  const startAuthored = async () => {
    try {
      const brain = await loadBrain(id, { force: true });
      const steps = [...(Number(fund.value()) > 0 ? act.fundTba(brain, fund.value()) : []), ...act.authoriseGuard(brain)];
      const ok = await act.runSteps("Prepare the brain", steps);
      if (ok) { r.started = true; invalidate(); render(root); }
    } catch (e) { toast(act.explain(e), "err"); }
  };

  const cfg = state.cfg;
  const selfHostCmd = `cd agent && RPC_URL=${cfg.rpc} TOKEN_ID=${id} TRADER_NFT_ADDRESS=${cfg.traderNFT} \\\n  GUARD_ADDRESS=${cfg.guard} ROUTER_ADDRESS=${cfg.router} GENOME_PATH=./brain-${(r.commitment || "").slice(2, 10)}.authored.json \\\n  GENOME_KEY=<your key> EXECUTOR_PRIVATE_KEY=<a burner key you set as executor> npm run loop`;

  return el("div", {},
    el("div", { class: "panel born" },
      el("h3", {}, id ? `Brain #${id} is born.` : "Minted."), draft.name ? el("p", {}, `Its name is ${draft.name}.`) : null,
      el("p", { class: "muted" }, "Commitment ", el("span", { class: "mono small" }, r.commitment || ""))),
    r.started
      ? el("div", { class: "panel" },
          el("h4", {}, sealed && enclave ? "It's running." : "It's ready."),
          sealed && enclave
            ? el("p", {}, "The enclave will pick it up on its next pass and make the first own-book trade within about ", el("strong", {}, fmt.duration(Math.max(60, 86400 / draft.cadence))), ". Once it has served the internship, its vault opens to depositors on its own.")
            : el("p", {}, sealed ? "Enrol it with an enclave from My Desk when one is configured." : "Run it yourself with the command below, or hand the jar and key to an operator you trust."),
          !sealed ? el("pre", {}, el("code", {}, selfHostCmd)) : null,
          el("div", { class: "btn-row" },
            el("a", { class: "btn primary", href: `#/brain/${id}` }, "See its page"),
            el("a", { class: "btn", href: `#/desk/${id}` }, "Open My Desk"),
            sealed ? el("button", { class: "btn", onclick: () => downloadJson(r.envelope, `brain-${(r.commitment || "").slice(2, 10)}.sealed.json`) }, "Download a copy of the jar") : null,
            el("button", { class: "btn", onclick: () => { step = 1; Object.assign(draft, { name: "", prompt: "", tweaks: "", result: null }); render(root); } }, "Birth another")))
      : el("div", { class: "panel" },
          el("h4", {}, "Start it"),
          sealed
            ? el("p", { class: "muted" }, "A new brain serves an internship on its own wallet before the vault opens. This does everything in one go: publishes the sealed jar on-chain (ciphertext only the enclave opens), seeds the wallet, authorises the guard to trade it, and enrols the brain with the enclave so it runs at its declared cadence.")
            : el("p", { class: "muted" }, "Authored custody means you hold the key, so you run the brain yourself. This seeds its wallet and authorises the guard; then start the runtime with your key."),
          fund.el,
          sealed ? fee.el : null,
          sealed && minFee ? el("p", { class: "muted small" }, `This enclave asks for ${minFee} mUSDC per trade; it pauses brains that pay less.`) : null,
          enclave || !sealed ? null : el("p", { class: "muted small" }, badge("no enclave configured", "bad"), " This chain has no enclave executor in its config; you can still publish, fund and authorise now and enrol later."),
          el("div", { class: "btn-row" },
            el("button", { class: "btn primary", disabled: !id, onclick: sealed ? startSealed : startAuthored }, sealed ? (enclave ? "Publish, fund, authorise, enrol" : "Publish, fund, authorise") : "Fund and authorise"),
            el("a", { class: "btn", href: `#/desk/${id}` }, "I'll do it from My Desk"))));
}

export async function render(root) {
  clear(root);
  if (step === 5 && !draft.result) step = 4;
  root.append(
    el("h3", { class: "section-sub" }, "Birth a Brain"),
    el("p", { class: "muted" }, "Five steps. Your prompt is hashed and encrypted here, in this tab; only the hash is minted — and a sealed brain can be up and trading before you leave the page."),
    stepper(),
    [step1, step2, step3, step4, step5][step - 1](root));
}
