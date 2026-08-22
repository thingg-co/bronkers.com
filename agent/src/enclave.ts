import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * Sealed-genome custody (prototype of the enclave model).
 *
 * A genome sealed to the enclave public key can only be opened by the holder
 * of the enclave private key — in production a TEE (e.g. AWS Nitro) whose key
 * never leaves the enclave and whose attestation proves the runtime never
 * exposes plaintext. In this prototype the "enclave" is the agent process and
 * the key sits in an env var: the cryptography is real, the hardware isolation
 * is the documented trust gap.
 *
 * Scheme: ECIES over X25519 — ephemeral keypair per seal, ECDH shared secret,
 * HKDF-SHA256 -> AES-256-GCM key. The sealer keeps nothing: once sealed,
 * even the sealer cannot decrypt (they may or may not remember the plaintext —
 * that distinction is the on-chain custody trait).
 */

export interface SealedEnvelope {
  v: 2;
  mode: "sealed";
  epk: string; // ephemeral X25519 public key, base64 SPKI DER
  iv: string;
  tag: string;
  ciphertext: string;
}

const HKDF_INFO = "brokners-genome-v2";

export function enclaveKeygen(): { publicKeyB64: string; privateKeyB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKeyB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKeyB64: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

function deriveKey(shared: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), HKDF_INFO, 32));
}

export function seal(plaintext: string, enclavePublicKeyB64: string): SealedEnvelope {
  const enclavePub = createPublicKey({
    key: Buffer.from(enclavePublicKeyB64, "base64"),
    type: "spki",
    format: "der",
  });
  const ephemeral = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: enclavePub });
  const key = deriveKey(shared);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return {
    v: 2,
    mode: "sealed",
    epk: ephemeral.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function unseal(env: SealedEnvelope, enclavePrivateKeyB64: string): string {
  const enclavePriv = createPrivateKey({
    key: Buffer.from(enclavePrivateKeyB64, "base64"),
    type: "pkcs8",
    format: "der",
  });
  const epk = createPublicKey({ key: Buffer.from(env.epk, "base64"), type: "spki", format: "der" });
  const shared = diffieHellman({ privateKey: enclavePriv, publicKey: epk });
  const key = deriveKey(shared);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
  d.setAuthTag(Buffer.from(env.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(env.ciphertext, "base64")), d.final()]).toString("utf8");
}
