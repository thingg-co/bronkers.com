import { parseUnits, type Address, type Hex, type TransactionReceipt } from "viem";
import { guardAbi, venueAbi } from "./abi.js";
import { config, publicClient, walletClient, type MarketSnapshot } from "./chain.js";
import type { TradeIntent } from "./brain.js";

export interface PreparedTrade {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  fromVault: boolean;
}

/**
 * Local mirror of the on-chain checks: fail fast with a readable error
 * instead of burning gas. The chain remains the actual boundary.
 */
export async function prepare(intent: TradeIntent, snapshot: MarketSnapshot): Promise<PreparedTrade | null> {
  if (intent.action === "hold") return null;
  if (!intent.tokenIn || !intent.tokenOut || !intent.amountIn) {
    throw new Error("swap intent missing tokenIn/tokenOut/amountIn");
  }
  const tokenIn = intent.tokenIn as Address;
  const tokenOut = intent.tokenOut as Address;
  const amountIn = parseUnits(intent.amountIn, 18);

  const allowed = await Promise.all(
    [tokenIn, tokenOut].map((t) =>
      publicClient.readContract({
        address: config.guard,
        abi: guardAbi,
        functionName: "tokenAllowed",
        args: [snapshot.tokenId, t],
      }),
    ),
  );
  if (!allowed.every(Boolean)) throw new Error(`policy: token not in allowlist (${tokenIn} -> ${tokenOut})`);

  const notional =
    tokenIn === snapshot.base
      ? amountIn
      : await publicClient.readContract({
          address: config.router,
          abi: venueAbi,
          functionName: "quote",
          args: [tokenIn, snapshot.base, amountIn],
        });
  const cap = (snapshot.navBase * BigInt(snapshot.policy.maxNotionalBps)) / 10_000n;
  if (notional > cap) throw new Error(`policy: notional ${notional} exceeds per-trade cap ${cap}`);

  const quoted = await publicClient.readContract({
    address: config.router,
    abi: venueAbi,
    functionName: "quote",
    args: [tokenIn, tokenOut, amountIn],
  });
  // accept up to half the allowed slippage; the guard enforces the full bound
  const minAmountOut = (quoted * BigInt(10_000 - snapshot.policy.maxSlippageBps / 2)) / 10_000n;
  return { tokenIn, tokenOut, amountIn, minAmountOut, fromVault: snapshot.book === "vault" };
}

/**
 * Simulate, sign, wait. Returns the receipt so the caller can price the gas.
 * With a transcript hash the trade goes through executeTradeWithTranscript and
 * the chain carries the evidence (TranscriptCommitted).
 */
export async function execute(trade: PreparedTrade, tokenId: bigint = config.tokenId, transcript?: Hex): Promise<TransactionReceipt> {
  const wallet = walletClient();
  const base = [tokenId, config.router, trade.tokenIn, trade.tokenOut, trade.amountIn, trade.minAmountOut, trade.fromVault] as const;
  let hash: Hex;
  if (transcript) {
    const { request } = await publicClient.simulateContract({ account: wallet.account, address: config.guard, abi: guardAbi, functionName: "executeTradeWithTranscript", args: [...base, transcript] });
    hash = await wallet.writeContract(request);
  } else {
    const { request } = await publicClient.simulateContract({ account: wallet.account, address: config.guard, abi: guardAbi, functionName: "executeTrade", args: [...base] });
    hash = await wallet.writeContract(request);
  }
  return publicClient.waitForTransactionReceipt({ hash });
}
