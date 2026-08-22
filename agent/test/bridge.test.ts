import assert from "node:assert/strict";
import { test } from "node:test";
import { CCTP, DOMAINS, fetchAttestation, isTestnetChain, planBridge, USDC } from "../src/bridge.js";

const me = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

test("planBridge: Polygon -> Arbitrum One uses the mainnet contracts and domains 7 -> 3", () => {
  const p = planBridge(137, 42161, me);
  assert.equal(p.env, "mainnet");
  assert.equal(p.sourceDomain, 7);
  assert.equal(p.destinationDomain, 3);
  assert.equal(p.tokenMessenger, CCTP.mainnet.tokenMessenger);
  assert.equal(p.messageTransmitter, CCTP.mainnet.messageTransmitter);
  assert.equal(p.burnToken, USDC[137]);
  assert.equal(p.mintRecipient.toLowerCase(), `0x000000000000000000000000${me.slice(2).toLowerCase()}`);
  assert.equal(p.iris, "https://iris-api.circle.com");
});

test("planBridge: Amoy -> Arbitrum Sepolia is the testnet rehearsal; mixing environments is refused", () => {
  const p = planBridge(80002, 421614, me);
  assert.equal(p.env, "testnet");
  assert.equal(p.sourceDomain, DOMAINS[80002]);
  assert.equal(p.tokenMessenger, CCTP.testnet.tokenMessenger);
  assert.equal(p.iris, "https://iris-api-sandbox.circle.com");
  assert.ok(isTestnetChain(80002) && !isTestnetChain(137));
  assert.throws(() => planBridge(137, 421614, me), /both be mainnet or both testnet/);
  assert.throws(() => planBridge(31337, 42161, me), /no CCTP domain/);
});

test("fetchAttestation polls Iris until the message is complete", async () => {
  let calls = 0;
  const fetchImpl = (async (url: string) => {
    calls++;
    assert.match(url, /\/v2\/messages\/7\?transactionHash=0xabc$/);
    const body = calls < 3
      ? { messages: [{ message: "0x01", attestation: null, status: "pending_confirmations" }] }
      : { messages: [{ message: "0x01", attestation: "0x02", status: "complete" }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await fetchAttestation("https://iris", 7, "0xabc", { fetchImpl, intervalMs: 1, timeoutMs: 5_000 });
  assert.deepEqual(r, { message: "0x01", attestation: "0x02" });
  assert.equal(calls, 3);
  // 404 means "not indexed yet" and is retried; other errors surface
  const notFound = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(fetchAttestation("https://iris", 7, "0xabc", { fetchImpl: notFound, intervalMs: 1, timeoutMs: 5 }), /did not complete/);
  const broken = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(fetchAttestation("https://iris", 7, "0xabc", { fetchImpl: broken, intervalMs: 1, timeoutMs: 50 }), /iris 500/);
});
