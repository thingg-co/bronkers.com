import { formatUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, guardAbi, traderNftAbi, vaultAbi } from "./abi.js";
import { ClaudeBrain, MockBrain, type Brain } from "./brain.js";
import { config, publicClient, snapshot, type Book } from "./chain.js";
import { type SealedEnvelope, unseal } from "./enclave.js";
import { execute, prepare } from "./executor.js";
import { commit, type Genome } from "./genome.js";

/**
 * The farm: one enclave process that runs every brain enrolled with it.
 *
 * Enrolment is on-chain and costs nothing new: a brain is enrolled when its
 * executor (ExecutionGuard.policyOf) is this process's key. For each such
 * brain the farm finds the sealed envelope the owner published on-chain
 * (TraderNFT.EnvelopePublished), opens it with ENCLAVE_PRIVATE_KEY, verifies
 * the plaintext against the genome commitment, and then runs the brain at its
 * declared cadence. It picks the book itself: the brain's own wallet during
 * the internship, the vault once the brain is seasoned and funded. Nothing is
 * persisted; the chain is the state, so a restart just resumes.
 *
 * Flags: --once (tick every due brain once, then exit), --mock-brain,
 *        --dry-run. Env: FARM_POLL_SECONDS (default 30).
 */
const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const dryRun = args.has("--dry-run");
const useMock = args.has("--mock-brain");
const pollMs = Math.max(5, Number(process.env.FARM_POLL_SECONDS ?? 30)) * 1000;

const enclaveKey = process.env.ENCLAVE_PRIVATE_KEY ?? "";
if (!enclaveKey) throw new Error("farm needs ENCLAVE_PRIVATE_KEY (the enclave's sealing key)");
const me = privateKeyToAccount(process.env.EXECUTOR_PRIVATE_KEY as Hex).address;
console.log(`farm up · executor ${me} · nft ${config.nft} · poll ${pollMs / 1000}s${useMock ? " · mock brain" : ""}`);

interface Running {
  tokenId: bigint;
  label: string;
  brain: Brain;
  cadence: number;
  intervalMs: number;
  lastTickAt: number; // ms
  commitment: Hex;
}
const running = new Map<bigint, Running>();
const skipped = new Map<bigint, string>(); // tokenId -> reason, logged once

function note(tokenId: bigint, reason: string) {
  if (skipped.get(tokenId) !== reason) {
    skipped.set(tokenId, reason);
    console.log(`#${tokenId}: ${reason}`);
  }
}

async function latestEnvelope(tokenId: bigint, fromBlock: bigint): Promise<SealedEnvelope | null> {
  const logs = await publicClient.getContractEvents({
    address: config.nft,
    abi: traderNftAbi,
    eventName: "EnvelopePublished",
    args: { tokenId },
    fromBlock,
  });
  if (!logs.length) return null;
  const raw = logs[logs.length - 1].args.envelope as Hex;
  const json = Buffer.from(raw.slice(2), "hex").toString("utf8");
  return JSON.parse(json) as SealedEnvelope;
}

