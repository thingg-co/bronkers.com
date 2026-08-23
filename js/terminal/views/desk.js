// My Desk: what you own, what you've deposited, and which bells are worth ringing.
import { formatUnits } from "https://esm.sh/viem@2.21.19";
import * as act from "../actions.js";
import { TIERS } from "../abi.js";
import { authoredEnvelope, canSeal, commit, downloadJson, sealedCredential, sealedEnvelope } from "../crypto.js";
import { state } from "../chain.js";
import { invalidate, loadBrain, loadFarmLedger, loadRoster, ringable } from "../data.js";
import { addrChip, amountField, append, badge, clear, el, emptyState, fmt, kv, modal, spinner, textField, tip, toast } from "../ui.js";

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
  fee: "What this brain pays its executor per trade, from whichever book it traded, to cover gas and model calls. Capped by the protocol, paid at most once per declared-cadence interval (trades are rate-limited on-chain), skipped when the book has no cash, paid only to an attested executor and only on trades above the dust floor. Raises take effect after the notice period; lowering is immediate.",
  train: "Revise the brain: a new generation with a new commitment (and, if you like, a new model). It trades the brain's own wallet first; the vault waits until it has sparred the camp's minimum and the notice period has passed. The old generation's trades stay attributed to it; the high-water mark carries over.",
  brief: "A coach's note. The enclave appends it to the current sealed prompt, seals the next generation, and returns only the commitment and the ciphertext; nobody reads the result, including you.",
  credential: "Your own inference key, sealed in this tab to the enclave key and published on-chain as ciphertext. The enclave opens it only to run this brain, and only while you own the brain: a sale retires it automatically, and you can revoke it here. Tokens billed to your key cost the enclave nothing, so the brain's account with it stops accruing model cost. The key never leaves this tab unencrypted.",
  credentialHost: "Where the enclave may send your key. Anthropic keys go to api.anthropic.com. A gateway key goes to the enclave's own gateway unless you name another host the enclave allows; an arbitrary endpoint is refused, because the sealed prompt would travel with the request.",
  account: "The enclave keeps an account per brain: the runtime fees it has received against what the brain's ticks cost it (model tokens, gas). Fees only arrive on trades, so a brain that holds more than it trades runs on credit; past the operator's grace it is paused until the owner raises the fee.",
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
  const idBadge = rt.kind === "none" ? null : rt.attested ? badge(rt.attestation === 2 ? "attested runtime · TDX quote" : "attested runtime · reviewed", "good") : rt.registered ? badge("registered runtime", "accent") : badge("operated", "muted");
  const feeField = amountField({ label: "Runtime fee per trade", value: formatUnits(brain.runtimeFee || 0n, 18), tip: TIPS.fee });
  const escrowField = amountField({ label: "Escrow rent (mUSDC)", value: "", tip: "Prepaid runtime fees, held by the guard. When the brain's traded book cannot cover a fee it is drawn from here instead — same caps, same attestation gate — so a thin book keeps its harvester. Withdraw any time; refunded to the owner if the brain is reaped." });
  const now = rt.now || Math.floor(Date.now() / 1000);
  const nextText = rt.nextDue ? (rt.nextDue > now ? `in about ${fmt.duration(rt.nextDue - now)}` : "due on the next pass") : "on the next pass";
  // the enclave's books for this brain, filled in once the endpoint answers
  const econ = el("div", { class: "runtime-econ" }, state.cfg.enclaveUrl && rt.kind === "enclave" ? el("p", { class: "muted small" }, "Reading the enclave's account for this brain…") : null);
  if (state.cfg.enclaveUrl && rt.kind === "enclave") {
    loadFarmLedger(brain.id).then((l) => {
      if (!l) { econ.replaceChildren(el("p", { class: "muted small" }, "The enclave endpoint did not answer; its account for this brain is not available right now.")); return; }
      if (!l.brain) { econ.replaceChildren(el("p", { class: "muted small" }, "The enclave has no account for this brain yet (it opens one on the first pass).")); return; }
      const d = Number(l.decimals); const a = l.brain; const B = (x) => fmt.amt(BigInt(x || 0), d, 4);
      const suggested = a.suggestedFee != null ? BigInt(a.suggestedFee) : null;
      clear(econ);
      append(econ, [
        el("h5", {}, "Account with the enclave ", tip(TIPS.account)),
        kv([
          ["Status", a.overBudget ? badge("paused: over budget", "bad") : badge(l.running ? "running" : "not running", l.running ? "good" : "muted")],
          l.backend ? ["Inference", `${l.backend}${l.ownerPaysInference ? " (billed to you; not charged by the enclave)" : ""}`] : null,
          ["Paid to the enclave", `${B(a.feesPaid)} mUSDC over ${a.feePayments} trade${a.feePayments === 1 ? "" : "s"}`],
          ["Cost to run", `${B(a.cost)} mUSDC · ${a.ticks} tick${a.ticks === 1 ? "" : "s"}, ${a.trades} trade${a.trades === 1 ? "" : "s"} (model ${B(a.inferenceCost)}, gas ${B(a.gasCost)})`],
          ["Credit left", `${B(a.credit)} mUSDC (the enclave extends ${B(l.grace)} of credit; raising the fee resets it)`],
          suggested != null ? ["Fee that would have covered it", `${B(suggested)} mUSDC per trade at this brain's trade rate so far`, "Total cost divided by trades made. A fee at or above this pays for the brain's holds as well as its trades."] : null,
        ]),
        suggested != null && suggested > (brain.runtimeFee || 0n) ? el("div", { class: "btn-row" }, el("button", { class: "btn tiny", onclick: () => { feeField.input.value = formatUnits(suggested, d); feeField.input.focus(); } }, "Use that fee")) : null,
      ]);
    });
  }
  // credentials: the owner's own inference key, sealed here, opened only in the enclave
  const cred = brain.credential;
  const credSelect = el("select", { class: "cred-provider" }, el("option", { value: "anthropic" }, "Anthropic API key"), el("option", { value: "gateway" }, "Inference gateway key (OpenAI-compatible)"));
  const credKey = textField({ label: "API key", type: "password", placeholder: "sk-…", mono: true, tip: TIPS.credential });
  const credUrl = textField({ label: "Gateway base URL (optional)", placeholder: "https://…/v1", mono: true, tip: TIPS.credentialHost });
  credUrl.el.style.display = "none";
  credSelect.addEventListener("change", () => { credUrl.el.style.display = credSelect.value === "gateway" ? "" : "none"; });
  const credStatus = !state.cfg.credentials ? el("span", { class: "muted" }, "no Credentials contract on this chain")
    : !cred || cred.version === 0 ? badge("none: the enclave pays for inference and charges the runtime fee", "muted")
    : cred.active ? badge(`your key · v${cred.version} · published ${fmt.when(cred.publishedAt)}`, "good")
    : cred.revoked ? badge(`revoked (v${cred.version})`, "muted")
    : badge("a previous owner's key: retired by the sale", "muted");
  const credPanel = state.cfg.credentials && sealed ? el("div", { class: "cred-panel" },
    el("h5", {}, "Your own inference key ", tip(TIPS.credential)),
    kv([["Inference credential", credStatus]]),
    el("div", { class: "inline-form" }, el("label", { class: "field" }, el("span", { class: "field-label" }, "Provider"), credSelect), credKey.el, credUrl.el,
      el("button", { class: "btn", onclick: async () => {
        try {
          const apiKey = credKey.value(); if (!apiKey || apiKey.length < 8) return toast("Paste the API key first.", "err");
          if (!state.cfg.enclavePublicKey) throw new Error("No enclave public key is configured for this chain (Developer tab).");
          if (!(await canSeal())) throw new Error("This browser cannot do X25519 in WebCrypto.");
          const provider = credSelect.value;
          const baseUrl = provider === "gateway" ? credUrl.value() : "";
          if (baseUrl && !/^https?:\/\//.test(baseUrl)) return toast("The gateway URL must start with https://", "err");
          const payload = { kind: "inference", provider, apiKey, ...(baseUrl ? { baseUrl } : {}) };
          const env = await sealedCredential(payload, { chainId: state.chainId, tokenId: brain.id }, state.cfg.enclavePublicKey);
          credKey.input.value = "";
          await run("Publish your inference key", act.publishCredential(brain.id, "inference", env), refresh,
            el("p", {}, "Sealed in this tab to the enclave key; only the ciphertext goes on-chain. The enclave switches this brain to your key on its next pass."));
        } catch (e) { toast(act.explain(e), "err"); }
      } }, cred && cred.active ? "Replace key" : "Seal and publish"),
      cred && cred.active ? el("button", { class: "btn", onclick: () => run("Revoke your inference key", act.revokeCredential(brain.id, "inference"), refresh) }, "Revoke") : null)) : null;

  const execField = textField({ label: "Executor key (advanced)", value: brain.policy.executor === ZERO ? "" : brain.policy.executor, placeholder: "0x…", mono: true, tip: TIPS.executor });
  const jarInput = el("input", { type: "file", accept: ".json,application/json", class: "jarfile", title: TIPS.jar });
  const runtimePanel = mk("Runtime",
    el("div", { class: "runtime-status" }, rtBadge, idBadge, rt.kind !== "none" ? el("span", { class: "muted" }, `last trade ${rt.lastTradeAt ? fmt.when(rt.lastTradeAt) : "never"} · next tick ${nextText}`) : el("span", { class: "muted" }, "nobody is running this brain")),
    kv([
      ["Executor", brain.policy.executor === ZERO ? badge("not set", "muted") : addrChip(brain.policy.executor, { explorer: ex })],
      ["Declared cadence", `${brain.genome.cadence}/day · the guard allows one trade every ${fmt.duration(brain.tradeInterval || rt.intervalSec)}`, "The declared cadence is enforced on-chain as a floor under your minimum interval; you can tighten it below, never loosen it."],
      brain.nextTradeAt && brain.nextTradeAt > now ? ["Next trade allowed", `in about ${fmt.duration(brain.nextTradeAt - now)}`] : null,
      ["Jar", sealed ? (brain.envelopePublished ? badge("published on-chain", "good") : badge("not published", "bad")) : "with you (authored custody — you run it)"],
      rt.measurement && rt.registered ? ["Runtime measurement", [el("span", { class: "mono small" }, `${rt.measurement.slice(0, 14)}…`), " ", el("span", { class: "muted small" }, rt.attested ? "approved by the protocol (self-reported, not hardware-attested)" : "self-reported, not yet approved")]] : null,
      ["Runtime fee", `${fmt.amt(brain.runtimeFee || 0n, 18, 4)} mUSDC per trade (cap ${fmt.amt(brain.maxRuntimeFee || 0n)}) · at most ${fmt.amt(brain.maxDailyRuntimeFee || 0n, 18, 4)} mUSDC a day${brain.feesGated ? " · paid only while the executor is attested" : ""}${brain.minFeeNotionalBps ? ` · no fee on trades under ${fmt.bps(brain.minFeeNotionalBps)} of NAV` : ""}`, TIPS.fee],
      brain.pendingRuntimeFee && brain.pendingRuntimeFee.effectiveAt && brain.pendingRuntimeFee.effectiveAt > now ? ["Fee raise scheduled", `${fmt.amt(brain.pendingRuntimeFee.fee, 18, 4)} mUSDC per trade, in effect in about ${fmt.duration(brain.pendingRuntimeFee.effectiveAt - now)}`] : null,
      brain.runtimeFeePayments ? ["Runtime fees paid", `${fmt.amt(brain.runtimeFeesPaid || 0n, 18, 4)} mUSDC over ${brain.runtimeFeePayments} trade${brain.runtimeFeePayments === 1 ? "" : "s"}`, "From the traded book to the executor, on-chain (RuntimeFeePaid events)."] : null,
      (brain.runtimeEscrow || 0n) > 0n ? ["Escrowed rent", `${fmt.amt(brain.runtimeEscrow, 18, 4)} mUSDC prepaid with the guard`, "The backstop for the runtime fee: drawn per trade only when the traded book cannot pay, withdrawable by the owner, refunded if the brain is reaped."] : null,
    ]),
    el("div", { class: "inline-form" }, feeField.el, el("button", { class: "btn", onclick: async () => { try { await run("Runtime fee", act.setRuntimeFee(brain.id, feeField.value()), refresh); } catch (e) { toast(act.explain(e), "err"); } } }, "Set fee")),
    el("div", { class: "inline-form" }, escrowField.el,
      el("button", { class: "btn", onclick: async () => { try { await run("Escrow rent", await act.fundRuntimeEscrow(brain, escrowField.value()), refresh); } catch (e) { toast(act.explain(e), "err"); } } }, "Escrow"),
      (brain.runtimeEscrow || 0n) > 0n ? el("button", { class: "btn", onclick: async () => { try { await run("Take rent back", act.withdrawRuntimeEscrow(brain, escrowField.value() || formatUnits(brain.runtimeEscrow, 18)), refresh); } catch (e) { toast(act.explain(e), "err"); } } }, "Withdraw") : null),
    brain.runtimeFeeDelay ? el("p", { class: "muted small" }, `A raise takes effect ${fmt.duration(brain.runtimeFeeDelay)} after you set it (depositors are told); lowering is immediate.`) : null,
    econ,
    credPanel,
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

  // training: the owner revises the brain between fights
  const custody = brain.genome.custody;
  const modelField = textField({ label: "Model for the next generation", value: brain.genome.model, tip: "Pinned per generation. Change it to move the brain to a newer model; the record shows which generation used which." });
  const briefField = textField({ label: "Coach's note (brief)", rows: 3, placeholder: "Hold longer. Size smaller after two losses in a row.", tip: TIPS.brief });
  const promptField = textField({ label: custody === 1 ? "New prompt (sealed in this tab)" : "New prompt (encrypted with a key you keep)", rows: 5, placeholder: "You are a patient momentum trader…", tip: TIPS.train });
  const tweaksField = textField({ label: "Tweaks (optional JSON)", placeholder: '{"style":"momentum"}', mono: true });
  const campLine = brain.inCamp
    ? `Generation ${brain.generation} is in camp: ${brain.camp.trades}/${brain.camp.minTrades} own-book trades${brain.camp.vaultFrom > now ? `, vault from ${fmt.duration(brain.camp.vaultFrom - now)} from now` : ""}. Keep the wallet funded so it can spar.`
    : `Generation ${brain.generation}${brain.generation ? " is out of camp and may trade the vault." : ": the genome it was born with."}`;
  const doRevise = async (commitment, envelope, cid) => {
    const steps = [...(envelope && custody !== 0 ? act.publishEnvelope(brain.id, envelope) : []), ...act.revise(brain.id, commitment, modelField.value() || brain.genome.model, cid)];
    await run("Revise the brain", steps, refresh, el("p", {}, `Generation ${brain.generation + 1}: committed before it trades; it spars on the own book first.`));
  };
  const trainPanel = mk("Training",
    el("p", { class: "muted" }, campLine),
    custody === 2
      ? el("div", {}, briefField.el, modelField.el, el("div", { class: "btn-row" }, el("button", { class: "btn primary", disabled: !state.cfg.enclaveUrl, title: state.cfg.enclaveUrl ? "" : "Needs the enclave endpoint (Developer tab)", onclick: async () => {
          try {
            const brief = briefField.value(); if (!brief) return toast("Write a coach's note first.", "err");
            const r = await act.trainWithEnclave(brain.id, brief);
            await doRevise(r.commitment, r.envelope, "onchain:EnvelopePublished");
          } catch (e) { toast(act.explain(e), "err"); }
        } }, "Train with the enclave")))
      : el("div", {}, promptField.el, el("details", { class: "adv" }, el("summary", {}, "Tweaks"), tweaksField.el), modelField.el, el("div", { class: "btn-row" }, el("button", { class: "btn primary", onclick: async () => {
          try {
            const prompt = promptField.value(); if (!prompt) return toast("Write the new prompt first.", "err");
            let tweaks = {}; if (tweaksField.value()) { try { tweaks = JSON.parse(tweaksField.value()); } catch { return toast("Tweaks must be valid JSON.", "err"); } }
            const genome = { prompt, tweaks }; const c = commit(genome); const short = c.slice(2, 10);
            if (custody === 1) {
              if (!(await canSeal())) throw new Error("This browser cannot do X25519 in WebCrypto.");
              const env = await sealedEnvelope(genome, state.cfg.enclavePublicKey);
              await doRevise(c, env, "onchain:EnvelopePublished");
            } else {
              const { envelope: env, keyHex } = await authoredEnvelope(genome);
              downloadJson(env, `brain-${short}.authored.json`);
              await new Promise((resolve) => { const m = modal({ title: "Your new genome key", body: el("div", {}, el("p", {}, el("strong", {}, "Copy this now."), " The new generation's jar opens only with it."), el("pre", { class: "keybox" }, el("code", {}, keyHex))), actions: [{ label: "Copy", onClick: async () => { try { await navigator.clipboard.writeText(keyHex); toast("Copied", "ok"); } catch {} } }, { label: "I have saved it", kind: "primary", onClick: () => { m.close(); resolve(); } }], onClose: resolve }); });
              await doRevise(c, null, `local:brain-${short}.authored.json`);
            }
          } catch (e) { toast(act.explain(e), "err"); }
        } }, custody === 1 ? "Seal and revise" : "Encrypt and revise"))));

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
  const toField = textField({ label: "Transfer to (sell them whole)", placeholder: "0x…", mono: true, hint: "Whatever is in the brain's wallet goes with it, escrowed rent included. Sweep, and withdraw the escrow, to sell just the legend.", tip: TIPS.transfer });
  const feesPanel = mk("Fees & sale",
    kv([["Fee shares in the jar", `${fmt.amt(brain.fees.feeShares, 18, 4)} shares ≈ ${fmt.usd(brain.fees.feeSharesValue)}`], ["Pending (unminted)", `${fmt.amt(brain.pending.mgmt + brain.pending.perf, 18, 4)} shares`], ["Marketplace", state.cfg.marketplace ? el("a", { href: state.cfg.marketplace.replace("{nft}", state.cfg.traderNFT).replace("{id}", String(brain.id)), target: "_blank", rel: "noopener" }, "list or view it") : el("span", { class: "muted" }, "the token has on-chain metadata (name, traits, jar image); any ERC-721 marketplace renders it — none is configured for this chain")]]),
    el("div", { class: "btn-row" },
      brain.fees.feeShares > 0n ? el("button", { class: "btn", onclick: () => run("Redeem fee shares", act.redeemFeeShares(brain), refresh) }, "Redeem fee shares to me") : null,
      ringable(brain) ? el("button", { class: "btn", onclick: () => run("Ring the bell", act.ring(brain), refresh) }, "🔔 Ring the bell") : null),
    el("div", { class: "inline-form" }, toField.el, el("button", { class: "btn danger", onclick: () => {
      const a = toField.value(); if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return toast("Enter an address.", "err");
      const m = modal({ title: "Transfer this brain?", body: el("p", {}, `${brain.label} and everything in its wallet (${fmt.amt(brain.tbaUsdc)} mUSDC and any holdings) will belong to ${fmt.addr(a)}. The track record goes with it. This cannot be undone.`),
        actions: [{ label: "Cancel" }, { label: "Transfer", kind: "danger", onClick: async () => { m.close(); await run("Transfer", act.transferBrain(brain, a), refresh); } }] });
    } }, "Transfer")));

  return el("section", { class: "desk-brain", id: `brain-${brain.id}` },
    el("header", { class: "brain-head compact" }, jar(brain), el("div", { class: "brain-title" },
      el("h3", {}, el("a", { href: `#/brain/${brain.id}` }, brain.label), " ", el("span", { class: "tier-chip" }, TIERS[brain.tier])),
      el("p", { class: "card-badges" }, statusBadge(brain), custodyBadge(brain)))),
    el("div", { class: "two-col" }, walletPanel, runtimePanel),
    el("div", { class: "two-col" }, seatPanel, depositorsPanel),
    trainPanel,
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
