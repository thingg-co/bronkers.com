import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseUnits, type Address } from "viem";
import type { Usage } from "./brain.js";

/**
 * The farm's books. Income is the runtime fee brains pay the executor key on
 * each trade (on-chain: RuntimeFeePaid). Costs are what running them costs
 * the operator: model tokens priced per model, gas priced through the native
 * token, and the machine lease accrued at its hourly rate. Everything is kept
 * in the base asset's units so income and cost compare directly.
 *
 * Policy, per brain: a brain may run `grace` worth of cost on credit beyond
 * what it has paid; past that it is paused. Fees only arrive on trades, so a
 * brain that holds more than it trades runs up a bill its fee never settles,
 * and the owner's remedy is a higher fee: raising the fee resets the credit
 * line (the debt is written off once) and the brain runs again. The ledger
 * also reports the fee that would have covered a brain's costs at its
 * observed trade rate, so the owner is told the number rather than guessing.
 *
 * Farm-wide: totals, the lease accrual, and lease payments, for /health and
 * the operator. Persisted to a JSON file (FARM_LEDGER_PATH) because costs are
 * not on the chain; income is recomputed from logs on every start.
 */

export interface Prices {
  inPerM: bigint; // base units per million input tokens
  outPerM: bigint; // base units per million output tokens
}

export interface BrainAccount {
  tokenId: string;
  ticks: number;
  trades: number;
  feesPaid: bigint;
  feePayments: number;
  feesScannedTo: bigint; // block up to which RuntimeFeePaid logs were folded in
  gasWei: bigint;
  gasCost: bigint;
  tokensIn: number;
  tokensOut: number;
  inferenceCost: bigint;
  forgiven: bigint; // debt written off when the owner raised the fee
  lastFee: bigint | null; // runtimeFeeOf when last checked
  pausedAt: number | null; // ms, when the budget paused it
}

export interface HostAccount {
  paid: bigint; // lease payments made, base units
  payments: number;
  lastPaymentAt: number | null; // ms
  accrued: bigint; // lease cost accrued at the observed rate since the ledger opened
  accruedAt: number | null; // ms
}

export interface LedgerConfig {
  decimals: number; // base asset decimals
  nativePrice: bigint; // base units per whole native token; 0 = gas tracked but not priced
  grace: bigint; // base units of credit per brain
  prices: (model: string, backend: string) => Prices;
  path: string | null; // null = in-memory only
}

export interface LedgerIdentity {
  chainId: number;
  executor: Address;
}

const ONE_NATIVE = 10n ** 18n;
const BIG_FIELDS = new Set(["feesPaid", "feesScannedTo", "gasWei", "gasCost", "inferenceCost", "forgiven", "lastFee", "paid", "accrued"]);

export function gasToBase(wei: bigint, nativePrice: bigint): bigint {
  return (wei * nativePrice) / ONE_NATIVE;
}

export function inferenceToBase(usage: { inputTokens: number; outputTokens: number }, p: Prices): bigint {
  return (BigInt(usage.inputTokens) * p.inPerM + BigInt(usage.outputTokens) * p.outPerM) / 1_000_000n;
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  return b === 0n ? 0n : (a + b - 1n) / b;
}

/**
 * Model prices in base units per million tokens, taking the base asset at par
 * with the dollar the providers bill in. FARM_PRICE_IN/FARM_PRICE_OUT override
 * everything; INFERENCE_PRICE_IN/OUT price the gateway backend (defaults are
 * the TEE gateways' published order of magnitude). Anthropic list prices as of
 * this writing; set the env when they move.
 */
