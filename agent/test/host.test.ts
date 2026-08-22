import assert from "node:assert/strict";
import { test } from "node:test";
import { costOfSeconds, hostFromEnv, NoHost, OYSTER, remainingSecondsOf, scaleUnits } from "../src/host.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const defaults = { rpcUrl: "http://127.0.0.1:8545", chainId: 31337, payerKey: KEY, baseDecimals: 18, parseBase: (s: string) => BigInt(Math.round(Number(s) * 1e6)) * 10n ** 12n };

test("remaining time follows balance, rate and the last settlement (Oyster arithmetic)", () => {
  // USDC (6 dec) with 12 extra decimals: 0.12/h = 120000 * 1e12 / 3600 per second
  const rate = (120_000n * 10n ** 12n) / 3600n;
  const job = { rate, balance: 1_200_000n, lastSettled: 1_000n }; // 1.2 USDC = ten hours
  assert.ok(Math.abs(remainingSecondsOf(job, 12n, 1_000n) - 36_000) <= 1);
  assert.ok(Math.abs(remainingSecondsOf(job, 12n, 1_000n + 4n * 3600n) - 21_600) <= 1);
  assert.equal(remainingSecondsOf(job, 12n, 1_000n + 11n * 3600n), 0);
  assert.equal(remainingSecondsOf({ ...job, rate: 0n }, 12n, 5n), Number.MAX_SAFE_INTEGER);
  // buying a day costs 2.88 USDC, rounded up to the token unit
  assert.equal(costOfSeconds(rate, 86_400, 12n), 2_880_000n);
  assert.equal(costOfSeconds(1n, 1, 12n), 1n); // never zero for a non-zero rate
});

test("amounts scale between token decimals at par", () => {
  assert.equal(scaleUnits(2_880_000n, 6, 18), 2_880_000n * 10n ** 12n);
  assert.equal(scaleUnits(2_880_000n * 10n ** 12n, 18, 6), 2_880_000n);
  assert.equal(scaleUnits(5n, 6, 6), 5n);
});

test("hostFromEnv: none by default, market and oyster need their ids, unknown kinds fail", async () => {
  const none = hostFromEnv({}, defaults);
  assert.ok(none instanceof NoHost);
  const s = await none.status();
  assert.equal(s.remainingSeconds, null);
  assert.equal(s.ratePerHour, null);
  assert.deepEqual(await none.extend(3600), { error: "no host configured" });

  const priced = hostFromEnv({ FARM_HOST_RATE: "0.12" }, defaults);
  assert.equal((await priced.status()).ratePerHour, defaults.parseBase("0.12"));

  assert.throws(() => hostFromEnv({ FARM_HOST: "market" }, defaults), /FARM_HOST_MARKET and FARM_HOST_JOB_ID/);
  assert.throws(() => hostFromEnv({ FARM_HOST: "oyster" }, defaults), /OYSTER_JOB_ID/);
  assert.throws(() => hostFromEnv({ FARM_HOST: "aws" }, defaults), /unknown FARM_HOST/);

  const market = hostFromEnv({ FARM_HOST: "market", FARM_HOST_MARKET: "0x" + "11".repeat(20), FARM_HOST_JOB_ID: "0x" + "22".repeat(32) }, defaults);
  assert.equal(market.kind, "market");
  const oyster = hostFromEnv({ FARM_HOST: "oyster", OYSTER_JOB_ID: "0x" + "33".repeat(32) }, defaults);
  assert.equal(oyster.kind, "oyster");
  assert.equal(OYSTER.chainId, 42161);
});
