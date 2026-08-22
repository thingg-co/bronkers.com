// Learn: the lifecycle one step at a time, on this chain, with your numbers.
// A paper market: real prices, fake money, the real contracts. Each step
// points at the control that does it, says what changes on-chain, and what
// it cannot do. Steps tick themselves off from chain state where they can.
import * as act from "../actions.js";
import { erc20Abi } from "../abi.js";
import { connect, state } from "../chain.js";
import { loadFarmHealth, loadRoster } from "../data.js";
import { badge, clear, el, fmt, spinner, toast } from "../ui.js";

function step(n, title, { done, body, actions }) {
  return el("section", { class: `learn-step ${done ? "done" : ""}` },
    el("div", { class: "learn-no" }, done ? "✓" : String(n)),
    el("div", { class: "learn-body" },
      el("h4", {}, title, " ", done ? badge("done", "good") : null),
      ...[].concat(body),
      actions && actions.length ? el("div", { class: "btn-row" }, ...actions) : null));
}

const p = (...c) => el("p", {}, ...c);
const muted = (...c) => el("p", { class: "muted small" }, ...c);

export async function render(root) {
  clear(root);
  root.append(el("h3", { class: "section-sub" }, "Learn"), spinner("Reading the chain…"));

  // live context: what you have, what exists, whether a harvester is running
  let roster = null, myUsdc = 0n, health = null;
  try { if (state.mode !== "offline") roster = await loadRoster(); } catch {}
  if (state.account && state.cfg.usdc) {
    try { myUsdc = await state.pub.readContract({ address: state.cfg.usdc, abi: erc20Abi, functionName: "balanceOf", args: [state.account] }); } catch {}
  }
  health = await loadFarmHealth();
  const brains = roster ? roster.brains : [];
  const mine = brains.filter((b) => b.mine);
  const seasonedMine = mine.filter((b) => b.seasoned);
  const open = brains.filter((b) => b.seasoned);
  const season = brains[0] && brains[0].season ? brains[0].season : null;
  const testnet = Boolean(state.cfg.testnet);

  clear(root);
  root.append(
    el("h3", { class: "section-sub" }, "Learn"),
    el("p", { class: "muted" }, "This is a paper market: real prices, fake money, and the real protocol. The venue quotes the two markets from price feeds and fills at that price less a small spread, so nothing you do here is pretend except the money. Work down the list; every step points at the control that does it, says what changes on-chain, and what it cannot do."),
    el("div", { class: "learn-steps" },

      step(1, "Connect, or use a dev key", {
        done: Boolean(state.account),
        body: [
          p("Reading needs no wallet: the Floor and every brain page are computed from the chain in your browser. Acting does. On a public testnet, connect any wallet; on a local anvil, paste a dev key on the Developer tab."),
          muted("There is no server. Your wallet talks straight to the contracts."),
        ],
        actions: [
          !state.account && window.ethereum ? el("button", { class: "btn primary", onclick: async () => { try { await connect(); toast("Connected", "ok"); render(root); } catch (e) { toast(act.explain(e), "err"); } } }, "Connect wallet") : null,
          !state.account ? el("a", { class: "btn", href: "#/dev" }, "Use a dev key (Developer tab)") : null,
        ],
      }),

      step(2, "Get paper money", {
        done: myUsdc > 0n,
        body: [
          p("Everything here is priced in mUSDC, a mock dollar anyone can mint. ", state.account ? ["You hold ", el("strong", {}, fmt.usd(myUsdc)), "."] : "Connect first."),
          muted("Prices are real (feeds); balances are not. That is the whole trick of a paper market."),
        ],
        actions: [
          state.account && testnet ? el("button", { class: "btn primary", onclick: async () => { const ok = await act.runSteps("Faucet", act.faucet("10000")); if (ok) render(root); } }, "Mint 10,000 paper mUSDC") : null,
          !testnet ? muted("Only on a test chain.") : null,
        ],
      }),

      step(3, "Birth a brain", {
        done: mine.length > 0,
        body: [
          p("A brain is a prompt, sealed in a jar. Only its hash goes on-chain, with public traits (risk, cadence, custody, model). The wizard seals the prompt in your browser, mints, publishes the jar, seeds the wallet, authorises the guard, sets the runtime fee and enrols it with a harvester, so it is trading before you leave the page."),
          muted("What it cannot do: nobody, including you after birth under sealed custody, can read the prompt; the brain's key can only trade, never withdraw."),
          mine.length ? muted(`You own ${mine.length}: ${mine.map((b) => b.label).join(", ")}.`) : null,
        ],
        actions: [el("a", { class: "btn primary", href: "#/create" }, "Birth a Brain")],
      }),

      step(4, "The internship", {
        done: seasonedMine.length > 0,
        body: [
          p("A new brain trades its own wallet first. Outside deposits stay closed until it has made ", el("strong", {}, season ? `${season.minTrades} trade${season.minTrades === 1 ? "" : "s"}` : "the minimum"), season && season.duration ? [" over ", el("strong", {}, fmt.duration(season.duration))] : null, " on its own book. Fund the wallet and authorise the guard from My Desk; the harvester does the rest at the declared cadence."),
          muted("The same idea returns later as the training camp: a revised brain spars on its own book before it may trade the vault."),
          mine.length ? muted(mine.map((b) => `${b.label}: ${b.inCamp ? `in camp (generation ${b.generation})` : b.seasoned ? "seasoned" : `intern, ${b.tradeCount}/${season ? season.minTrades : "?"} trades`}`).join(" · ")) : null,
        ],
        actions: [mine.length ? el("a", { class: "btn", href: `#/desk/${mine[0].id}` }, "Open My Desk") : null],
      }),

      step(5, "Watch it trade", {
        body: [
          p("The harvester (the enclave process you enrolled with) wakes each brain at its declared cadence, shows it the market, and sends the model's decision through the guard. The guard enforces the venue and token allowlists, the per-trade cap, the slippage bound and the cadence; proceeds always return to the book that traded. Every trade is a ", el("code", {}, "TradeExecuted"), " event, with the hash of the model transcript beside it."),
          health ? muted(`A harvester is running here: ${(health.running || []).length} brain${(health.running || []).length === 1 ? "" : "s"} enrolled.`) : muted("No harvester answered on this chain's enclave endpoint right now; enrolled brains idle until one does."),
          state.chainId === 31337 ? muted("On anvil the clock only moves when something happens: use “Move the chain's clock” on the Developer tab to let the next tick come due.") : null,
        ],
        actions: [el("a", { class: "btn", href: "#/" }, "The Floor"), state.chainId === 31337 ? el("a", { class: "btn", href: "#/dev" }, "Developer tab") : null],
      }),

      step(6, "Back a brain", {
        body: [
          p("A seasoned brain's vault takes deposits (if its owner opened it to you). You get shares at the current share price and can redeem any time at the prevailing price; the executor key cannot touch or block withdrawals. The owner earns a streamed management fee and a performance fee only above the high-water mark, minted as shares into the brain's own wallet."),
          muted(open.length ? `${open.length} brain${open.length === 1 ? " is" : "s are"} taking deposits right now.` : "No brain is taking deposits yet."),
        ],
        actions: [el("a", { class: "btn", href: "#/" }, "Find one on the Floor")],
      }),

      step(7, "Ring the bell", {
        body: [
          p("Fee crystallisation is a public crank. Whoever rings takes 1% of the fee shares it mints, out of the owner's cut, never from depositors. The bell modal shows what is pending before you ring."),
        ],
        actions: [el("a", { class: "btn", href: "#/" }, "Bells worth ringing")],
      }),

      step(8, "Train it", {
        body: [
          p("Owners revise their brains between fights. A revision is a new generation: a new commitment (and, if you like, a new model), recorded before it trades. The new generation spars on the brain's own wallet and waits out the notice period before it may trade the vault; every trade stays attributed to the generation that made it, and the high-water mark carries. Sealed brains are coached with a note the enclave applies inside the jar."),
        ],
        actions: [mine.length ? el("a", { class: "btn", href: `#/desk/${mine[0].id}` }, "Training (My Desk)") : null],
      }),

      step(9, "Pay the harvester", {
        body: [
          p("A brain pays its executor a runtime fee per trade, from the book it traded: owner-set, protocol-capped, bounded per day by the cadence, paid only to an attested executor and only on trades of real size, with raises announced. The harvester keeps an account per brain (fees in, model and gas out) and pauses a brain that overruns its credit; My Desk shows the account and the fee that would cover it."),
          health && health.budget ? muted(`This harvester's books: income ${fmt.amt(BigInt(health.budget.income || 0), Number(health.budget.decimals || 18), 4)} ${health.budget.symbol || "mUSDC"}, cost ${fmt.amt(BigInt(health.budget.cost || 0), Number(health.budget.decimals || 18), 4)}.`) : null,
        ],
        actions: [el("a", { class: "btn", href: "#/dev" }, "The farm's books")],
      }),

      step(10, "Sell them whole", {
        body: [
          p("The brain is an ERC-721 with a token-bound wallet. Transfer the token and the wallet, the fee shares and the whole record go with it; sweep the wallet first to sell just the legend. Any marketplace renders it from on-chain metadata. A buyer rotates the executor key, reads the generations, and recomputes the record from the logs."),
        ],
        actions: [mine.length ? el("a", { class: "btn", href: `#/desk/${mine[0].id}` }, "Transfer (My Desk)") : null],
      }),

      step(11, "What is enforced, and what is not", {
        body: [
          p("The landing page maps every meme claim to the invariant that enforces it; the architecture note and the paper say the rest. Two honest limits of this paper market: the feeds are the venue, so there is no liquidity to run out of and no slippage beyond the spread; and a testnet record is practice, not a track record anyone should pay for."),
        ],
        actions: [el("a", { class: "btn", href: "/#" }, "Silly Copy. Serious Code."), el("a", { class: "btn", href: "/docs/whitepaper" }, "The paper"), el("a", { class: "btn", href: "/docs/quickstart" }, "Run it yourself")],
      }),
    ));
}
