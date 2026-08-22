import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { encodePacked, formatUnits, keccak256, parseUnits, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, guardAbi, registryAbi, traderNftAbi, vaultAbi } from "./abi.js";
import { createBrain, describeBackend, type Brain } from "./brain.js";
import { defaultPrices, Ledger } from "./budget.js";
import { chainId, config, publicClient, snapshot, walletClient, type Book } from "./chain.js";
import { composePrompt, enclavePublicKeyOf, seal, type SealedEnvelope, unseal } from "./enclave.js";
import { execute, prepare } from "./executor.js";
import { commit, type Genome } from "./genome.js";
import { hostFromEnv, type HostStatus } from "./host.js";
import { measureRuntime } from "./measure.js";

/**
 * The farm: one enclave process that runs every brain enrolled with it, and
 * pays for itself.
 *
 * Enrolment is on-chain and costs nothing new: a brain is enrolled when its
 * executor (ExecutionGuard.policyOf) is this process's key. For each such
 * brain the farm finds the sealed envelope the owner published on-chain
 * (TraderNFT.EnvelopePublished), opens it with ENCLAVE_PRIVATE_KEY, verifies
 * the plaintext against the genome commitment, and then runs the brain at its
 * declared cadence (which the guard enforces on-chain). It picks the book
 * itself: the brain's own wallet during the internship, the vault once the
 * brain is seasoned and funded. The chain is the state; a restart resumes.
 *
 * Identity: on start the farm measures its own source bundle and registers
 * (measurement, enclave public key) under its executor key in the
 * RuntimeRegistry, if one is configured: self-reported, or hardware-attested
 * when FARM_QUOTE_PATH holds a TDX quote whose report data is
 * keccak256(executor ‖ enclave key) (printed at start) and the registry has
 * a verifier.
 *
 * Economics (budget.ts): every tick is priced (model tokens, gas) and every
 * trade's runtime fee is counted from RuntimeFeePaid logs. A brain that has
 * consumed more than it paid plus FARM_GRACE is paused until its owner raises
 * the fee; FARM_MIN_FEE refuses brains that ask below the operator's price.
 * The machine lease (host.ts) is read from the market it is rented on and
 * topped up from the farm's float before it runs out; every payment is logged
 * and in the ledger. GET /ledger shows all of it per brain; GET /health the
 * totals.
 *
 * Enclave endpoint (optional, FARM_HTTP_PORT): GET /health, GET /ledger
 * [?tokenId=], POST /compose {brief, tweaks} -> {commitment, envelope} for
 * sealed-generated brains. The prompt is composed and sealed in-process and
 * never returned.
 *
 * Flags: --once (tick every due brain once, then exit), --mock-brain,
 *        --dry-run, --measure (print the runtime measurement and exit).
 * Env: FARM_POLL_SECONDS (default 30), FARM_MIN_FEE, FARM_GRACE (default 1),
 *      FARM_NATIVE_PRICE (base per native token, prices gas), FARM_PRICE_IN/OUT,
 *      FARM_LEDGER_PATH (default ./.farm-ledger.json), FARM_HOST (none|market|oyster)
 *      + FARM_HOST_* / OYSTER_* (host.ts), FARM_HOST_MIN_SECONDS (default 6h),
 *      FARM_HOST_EXTEND_SECONDS (default 24h), FARM_HOST_CHECK_SECONDS (default 300),
 *      FARM_HTTP_PORT, REGISTRY_ADDRESS, FARM_QUOTE_PATH, FARM_QUOTE_FEE (native),
 *      INFERENCE_BASE_URL/INFERENCE_API_KEY (TEE gateway instead of Anthropic),
 *      FARM_TURBO=1 (dev: tick every poll; trades still wait for the on-chain cadence).
 */
const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const dryRun = args.has("--dry-run");
const useMock = args.has("--mock-brain");
const pollMs = Math.max(5, Number(process.env.FARM_POLL_SECONDS ?? 30)) * 1000;
const httpPort = Number(process.env.FARM_HTTP_PORT ?? 0);
// FARM_TURBO=1 (dev only): tick every poll instead of waiting out the declared cadence.
// The guard still enforces the cadence on-chain; on anvil, move the clock (Developer tab).
const turbo = process.env.FARM_TURBO === "1";

