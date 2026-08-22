import { formatUnits } from "viem";
import { traderNftAbi } from "./abi.js";
import { createBrain, describeBackend, type Brain } from "./brain.js";
import { config, publicClient, snapshot, type Book } from "./chain.js";
import { commit, openSecretStore, type Genome } from "./genome.js";
import { execute, prepare } from "./executor.js";

/**
 * The trader's life: decrypt genome -> prove it matches the on-chain
 * commitment -> observe -> think -> act through the guard -> repeat.
 *
 * Flags: --once (single tick), --dry-run (print intent, don't submit),
 *        --mock-brain (deterministic, no API key needed),
 *        --own-book (trade the trader's own wallet instead of the LP vault —
 *                    how a new trader serves its paper season)
 *
 * The decrypted genome exists only inside this process and is never logged —
 * for sealed custody, this process IS the prototype "enclave".
 */
const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const dryRun = args.has("--dry-run");
const useMock = args.has("--mock-brain");
const book: Book = args.has("--own-book") ? "own" : "vault";

async function loadVerifiedGenome(): Promise<{ genome: Genome; model: string; cadence: number }> {
  const onChain = await publicClient.readContract({
    address: config.nft,
    abi: traderNftAbi,
    functionName: "genomeOf",
    args: [config.tokenId],
  });
  const genome = openSecretStore(config.genomePath, {
    genomeKey: config.genomeKey,
    enclaveKey: process.env.ENCLAVE_PRIVATE_KEY,
  }).decrypt();
  const local = commit(genome);
  if (local !== onChain.commitment) {
    throw new Error(
      `PROVENANCE FAILURE: local genome hashes to ${local} but trader #${config.tokenId} ` +
        `committed ${onChain.commitment}. Refusing to run — this is not that trader's brain.`,
    );
  }
  console.log(`genome verified against on-chain commitment ${onChain.commitment}`);
  return { genome, model: onChain.model, cadence: onChain.cadence };
}

async function tick(brain: Brain): Promise<void> {
  const snap = await snapshot(book);
  const { intent, usage } = await brain.decide(snap);
  console.log(`intent: ${intent.action} — ${intent.rationale}${usage ? ` · ${usage.inputTokens}+${usage.outputTokens} tokens (${usage.model})` : ""}`);
  const trade = await prepare(intent, snap);
  if (!trade) return;
  console.log(
    `swap ${formatUnits(trade.amountIn, 18)} of ${trade.tokenIn} -> ${trade.tokenOut} (minOut ${formatUnits(trade.minAmountOut, 18)})`,
  );
  if (dryRun) {
    console.log("dry-run: not submitting");
    return;
  }
  const receipt = await execute(trade);
  console.log(`executed within guardrails: ${receipt.transactionHash} (gas ${formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18)})`);
}

const { genome, model, cadence } = await loadVerifiedGenome();
const brain: Brain = createBrain({ genome, model, mock: useMock });
console.log(`brain: ${describeBackend(useMock)} · model ${model}`);
const intervalMs = Math.max(60_000, Math.floor((24 * 3_600_000) / Math.max(1, cadence)));

do {
  try {
    await tick(brain);
  } catch (err) {
    console.error(`tick failed: ${err instanceof Error ? err.message : err}`);
    if (once) process.exit(1);
  }
  if (!once) {
    console.log(`sleeping ${Math.round(intervalMs / 60_000)}min (declared cadence: ${cadence}/day)`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
} while (!once);
