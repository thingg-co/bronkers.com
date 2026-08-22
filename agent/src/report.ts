import { writeFileSync } from "node:fs";
import { formatUnits, parseAbi } from "viem";
import { guardAbi, traderNftAbi, vaultAbi } from "./abi.js";
import { config, publicClient } from "./chain.js";

/**
 * Minimal indexer: fold on-chain state and events for EVERY brain into
 * data/traders.json. The Terminal uses it only as an offline fallback ("snapshot
 * mode"); anyone can recompute these numbers from logs.
 */
const { nft, guard } = config;
const WAD = 10n ** 18n;

const extraNftAbi = parseAbi([
  "function nextId() view returns (uint256)",
  "function nameOf(uint256) view returns (string)",
  "function generationOf(uint256) view returns (uint32)",
]);
const extraGuardAbi = parseAbi(["function tierOf(uint256) view returns (uint8)"]);
const extraVaultAbi = parseAbi(["function convertToAssets(uint256) view returns (uint256)"]);
const erc20SymbolAbi = parseAbi(["function symbol() view returns (string)"]);

const symbols = new Map<string, string>();
async function symbolOf(addr: `0x${string}`): Promise<string> {
  const k = addr.toLowerCase();
  if (!symbols.has(k)) {
    try {
      symbols.set(k, await publicClient.readContract({ address: addr, abi: erc20SymbolAbi, functionName: "symbol" }));
    } catch {
      symbols.set(k, addr.slice(0, 6));
    }
  }
  return symbols.get(k)!;
}

const blockTs = new Map<bigint, number>();
async function tsOf(block: bigint): Promise<number> {
  if (!blockTs.has(block)) blockTs.set(block, Number((await publicClient.getBlock({ blockNumber: block })).timestamp));
  return blockTs.get(block)!;
}

const nextId = await publicClient.readContract({ address: nft, abi: extraNftAbi, functionName: "nextId" });
const traders = [];
for (let tokenId = 1n; tokenId <= nextId; tokenId++) {
  const [genome, owner, vault, account, name, tier, generation] = await Promise.all([
    publicClient.readContract({ address: nft, abi: traderNftAbi, functionName: "genomeOf", args: [tokenId] }),
    publicClient.readContract({ address: nft, abi: traderNftAbi, functionName: "ownerOf", args: [tokenId] }),
    publicClient.readContract({ address: nft, abi: traderNftAbi, functionName: "vaultOf", args: [tokenId] }),
    publicClient.readContract({ address: nft, abi: traderNftAbi, functionName: "accountOf", args: [tokenId] }),
    publicClient.readContract({ address: nft, abi: extraNftAbi, functionName: "nameOf", args: [tokenId] }),
    publicClient.readContract({ address: guard, abi: extraGuardAbi, functionName: "tierOf", args: [tokenId] }),
    publicClient.readContract({ address: nft, abi: extraNftAbi, functionName: "generationOf", args: [tokenId] }),
  ]);
  const [nav, pps, seasoned, logs, feeLogs, runtimeFee] = await Promise.all([
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalAssets" }),
    publicClient.readContract({ address: vault, abi: extraVaultAbi, functionName: "convertToAssets", args: [WAD] }),
    publicClient.readContract({ address: guard, abi: guardAbi, functionName: "seasoned", args: [tokenId] }),
    publicClient.getContractEvents({ address: guard, abi: guardAbi, eventName: "TradeExecuted", args: { tokenId }, fromBlock: 0n }),
    publicClient.getContractEvents({ address: guard, abi: guardAbi, eventName: "RuntimeFeePaid", args: { tokenId }, fromBlock: 0n }),
    publicClient.readContract({ address: guard, abi: guardAbi, functionName: "runtimeFeeOf", args: [tokenId] }),
  ]);
  const trades = [];
  for (const t of logs) {
    trades.push({
      block: Number(t.blockNumber),
      ts: await tsOf(t.blockNumber),
      tokenIn: t.args.tokenIn,
      tokenOut: t.args.tokenOut,
      inSym: await symbolOf(t.args.tokenIn!),
      outSym: await symbolOf(t.args.tokenOut!),
      amountIn: formatUnits(t.args.amountIn ?? 0n, 18),
      amountOut: formatUnits(t.args.amountOut ?? 0n, 18),
      fromVault: t.args.fromVault,
    });
  }
  traders.push({
    tokenId: Number(tokenId),
    name,
    owner,
    account,
    vault,
    commitment: genome.commitment,
    generation: Number(generation),
    birthBlock: Number(genome.birthBlock),
    model: genome.model,
    riskProfile: genome.riskProfile,
    cadence: genome.cadence,
    custody: ["authored", "sealed-authored", "sealed-generated"][genome.custody] ?? "unknown",
    tier,
    seasoned,
    nav: formatUnits(nav, 18),
    pps: formatUnits(pps, 18),
    tradeCount: trades.length,
    // the runtime fee is a fund expense and belongs in the record like any other
    runtimeFee: formatUnits(runtimeFee, 18),
    runtimeFeesPaid: formatUnits(feeLogs.reduce((s, l) => s + (l.args.fee ?? 0n), 0n), 18),
    runtimeFeePayments: feeLogs.length,
    trades,
  });
}

const out = { generatedAtBlock: Number(await publicClient.getBlockNumber()), traders };
writeFileSync(new URL("../../data/traders.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(`wrote data/traders.json — ${traders.length} brains, ${traders.reduce((s, t) => s + t.tradeCount, 0)} trades`);
