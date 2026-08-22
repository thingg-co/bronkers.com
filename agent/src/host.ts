import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, marketAbi } from "./abi.js";

/**
 * The machine the farm runs on, seen as a lease the farm itself pays.
 *
 * On Marlin Oyster a CVM is a job on an on-chain market: a prepaid balance
 * drained at a per-second rate (USDC on Arbitrum One, rate scaled by the
 * market's EXTRA_DECIMALS). Reading `jobs(jobId)` gives balance, rate and the
 * last settlement, from which the remaining runtime follows; `jobDeposit`
 * buys more. The same two calls work against the dev mock deployed next to
 * the protocol, so FARM_HOST=market exercises the whole loop on anvil and
 * FARM_HOST=oyster points it at Marlin; nothing else changes.
 *
 * Amounts cross this boundary in the farm's base-asset units (the ledger's
 * currency), scaled from the market token's decimals at par.
 */

export interface HostStatus {
  kind: string;
  jobId: string | null;
  remainingSeconds: number | null; // null when the host cannot say
  ratePerHour: bigint | null; // base units
  balance: bigint | null; // base units left on the lease
  float: bigint | null; // what the payer holds to extend with, base units
  detail: string;
}

export interface Host {
  readonly kind: string;
  status(): Promise<HostStatus>;
  /** Prepay `seconds` more runtime. Either what was paid (base units) and a reference, or why not. */
  extend(seconds: number): Promise<{ amount: bigint; ref: string } | { error: string }>;
}

/** No lease the farm can see or pay (self-managed machine, or dev without a market). */
export class NoHost implements Host {
  readonly kind = "none";
  constructor(private ratePerHour: bigint | null) {}
  async status(): Promise<HostStatus> {
    return { kind: this.kind, jobId: null, remainingSeconds: null, ratePerHour: this.ratePerHour, balance: null, float: null, detail: "no host configured; the machine is paid for outside the farm" };
  }
  async extend(_seconds: number): Promise<{ error: string }> {
    return { error: "no host configured" };
  }
}

export interface MarketHostOptions {
  kind: "market" | "oyster";
  rpcUrl: string;
  chainId: number;
  market: Address;
  jobId: Hex;
  payerKey: Hex;
  baseDecimals: number; // the farm's ledger currency
}

/** Scale an amount between token decimals at par. */
export function scaleUnits(amount: bigint, from: number, to: number): bigint {
  if (from === to) return amount;
  return from < to ? amount * 10n ** BigInt(to - from) : amount / 10n ** BigInt(from - to);
}

/** Remaining seconds on a job given the market's fields (the arithmetic the Oyster CLI uses). */
export function remainingSecondsOf(job: { rate: bigint; balance: bigint; lastSettled: bigint }, extraDecimals: bigint, now: bigint): number {
  if (job.rate === 0n) return Number.MAX_SAFE_INTEGER;
  const scaled = job.balance * 10n ** extraDecimals;
  const used = job.rate * (now > job.lastSettled ? now - job.lastSettled : 0n);
  return used >= scaled ? 0 : Number((scaled - used) / job.rate);
}

/** Token units needed to buy `seconds` at `rate` (per second, scaled by extraDecimals). */
export function costOfSeconds(rate: bigint, seconds: number, extraDecimals: bigint): bigint {
  const scale = 10n ** extraDecimals;
  const scaled = rate * BigInt(seconds);
  return (scaled + scale - 1n) / scale;
}

export class MarketHost implements Host {
  readonly kind: string;
  private pub;
  private wallet;
  private payer: Address;
  private token: Address | null = null;
  private tokenDecimals = 0;
  private extraDecimals = 0n;