const measurement = measureRuntime();
if (args.has("--measure")) {
  console.log(measurement);
  process.exit(0);
}

const enclaveKey = process.env.ENCLAVE_PRIVATE_KEY ?? "";
if (!enclaveKey) throw new Error("farm needs ENCLAVE_PRIVATE_KEY (the enclave's sealing key)");
const enclavePub = enclavePublicKeyOf(enclaveKey);
const enclavePubBytes = toHex(Buffer.from(enclavePub, "base64"));
const executorKey = process.env.EXECUTOR_PRIVATE_KEY as Hex;
if (!executorKey) throw new Error("farm needs EXECUTOR_PRIVATE_KEY");
const me = privateKeyToAccount(executorKey).address;

// the ledger's currency is the protocol's base asset
const base = await publicClient.readContract({ address: config.guard, abi: guardAbi, functionName: "baseAsset" });
const [baseDecimals, baseSymbol] = await Promise.all([
  publicClient.readContract({ address: base, abi: erc20Abi, functionName: "decimals" }),
  publicClient.readContract({ address: base, abi: erc20Abi, functionName: "symbol" }),
]);
const parseBase = (s: string) => parseUnits(s, baseDecimals);
const fmtBase = (v: bigint) => `${formatUnits(v, baseDecimals)} ${baseSymbol}`;
const minFee = parseBase(process.env.FARM_MIN_FEE ?? "0");

const ledger = Ledger.open(
  {
    decimals: baseDecimals,
    nativePrice: parseBase(process.env.FARM_NATIVE_PRICE ?? "0"),
    grace: parseBase(process.env.FARM_GRACE ?? "1"),
    prices: defaultPrices(baseDecimals),
    path: process.env.FARM_LEDGER_PATH === "" ? null : (process.env.FARM_LEDGER_PATH ?? "./.farm-ledger.json"),
  },
  { chainId, executor: me },
);
const host = hostFromEnv(process.env, { rpcUrl: config.rpcUrl, chainId, payerKey: executorKey, baseDecimals, parseBase });
const hostMinSeconds = Number(process.env.FARM_HOST_MIN_SECONDS ?? 6 * 3600);
const hostExtendSeconds = Number(process.env.FARM_HOST_EXTEND_SECONDS ?? 24 * 3600);
const hostCheckMs = Number(process.env.FARM_HOST_CHECK_SECONDS ?? 300) * 1000;
let lastHostCheck = 0;
let lastHostStatus: HostStatus | null = null;

console.log(`farm up · executor ${me} · chain ${chainId} · nft ${config.nft} · poll ${pollMs / 1000}s · ${describeBackend(useMock)}`);
console.log(`runtime measurement ${measurement}`);
console.log(`attestation report data (put this in the TDX quote's report data): ${keccak256(encodePacked(["address", "bytes"], [me, enclavePubBytes]))}`);
console.log(`budget: grace ${fmtBase(ledger.cfg.grace)} per brain · gas ${ledger.cfg.nativePrice > 0n ? `priced at ${fmtBase(ledger.cfg.nativePrice)} per native token` : "tracked, not priced (set FARM_NATIVE_PRICE)"} · host ${host.kind} · ledger ${ledger.cfg.path ?? "in memory"}`);
if (turbo) console.log("FARM_TURBO=1: ticking every poll (dev only); trades still wait for the on-chain cadence");

interface Running {
  tokenId: bigint;
  label: string;
  brain: Brain;
  cadence: number;
  intervalSec: number;
  lastTradeAt: number; // chain seconds, from policyOf
  lastTickAt: number; // chain seconds, our last tick (trade or hold)
  birthBlock: bigint;
  commitment: Hex;
}
const running = new Map<bigint, Running>();
const skipped = new Map<bigint, string>(); // tokenId -> reason, logged once
const notes = new Map<string, string>(); // farm-level notes, logged once per change

