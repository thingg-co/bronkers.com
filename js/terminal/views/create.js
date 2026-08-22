// Birth a Brain: a five-step wizard. Plain words, sealed by default, and the
// secret never leaves the browser unencrypted.
import * as act from "../actions.js";
import { CUSTODY, RISK } from "../abi.js";
import { state } from "../chain.js";
import { authoredEnvelope, canSeal, commit, downloadJson, sealedEnvelope } from "../crypto.js";
import { invalidate } from "../data.js";
import { badge, clear, el, fmt, kv, modal, textField, toast } from "../ui.js";

const TEMPLATES = [
  { key: "momentum", label: "Momentum", prompt: "You are a patient momentum trader. You buy strength and sell weakness, never chase, and size every position small. You would rather miss a move than force one. Protect capital first." },
  { key: "meanrev", label: "Mean reversion", prompt: "You are a disciplined mean-reversion trader. You buy weakness and sell strength against a slow moving average, scale in gradually, and take profits early. You never add to a loser more than once." },
  { key: "contrarian", label: "Contrarian", prompt: "You are a contrarian. You fade crowded moves and consensus narratives, but only when price has already overshot. You hold cash most of the time and act rarely, with conviction." },
  { key: "conservative", label: "Capital preservation", prompt: "You are a capital-preservation trader. Your first job is to not lose money; your second job is to compound slowly. Trade only when the setup is obvious, size tiny, and hold cash otherwise." },
];

const draft = {
  name: "", prompt: "", tweaks: "", custody: 1, risk: 1, cadence: 4,
  markets: { weth: true, wbtc: true }, mgmtBps: 200, perfBps: 2000, model: "claude-sonnet-5",
};

let step = 1;

function stepper() {
  const names = ["Strategy", "Custody", "Traits", "Review", "Mint"];
  return el("ol", { class: "stepper" }, names.map((n, i) => el("li", { class: i + 1 === step ? "current" : i + 1 < step ? "done" : "" }, el("span", { class: "stepper-no" }, String(i + 1)), n)));
}

function nav(root, { back = true, next = "Next", onNext, disabled } = {}) {
  return el("div", { class: "btn-row wizard-nav" },
    back ? el("button", { class: "btn", onclick: () => { step--; render(root); } }, "Back") : el("span"),
    el("button", { class: "btn primary", disabled, onclick: async () => { if (!onNext || (await onNext()) !== false) { step++; render(root); } } }, next));
}

// ---- steps ----

function step1(root) {
  const name = textField({ label: "Name (optional, permanent, ≤ 32 bytes)", value: draft.name, placeholder: "Umbra" });
  const prompt = textField({ label: "The strategy prompt — this is the secret", value: draft.prompt, rows: 7, placeholder: "You are a patient momentum trader…", hint: "This text is hashed and encrypted in your browser. Only the hash goes on-chain." });
  const tmpl = el("div", { class: "chips" }, TEMPLATES.map((t) => el("button", { type: "button", class: "chip", onclick: () => { prompt.input.value = t.prompt; } }, t.label)));
  const tweaks = textField({ label: "Tweaks (optional JSON, also secret)", value: draft.tweaks, placeholder: '{"style":"momentum"}', mono: true, hint: "Anything structured you want the brain to carry: style, universe hints, risk notes." });
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
    { v: 1, title: "Sealed (recommended)", body: "Encrypted to the enclave's key before it leaves this page. No owner, now or later, can read it. You know it because you wrote it; a buyer never will.", ok: enclaveOk, why: enclaveOk ? null : "Needs the enclave public key for this chain (Developer tab)." },
    { v: 0, title: "Authored", body: "Encrypted with a key you keep. You hand the key to a buyer on sale, and every past owner keeps a copy. Simplest; leaks on resale.", ok: true },
    { v: 2, title: "Sealed & generated", body: "You write a brief; the enclave composes the prompt and seals it. No human ever reads it. The enclave has to do the writing, so this runs from the CLI today.", ok: false, why: "CLI only for now: agent → npm run genome -- generate \"<brief>\"." },
  ];
  const list = el("div", { class: "choice-list" }, opts.map((o) => el("label", { class: `choice ${o.ok ? "" : "disabled"} ${draft.custody === o.v ? "selected" : ""}` },
    el("input", { type: "radio", name: "custody", value: o.v, checked: draft.custody === o.v, disabled: !o.ok, onchange: () => { draft.custody = o.v; render(root); } }),
    el("span", { class: "choice-body" }, el("strong", {}, o.title), el("span", {}, o.body), o.why ? el("span", { class: "muted small" }, o.why) : null))));
  return el("div", {},
    el("p", { class: "muted" }, "Custody is a public trait. It tells a buyer what they are actually buying."),
    list,
    nav(root, { onNext: () => { if (draft.custody === 2) { toast("Sealed & generated is CLI-only for now.", "err"); return false; } } }));
}

