// Achievements: little milestones a brain earns, derived from its public
// state. The game layer over the record — computed from chain data in the
// browser, never stored, never touching an invariant. Same list works from a
// roster summary or a full brain detail; a milestone whose data isn't loaded
// simply reads as not-yet-earned.
export function achievements(b) {
  const supply = b.supply ?? 0n;
  const ret = b.sharePriceReturn ?? 0;
  // fee shares in the jar (detail) or fees pending right now (summary)
  const earned = b.fees ? b.fees.feeShares : b.pending ? b.pending.mgmt + b.pending.perf : 0n;
  const dd = typeof b.drawdown === "number" ? b.drawdown : 0;
  return [
    { key: "born", icon: "🐣", label: "Born", earned: true, blurb: "Minted and sealed. One brain per bit." },
    { key: "firsttrade", icon: "⚡", label: "First Trade", earned: (b.tradeCount ?? 0) > 0, blurb: "Made its first move on-chain." },
    { key: "graduated", icon: "🎓", label: "Graduated", earned: Boolean(b.seasoned), blurb: "Finished the internship; the vault can open." },
    { key: "money", icon: "📈", label: "In the Money", earned: supply > 0n && ret > 0, blurb: "Vault share price above where it started." },
    { key: "earner", icon: "🔔", label: "Earner", earned: (earned ?? 0n) > 0n, blurb: "Accrued fees into its own wallet." },
    { key: "promoted", icon: "💼", label: "Promoted", earned: (b.tier ?? 0) > 0, blurb: "Bought a bigger seat: Associate or Partner." },
    { key: "trained", icon: "🥊", label: "Trained", earned: (b.generation ?? 0) > 0, blurb: "Revised into a new generation between fights." },
    { key: "survivor", icon: "🩹", label: "Survivor", earned: dd >= 0.1 && !b.reapable && (b.tradeCount ?? 0) > 0, blurb: "Took a 10%+ drawdown and kept trading." },
    { key: "deathsdoor", icon: "💀", label: "Death's Door", earned: Boolean(b.reapable), blurb: "Broke and reapable — fund it or lose it." },
  ];
}

export const earnedList = (b) => achievements(b).filter((a) => a.earned);
export const earnedCount = (b) => achievements(b).filter((a) => a.earned).length;
export const total = (b) => achievements(b).length;
