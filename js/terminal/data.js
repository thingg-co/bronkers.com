// Read side. Everything the Terminal shows is computed here from public
// chain state and logs — no indexer. Anyone can recompute these numbers.
import { formatUnits } from "https://esm.sh/viem@2.21.19";
import { erc20Abi, guardAbi, nftAbi, registryAbi, vaultAbi } from "./abi.js";
import { state } from "./chain.js";

const WAD = 10n ** 18n;
const cache = { roster: null, brains: new Map(), symbols: new Map(), blocks: new Map(), season: null };

export function invalidate(id) {
  cache.roster = null;
  if (id == null) cache.brains.clear();
  else cache.brains.delete(Number(id));
}

// The guard's clock is the chain's, not the browser's (on anvil they drift
// apart as soon as the clock is moved), so anything compared with an on-chain
// timestamp uses this.
let chainTime = { at: 0, ts: 0 };
export async function chainNow() {
  if (Date.now() - chainTime.at < 15_000) return chainTime.ts;
  try {
    const b = await state.pub.getBlock();
    chainTime = { at: Date.now(), ts: Number(b.timestamp) };
    return chainTime.ts;
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}

const read = (address, abi, functionName, args = [], opts = {}) =>
  state.pub.readContract({ address, abi, functionName, args, ...opts });

// small concurrency limiter so public RPCs don't rate-limit us
function limiter(n) {
  let active = 0;
  const q = [];
  const next = () => {
    if (active >= n || !q.length) return;
    active++;
    const { fn, res, rej } = q.shift();
    fn().then(res, rej).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((res, rej) => {
    q.push({ fn, res, rej });
    next();
  });
}
const limit = limiter(8);

export async function tokenSymbol(addr) {
  if (!addr) return "?";
  const a = addr.toLowerCase();
  if (cache.symbols.has(a)) return cache.symbols.get(a);
  const cfg = state.cfg || {};
  const known = { [String(cfg.usdc).toLowerCase()]: "mUSDC", [String(cfg.weth).toLowerCase()]: "mWETH", [String(cfg.wbtc).toLowerCase()]: "mWBTC" };
  let sym = known[a];
  if (!sym) {
    try {
      sym = await read(addr, erc20Abi, "symbol");
    } catch {
      sym = addr.slice(0, 6);
    }
  }
  cache.symbols.set(a, sym);
  return sym;
}

export async function seasonParams() {
  if (cache.season) return cache.season;
  const [minTrades, duration] = await Promise.all([
    read(state.cfg.guard, guardAbi, "seasonMinTrades"),
    read(state.cfg.guard, guardAbi, "seasonDuration"),
  ]);
  cache.season = { minTrades: Number(minTrades), duration: Number(duration) };
  return cache.season;
}

/** One brain's headline numbers (what a roster card needs). */
export async function summary(id) {
  id = BigInt(id);
  const { traderNFT, guard } = state.cfg;
  const [genome, owner, name, vault, tba, tier, seasoned, tradeCount, firstTradeAt, camp] = await Promise.all([
    read(traderNFT, nftAbi, "genomeOf", [id]),
    read(traderNFT, nftAbi, "ownerOf", [id]),
    read(traderNFT, nftAbi, "nameOf", [id]),
    read(traderNFT, nftAbi, "vaultOf", [id]),
    read(traderNFT, nftAbi, "accountOf", [id]),
    read(guard, guardAbi, "tierOf", [id]),
    read(guard, guardAbi, "seasoned", [id]),
    read(guard, guardAbi, "tradeCountOf", [id]),
    read(guard, guardAbi, "firstTradeAt", [id]),
    read(guard, guardAbi, "campStatus", [id]).catch(() => [0, false, 0, 0, 0n]),
  ]);
  const me = state.account;
  const [nav, supply, pps, tbaNav, pending, myShares] = await Promise.all([
    read(vault, vaultAbi, "totalAssets"),
    read(vault, vaultAbi, "totalSupply"),
    read(vault, vaultAbi, "convertToAssets", [WAD]),
    read(guard, guardAbi, "tbaNav", [id]),
    read(vault, vaultAbi, "pendingFees"),
    me ? read(vault, vaultAbi, "balanceOf", [me]) : Promise.resolve(0n),
  ]);
  const season = await seasonParams();
  return {
    id: Number(id),
    name,
    label: name || `Brain #${id}`,
    genome,
    owner,
    vault,
    tba,
    tier: Number(tier),
    seasoned,
    tradeCount: Number(tradeCount),
    firstTradeAt: Number(firstTradeAt),
    season,
    // generations: the current one, and whether it is still sparring on the own book
    generation: Number(camp[0]),
    inCamp: Boolean(camp[1]),
    camp: { trades: Number(camp[2]), minTrades: Number(camp[3]), vaultFrom: Number(camp[4]) },
    nav,
    supply,
    pps, // assets per 1e18 shares
    sharePriceReturn: Number(pps - WAD) / 1e18,
    tbaNav,
    pending: { mgmt: pending[0], perf: pending[1], reward: pending[2] },
    myShares,
    mine: Boolean(me && owner.toLowerCase() === me.toLowerCase()),
  };
}

export async function loadRoster({ force } = {}) {
  if (cache.roster && !force) return cache.roster;
  const { traderNFT } = state.cfg;
  const [nextId, maxSupply] = await Promise.all([
    read(traderNFT, nftAbi, "nextId"),
    read(traderNFT, nftAbi, "MAX_SUPPLY"),
  ]);
  const ids = [];
  for (let i = 1n; i <= nextId; i++) ids.push(i);
  const brains = await Promise.all(ids.map((i) => limit(() => summary(i))));
  cache.roster = { count: Number(nextId), max: Number(maxSupply), brains };
  return cache.roster;
}

async function blockTs(n) {
  n = BigInt(n);
  if (cache.blocks.has(n)) return cache.blocks.get(n);
  const b = await state.pub.getBlock({ blockNumber: n });
  const ts = Number(b.timestamp);
  cache.blocks.set(n, ts);
  return ts;
}

export async function loadTrades(id, fromBlock) {
  const logs = await state.pub.getContractEvents({
    address: state.cfg.guard,
    abi: guardAbi,
    eventName: "TradeExecuted",
    args: { tokenId: BigInt(id) },
    fromBlock: BigInt(fromBlock || 0),
    toBlock: "latest",
  });
  const trades = [];
  for (const l of logs) {
    const [inSym, outSym, ts] = await Promise.all([
      tokenSymbol(l.args.tokenIn),
      tokenSymbol(l.args.tokenOut),
      limit(() => blockTs(l.blockNumber)),
    ]);
    trades.push({
      block: Number(l.blockNumber),
      ts,
      hash: l.transactionHash,
      tokenIn: l.args.tokenIn,
      tokenOut: l.args.tokenOut,
      inSym,
      outSym,
      amountIn: l.args.amountIn,
      amountOut: l.args.amountOut,
      fromVault: l.args.fromVault,
      venue: l.args.venue,
    });
  }
  return trades;
}

/** Share price and NAV at each trade block (archive reads; best effort). */
export async function navSeries(brain, trades) {
  const blocks = [...new Set(trades.map((t) => t.block))].slice(-60);
  const points = [];
  for (const b of blocks) {
    try {
      const [pps, nav, own] = await Promise.all([
        read(brain.vault, vaultAbi, "convertToAssets", [WAD], { blockNumber: BigInt(b) }),
        read(brain.vault, vaultAbi, "totalAssets", [], { blockNumber: BigInt(b) }),
        read(state.cfg.guard, guardAbi, "tbaNav", [BigInt(brain.id)], { blockNumber: BigInt(b) }),
      ]);
      points.push({ block: b, ts: await blockTs(b), pps, nav, own });
    } catch {
      // non-archive RPC; skip historical point
    }
  }
  const nowBlock = Number(await state.pub.getBlockNumber());
  points.push({ block: nowBlock, ts: Math.floor(Date.now() / 1000), pps: brain.pps, nav: brain.nav, own: brain.tbaNav });
  return points;
}

export function maxDrawdown(values) {
  let peak = -Infinity;
  let dd = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) dd = Math.max(dd, (peak - v) / peak);
  }
  return dd;
}

