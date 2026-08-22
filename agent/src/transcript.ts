import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, stringToBytes, type Hex } from "viem";
import type { Decision } from "./brain.js";
import { describeSnapshot, type MarketSnapshot } from "./chain.js";

/**
 * The inference transcript behind a trade: what the model was shown, what it
 * answered, which model and how many tokens. Its keccak256 goes on-chain with
 * the trade (ExecutionGuard.executeTradeWithTranscript -> TranscriptCommitted);
 * the transcript itself stays with the operator and can be disclosed for an
 * audit without exposing the genome (the prompt is not in it). Evidence, not a
 * claim: anyone can check a disclosed transcript against the hash the chain
 * carries.
 */
export interface Transcript {
  v: 1;
  chainId: number;
  tokenId: string;
  book: string;
  at: string; // ISO time the decision was made
  snapshot: string; // the market description the model saw
  tokens: { symbol: string; token: string }[];
  intent: Decision["intent"];
  model: string | null;
  backend: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export function buildTranscript(chainId: number, snapshot: MarketSnapshot, decision: Decision): { transcript: Transcript; json: string; hash: Hex } {
  const transcript: Transcript = {
    v: 1,
    chainId,
    tokenId: snapshot.tokenId.toString(),
    book: snapshot.book,
    at: new Date().toISOString(),
    snapshot: describeSnapshot(snapshot),
    tokens: [{ symbol: snapshot.baseSymbol, token: snapshot.base }, ...snapshot.holdings.map((h) => ({ symbol: h.symbol, token: h.token }))],
    intent: decision.intent,
    model: decision.usage?.model ?? null,
    backend: decision.usage?.backend ?? null,
    usage: decision.usage ? { inputTokens: decision.usage.inputTokens, outputTokens: decision.usage.outputTokens } : null,
  };
  const json = JSON.stringify(transcript);
  return { transcript, json, hash: keccak256(stringToBytes(json)) };
}

/** Keep the transcript under its hash so a disclosure can be checked against the chain. */
export function saveTranscript(dir: string | null, hash: Hex, json: string): string | null {
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${hash}.json`);
  writeFileSync(path, json);
  return path;
}