export function defaultPrices(decimals: number, env: NodeJS.ProcessEnv = process.env): (model: string, backend: string) => Prices {
  const u = (s: string) => parseUnits(s, decimals);
  const table: [RegExp, string, string][] = [
    [/fable-5|mythos-5/, "10", "50"],
    [/opus/, "5", "25"],
    [/sonnet/, "3", "15"],
    [/haiku/, "1", "5"],
  ];
  return (model, backend) => {
    if (backend === "mock") return { inPerM: 0n, outPerM: 0n };
    if (env.FARM_PRICE_IN && env.FARM_PRICE_OUT) return { inPerM: u(env.FARM_PRICE_IN), outPerM: u(env.FARM_PRICE_OUT) };
    if (backend === "gateway") return { inPerM: u(env.INFERENCE_PRICE_IN ?? "0.30"), outPerM: u(env.INFERENCE_PRICE_OUT ?? "1.50") };
    const hit = table.find(([re]) => re.test(model));
    return hit ? { inPerM: u(hit[1]), outPerM: u(hit[2]) } : { inPerM: u("3"), outPerM: u("15") };
  };
}

function freshAccount(tokenId: string): BrainAccount {
  return {
    tokenId,
    ticks: 0,
    trades: 0,
    feesPaid: 0n,
    feePayments: 0,
    feesScannedTo: 0n,
    gasWei: 0n,
    gasCost: 0n,
    tokensIn: 0,
    tokensOut: 0,
    inferenceCost: 0n,
    forgiven: 0n,
    lastFee: null,
    pausedAt: null,
  };
}

export class Ledger {
  readonly brains = new Map<string, BrainAccount>();
  host: HostAccount = { paid: 0n, payments: 0, lastPaymentAt: null, accrued: 0n, accruedAt: null };

  constructor(
    readonly cfg: LedgerConfig,
    readonly identity: LedgerIdentity,
    readonly since: number = Date.now(),
  ) {}

  /** Load the ledger file if it belongs to this chain and key; otherwise start fresh. */
  static open(cfg: LedgerConfig, identity: LedgerIdentity): Ledger {
    if (cfg.path && existsSync(cfg.path)) {
      try {
        const raw = JSON.parse(readFileSync(cfg.path, "utf8"), (k, v) => (BIG_FIELDS.has(k) && typeof v === "string" ? BigInt(v) : v));
        if (raw.v === 1 && raw.chainId === identity.chainId && String(raw.executor).toLowerCase() === identity.executor.toLowerCase()) {
          const ledger = new Ledger(cfg, identity, raw.since ?? Date.now());
          for (const b of raw.brains ?? []) {
            const a = freshAccount(String(b.tokenId));
            for (const k of Object.keys(a) as (keyof BrainAccount)[]) if (k in b) (a as unknown as Record<string, unknown>)[k] = b[k];
            ledger.brains.set(a.tokenId, a);
          }
          if (raw.host) ledger.host = { ...ledger.host, ...raw.host };
          return ledger;
        }
      } catch {
        // unreadable or foreign ledger: start over rather than trust it
      }
    }
    return new Ledger(cfg, identity);
  }