/** Everything the detail page needs. */
export async function loadBrain(id, { force } = {}) {
  id = Number(id);
  if (cache.brains.has(id) && !force) return cache.brains.get(id);
  const b = await summary(id);
  const { guard, usdc } = state.cfg;
  const me = state.account;
  const [policy, mgmtBps, perfBps, hwm, lastCheckpoint, allowlistEnabled, depositAllowed, universe, feeShares, tbaUsdc, tbaAllowance, myAssets, myUsdc, myAllowance, vaultUsdc] =
    await Promise.all([
      read(guard, guardAbi, "policyOf", [BigInt(id)]),
      read(b.vault, vaultAbi, "managementFeeBps"),
      read(b.vault, vaultAbi, "performanceFeeBps"),
      read(b.vault, vaultAbi, "highWaterMark"),
      read(b.vault, vaultAbi, "lastCheckpoint"),
      read(b.vault, vaultAbi, "allowlistEnabled"),
      me ? read(b.vault, vaultAbi, "depositAllowed", [me]) : Promise.resolve(false),
      read(b.vault, vaultAbi, "universe"),
      read(b.vault, vaultAbi, "balanceOf", [b.tba]),
      read(usdc, erc20Abi, "balanceOf", [b.tba]),
      read(usdc, erc20Abi, "allowance", [b.tba, guard]),
      me ? read(b.vault, vaultAbi, "convertToAssets", [b.myShares]) : Promise.resolve(0n),
      me ? read(usdc, erc20Abi, "balanceOf", [me]) : Promise.resolve(0n),
      me ? read(usdc, erc20Abi, "allowance", [me, b.vault]) : Promise.resolve(0n),
      read(usdc, erc20Abi, "balanceOf", [b.vault]),
    ]);
  const holdings = await Promise.all(
    universe.map(async (t) => {
      const [sym, vaultBal, tbaBal] = await Promise.all([
        tokenSymbol(t),
        read(t, erc20Abi, "balanceOf", [b.vault]),
        read(t, erc20Abi, "balanceOf", [b.tba]),
      ]);
      return { token: t, sym, vaultBal, tbaBal };
    }),
  );
  const [feeSharesValue, trades, envelopeLogs, runtimeFee, maxRuntimeFee, tokenURI, tradeInterval, nextTradeAt, feeLogs, now, pendingFee, feeDelay, minFeeNotionalBps, feeRegistry, transcriptLogs] = await Promise.all([
    read(b.vault, vaultAbi, "convertToAssets", [feeShares]),
    loadTrades(id, b.genome.birthBlock),
    state.pub.getContractEvents({ address: state.cfg.traderNFT, abi: nftAbi, eventName: "EnvelopePublished", args: { tokenId: BigInt(id) }, fromBlock: BigInt(b.genome.birthBlock || 0), toBlock: "latest" }).catch(() => []),
    read(guard, guardAbi, "runtimeFeeOf", [BigInt(id)]).catch(() => 0n),
    read(guard, guardAbi, "maxRuntimeFee").catch(() => 0n),
    read(state.cfg.traderNFT, nftAbi, "tokenURI", [BigInt(id)]).catch(() => ""),
    read(guard, guardAbi, "tradeIntervalOf", [BigInt(id)]).catch(() => 0n),
    read(guard, guardAbi, "nextTradeAt", [BigInt(id)]).catch(() => 0n),
    // the runtime fee is a fund expense; it is in the record like any other
    state.pub.getContractEvents({ address: guard, abi: guardAbi, eventName: "RuntimeFeePaid", args: { tokenId: BigInt(id) }, fromBlock: BigInt(b.genome.birthBlock || 0), toBlock: "latest" }).catch(() => []),
    chainNow(),
    read(guard, guardAbi, "pendingRuntimeFeeOf", [BigInt(id)]).catch(() => [0n, 0n]),
    read(guard, guardAbi, "runtimeFeeDelay").catch(() => 0n),
    read(guard, guardAbi, "minFeeNotionalBps").catch(() => 0),
    read(guard, guardAbi, "registry").catch(() => "0x0000000000000000000000000000000000000000"),
    // the hash of the inference transcript behind each trade, when the runtime committed one
    state.pub.getContractEvents({ address: guard, abi: guardAbi, eventName: "TranscriptCommitted", args: { tokenId: BigInt(id) }, fromBlock: BigInt(b.genome.birthBlock || 0), toBlock: "latest" }).catch(() => []),
  ]);
  const transcriptByTx = new Map(transcriptLogs.map((l) => [l.transactionHash, l.args.transcript]));
  for (const t of trades) t.transcript = transcriptByTx.get(t.hash) || null;
  // generations: every trade belongs to the generation that was current at its block
  const revisionLogs = await state.pub.getContractEvents({ address: state.cfg.traderNFT, abi: nftAbi, eventName: "GenomeRevised", args: { tokenId: BigInt(id) }, fromBlock: BigInt(b.genome.birthBlock || 0), toBlock: "latest" }).catch(() => []);
  const revisions = revisionLogs.map((l) => ({ generation: Number(l.args.generation), commitment: l.args.commitment, model: l.args.model, block: Number(l.blockNumber), hash: l.transactionHash }));
  for (const t of trades) {
    let gen = 0;
    for (const r of revisions) if (t.block >= r.block) gen = r.generation;
    t.generation = gen;
  }
  const runtime = runtimeStatus(policy[0], Number(policy[4]), b, now, Number(tradeInterval));
  if (state.cfg.registry && runtime.kind !== "none") {
    try {
      const [[measurement, enclavePublicKey, registeredAt], attested, attestation] = await Promise.all([
        read(state.cfg.registry, registryAbi, "runtimeOf", [policy[0]]),
        read(state.cfg.registry, registryAbi, "attested", [policy[0]]),
        read(state.cfg.registry, registryAbi, "attestationOf", [policy[0]]).catch(() => 0),
      ]);
      runtime.registered = Number(registeredAt) > 0;
      runtime.measurement = measurement;
      runtime.attested = Boolean(attested);
      runtime.attestation = Number(attestation); // 0 none, 1 self-reported, 2 hardware (TDX quote verified on-chain)
    } catch {}
  }
  let token = null;
  if (tokenURI && tokenURI.startsWith("data:application/json;base64,")) {
    try { token = JSON.parse(atob(tokenURI.split(",")[1])); } catch {}
  }
  const series = await navSeries(b, trades);
  const brain = {
    ...b,
    policy: {
      executor: policy[0],
      maxNotionalBps: Number(policy[1]),
      maxSlippageBps: Number(policy[2]),
      minTradeInterval: Number(policy[3]),
      lastTradeAt: Number(policy[4]),
    },
    fees: { mgmtBps: Number(mgmtBps), perfBps: Number(perfBps), hwm, lastCheckpoint: Number(lastCheckpoint), feeShares, feeSharesValue },
    allowlistEnabled,
    depositAllowed,
    holdings,
    tbaUsdc,
    vaultUsdc,
    tbaAuthorised: tbaAllowance > 0n,
    envelopePublished: envelopeLogs.length > 0,
    runtime,
    runtimeFee,
    maxRuntimeFee,
    // what the guard enforces between trades (declared cadence, floored), and when the next one may go
    tradeInterval: Number(tradeInterval),
    nextTradeAt: Number(nextTradeAt),
    maxDailyRuntimeFee: runtimeFee * BigInt(Math.max(1, Number(b.genome.cadence))),
    // a scheduled raise (fee, effectiveAt), the notice period, the dust floor, and whether fees are gated on attestation
    pendingRuntimeFee: { fee: pendingFee[0], effectiveAt: Number(pendingFee[1]) },
    runtimeFeeDelay: Number(feeDelay),
    minFeeNotionalBps: Number(minFeeNotionalBps),
    feesGated: String(feeRegistry).toLowerCase() !== "0x0000000000000000000000000000000000000000",
    transcripts: transcriptLogs.length,
    revisions,
    runtimeFeesPaid: feeLogs.reduce((s, l) => s + (l.args.fee ?? 0n), 0n),
    runtimeFeePayments: feeLogs.length,
    token,
    my: { shares: b.myShares, assets: myAssets, usdc: myUsdc, allowance: myAllowance },
    trades,
    series,
    drawdown: maxDrawdown(series.map((p) => Number(p.pps) / 1e18)),
  };
  cache.brains.set(id, brain);
  return brain;
}