  constructor(private o: MarketHostOptions) {
    this.kind = o.kind;
    const chain = defineChain({ id: o.chainId, name: o.kind, nativeCurrency: { name: "native", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [o.rpcUrl] } } });
    const account = privateKeyToAccount(o.payerKey);
    this.payer = account.address;
    this.pub = createPublicClient({ chain, transport: http(o.rpcUrl) });
    this.wallet = createWalletClient({ account, chain, transport: http(o.rpcUrl) });
  }

  private async init(): Promise<void> {
    if (this.token) return;
    const [token, extra] = await Promise.all([
      this.pub.readContract({ address: this.o.market, abi: marketAbi, functionName: "token" }),
      this.pub.readContract({ address: this.o.market, abi: marketAbi, functionName: "EXTRA_DECIMALS" }),
    ]);
    this.token = token;
    this.extraDecimals = extra;
    this.tokenDecimals = await this.pub.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
  }

  private async job() {
    const [, owner, provider, rate, balance, lastSettled] = await this.pub.readContract({ address: this.o.market, abi: marketAbi, functionName: "jobs", args: [this.o.jobId] });
    return { owner, provider, rate, balance, lastSettled };
  }

  async status(): Promise<HostStatus> {
    await this.init();
    const [job, block, float] = await Promise.all([
      this.job(),
      this.pub.getBlock(),
      this.pub.readContract({ address: this.token!, abi: erc20Abi, functionName: "balanceOf", args: [this.payer] }),
    ]);
    const toBase = (v: bigint) => scaleUnits(v, this.tokenDecimals, this.o.baseDecimals);
    if (job.owner === "0x0000000000000000000000000000000000000000") {
      return { kind: this.kind, jobId: this.o.jobId, remainingSeconds: 0, ratePerHour: null, balance: null, float: toBase(float), detail: "job not found on the market (closed or wrong id)" };
    }
    const remaining = remainingSecondsOf(job, this.extraDecimals, block.timestamp);
    const ratePerHour = toBase((job.rate * 3600n) / 10n ** this.extraDecimals);
    return {
      kind: this.kind,
      jobId: this.o.jobId,
      remainingSeconds: remaining,
      ratePerHour,
      balance: toBase(job.balance),
      float: toBase(float),
      detail: `provider ${job.provider} · payer ${this.payer}`,
    };
  }

  async extend(seconds: number): Promise<{ amount: bigint; ref: string } | { error: string }> {
    await this.init();
    const job = await this.job();
    if (job.owner === "0x0000000000000000000000000000000000000000") return { error: "job not found on the market" };
    const amount = costOfSeconds(job.rate, seconds, this.extraDecimals); // token units
    if (amount === 0n) return { error: "rate is zero; nothing to pay" };
    const float = await this.pub.readContract({ address: this.token!, abi: erc20Abi, functionName: "balanceOf", args: [this.payer] });
    if (float < amount) return { error: `float ${float} below the ${amount} needed (token units); top up the payer or bridge fees across` };
    const allowance = await this.pub.readContract({ address: this.token!, abi: erc20Abi, functionName: "allowance", args: [this.payer, this.o.market] });
    if (allowance < amount) {
      const { request } = await this.pub.simulateContract({ account: this.wallet.account, address: this.token!, abi: erc20Abi, functionName: "approve", args: [this.o.market, amount] });
      await this.pub.waitForTransactionReceipt({ hash: await this.wallet.writeContract(request) });
    }
    const { request } = await this.pub.simulateContract({ account: this.wallet.account, address: this.o.market, abi: marketAbi, functionName: "jobDeposit", args: [this.o.jobId, amount] });
    const hash = await this.wallet.writeContract(request);
    await this.pub.waitForTransactionReceipt({ hash });
    return { amount: scaleUnits(amount, this.tokenDecimals, this.o.baseDecimals), ref: hash };
  }
}

export const OYSTER = {
  rpcUrl: "https://arb1.arbitrum.io/rpc",
  chainId: 42161,
  market: "0x9d95D61eA056721E358BC49fE995caBF3B86A34B" as Address, // Oyster market (MarketV1)
  usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address,
};

/**
 * FARM_HOST=none (default) | market | oyster.
 *   market: FARM_HOST_MARKET, FARM_HOST_JOB_ID, optional FARM_HOST_RPC_URL/FARM_HOST_CHAIN_ID (default: the protocol chain)
 *   oyster: OYSTER_JOB_ID, optional OYSTER_RPC_URL (Arbitrum One by default)
 * The payer is the executor key unless FARM_HOST_KEY says otherwise. FARM_HOST_RATE (base units per hour)
 * prices the machine for the ledger when there is no market to read it from.
 */
export function hostFromEnv(env: NodeJS.ProcessEnv, defaults: { rpcUrl: string; chainId: number; payerKey: Hex; baseDecimals: number; parseBase: (s: string) => bigint }): Host {
  const kind = (env.FARM_HOST ?? "none").toLowerCase();
  const payerKey = (env.FARM_HOST_KEY ?? defaults.payerKey) as Hex;
  if (kind === "oyster") {
    const jobId = env.OYSTER_JOB_ID ?? env.FARM_HOST_JOB_ID;
    if (!jobId) throw new Error("FARM_HOST=oyster needs OYSTER_JOB_ID (from `oyster-cvm deploy`)");
    return new MarketHost({ kind: "oyster", rpcUrl: env.OYSTER_RPC_URL ?? OYSTER.rpcUrl, chainId: Number(env.OYSTER_CHAIN_ID ?? OYSTER.chainId), market: (env.OYSTER_MARKET ?? OYSTER.market) as Address, jobId: jobId as Hex, payerKey, baseDecimals: defaults.baseDecimals });
  }
  if (kind === "market") {
    if (!env.FARM_HOST_MARKET || !env.FARM_HOST_JOB_ID) throw new Error("FARM_HOST=market needs FARM_HOST_MARKET and FARM_HOST_JOB_ID");
    return new MarketHost({ kind: "market", rpcUrl: env.FARM_HOST_RPC_URL ?? defaults.rpcUrl, chainId: Number(env.FARM_HOST_CHAIN_ID ?? defaults.chainId), market: env.FARM_HOST_MARKET as Address, jobId: env.FARM_HOST_JOB_ID as Hex, payerKey, baseDecimals: defaults.baseDecimals });
  }
  if (kind !== "none") throw new Error(`unknown FARM_HOST ${kind}`);
  return new NoHost(env.FARM_HOST_RATE ? defaults.parseBase(env.FARM_HOST_RATE) : null);
}