function note(tokenId: bigint, reason: string) {
  if (skipped.get(tokenId) !== reason) {
    skipped.set(tokenId, reason);
    console.log(`#${tokenId}: ${reason}`);
  }
}
function noteOnce(key: string, text: string) {
  if (notes.get(key) !== text) {
    notes.set(key, text);
    console.log(text);
  }
}

/** Bind this executor key to the runtime it is running, if a registry is configured. */
async function registerRuntime(): Promise<void> {
  if (!config.registry) return;
  try {
    const [have] = await publicClient.readContract({ address: config.registry, abi: registryAbi, functionName: "runtimeOf", args: [me] });
    const quotePath = process.env.FARM_QUOTE_PATH;
    const wallet = walletClient();
    if (quotePath) {
      // hardware path: the quote's report data commits to (executor, enclave key); the
      // registry's verifier checks the quote and extracts the measurement
      const verifier = await publicClient.readContract({ address: config.registry, abi: registryAbi, functionName: "verifier" });
      if (verifier === "0x0000000000000000000000000000000000000000") {
        console.log("registry: FARM_QUOTE_PATH set but the registry has no verifier on this chain; registering self-reported instead");
      } else {
        const raw = readFileSync(quotePath, "utf8").trim();
        const quote = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
        const value = parseUnits(process.env.FARM_QUOTE_FEE ?? "0", 18);
        const { request } = await publicClient.simulateContract({
          account: wallet.account, address: config.registry, abi: registryAbi, functionName: "registerAttested", args: [quote, enclavePubBytes], value,
        });
        const hash = await wallet.writeContract(request);
        await publicClient.waitForTransactionReceipt({ hash });
        console.log(`registry: registered hardware-attested under ${me} (${hash})`);
        return;
      }
    }
    if (have === measurement) {
      console.log(`registry: already registered with this measurement`);
      return;
    }
    const { request } = await publicClient.simulateContract({
      account: wallet.account, address: config.registry, abi: registryAbi, functionName: "register", args: [measurement, enclavePubBytes],
    });
    const hash = await wallet.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`registry: registered measurement + enclave key under ${me} (${hash}); self-reported, not hardware-attested`);
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

/** Fold the runtime fees this brain has paid us (RuntimeFeePaid logs) into the ledger, in chunks public RPCs accept. */
async function refreshFees(tokenId: bigint, birthBlock: bigint): Promise<void> {
  const a = ledger.account(tokenId);
  const latest = await publicClient.getBlockNumber({ cacheTime: 0 }); // fresh: called right after our own trade mines
  let from = a.feesScannedTo > 0n ? a.feesScannedTo + 1n : birthBlock;
  const chunk = BigInt(process.env.FARM_LOG_CHUNK ?? 10_000);
  while (from <= latest) {
    const to = from + chunk - 1n < latest ? from + chunk - 1n : latest;
    const logs = await publicClient.getContractEvents({
      address: config.guard, abi: guardAbi, eventName: "RuntimeFeePaid", args: { tokenId, executor: me }, fromBlock: from, toBlock: to,
    });
    ledger.recordFees(tokenId, logs.map((l) => l.args.fee as bigint), to);
    from = to + 1n;
  }
}

/** Find (or refresh) the set of brains enrolled with this key, and apply the budget. */
async function enrol(): Promise<void> {
  const nextId = await publicClient.readContract({ address: config.nft, abi: traderNftAbi, functionName: "nextId" });
  for (let tokenId = 1n; tokenId <= nextId; tokenId++) {
    const policy = await publicClient.readContract({ address: config.guard, abi: guardAbi, functionName: "policyOf", args: [tokenId] });
    const executor = policy[0];
    if (executor.toLowerCase() !== me.toLowerCase()) {
      if (running.delete(tokenId)) console.log(`#${tokenId}: unenrolled (executor changed)`);
      continue;
    }
    const r = running.get(tokenId);
    if (r) r.lastTradeAt = Number(policy[4]);

    const fee = await publicClient.readContract({ address: config.guard, abi: guardAbi, functionName: "runtimeFeeOf", args: [tokenId] });
    const change = ledger.noteFee(tokenId, fee);
    if (change === "raised") console.log(`#${tokenId}: runtime fee raised to ${fmtBase(fee)} by the owner; credit line reset`);
    if (change === "lowered") console.log(`#${tokenId}: runtime fee lowered to ${fmtBase(fee)}`);
    if (minFee > 0n && fee < minFee) {
      if (running.delete(tokenId)) console.log(`#${tokenId}: paused (runtime fee below this operator's minimum)`);
      note(tokenId, `runtime fee ${fmtBase(fee)} is below this operator's minimum ${fmtBase(minFee)}; not running`);
      continue;
    }

    const onChain = await publicClient.readContract({ address: config.nft, abi: traderNftAbi, functionName: "genomeOf", args: [tokenId] });
    try {
      await refreshFees(tokenId, BigInt(onChain.birthBlock));
    } catch (e) {
      noteOnce(`fees-${tokenId}`, `#${tokenId}: could not read fee logs: ${e instanceof Error ? e.message : e}`);
    }
    const account = ledger.account(tokenId);
    if (ledger.overBudget(account)) {
      if (account.pausedAt === null) ledger.setPaused(tokenId, true);
      const suggested = ledger.suggestedFee(account);
      if (running.delete(tokenId)) console.log(`#${tokenId}: paused by the budget`);
      note(tokenId, `paused: it has cost ${fmtBase(ledger.costOf(account))} to run and paid ${fmtBase(account.feesPaid)} (credit ${fmtBase(ledger.cfg.grace)} exhausted); its owner can raise the runtime fee in My Desk to resume${suggested !== null ? ` (a fee of ${fmtBase(suggested)} per trade would have covered it so far)` : ""}`);
      continue;
    }
    if (account.pausedAt !== null) ledger.setPaused(tokenId, false);
    if (running.has(tokenId)) continue;

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
    const intervalSec = Math.max(60, Math.floor(86_400 / cadence));
    running.set(tokenId, {
      tokenId,
      label: name ? `${name} (#${tokenId})` : `#${tokenId}`,
      brain: createBrain({ genome, model: onChain.model, mock: useMock }),
      cadence,
      intervalSec,
      lastTradeAt: Number(policy[4]),
      lastTickAt: Number(policy[4]), // resume from the last on-chain trade
      birthBlock: BigInt(onChain.birthBlock),
      commitment: onChain.commitment,
    });
    skipped.delete(tokenId);
    console.log(`${running.get(tokenId)!.label}: enrolled · cadence ${cadence}/day · fee ${fmtBase(fee)} · genome verified ${onChain.commitment.slice(0, 10)}…`);
  }
  ledger.save();
}

/** Which pool of capital, if any, this brain should trade right now. */
async function chooseBook(tokenId: bigint): Promise<Book | null> {
  const [vault, tba, seasoned] = await Promise.all([
    publicClient.readContract({ address: config.nft, abi: traderNftAbi, functionName: "vaultOf", args: [tokenId] }),
    publicClient.readContract({ address: config.nft, abi: traderNftAbi, functionName: "accountOf", args: [tokenId] }),
    publicClient.readContract({ address: config.guard, abi: guardAbi, functionName: "seasoned", args: [tokenId] }),
  ]);
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
  const { intent, usage } = await r.brain.decide(snap);
  ledger.recordTick(r.tokenId, usage);
  console.log(`${r.label} [${book}]: ${intent.action} — ${intent.rationale}${usage ? ` · ${usage.inputTokens}+${usage.outputTokens} tokens` : ""}`);
  const trade = await prepare(intent, snap);
  if (!trade) {
    ledger.save();
    return;
  }
  console.log(`${r.label}: swap ${formatUnits(trade.amountIn, 18)} ${trade.tokenIn} -> ${trade.tokenOut} (minOut ${formatUnits(trade.minAmountOut, 18)})`);
  if (dryRun) return;
  const receipt = await execute(trade, r.tokenId);
  ledger.recordTrade(r.tokenId, receipt.gasUsed, receipt.effectiveGasPrice);
  r.lastTradeAt = r.lastTickAt;
  await refreshFees(r.tokenId, r.birthBlock).catch(() => {});
  const account = ledger.account(r.tokenId);
  console.log(`${r.label}: executed within guardrails ${receipt.transactionHash} · gas ${formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18)} · paid to date ${fmtBase(account.feesPaid)} · cost to date ${fmtBase(ledger.costOf(account))}`);
  ledger.save();
}

/** Keep the machine paid: read the lease, accrue its cost, extend it before it runs out. */
async function lease(): Promise<void> {
  let s: HostStatus;
  try {
    s = await host.status();
  } catch (e) {
    noteOnce("host", `lease: cannot read the host: ${e instanceof Error ? e.message : e}`);
    return;
  }
  lastHostStatus = s;
  ledger.accrueHost(s.ratePerHour);
  if (s.remainingSeconds !== null && s.remainingSeconds < hostMinSeconds) {
    const r = await host.extend(hostExtendSeconds).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    if ("amount" in r) {
      ledger.recordHostPayment(r.amount);
      notes.delete("extend");
      console.log(`lease: ${Math.round(s.remainingSeconds / 60)} min left; paid ${fmtBase(r.amount)} for ${Math.round(hostExtendSeconds / 3600)}h more (${r.ref})`);
    } else {
      noteOnce("extend", `lease: ${Math.round(s.remainingSeconds / 60)} min left and cannot extend: ${r.error}${host.kind === "oyster" ? " — move fees across with `npm run bridge -- --amount <usdc> --to 42161`" : ""}`);
    }
  }
  ledger.save();
}

async function round(): Promise<void> {
  await enrol();
  const now = Number((await publicClient.getBlock()).timestamp); // the guard's clock, not ours
  for (const r of running.values()) {
    const due = once || turbo || now >= Math.max(r.lastTickAt, r.lastTradeAt) + r.intervalSec;
    if (!due) continue;
    r.lastTickAt = now;
    try {
      await tick(r);
    } catch (err) {
      console.error(`${r.label}: tick failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (Date.now() - lastHostCheck >= hostCheckMs) {
    lastHostCheck = Date.now();
    await lease();
  }
  if (!running.size) noteOnce("empty", "no brains running under this key right now");
  else notes.delete("empty");
}

// ---- enclave endpoint (optional) ----
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

async function health() {
  const [float, native] = await Promise.all([
    publicClient.readContract({ address: base, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
    publicClient.getBalance({ address: me }),
  ]);
  const t = ledger.totals();
  return {
    executor: me,
    chainId,
    enclavePublicKey: enclavePub,
    measurement,
    registry: config.registry || null,
    backend: describeBackend(useMock),
    running: [...running.values()].map((r) => r.label),
    budget: {
      symbol: baseSymbol,
      decimals: baseDecimals,
      since: ledger.since,
      grace: ledger.cfg.grace,
      minFee,
      income: t.income,
      inference: t.inference,
      gas: t.gas,
      hostAccrued: t.hostAccrued,
      hostPaid: t.hostPaid,
      cost: t.cost,
      net: t.net,
      brains: t.brains,
      paused: t.paused,
      float,
      nativeBalance: native,
      host: lastHostStatus,
    },
  };
}

function startHttp(): void {
  if (!httpPort) return;
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Content-Type": "application/json" };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://farm");
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    if (req.method === "GET" && url.pathname === "/health") {
      try {
        res.writeHead(200, cors);
        res.end(json(await health()));
      } catch (e) {
        res.writeHead(500, cors);
        res.end(json({ error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/ledger") {
      const all = ledger.toJSON();
      const tokenId = url.searchParams.get("tokenId");
      if (tokenId) {
        const b = all.brains.find((x) => x.tokenId === String(Number(tokenId)));
        res.writeHead(200, cors);
        res.end(json({ decimals: all.decimals, grace: all.grace, minFee, brain: b ?? null, running: running.has(BigInt(tokenId)) }));
        return;
      }
      res.writeHead(200, cors);
      res.end(json({ ...all, minFee, host: { ...all.host, status: lastHostStatus } }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/compose") {
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
  server.listen(httpPort, "127.0.0.1", () => console.log(`enclave endpoint on http://127.0.0.1:${httpPort} (GET /health, GET /ledger, POST /compose)`));
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
