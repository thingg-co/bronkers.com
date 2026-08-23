import { z } from "zod";
import { CREDENTIALS_INFO, seal, unseal, type SealedEnvelope } from "./enclave.js";

/**
 * Owner-supplied credentials for a brain ("bring your own key").
 *
 * An owner seals a credential in the browser to the enclave's public key
 * (js/terminal/crypto.js, byte-compatible with seal() here under
 * CREDENTIALS_INFO) and publishes it through Credentials.publish as an event.
 * The farm opens it in-process, checks that it was sealed for this brain on
 * this chain, and uses it for nothing but the one job its kind names. The
 * plaintext is never written, logged, or put in a transcript, and it is held
 * only for as long as the brain is running under this key.
 *
 * Kinds the farm understands:
 *   inference — the model is called on the owner's account. provider
 *     "anthropic" (Anthropic's API with the owner's key) or "gateway" (an
 *     OpenAI-compatible endpoint with the owner's key). The endpoint host must
 *     be on the operator's allowlist: a sealed brain's prompt goes to whatever
 *     host answers, so an owner may bring a key, not an arbitrary endpoint
 *     (otherwise sealed custody would leak through the inference URL).
 *
 * Anything else is carried opaque: the contract does not care, and a farm that
 * does not know a kind leaves it unused.
 */

export const INFERENCE_KIND = "inference";

export const InferenceCredential = z.object({
  kind: z.literal("inference"),
  provider: z.enum(["anthropic", "gateway"]),
  apiKey: z.string().min(8).max(4096),
  baseUrl: z.string().url().optional(),
});
export type InferenceCredential = z.infer<typeof InferenceCredential>;

/** What every credential plaintext carries besides its payload: the binding to one brain on one chain. */
export const CredentialBinding = z.object({
  v: z.literal(1),
  chainId: z.number().int().positive(),
  tokenId: z.string().regex(/^\d+$/),
  kind: z.string().min(1).max(64),
});

export type Credential = z.infer<typeof CredentialBinding> & Record<string, unknown>;

/** Seal a credential for one brain (the CLI and tests; the browser does the same in crypto.js). */
export function sealCredential(cred: Credential, enclavePublicKeyB64: string): SealedEnvelope {
  CredentialBinding.parse(cred);
  return seal(JSON.stringify(cred), enclavePublicKeyB64, CREDENTIALS_INFO);
}

/**
 * Open a credential and check it was sealed for this brain on this chain and
 * for the kind it was published under. Throws with a reason that is safe to log
 * (the plaintext is never included).
 */
export function openCredential(
  env: SealedEnvelope,
  enclavePrivateKeyB64: string,
  expect: { chainId: number; tokenId: bigint; kind: string },
): Credential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unseal(env, enclavePrivateKeyB64, CREDENTIALS_INFO));
  } catch {
    throw new Error("credential does not open with this enclave key");
  }
  const b = CredentialBinding.safeParse(parsed);
  if (!b.success) throw new Error("credential is not in the expected format");
  if (b.data.chainId !== expect.chainId) throw new Error(`credential was sealed for chain ${b.data.chainId}, not ${expect.chainId}`);
  if (b.data.tokenId !== expect.tokenId.toString()) throw new Error(`credential was sealed for brain #${b.data.tokenId}, not #${expect.tokenId}`);
  if (b.data.kind !== expect.kind) throw new Error(`credential is of kind "${b.data.kind}", published as "${expect.kind}"`);
  return parsed as Credential;
}

/** The hosts an owner's inference key may be sent to: Anthropic, the operator's own gateway, and FARM_INFERENCE_HOSTS. */
export function allowedInferenceHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const hosts = new Set<string>(["api.anthropic.com"]);
  const gw = env.INFERENCE_BASE_URL;
  if (gw) {
    try {
      hosts.add(new URL(gw).host);
    } catch {}
  }
  for (const h of (env.FARM_INFERENCE_HOSTS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) hosts.add(h);
  return hosts;
}

/**
 * Validate an inference credential against the operator's policy. Returns the
 * credential to hand to createBrain, or throws a loggable reason. The base URL
 * must be https (plain http only for loopback, for the dev gateway), carry no
 * userinfo, and sit on an allowed host.
 */
export function checkInference(cred: Credential, env: NodeJS.ProcessEnv = process.env): InferenceCredential {
  const r = InferenceCredential.safeParse(cred);
  if (!r.success) throw new Error("inference credential is missing fields (provider, apiKey)");
  const c = r.data;
  if (c.provider === "gateway" && !c.baseUrl) {
    if (!env.INFERENCE_BASE_URL) throw new Error("gateway credential has no baseUrl and this farm has no INFERENCE_BASE_URL");
    c.baseUrl = env.INFERENCE_BASE_URL;
  }
  if (c.baseUrl) {
    const u = new URL(c.baseUrl);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new Error("inference baseUrl must be https");
    if (u.username || u.password) throw new Error("inference baseUrl must not carry credentials");
    if (!allowedInferenceHosts(env).has(u.host)) throw new Error(`inference host ${u.host} is not on this farm's allowlist (FARM_INFERENCE_HOSTS)`);
  }
  return c;
}