function step3(root) {
  const risk = el("select", { class: "select", onchange: (e) => { draft.risk = Number(e.target.value); } }, RISK.map((r, i) => el("option", { value: i, selected: draft.risk === i }, r)));
  const cadence = el("input", { type: "number", min: 1, max: 255, value: draft.cadence, onchange: (e) => { draft.cadence = Math.max(1, Math.min(255, Number(e.target.value) || 1)); } });
  const mk = (key, label) => el("label", { class: "check" }, el("input", { type: "checkbox", checked: draft.markets[key], onchange: (e) => { draft.markets[key] = e.target.checked; } }), ` ${label}`);
  const mgmt = el("input", { type: "range", min: 0, max: 500, step: 25, value: draft.mgmtBps, oninput: (e) => { draft.mgmtBps = Number(e.target.value); mgmtOut.textContent = fmt.bps(draft.mgmtBps); } });
  const mgmtOut = el("output", {}, fmt.bps(draft.mgmtBps));
  const perf = el("input", { type: "range", min: 0, max: 3000, step: 100, value: draft.perfBps, oninput: (e) => { draft.perfBps = Number(e.target.value); perfOut.textContent = fmt.bps(draft.perfBps); } });
  const perfOut = el("output", {}, fmt.bps(draft.perfBps));
  return el("div", {},
    el("p", { class: "muted" }, "Public traits. They go on-chain in the clear and can be filtered on in any marketplace."),
    el("div", { class: "two-col" },
      el("div", {},
        el("label", { class: "field" }, el("span", { class: "field-label" }, "Risk profile"), risk),
        el("label", { class: "field" }, el("span", { class: "field-label" }, "Declared cadence (trades per day)"), cadence),
        el("div", { class: "field" }, el("span", { class: "field-label" }, "Markets (protocol-curated; you can only narrow)"), mk("weth", "mWETH / mUSDC"), mk("wbtc", "mWBTC / mUSDC"))),
      el("div", {},
        el("label", { class: "field" }, el("span", { class: "field-label" }, "Management fee (per year) ", mgmtOut), mgmt),
        el("label", { class: "field" }, el("span", { class: "field-label" }, "Performance fee (above high-water mark) ", perfOut), perf),
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
  const c = commit(genomeObj());
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
      ])),
      el("div", { class: "panel" }, el("h4", {}, "Stays with you (secret)"), kv([
        ["Prompt", `${draft.prompt.length} characters`],
        ["Tweaks", draft.tweaks ? "yes" : "none"],
        ["Encrypted jar", draft.custody === 1 ? "sealed to the enclave; downloads to your machine" : "encrypted with a key you keep; both download to your machine"],
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
    if (draft.custody === 1) {
      if (!(await canSeal())) throw new Error("This browser cannot do X25519 in WebCrypto; use Authored custody or the CLI.");
      const env = await sealedEnvelope(genome, state.cfg.enclavePublicKey);
      downloadJson(env, `brain-${short}.sealed.json`);
      cid = `local:brain-${short}.sealed.json`;
    } else {
      const { envelope, keyHex: k } = await authoredEnvelope(genome);
      keyHex = k;
      downloadJson(envelope, `brain-${short}.authored.json`);
      cid = `local:brain-${short}.authored.json`;
    }
    let tokenId = null;
    const steps = [{ label: "Mint the brain (commitment + traits on-chain)", run: async () => {
      tokenId = await act.mintBrain({ commitment, risk: draft.risk, cadence: draft.cadence, custody: draft.custody, model: draft.model, cid, universe: universe(), mgmtBps: draft.mgmtBps, perfBps: draft.perfBps });
      return { transactionHash: null };
    } }];
    if (draft.name) steps.push({ label: `Name it “${draft.name}”`, run: async () => act.christen(tokenId, draft.name)[0].run() });
    const ok = await act.runSteps("Birth a brain", steps, { summary: el("p", {}, "Your encrypted jar has downloaded. Keep it: the runtime needs it to think.") });
    if (!ok) return false;
    invalidate();
    draft.result = { tokenId, keyHex, cid, commitment };
    if (keyHex) {
      await new Promise((resolve) => {
        const m = modal({ title: "Your genome key", body: el("div", {},
          el("p", {}, el("strong", {}, "Copy this now.") ," It is not stored anywhere. Without it, nobody can ever open the jar — including you."),
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
  return el("div", {},
    el("div", { class: "panel born" },
      el("h3", {}, id ? `Brain #${id} is born.` : "Minted."), draft.name ? el("p", {}, `Its name is ${draft.name}.`) : null,
      el("p", { class: "muted" }, "Commitment ", el("span", { class: "mono small" }, r.commitment || ""))),
    el("h4", {}, "Next: the internship"),
    el("ol", { class: "next-steps" },
      el("li", {}, el("strong", {}, "Fund its wallet."), " A new brain trades its own money first. Send it some mUSDC from My Desk."),
      el("li", {}, el("strong", {}, "Authorise the guard."), " One click in My Desk lets the guard move the brain's own wallet through curated venues, and nowhere else."),
      el("li", {}, el("strong", {}, "Set an executor key."), " The runtime signs with it; it can only call executeTrade. Rotate it any time."),
      el("li", {}, el("strong", {}, "Run the runtime"), " with the jar you just downloaded (command in the Developer tab). Once it has finished its paper season, the vault opens to depositors.")),
    el("div", { class: "btn-row" },
      id ? el("a", { class: "btn primary", href: `#/desk/${id}` }, "Open My Desk") : null,
      id ? el("a", { class: "btn", href: `#/brain/${id}` }, "See its page") : null,
      el("button", { class: "btn", onclick: () => { step = 1; Object.assign(draft, { name: "", prompt: "", tweaks: "", result: null }); render(root); } }, "Birth another")));
}

export async function render(root) {
  clear(root);
  if (step === 5 && !draft.result) step = 4;
  root.append(
    el("h3", { class: "section-sub" }, "Birth a Brain"),
    el("p", { class: "muted" }, "Five steps. Your prompt is hashed and encrypted here, in this tab; only the hash is minted."),
    stepper(),
    [step1, step2, step3, step4, step5][step - 1](root));
}
