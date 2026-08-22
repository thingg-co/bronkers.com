import { createServer } from "node:http";
import { formatUnits, parseUnits, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, guardAbi, registryAbi, traderNftAbi, vaultAbi } from "./abi.js";
import { ClaudeBrain, MockBrain, type Brain } from "./brain.js";
import { config, publicClient, snapshot, walletClient, type Book } from "./chain.js";
import { composePrompt, enclavePublicKeyOf, seal, type SealedEnvelope, unseal } from "./enclave.js";
import { execute, prepare } from "./executor.js";
import { commit, type Genome } from "./genome.js";
import { measureRuntime } from "./measure.js";

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
 * Identity: on start the farm measures its own source bundle and registers
 * (measurement, enclave public key) under its executor key in the
 * RuntimeRegistry, if one is configured. Self-reported, not hardware-attested.
 *
 * Economics: a brain may pay its executor a per-trade runtime fee (owner-set,
 * protocol-capped). FARM_MIN_FEE (base units, default 0) lets an operator
 * refuse brains that pay less.
 *
 * Enclave endpoint (optional, FARM_HTTP_PORT): GET /health, POST /compose
 * {brief, tweaks} -> {commitment, envelope} for sealed-generated brains. The
 * prompt is composed and sealed in-process and never returned.
 *
 * Flags: --once (tick every due brain once, then exit), --mock-brain,
 *        --dry-run, --measure (print the runtime measurement and exit).
 * Env: FARM_POLL_SECONDS (default 30), FARM_MIN_FEE, FARM_HTTP_PORT, REGISTRY_ADDRESS,
 *      FARM_TURBO=1 (dev: ignore cadence, tick every poll).
 */
const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const dryRun = args.has("--dry-run");
const useMock = args.has("--mock-brain");
const pollMs = Math.max(5, Number(process.env.FARM_POLL_SECONDS ?? 30)) * 1000;
const minFee = parseUnits(process.env.FARM_MIN_FEE ?? "0", 18);
const httpPort = Number(process.env.FARM_HTTP_PORT ?? 0);
// FARM_TURBO=1 (dev only): ignore each brain's declared cadence and tick every poll.
// Production honours the cadence trait; it is a public promise.
const turbo = process.env.FARM_TURBO === "1";

const measurement = measureRuntime();
if (args.has("--measure")) {
  console.log(measurement);
  process.exit(0);
}

const enclaveKey = process.env.ENCLAVE_PRIVATE_KEY ?? "";
if (!enclaveKey) throw new Error("farm needs ENCLAVE_PRIVATE_KEY (the enclave's sealing key)");
const enclavePub = enclavePublicKeyOf(enclaveKey);
const me = privateKeyToAccount(process.env.EXECUTOR_PRIVATE_KEY as Hex).address;
console.log(`farm up · executor ${me} · nft ${config.nft} · poll ${pollMs / 1000}s${useMock ? " · mock brain" : ""}`);
console.log(`runtime measurement ${measurement}`);
if (turbo) console.log("FARM_TURBO=1: ignoring declared cadence, ticking every poll (dev only)");

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

/** Bind this executor key to the runtime it is running, if a registry is configured. */
async function registerRuntime(): Promise<void> {
  if (!config.registry) return;
  try {
    const [have] = await publicClient.readContract({ address: config.registry, abi: registryAbi, functionName: "runtimeOf", args: [me] });
    if (have === measurement) {
      console.log(`registry: already registered with this measurement`);
      return;
    }
    const wallet = walletClient();
    const { request } = await publicClient.simulateContract({
      account: wallet.account, address: config.registry, abi: registryAbi, functionName: "register",
      args: [measurement, toHex(Buffer.from(enclavePub, "base64"))],
    });
    const hash = await wallet.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`registry: registered measurement + enclave key under ${me} (${hash})`);
  } catch (e) {
    console.error(`registry: could not register: ${e instanceof Error ? e.message : e}`);
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
    if (minFee > 0n) {
      const fee = await publicClient.readContract({ address: config.guard, abi: guardAbi, functionName: "runtimeFeeOf", args: [tokenId] });
      if (fee < minFee) {
        if (running.delete(tokenId)) console.log(`#${tokenId}: paused (runtime fee below this operator's minimum)`);
        note(tokenId, `runtime fee ${formatUnits(fee, 18)} is below this operator's minimum ${formatUnits(minFee, 18)}; not running`);
        continue;
      }
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
  const fee = await publicClient.readContract({ address: config.guard, abi: guardAbi, functionName: "runtimeFeeOf", args: [r.tokenId] });
  console.log(`${r.label}: executed within guardrails ${hash}${fee > 0n ? ` · runtime fee ${formatUnits(fee, 18)}` : ""}`);
}

async function round(): Promise<void> {
  await enrol();
  const now = Date.now();
  for (const r of running.values()) {
    if (now - r.lastTickAt < r.intervalMs && !once && !turbo) continue;
    r.lastTickAt = now;
    try {
      await tick(r);
    } catch (err) {
      console.error(`${r.label}: tick failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (!running.size) console.log("no brains enrolled with this key yet");
}

// ---- enclave endpoint (optional) ----
function startHttp(): void {
  if (!httpPort) return;
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Content-Type": "application/json" };
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, cors);
      res.end(JSON.stringify({ executor: me, enclavePublicKey: enclavePub, measurement, registry: config.registry || null, running: [...running.values()].map((r) => r.label) }));
      return;
    }
    if (req.method === "POST" && req.url === "/compose") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 64_000) req.destroy(); });
      req.on("end", () => {
        try {
          const { brief, tweaks } = JSON.parse(body || "{}") as { brief?: string; tweaks?: Record<string, unknown> };
          if (!brief || typeof brief !== "string" || brief.length > 4_000) throw new Error("brief must be a string up to 4000 characters");
          const genome: Genome = { prompt: composePrompt(brief), tweaks: tweaks && typeof tweaks === "object" ? tweaks : {} };
          const envelope = seal(JSON.stringify(genome), enclavePub);
          // the plaintext exists only in this scope and is never returned or logged
          res.writeHead(200, cors);
          res.end(JSON.stringify({ commitment: commit(genome), envelope, custody: 2 }));
        } catch (e) {
          res.writeHead(400, cors);
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
      return;
    }
    res.writeHead(404, cors);
    res.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(httpPort, "127.0.0.1", () => console.log(`enclave endpoint on http://127.0.0.1:${httpPort} (GET /health, POST /compose)`));
}

await registerRuntime();
startHttp();
do {
  try {
    await round();
  } catch (err) {
    console.error(`round failed: ${err instanceof Error ? err.message : err}`);
  }
  if (!once) await new Promise((r) => setTimeout(r, pollMs));
} while (!once);
if (once) process.exit(0);