  save(): void {
    if (!this.cfg.path) return;
    const tmp = `${this.cfg.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.toJSON(), (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    renameSync(tmp, this.cfg.path);
  }

  account(tokenId: bigint | string): BrainAccount {
    const key = String(tokenId);
    let a = this.brains.get(key);
    if (!a) {
      a = freshAccount(key);
      this.brains.set(key, a);
    }
    return a;
  }

  recordTick(tokenId: bigint | string, usage: Usage | null): void {
    const a = this.account(tokenId);
    a.ticks++;
    if (usage) {
      a.tokensIn += usage.inputTokens;
      a.tokensOut += usage.outputTokens;
      // tokens billed to the owner's own key (a published credential) cost the operator nothing
      if (usage.paidBy !== "owner") a.inferenceCost += inferenceToBase(usage, this.cfg.prices(usage.model, usage.backend));
    }
  }

  recordTrade(tokenId: bigint | string, gasUsed: bigint, gasPrice: bigint): void {
    const a = this.account(tokenId);
    a.trades++;
    const wei = gasUsed * gasPrice;
    a.gasWei += wei;
    a.gasCost += gasToBase(wei, this.cfg.nativePrice);
  }

  /** Fold RuntimeFeePaid amounts found in logs up to `scannedTo` into the account. */
  recordFees(tokenId: bigint | string, fees: bigint[], scannedTo: bigint): void {
    const a = this.account(tokenId);
    for (const f of fees) {
      a.feesPaid += f;
      a.feePayments++;
    }
    if (scannedTo > a.feesScannedTo) a.feesScannedTo = scannedTo;
  }

  /**
   * Record the brain's current runtime fee. A raise is the owner's answer to a
   * pause: the outstanding debt is written off and the credit line starts
   * over. Lowering the fee changes nothing about what is owed.
   */
  noteFee(tokenId: bigint | string, fee: bigint): "first" | "raised" | "lowered" | "unchanged" {
    const a = this.account(tokenId);
    if (a.lastFee === null) {
      a.lastFee = fee;
      return "first";
    }
    if (fee > a.lastFee) {
      a.lastFee = fee;
      const debt = this.costOf(a) - a.feesPaid - a.forgiven;
      if (debt > 0n) a.forgiven += debt;
      a.pausedAt = null;
      return "raised";
    }
    if (fee < a.lastFee) {
      a.lastFee = fee;
      return "lowered";
    }
    return "unchanged";
  }

  costOf(a: BrainAccount): bigint {
    return a.gasCost + a.inferenceCost;
  }

  /** What the brain may still consume before it is paused (negative = over budget). */
  creditOf(a: BrainAccount): bigint {
    return a.feesPaid + a.forgiven + this.cfg.grace - this.costOf(a);
  }

  overBudget(a: BrainAccount): boolean {
    return this.creditOf(a) < 0n;
  }

  /** The per-trade fee that would have covered this brain's costs so far, at its observed trade rate. */
  suggestedFee(a: BrainAccount): bigint | null {
    return a.trades > 0 ? ceilDiv(this.costOf(a), BigInt(a.trades)) : null;
  }

  setPaused(tokenId: bigint | string, paused: boolean, now = Date.now()): void {
    const a = this.account(tokenId);
    a.pausedAt = paused ? (a.pausedAt ?? now) : null;
  }

  /** Accrue the lease at the current hourly rate for the time since the last accrual. */
  accrueHost(ratePerHour: bigint | null, now = Date.now()): void {
    if (this.host.accruedAt !== null && ratePerHour && now > this.host.accruedAt) {
      this.host.accrued += (ratePerHour * BigInt(now - this.host.accruedAt)) / 3_600_000n;
    }
    this.host.accruedAt = now;
  }

  recordHostPayment(amount: bigint, now = Date.now()): void {
    this.host.paid += amount;
    this.host.payments++;
    this.host.lastPaymentAt = now;
  }

  totals() {
    let income = 0n;
    let inference = 0n;
    let gas = 0n;
    let paused = 0;
    for (const a of this.brains.values()) {
      income += a.feesPaid;
      inference += a.inferenceCost;
      gas += a.gasCost;
      if (a.pausedAt !== null) paused++;
    }
    const cost = inference + gas + this.host.accrued;
    return { income, inference, gas, hostAccrued: this.host.accrued, hostPaid: this.host.paid, cost, net: income - cost, brains: this.brains.size, paused };
  }

  toJSON() {
    return {
      v: 1 as const,
      chainId: this.identity.chainId,
      executor: this.identity.executor,
      since: this.since,
      decimals: this.cfg.decimals,
      grace: this.cfg.grace,
      nativePrice: this.cfg.nativePrice,
      brains: [...this.brains.values()].map((a) => ({
        ...a,
        cost: this.costOf(a),
        credit: this.creditOf(a),
        overBudget: this.overBudget(a),
        suggestedFee: this.suggestedFee(a),
      })),
      host: this.host,
      totals: this.totals(),
    };
  }
}
