// Venue-aware trade formatting.
//
// The guard emits the same TradeExecuted(tokenIn, tokenOut, amountIn,
// amountOut) for every venue; what those tokens *mean* depends on the venue
// kind. A swap venue trades one asset for another. A prediction market trades
// collateral for an outcome token that pays 1 or 0, so the natural reading is
// "bought N YES at 62¢ on <question>". The Polymarket adapter will register
// its markets here (config: venues + markets); until then every venue is a
// swap and the prediction path is exercised by the formatter tests only.
import { formatUnits } from "https://esm.sh/viem@2.21.19";
import { state } from "./chain.js";

const n = (v, max) => new Intl.NumberFormat(undefined, { maximumFractionDigits: max }).format(v);

export function venueKind(venueAddr) {
  const venues = (state.cfg && state.cfg.venues) || {};
  const v = venues[String(venueAddr).toLowerCase()] || venues[venueAddr];
  return (v && v.kind) || "swap";
}

export function venueLabel(venueAddr) {
  const venues = (state.cfg && state.cfg.venues) || {};
  const v = venues[String(venueAddr).toLowerCase()] || venues[venueAddr];
  return (v && v.label) || "venue";
}

/** Prediction-market metadata for an outcome token, if configured. */
export function marketFor(tokenAddr) {
  const markets = (state.cfg && state.cfg.markets) || {};
  return markets[String(tokenAddr).toLowerCase()] || markets[tokenAddr] || null;
}

/**
 * describe(trade) -> { text, side, detail }
 *   swap:        "Bought 0.25 mWETH for 500 mUSDC"
 *   prediction:  "Bought 1,400 YES at 36¢ · Will X happen by June?"
 */
export function describe(t, { usdcSym = "mUSDC" } = {}) {
  const kind = venueKind(t.venue);
  const inIsCash = new RegExp(usdcSym, "i").test(t.inSym);
  const amtIn = Number(formatUnits(t.amountIn, 18));
  const amtOut = Number(formatUnits(t.amountOut, 18));
  if (kind === "prediction") {
    const outcomeToken = inIsCash ? t.tokenOut : t.tokenIn;
    const m = marketFor(outcomeToken) || { question: "unknown market", outcome: inIsCash ? t.outSym : t.inSym };
    const shares = inIsCash ? amtOut : amtIn;
    const cash = inIsCash ? amtIn : amtOut;
    const price = shares > 0 ? cash / shares : 0;
    return {
      side: inIsCash ? "buy" : "sell",
      text: `${inIsCash ? "Bought" : "Sold"} ${n(shares, 0)} ${m.outcome} at ${n(price * 100, 0)}¢`,
      detail: m.question,
    };
  }
  const a = `${n(amtIn, amtIn >= 1000 ? 0 : amtIn >= 1 ? 2 : 4)} ${t.inSym}`;
  const b = `${n(amtOut, amtOut >= 1000 ? 0 : amtOut >= 1 ? 2 : 4)} ${t.outSym}`;
  return inIsCash
    ? { side: "buy", text: `Bought ${b} for ${a}`, detail: null }
    : { side: "sell", text: `Sold ${a} for ${b}`, detail: null };
}

/** Holdings line for a brain: swap tokens as balances, outcome tokens as positions. */
export function describeHolding(h) {
  const m = marketFor(h.token);
  if (m) return { text: `${n(Number(formatUnits(h.vaultBal, 18)), 0)} ${m.outcome}`, detail: m.question };
  return { text: `${n(Number(formatUnits(h.vaultBal, 18)), 4)} ${h.sym}`, detail: null };
}
