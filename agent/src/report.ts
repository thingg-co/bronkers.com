import { writeFileSync } from "node:fs";
import { formatUnits } from "viem";
import { guardAbi, traderNftAbi, vaultAbi } from "./abi.js";
import { config, publicClient } from "./chain.js";

/**
 * Minimal indexer: fold on-chain events into data/traders.json for the static
 * site. The site only renders; anyone can recompute these numbers from logs.
 */
const { tokenId, nft, guard } = config;

const [genome, owner, vault, account] = await Promise.all([
  publicClient.readContract({ address: nft, abi: traderNftAbi, functionName: "genomeOf", args: [tokenId] }),
  publicClient.readContract({ address: nft, abi: traderNftAbi, functionName: "ownerOf", args: [tokenId] }),
  publicClient.readContract({ address: nft, abi: traderNftAbi, functionName: "vaultOf", args: [tokenId] }),
  publicClient.readContract({ address: nft, abi: traderNftAbi, functionName: "accountOf", args: [tokenId] }),
]);

const [nav, seasoned, trades] = await Promise.all([
  publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalAssets" }),
  publicClient.readContract({ address: guard, abi: guardAbi, functionName: "seasoned", args: [tokenId] }),
  publicClient.getContractEvents({
    address: guard,
    abi: guardAbi,
    eventName: "TradeExecuted",
    args: { tokenId },
    fromBlock: 0n,
  }),
]);

const out = {
  generatedAtBlock: Number(await publicClient.getBlockNumber()),
  traders: [
    {
      tokenId: Number(tokenId),
      owner,
      account,
      vault,
      commitment: genome.commitment,
      birthBlock: Number(genome.birthBlock),
      model: genome.model,
      riskProfile: genome.riskProfile,
      custody: ["authored", "sealed-authored", "sealed-generated"][genome.custody] ?? "unknown",
      seasoned,
      nav: formatUnits(nav, 18),
      tradeCount: trades.length,
      trades: trades.map((t) => ({
        block: Number(t.blockNumber),
        tokenIn: t.args.tokenIn,
        tokenOut: t.args.tokenOut,
        amountIn: formatUnits(t.args.amountIn ?? 0n, 18),
        amountOut: formatUnits(t.args.amountOut ?? 0n, 18),
        fromVault: t.args.fromVault,
      })),
    },
  ],
};

writeFileSync(new URL("../../data/traders.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(`wrote data/traders.json — trader #${tokenId}: ${trades.length} trades, NAV ${formatUnits(nav, 18)}`);
