import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Genome } from "./genome.js";
import { describeSnapshot, type MarketSnapshot } from "./chain.js";

export const TradeIntent = z.object({
  action: z.enum(["swap", "hold"]),
  tokenIn: z.string().optional(),
  tokenOut: z.string().optional(),
  amountIn: z.string().optional(), // decimal string in whole-token units
  rationale: z.string(),
});
export type TradeIntent = z.infer<typeof TradeIntent>;

export interface Brain {
  decide(snapshot: MarketSnapshot): Promise<TradeIntent>;
}

/** The real brain: the decrypted genome is the system prompt. */
export class ClaudeBrain implements Brain {
  private client = new Anthropic();
  constructor(
    private genome: Genome,
    private model: string,
  ) {}

  async decide(snapshot: MarketSnapshot): Promise<TradeIntent> {
    const tokens = [
      `${snapshot.baseSymbol}: ${snapshot.base}`,
      ...snapshot.holdings.map((h) => `${h.symbol}: ${h.token}`),
    ].join("\n");
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system:
        `${this.genome.prompt}\n\n` +
        `Tweaks: ${JSON.stringify(this.genome.tweaks)}\n` +
        `You manage an on-chain vault. You MUST respond by calling submit_trade_intent. ` +
        `All trades are policy-checked on-chain; propose amounts within policy.`,
      messages: [
        {
          role: "user",
          content: `Market snapshot:\n${describeSnapshot(snapshot)}\n\nToken addresses:\n${tokens}\n\nDecide your next action.`,
        },
      ],
      tools: [
        {
          name: "submit_trade_intent",
          description: "Submit your trading decision",
          input_schema: {
            type: "object" as const,
            properties: {
              action: { type: "string", enum: ["swap", "hold"] },
              tokenIn: { type: "string", description: "address of token to sell (omit for hold)" },
              tokenOut: { type: "string", description: "address of token to buy (omit for hold)" },
              amountIn: { type: "string", description: "amount to sell, decimal whole-token units" },
              rationale: { type: "string" },
            },
            required: ["action", "rationale"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "submit_trade_intent" },
    });
    const toolUse = res.content.find((c) => c.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") throw new Error("Brain returned no trade intent");
    return TradeIntent.parse(toolUse.input);
  }
}

/** Deterministic brain for demos and CI: buys a small clip of the first universe token. */
export class MockBrain implements Brain {
  async decide(snapshot: MarketSnapshot): Promise<TradeIntent> {
    const target = snapshot.holdings[0];
    if (!target) return { action: "hold", rationale: "no universe tokens configured" };
    // 5% of NAV, well inside the default 20% notional cap
    const amountBase = (snapshot.navBase * 5n) / 100n;
    return {
      action: "swap",
      tokenIn: snapshot.base,
      tokenOut: target.token,
      amountIn: (Number(amountBase) / 1e18).toString(),
      rationale: "MockBrain: rotate 5% of NAV into the first universe asset (demo).",
    };
  }
}
