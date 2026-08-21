import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { keccak256, toBytes, type Hex } from "viem";
import { unseal, type SealedEnvelope } from "./enclave.js";

/**
 * The trader genome: the secret prompt plus the tweaks that make the agent
 * unique. Only keccak256(canonicalize(genome)) ever touches the chain.
 *
 * CANONICALIZATION IS FROZEN: UTF-8, recursively sorted keys, no whitespace.
 * Changing this breaks every existing commitment — treat it like a consensus rule.
 */
export interface Genome {
  prompt: string;
  tweaks: Record<string, unknown>;
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function commit(genome: Genome): Hex {
  return keccak256(toBytes(canonicalize(genome)));
}

/**
 * SecretStore hides how the encrypted genome is held and released. Two
 * custody models exist:
 *  - AUTHORED (v1 envelope): symmetric AES-256-GCM; the key is handed to the
 *    buyer on sale (production: threshold encryption gated on ownerOf).
 *  - SEALED (v2 envelope): ECIES-sealed to the enclave key; no owner ever
 *    holds a decryption key — only the enclave runtime can open it.
 */
export interface SecretStore {
  decrypt(): Genome;
}

interface Envelope {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class LocalSecretStore implements SecretStore {
  constructor(
    private path: string,
    private keyHex: string,
  ) {}

  decrypt(): Genome {
    const env = JSON.parse(readFileSync(this.path, "utf8")) as Envelope;
    const key = Buffer.from(this.keyHex.replace(/^0x/, ""), "hex");
    if (key.length !== 32) throw new Error("GENOME_KEY must be 32 bytes of hex");
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
    d.setAuthTag(Buffer.from(env.tag, "base64"));
    const plain = Buffer.concat([d.update(Buffer.from(env.ciphertext, "base64")), d.final()]);
    return JSON.parse(plain.toString("utf8")) as Genome;
  }
}

/** Sealed custody: only the enclave private key can open the envelope. */
export class SealedSecretStore implements SecretStore {
  constructor(
    private path: string,
    private enclavePrivateKeyB64: string,
  ) {}

  decrypt(): Genome {
    const env = JSON.parse(readFileSync(this.path, "utf8")) as SealedEnvelope;
    if (!this.enclavePrivateKeyB64) throw new Error("sealed genome requires ENCLAVE_PRIVATE_KEY");
    return JSON.parse(unseal(env, this.enclavePrivateKeyB64)) as Genome;
  }
}

/** Pick the right store from the envelope on disk. */
export function openSecretStore(path: string, opts: { genomeKey?: string; enclaveKey?: string }): SecretStore {
  const env = JSON.parse(readFileSync(path, "utf8")) as { v?: number; mode?: string };
  if (env.v === 2 && env.mode === "sealed") return new SealedSecretStore(path, opts.enclaveKey ?? "");
  return new LocalSecretStore(path, opts.genomeKey ?? "");
}

export function encryptGenome(genome: Genome, keyHex?: string): { envelope: Envelope; keyHex: string } {
  const key = keyHex ? Buffer.from(keyHex.replace(/^0x/, ""), "hex") : randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([c.update(JSON.stringify(genome), "utf8"), c.final()]);
  return {
    envelope: {
      v: 1,
      iv: iv.toString("base64"),
      tag: c.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    },
    keyHex: key.toString("hex"),
  };
}