/** Who is running this brain, as far as the chain can tell. */
export function runtimeStatus(executor, lastTradeAt, b, now = Math.floor(Date.now() / 1000), tradeInterval = 0) {
  const zero = "0x0000000000000000000000000000000000000000";
  const enclave = (state.cfg.enclaveExecutor || "").toLowerCase();
  const kind = !executor || executor === zero ? "none" : enclave && executor.toLowerCase() === enclave ? "enclave" : "self";
  const intervalSec = tradeInterval || Math.max(60, Math.floor(86400 / Math.max(1, Number(b.genome.cadence))));
  const nextDue = lastTradeAt ? lastTradeAt + intervalSec : null;
  return { kind, lastTradeAt, nextDue, intervalSec, now, registered: false, attested: false, attestation: 0, measurement: null };
}

/**
 * The enclave's own books for one brain (GET enclaveUrl/ledger?tokenId=): what
 * it has paid, what it has cost, the credit left, whether it is paused, and
 * the fee that would have covered it. Null when there is no endpoint or it is
 * unreachable; the chain never depends on it.
 */
export async function loadFarmLedger(id) {
  const url = (state.cfg.enclaveUrl || "").replace(/\/$/, "");
  if (!url) return null;
  try {
    const res = await fetch(`${url}/ledger?tokenId=${Number(id)}`, { cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** The farm's /health: identity, what it runs, and its budget totals and lease. */
export async function loadFarmHealth() {
  const url = (state.cfg.enclaveUrl || "").replace(/\/$/, "");
  if (!url) return null;
  try {
    const res = await fetch(`${url}/health`, { cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Static fallback when no chain is reachable: data/traders.json from report.ts. */
export async function loadSnapshot() {
  const res = await fetch("data/traders.json", { cache: "no-store" });
  if (!res.ok) throw new Error("no snapshot");
  const json = await res.json();
  const brains = (json.traders || []).map((t) => ({
    id: t.tokenId,
    name: t.name || "",
    label: t.name || `Brain #${t.tokenId}`,
    genome: { commitment: t.commitment, birthBlock: t.birthBlock, model: t.model, riskProfile: t.riskProfile, cadence: t.cadence ?? 0, custody: ["authored", "sealed-authored", "sealed-generated"].indexOf(t.custody) },
    owner: t.owner,
    vault: t.vault,
    tba: t.account,
    tier: t.tier ?? 0,
    seasoned: t.seasoned,
    tradeCount: t.tradeCount,
    runtimeFee: t.runtimeFee ? BigInt(Math.round(Number(t.runtimeFee) * 1e6)) * 10n ** 12n : 0n,
    runtimeFeesPaid: t.runtimeFeesPaid ? BigInt(Math.round(Number(t.runtimeFeesPaid) * 1e6)) * 10n ** 12n : 0n,
    runtimeFeePayments: t.runtimeFeePayments ?? 0,
    nav: BigInt(Math.round(Number(t.nav) * 1e6)) * 10n ** 12n,
    pps: t.pps ? BigInt(Math.round(Number(t.pps) * 1e6)) * 10n ** 12n : WAD,
    sharePriceReturn: t.pps ? Number(t.pps) - 1 : 0,
    tbaNav: 0n,
    supply: 0n,
    pending: { mgmt: 0n, perf: 0n, reward: 0n },
    myShares: 0n,
    mine: false,
    snapshot: true,
    trades: (t.trades || []).map((x) => ({
      block: x.block,
      ts: x.ts,
      amountIn: BigInt(Math.round(Number(x.amountIn) * 1e6)) * 10n ** 12n,
      amountOut: BigInt(Math.round(Number(x.amountOut) * 1e6)) * 10n ** 12n,
      inSym: x.inSym || x.tokenIn?.slice(0, 6),
      outSym: x.outSym || x.tokenOut?.slice(0, 6),
      fromVault: x.fromVault,
    })),
  }));
  return { count: brains.length, max: 4096, brains, generatedAtBlock: json.generatedAtBlock, snapshot: true };
}

export const fmtUnits = (v, d = 18) => formatUnits(v ?? 0n, d);

/** A bell reward worth showing (≥ 0.0001 share); anything smaller is dust. */
export const DUST = 10n ** 14n;
export const ringable = (b) => Boolean(b && b.pending && b.pending.reward >= DUST);
