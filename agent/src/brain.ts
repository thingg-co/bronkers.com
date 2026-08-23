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

/** What one model call consumed, so the farm can price the tick. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  backend: "anthropic" | "gateway" | "mock";
  /** who is billed for these tokens: the operator (default) or the owner, through a credential they published */
  paidBy?: "operator" | "owner";
}

export interface Decision {
  intent: TradeIntent;
  usage: Usage | null;
}

export interface Brain {
  decide(snapshot: MarketSnapshot): Promise<Decision>;
}

const TOOL_NAME = "submit_trade_intent";
const TOOL_DESCRIPTION = "Submit your trading decision";
const TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    action: { type: "string", enum: ["swap", "hold"] },
    tokenIn: { type: "string", description: "address of token to sell (omit for hold)" },
    tokenOut: { type: "string", description: "address of token to buy (omit for hold)" },
    amountIn: { type: "string", description: "amount to sell, decimal whole-token units" },
    rationale: { type: "string" },
  },
  required: ["action", "rationale"],
};

function systemPrompt(genome: Genome): string {
  return (
    `${genome.prompt}\n\n` +
    `Tweaks: ${JSON.stringify(genome.tweaks)}\n` +
    `You manage an on-chain vault. You MUST respond by calling ${TOOL_NAME}. ` +
    `All trades are policy-checked on-chain; propose amounts within policy.`
  );
}

function userPrompt(snapshot: MarketSnapshot): string {
  const tokens = [
    `${snapshot.baseSymbol}: ${snapshot.base}`,
    ...snapshot.holdings.map((h) => `${h.symbol}: ${h.token}`),
  ].join("\n");
  return `Market snapshot:\n${describeSnapshot(snapshot)}\n\nToken addresses:\n${tokens}\n\nDecide your next action.`;
}

/** The real brain against Anthropic's API: the decrypted genome is the system prompt. */
export class ClaudeBrain implements Brain {
  private client: Anthropic;
  constructor(
    private genome: Genome,
    private model: string,
    /** the owner's key (and optional base URL), if they published one; the operator's env otherwise */
    private owned?: { apiKey: string; baseUrl?: string },
  ) {
    this.client = owned ? new Anthropic({ apiKey: owned.apiKey, ...(owned.baseUrl ? { baseURL: owned.baseUrl } : {}) }) : new Anthropic();
  }

  async decide(snapshot: MarketSnapshot): Promise<Decision> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: systemPrompt(this.genome),
      messages: [{ role: "user", content: userPrompt(snapshot) }],
      tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, input_schema: TOOL_SCHEMA }],
      tool_choice: { type: "tool", name: TOOL_NAME },
    });
    const toolUse = res.content.find((c) => c.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") throw new Error("Brain returned no trade intent");
    return {
      intent: TradeIntent.parse(toolUse.input),
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, model: res.model ?? this.model, backend: "anthropic", paidBy: this.owned ? "owner" : "operator" },
    };
  }
}

/**
 * The same brain over an OpenAI-compatible chat-completions gateway, which is
 * what the TEE inference providers expose (Phala/RedPill, SecretAI): the model
 * runs in a GPU enclave and the balance is paid in USDC, so no card sits
 * between a brain's capital and its inference. Env: INFERENCE_BASE_URL
 * (…/v1), INFERENCE_API_KEY. The on-chain model trait names the model.
 */
export class GatewayBrain implements Brain {
  private baseUrl: string;
  constructor(
    private genome: Genome,
    private model: string,
    baseUrl = (process.env.INFERENCE_BASE_URL ?? ""),
    private apiKey = process.env.INFERENCE_API_KEY ?? "",
    private paidBy: "operator" | "owner" = "operator",
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    if (!this.baseUrl) throw new Error("GatewayBrain needs INFERENCE_BASE_URL");
  }

  async decide(snapshot: MarketSnapshot): Promise<Decision> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        messages: [
          { role: "system", content: systemPrompt(this.genome) },
          { role: "user", content: userPrompt(snapshot) },
        ],
        tools: [{ type: "function", function: { name: TOOL_NAME, description: TOOL_DESCRIPTION, parameters: TOOL_SCHEMA } }],
        tool_choice: { type: "function", function: { name: TOOL_NAME } },
      }),
    });
    if (!res.ok) throw new Error(`inference gateway ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as {
      model?: string;
      choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const call = json.choices?.[0]?.message?.tool_calls?.find((c) => c.function?.name === TOOL_NAME) ?? json.choices?.[0]?.message?.tool_calls?.[0];
    if (!call?.function?.arguments) throw new Error("Brain returned no trade intent");
    return {
      intent: TradeIntent.parse(JSON.parse(call.function.arguments)),
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        model: json.model ?? this.model,
        backend: "gateway",
        paidBy: this.paidBy,
      },
    };
  }
}

/** Deterministic brain for demos and CI: buys a small clip of the first universe token. */
export class MockBrain implements Brain {
  async decide(snapshot: MarketSnapshot): Promise<Decision> {
    const target = snapshot.holdings[0];
    if (!target) return { intent: { action: "hold", rationale: "no universe tokens configured" }, usage: null };
    // 5% of NAV, well inside the default 20% notional cap
    const amountBase = (snapshot.navBase * 5n) / 100n;
    return {
      intent: {
        action: "swap",
        tokenIn: snapshot.base,
        tokenOut: target.token,
        amountIn: (Number(amountBase) / 1e18).toString(),
        rationale: "MockBrain: rotate 5% of NAV into the first universe asset (demo).",
      },
      usage: null,
    };
  }
}

/** An owner's own inference account, already validated by credentials.ts checkInference(). */
export interface OwnedInference {
  provider: "anthropic" | "gateway";
  apiKey: string;
  baseUrl?: string;
}

/**
 * Backend selection: --mock-brain; else the owner's key if they published one
 * (their account is billed, the farm's ledger prices those tokens at zero);
 * else a TEE gateway if INFERENCE_BASE_URL is set; else Anthropic.
 */
export function createBrain(opts: { genome: Genome; model: string; mock?: boolean; inference?: OwnedInference | null }): Brain {
  if (opts.mock) return new MockBrain();
  const own = opts.inference;
  if (own) {
    if (own.provider === "gateway") return new GatewayBrain(opts.genome, opts.model, own.baseUrl, own.apiKey, "owner");
    return new ClaudeBrain(opts.genome, opts.model, { apiKey: own.apiKey, baseUrl: own.baseUrl });
  }
  if (process.env.INFERENCE_BASE_URL) return new GatewayBrain(opts.genome, opts.model);
  return new ClaudeBrain(opts.genome, opts.model);
}

export function describeBackend(mock?: boolean, inference?: OwnedInference | null): string {
  if (mock) return "mock brain";
  if (inference) return inference.provider === "gateway" ? `owner's key at ${inference.baseUrl}` : "owner's Anthropic key";
  if (process.env.INFERENCE_BASE_URL) return `inference gateway ${process.env.INFERENCE_BASE_URL}`;
  return "Anthropic API";
}