/** Find (or refresh) the set of brains enrolled with this key. */
async function enrol(): Promise<void> {
  const nextId = await publicClient.readContract({ address: config.nft, abi: traderNftAbi, functionName: "nextId" });
  for (let tokenId = 1n; tokenId <= nextId; tokenId++) {
    const policy = await publicClient.readContract({ address: config.guard, abi: guardAbi, functionName: "policyOf", args: [tokenId] });
    const executor = policy[0];
    if (executor.toLowerCase() !== me.toLowerCase()) {
      if (running.delete(tokenId)) console.log(`#${tokenId}: unenrolled (executor changed)`);
      continue;
    }
    if (running.has(tokenId)) continue;

    const onChain = await publicClient.readContract({ address: config.nft, abi: traderNftAbi, functionName: "genomeOf", args: [tokenId] });
    if (onChain.custody === 0) {
      note(tokenId, "authored custody: the owner holds the key, so this brain is self-hosted (run `npm run loop`)");
      continue;
    }
    const env = await latestEnvelope(tokenId, BigInt(onChain.birthBlock));
    if (!env) {
      note(tokenId, "enrolled but no published envelope yet (owner: publish the jar from My Desk)");
      continue;
    }
    let genome: Genome;
    try {
      genome = JSON.parse(unseal(env, enclaveKey)) as Genome;
    } catch (e) {
      note(tokenId, `cannot open envelope with this enclave key: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const local = commit(genome);
    if (local !== onChain.commitment) {
      note(tokenId, `PROVENANCE FAILURE: envelope hashes to ${local}, chain committed ${onChain.commitment}; refusing to run`);
      continue;
    }
    const name = await publicClient.readContract({ address: config.nft, abi: traderNftAbi, functionName: "nameOf", args: [tokenId] });
    const cadence = Math.max(1, onChain.cadence);
    const intervalMs = Math.max(60_000, Math.floor((24 * 3_600_000) / cadence));
    running.set(tokenId, {
      tokenId,
      label: name ? `${name} (#${tokenId})` : `#${tokenId}`,
      brain: useMock ? new MockBrain() : new ClaudeBrain(genome, onChain.model),
      cadence,
      intervalMs,
      lastTickAt: Number(policy[4]) * 1000, // resume from the last on-chain trade
      commitment: onChain.commitment,
    });
    skipped.delete(tokenId);
    console.log(`${running.get(tokenId)!.label}: enrolled · cadence ${cadence}/day · genome verified ${onChain.commitment.slice(0, 10)}…`);
  }
}

/** Which pool of capital, if any, this brain should trade right now. */
async function chooseBook(tokenId: bigint): Promise<Book | null> {
  const [vault, tba, seasoned] = await Promise.all([
    publicClient.readContract({ address: config.nft, abi: traderNftAbi, functionName: "vaultOf", args: [tokenId] }),
    publicClient.readContract({ address: config.nft, abi: traderNftAbi, functionName: "accountOf", args: [tokenId] }),
    publicClient.readContract({ address: config.guard, abi: guardAbi, functionName: "seasoned", args: [tokenId] }),
  ]);
  const base = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "asset" });
  const [vaultAssets, ownNav, allowance] = await Promise.all([
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalAssets" }),
    publicClient.readContract({ address: config.guard, abi: guardAbi, functionName: "tbaNav", args: [tokenId] }),
    publicClient.readContract({ address: base, abi: erc20Abi, functionName: "allowance", args: [tba, config.guard] }),
  ]);
  if (seasoned && vaultAssets > 0n) return "vault";
  if (ownNav > 0n && allowance > 0n) return "own";
  if (ownNav > 0n) note(tokenId, "wallet funded but the guard is not authorised (owner: My Desk → Authorise the guard)");
  else note(tokenId, seasoned ? "idle: vault and wallet are both empty" : "idle: wallet is empty; the internship needs funds in the brain's own wallet");
  return null;
}

async function tick(r: Running): Promise<void> {
  const book = await chooseBook(r.tokenId);
  if (!book) return;
  const snap = await snapshot(book, r.tokenId);
  const intent = await r.brain.decide(snap);
  console.log(`${r.label} [${book}]: ${intent.action} — ${intent.rationale}`);
  const trade = await prepare(intent, snap);
  if (!trade) return;
  console.log(`${r.label}: swap ${formatUnits(trade.amountIn, 18)} ${trade.tokenIn} -> ${trade.tokenOut} (minOut ${formatUnits(trade.minAmountOut, 18)})`);
  if (dryRun) return;
  const hash = await execute(trade, r.tokenId);
  console.log(`${r.label}: executed within guardrails ${hash}`);
}

async function round(): Promise<void> {
  await enrol();
  const now = Date.now();
  for (const r of running.values()) {
    if (now - r.lastTickAt < r.intervalMs && !once) continue;
    r.lastTickAt = now;
    try {
      await tick(r);
    } catch (err) {
      console.error(`${r.label}: tick failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (!running.size) console.log("no brains enrolled with this key yet");
}

do {
  try {
    await round();
  } catch (err) {
    console.error(`round failed: ${err instanceof Error ? err.message : err}`);
  }
  if (!once) await new Promise((r) => setTimeout(r, pollMs));
} while (!once);
