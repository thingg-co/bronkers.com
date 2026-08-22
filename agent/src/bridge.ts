import "dotenv/config";
import { pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, defineChain, formatUnits, http, pad, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { cctpAbi, erc20Abi } from "./abi.js";

/**
 * Moving fee income to where the machine is paid: Circle CCTP v2, USDC burned
 * on the protocol chain (Polygon) and minted to the same key on the host
 * chain (Arbitrum One, where the Oyster market is). Three steps: approve +
 * depositForBurn on the source TokenMessengerV2, fetch the attestation from
 * Circle's Iris API, receiveMessage on the destination MessageTransmitterV2.
 *
 * Addresses and domains are Circle's published v2 values (one address per
 * environment across EVM chains). The testnet rehearsal is Amoy -> Arbitrum
 * Sepolia with faucet USDC; it has no protocol meaning there because the
 * protocol's testnet base asset is a mock token, not Circle's USDC. This
 * path matters on mainnet only, which is gated. `npm run bridge -- --amount
 * 10 --to 42161 --dry-run` prints what it would do without signing.
 */

export const CCTP = {
  mainnet: {
    tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" as Address,
    messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64" as Address,
    iris: "https://iris-api.circle.com",
  },
  testnet: {
    tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as Address,
    messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as Address,
    iris: "https://iris-api-sandbox.circle.com",
  },
};

/** CCTP domain ids by EVM chain id. */
export const DOMAINS: Record<number, number> = {
  1: 0, 43114: 1, 10: 2, 42161: 3, 8453: 6, 137: 7, // mainnets
  11155111: 0, 43113: 1, 11155420: 2, 421614: 3, 84532: 6, 80002: 7, // testnets
};

/** Circle-issued USDC by chain id (the only token CCTP moves). */
export const USDC: Record<number, Address> = {
  137: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  80002: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
  421614: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
};

export const FINALITY_FAST = 1000;
export const FINALITY_STANDARD = 2000;

export const isTestnetChain = (chainId: number) => [11155111, 43113, 11155420, 421614, 84532, 80002].includes(chainId);

export interface BridgePlan {
  env: "mainnet" | "testnet";
  sourceDomain: number;
  destinationDomain: number;
  tokenMessenger: Address;
  messageTransmitter: Address;
  burnToken: Address;
  mintRecipient: Hex; // bytes32 left-padded address
  iris: string;
}

/** Pure: everything the transfer needs, or a reason it cannot be planned. */
export function planBridge(fromChainId: number, toChainId: number, recipient: Address): BridgePlan {
  const env = isTestnetChain(fromChainId) ? "testnet" : "mainnet";
  if (isTestnetChain(toChainId) !== (env === "testnet")) throw new Error("bridge: source and destination must both be mainnet or both testnet");
  const sourceDomain = DOMAINS[fromChainId];
  const destinationDomain = DOMAINS[toChainId];
  if (sourceDomain === undefined || destinationDomain === undefined) throw new Error(`bridge: no CCTP domain for chain ${fromChainId} -> ${toChainId}`);
  const burnToken = USDC[fromChainId];
  if (!burnToken) throw new Error(`bridge: no known USDC on chain ${fromChainId}`);
  const c = CCTP[env];
  return { env, sourceDomain, destinationDomain, tokenMessenger: c.tokenMessenger, messageTransmitter: c.messageTransmitter, burnToken, mintRecipient: pad(recipient, { size: 32 }), iris: c.iris };
}

interface IrisMessage {
  message: Hex;
  attestation: Hex | null;
  status: "complete" | "pending_confirmations";
}

/** Poll Iris until the attestation for a burn tx is complete. */
export async function fetchAttestation(iris: string, sourceDomain: number, txHash: Hex, opts: { timeoutMs?: number; intervalMs?: number; fetchImpl?: typeof fetch } = {}): Promise<{ message: Hex; attestation: Hex }> {
  const f = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  while (Date.now() < deadline) {
    const res = await f(`${iris}/v2/messages/${sourceDomain}?transactionHash=${txHash}`);
    if (res.ok) {
      const json = (await res.json()) as { messages?: IrisMessage[] };
      const m = json.messages?.[0];
      if (m && m.status === "complete" && m.attestation) return { message: m.message, attestation: m.attestation };
    } else if (res.status !== 404) {
      throw new Error(`iris ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 10_000));
  }
  throw new Error("bridge: attestation did not complete in time");
}

export interface BridgeArgs {
  fromRpc: string;
  fromChainId: number;
  toRpc: string;
  toChainId: number;
  key: Hex;
  amount: bigint; // USDC units (6 decimals)
  maxFee?: bigint;
  finality?: number;
  dryRun?: boolean;
  log?: (s: string) => void;
}

export async function bridge(a: BridgeArgs): Promise<{ burnTx: Hex | null; mintTx: Hex | null }> {
  const log = a.log ?? console.log;
  const account = privateKeyToAccount(a.key);
  const plan = planBridge(a.fromChainId, a.toChainId, account.address);
  log(`bridge: ${formatUnits(a.amount, 6)} USDC chain ${a.fromChainId} (domain ${plan.sourceDomain}) -> chain ${a.toChainId} (domain ${plan.destinationDomain}) for ${account.address} [${plan.env}]`);
  if (a.dryRun) {
    log(`bridge: would approve ${plan.tokenMessenger} on ${plan.burnToken}, then depositForBurn(amount, ${plan.destinationDomain}, ${plan.mintRecipient}, ${plan.burnToken}, 0x0, ${a.maxFee ?? 0n}, ${a.finality ?? FINALITY_STANDARD}); then receiveMessage on ${plan.messageTransmitter} with the attestation from ${plan.iris}`);
    return { burnTx: null, mintTx: null };
  }
  const src = defineChain({ id: a.fromChainId, name: "source", nativeCurrency: { name: "n", symbol: "N", decimals: 18 }, rpcUrls: { default: { http: [a.fromRpc] } } });
  const dst = defineChain({ id: a.toChainId, name: "destination", nativeCurrency: { name: "n", symbol: "N", decimals: 18 }, rpcUrls: { default: { http: [a.toRpc] } } });
  const srcPub = createPublicClient({ chain: src, transport: http(a.fromRpc) });
  const srcWallet = createWalletClient({ account, chain: src, transport: http(a.fromRpc) });
  const dstPub = createPublicClient({ chain: dst, transport: http(a.toRpc) });
  const dstWallet = createWalletClient({ account, chain: dst, transport: http(a.toRpc) });

  const allowance = await srcPub.readContract({ address: plan.burnToken, abi: erc20Abi, functionName: "allowance", args: [account.address, plan.tokenMessenger] });
  if (allowance < a.amount) {
    const { request } = await srcPub.simulateContract({ account, address: plan.burnToken, abi: erc20Abi, functionName: "approve", args: [plan.tokenMessenger, a.amount] });
    await srcPub.waitForTransactionReceipt({ hash: await srcWallet.writeContract(request) });
    log("bridge: approved");
  }
  const { request: burn } = await srcPub.simulateContract({
    account,
    address: plan.tokenMessenger,
    abi: cctpAbi,
    functionName: "depositForBurn",
    args: [a.amount, plan.destinationDomain, plan.mintRecipient, plan.burnToken, pad("0x", { size: 32 }), a.maxFee ?? 0n, a.finality ?? FINALITY_STANDARD],
  });
  const burnTx = await srcWallet.writeContract(burn);
  await srcPub.waitForTransactionReceipt({ hash: burnTx });
  log(`bridge: burned ${burnTx}; waiting for Circle's attestation`);
  const { message, attestation } = await fetchAttestation(plan.iris, plan.sourceDomain, burnTx);
  const { request: mint } = await dstPub.simulateContract({ account, address: plan.messageTransmitter, abi: cctpAbi, functionName: "receiveMessage", args: [message, attestation] });
  const mintTx = await dstWallet.writeContract(mint);
  await dstPub.waitForTransactionReceipt({ hash: mintTx });
  log(`bridge: minted on chain ${a.toChainId} ${mintTx}`);
  return { burnTx, mintTx };
}

// ---- CLI: npm run bridge -- --amount 10 --to 42161 [--dry-run] ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const amount = flag("amount");
  if (!amount) {
    console.error("usage: npm run bridge -- --amount <usdc> --to <chainId> [--dry-run]   (env: RPC_URL, BRIDGE_TO_RPC_URL, EXECUTOR_PRIVATE_KEY)");
    process.exit(1);
  }
  const fromRpc = process.env.RPC_URL ?? "http://127.0.0.1:8545";
  const toChainId = Number(flag("to") ?? 42161);
  const toRpc = process.env.BRIDGE_TO_RPC_URL ?? (toChainId === 42161 ? "https://arb1.arbitrum.io/rpc" : toChainId === 421614 ? "https://sepolia-rollup.arbitrum.io/rpc" : "");
  const key = process.env.EXECUTOR_PRIVATE_KEY as Hex;
  if (!key) throw new Error("EXECUTOR_PRIVATE_KEY is the bridging key");
  const fromChainId = await createPublicClient({ transport: http(fromRpc) }).getChainId();
  await bridge({ fromRpc, fromChainId, toRpc, toChainId, key, amount: parseUnits(amount, 6), dryRun: args.includes("--dry-run") });
}
