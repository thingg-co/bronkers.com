import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { erc20Abi, guardAbi, traderNftAbi, vaultAbi, venueAbi } from "./abi.js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export const config = {
  rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
  tokenId: BigInt(process.env.TOKEN_ID ?? "1"),
  nft: env("TRADER_NFT_ADDRESS") as Address,
  guard: env("GUARD_ADDRESS") as Address,
  router: env("ROUTER_ADDRESS") as Address,
  registry: (process.env.REGISTRY_ADDRESS ?? "") as Address,
  genomePath: process.env.GENOME_PATH ?? "./genome.local.json",
  genomeKey: process.env.GENOME_KEY ?? "",
};

export const publicClient = createPublicClient({ chain: foundry, transport: http(config.rpcUrl) });

export function walletClient() {
  // The executor key is a burner by design: on-chain policy is the boundary.
  const account = privateKeyToAccount(env("EXECUTOR_PRIVATE_KEY") as Hex);
  return createWalletClient({ account, chain: foundry, transport: http(config.rpcUrl) });
}

export interface Policy {
  executor: Address;
  maxNotionalBps: number;
  maxSlippageBps: number;
  minTradeInterval: bigint;
  lastTradeAt: bigint;
}

/** Which pool of capital the agent is trading this tick. */
export type Book = "vault" | "own";

export interface MarketSnapshot {
  tokenId: bigint;
  book: Book;
  base: Address;
  baseSymbol: string;
  vault: Address;
  navBase: bigint;
  holdings: { token: Address; symbol: string; balance: bigint; quoteInBase: bigint }[];
  policy: Policy;
}

/** Everything the brain is allowed to see: balances, quotes, and its own limits. */
export async function snapshot(book: Book, tokenId: bigint = config.tokenId): Promise<MarketSnapshot> {
  const { nft, guard, router } = config;
  const [vault, tba] = await Promise.all([
    publicClient.readContract({ address: nft, abi: traderNftAbi, functionName: "vaultOf", args: [tokenId] }),
    publicClient.readContract({ address: nft, abi: traderNftAbi, functionName: "accountOf", args: [tokenId] }),
  ]);
  const holder = book === "vault" ? vault : tba;
  const [base, nav, universe, rawPolicy] = await Promise.all([
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "asset" }),
    book === "vault"
      ? publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalAssets" })
      : publicClient.readContract({ address: guard, abi: guardAbi, functionName: "tbaNav", args: [tokenId] }),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "universe" }),
    publicClient.readContract({ address: guard, abi: guardAbi, functionName: "policyOf", args: [tokenId] }),
  ]);
  const baseSymbol = await publicClient.readContract({ address: base, abi: erc20Abi, functionName: "symbol" });
  const holdings = await Promise.all(
    universe.map(async (token) => {
      const [symbol, balance] = await Promise.all([
        publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
        publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] }),
      ]);
      const quoteInBase = await publicClient.readContract({
        address: router,
        abi: venueAbi,
        functionName: "quote",
        args: [token, base, 10n ** 18n],
      });
      return { token, symbol, balance, quoteInBase };
    }),
  );
  const [executor, maxNotionalBps, maxSlippageBps, minTradeInterval, lastTradeAt] = rawPolicy;
  return {
    tokenId,
    book,
    base,
    baseSymbol,
    vault,
    navBase: nav,
    holdings,
    policy: { executor, maxNotionalBps, maxSlippageBps, minTradeInterval, lastTradeAt },
  };
}

export function describeSnapshot(s: MarketSnapshot): string {
  const lines = [
    `Trading book: ${s.book === "vault" ? "LP vault" : "own account (paper season)"}`,
    `NAV: ${formatUnits(s.navBase, 18)} ${s.baseSymbol}`,
    ...s.holdings.map(
      (h) =>
        `Holding ${h.symbol}: ${formatUnits(h.balance, 18)} (1 ${h.symbol} = ${formatUnits(h.quoteInBase, 18)} ${s.baseSymbol})`,
    ),
    `Policy: max ${s.policy.maxNotionalBps} bps of NAV per trade, max slippage ${s.policy.maxSlippageBps} bps`,
  ];
  return lines.join("\n");
}
