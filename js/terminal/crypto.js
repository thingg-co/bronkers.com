// Genome commitment and envelopes, in the browser.
//
// canonicalize() is FROZEN and mirrors agent/src/genome.ts byte for byte:
// UTF-8, recursively sorted keys, no whitespace. Changing it would orphan
// every on-chain commitment.
//
// Two envelopes, matching the agent runtime:
//   v1 "authored": AES-256-GCM under a random key the minter keeps.
//   v2 "sealed":   ECIES over X25519 to the enclave's public key (HKDF-SHA256
//                  -> AES-256-GCM). Once sealed, nobody outside the enclave
//                  can open it — including the browser that sealed it.
import { keccak256, toBytes } from "https://esm.sh/viem@2.21.19";

const HKDF_INFO = "brokners-genome-v2";
// Owner-supplied credentials (an inference key) are sealed under their own
// info, so a credential can never be opened as a genome or the reverse.
// Mirrors agent/src/enclave.ts CREDENTIALS_INFO.
const CREDENTIALS_INFO = "brokners-credentials-v1";
const te = new TextEncoder();

export function canonicalize(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  return `{${Object.entries(v)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, x]) => `${JSON.stringify(k)}:${canonicalize(x)}`)
    .join(",")}}`;
}

export function commit(genome) {
  return keccak256(toBytes(canonicalize(genome)));
}

const b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (u8) => [...new Uint8Array(u8)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function aesGcmEncrypt(rawKey, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(plaintext)));
  return { iv: b64(iv), tag: b64(sealed.slice(-16)), ciphertext: b64(sealed.slice(0, -16)) };
}

/** Custody 0. Returns the envelope and the hex key the minter must keep. */
export async function authoredEnvelope(genome) {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const body = await aesGcmEncrypt(rawKey, JSON.stringify(genome));
  return { envelope: { v: 1, ...body }, keyHex: hex(rawKey) };
}

/** True if this browser can do X25519 + HKDF in WebCrypto (all current browsers). */
export async function canSeal() {
  try {
    await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
    return true;
  } catch {
    return false;
  }
}

async function eciesSeal(plaintext, enclavePublicKeyB64, info) {
  const enclavePub = await crypto.subtle.importKey("spki", unb64(enclavePublicKeyB64), { name: "X25519" }, false, []);
  const eph = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: enclavePub }, eph.privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const rawKey = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode(info) },
    hkdfKey,
    256,
  );
  const body = await aesGcmEncrypt(rawKey, plaintext);
  const epk = b64(await crypto.subtle.exportKey("spki", eph.publicKey));
  return { v: 2, mode: "sealed", epk, ...body };
}

/** Custody 1. Seals to the enclave public key (base64 SPKI DER, as printed by `genome keygen`). */
export function sealedEnvelope(genome, enclavePublicKeyB64) {
  return eciesSeal(JSON.stringify(genome), enclavePublicKeyB64, HKDF_INFO);
}

/**
 * An owner-supplied credential for one brain on one chain, sealed to the
 * enclave key under the credentials domain. `cred` is e.g.
 * { kind: "inference", provider: "anthropic", apiKey }; the binding
 * (v, chainId, tokenId, kind) is added here and checked by the farm, so a
 * credential published under another brain is refused. The key never leaves
 * this tab unencrypted.
 */
export function sealedCredential(cred, { chainId, tokenId }, enclavePublicKeyB64) {
  const bound = { v: 1, chainId: Number(chainId), tokenId: String(tokenId), ...cred, kind: cred.kind };
  return eciesSeal(JSON.stringify(bound), enclavePublicKeyB64, CREDENTIALS_INFO);
}

export function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
