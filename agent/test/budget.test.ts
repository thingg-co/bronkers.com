import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseUnits } from "viem";
import { ceilDiv, defaultPrices, gasToBase, inferenceToBase, Ledger, type LedgerConfig } from "../src/budget.js";

const D = 18;
const u = (s: string) => parseUnits(s, D);
const executor = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

function cfg(over: Partial<LedgerConfig> = {}): LedgerConfig {
  return { decimals: D, nativePrice: u("2000"), grace: u("1"), prices: defaultPrices(D, {}), path: null, ...over };
}

test("gas and inference convert into base units", () => {
  // 300k gas at 1 gwei = 0.0003 native; at 2000 base per native = 0.6 base
  assert.equal(gasToBase(300_000n * 10n ** 9n, u("2000")), u("0.6"));
  // 1,500 in + 200 out at 3/15 per million = 0.0045 + 0.003
  assert.equal(inferenceToBase({ inputTokens: 1500, outputTokens: 200 }, { inPerM: u("3"), outPerM: u("15") }), u("0.0075"));
  assert.equal(ceilDiv(10n, 4n), 3n);
  assert.equal(ceilDiv(0n, 0n), 0n);
});

test("default prices: table by model, env overrides, gateway defaults, mock is free", () => {
  const p = defaultPrices(D, {});
  assert.deepEqual(p("claude-sonnet-5", "anthropic"), { inPerM: u("3"), outPerM: u("15") });
  assert.deepEqual(p("claude-opus-5", "anthropic"), { inPerM: u("5"), outPerM: u("25") });
  assert.deepEqual(p("anything", "mock"), { inPerM: 0n, outPerM: 0n });
  assert.deepEqual(p("llama", "gateway"), { inPerM: u("0.30"), outPerM: u("1.50") });
  const q = defaultPrices(D, { FARM_PRICE_IN: "1", FARM_PRICE_OUT: "2" });
  assert.deepEqual(q("claude-opus-5", "anthropic"), { inPerM: u("1"), outPerM: u("2") });
  const g = defaultPrices(D, { INFERENCE_PRICE_IN: "0.1", INFERENCE_PRICE_OUT: "0.4" });
  assert.deepEqual(g("x", "gateway"), { inPerM: u("0.1"), outPerM: u("0.4") });
});

test("a brain runs on credit, is paused past the grace, and a fee raise resets the line", () => {
  const l = new Ledger(cfg(), { chainId: 31337, executor });
  const id = 1n;
  assert.equal(l.noteFee(id, u("1")), "first");
  // 100 ticks of 2k+300 tokens on sonnet ≈ 0.0105 each ≈ 1.05 total: just past the 1.0 grace
  for (let i = 0; i < 100; i++) l.recordTick(id, { inputTokens: 2000, outputTokens: 300, model: "claude-sonnet-5", backend: "anthropic" });
  const a = l.account(id);
  assert.equal(l.costOf(a), u("1.05"));
  assert.equal(l.creditOf(a), u("-0.05"));
  assert.equal(l.overBudget(a), true);
  assert.equal(l.suggestedFee(a), null); // no trades yet, nothing to suggest

  // one trade paid 1.0 in fees and cost 0.6 of gas
  l.recordTrade(id, 300_000n, 10n ** 9n);
  l.recordFees(id, [u("1")], 120n);
  assert.equal(a.trades, 1);
  assert.equal(a.feesPaid, u("1"));
  assert.equal(a.feesScannedTo, 120n);
  assert.equal(l.costOf(a), u("1.65"));
  assert.equal(l.creditOf(a), u("0.35"));
  assert.equal(l.overBudget(a), false);
  assert.equal(l.suggestedFee(a), u("1.65")); // total cost over one trade

  // more holds push it over again
  for (let i = 0; i < 50; i++) l.recordTick(id, { inputTokens: 2000, outputTokens: 300, model: "claude-sonnet-5", backend: "anthropic" });
  assert.equal(l.overBudget(a), true);
  l.setPaused(id, true, 1000);
  assert.equal(a.pausedAt, 1000);

  // lowering the fee does nothing for the debt; raising it writes the debt off and unpauses
  assert.equal(l.noteFee(id, u("0.5")), "lowered");
  assert.equal(l.overBudget(a), true);
  assert.equal(l.noteFee(id, u("2")), "raised");
  assert.equal(a.pausedAt, null);
  assert.equal(a.forgiven, l.costOf(a) - a.feesPaid);
  assert.equal(l.creditOf(a), u("1")); // a fresh grace window
  assert.equal(l.noteFee(id, u("2")), "unchanged");
});

test("farm totals and host accrual", () => {
  const l = new Ledger(cfg({ nativePrice: 0n }), { chainId: 1, executor });
  l.recordFees(1n, [u("1"), u("1")], 10n);
  l.recordTick(1n, { inputTokens: 1000, outputTokens: 0, model: "claude-haiku-4-5", backend: "anthropic" }); // 0.001
  l.recordTrade(1n, 100_000n, 10n ** 9n); // gas tracked but unpriced
  l.accrueHost(u("0.12"), 0); // first call only stamps the time
  l.accrueHost(u("0.12"), 30 * 60_000); // half an hour later: 0.06
  l.recordHostPayment(u("2.88"), 31 * 60_000);
  const t = l.totals();
  assert.equal(t.income, u("2"));
  assert.equal(t.inference, u("0.001"));
  assert.equal(t.gas, 0n);
  assert.equal(l.account(1n).gasWei, 100_000n * 10n ** 9n);
  assert.equal(t.hostAccrued, u("0.06"));
  assert.equal(t.hostPaid, u("2.88"));
  assert.equal(t.cost, u("0.061"));
  assert.equal(t.net, u("1.939"));
  assert.equal(t.brains, 1);
  assert.equal(t.paused, 0);
});

test("the ledger round-trips through its file and ignores a foreign one", () => {
  const dir = mkdtempSync(join(tmpdir(), "farm-ledger-"));
  const path = join(dir, "ledger.json");
  const l = new Ledger(cfg({ path }), { chainId: 31337, executor });
  l.recordTick(7n, { inputTokens: 10, outputTokens: 10, model: "claude-sonnet-5", backend: "anthropic" });
  l.recordFees(7n, [u("0.25")], 99n);
  l.noteFee(7n, u("0.25"));
  l.setPaused(7n, true, 5);
  l.recordHostPayment(u("1"), 6);
  l.save();
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(raw.v, 1);
  assert.equal(raw.brains[0].feesPaid, u("0.25").toString()); // bigints as decimal strings
  assert.equal(typeof raw.brains[0].credit, "string");

  const again = Ledger.open(cfg({ path }), { chainId: 31337, executor });
  const a = again.account(7n);
  assert.equal(a.feesPaid, u("0.25"));
  assert.equal(a.feesScannedTo, 99n);
  assert.equal(a.lastFee, u("0.25"));
  assert.equal(a.pausedAt, 5);
  assert.equal(a.tokensIn, 10);
  assert.equal(again.host.paid, u("1"));
  assert.equal(again.since, l.since);

  const other = Ledger.open(cfg({ path }), { chainId: 137, executor });
  assert.equal(other.brains.size, 0); // a different chain's ledger is not ours
});
