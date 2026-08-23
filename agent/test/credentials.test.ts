import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedInferenceHosts, checkInference, openCredential, sealCredential } from "../src/credentials.js";
import { enclaveKeygen, seal, unseal } from "../src/enclave.js";

const { publicKeyB64: pub, privateKeyB64: priv } = enclaveKeygen();
const cred = { v: 1 as const, chainId: 31337, tokenId: "7", kind: "inference", provider: "anthropic", apiKey: "sk-ant-test-0123456789" };

test("a credential opens only for the brain, chain, and kind it was sealed for", () => {
  const env = sealCredential(cred, pub);
  const out = openCredential(env, priv, { chainId: 31337, tokenId: 7n, kind: "inference" });
  assert.equal(out.apiKey, cred.apiKey);
  assert.throws(() => openCredential(env, priv, { chainId: 80002, tokenId: 7n, kind: "inference" }), /chain 31337/);
  assert.throws(() => openCredential(env, priv, { chainId: 31337, tokenId: 8n, kind: "inference" }), /brain #7/);
  assert.throws(() => openCredential(env, priv, { chainId: 31337, tokenId: 7n, kind: "data" }), /kind "inference"/);
  const other = enclaveKeygen();
  assert.throws(() => openCredential(env, other.privateKeyB64, { chainId: 31337, tokenId: 7n, kind: "inference" }), /does not open/);
});

test("credential and genome envelopes are domain-separated", () => {
  // a genome envelope cannot be opened as a credential, nor a credential as a genome
  const genomeEnv = seal(JSON.stringify({ prompt: "x", tweaks: {} }), pub);
  assert.throws(() => openCredential(genomeEnv, priv, { chainId: 31337, tokenId: 7n, kind: "inference" }), /does not open/);
  const credEnv = sealCredential(cred, pub);
  assert.throws(() => unseal(credEnv, priv));
});

test("inference credentials are checked against the operator's host policy", () => {
  const env = { INFERENCE_BASE_URL: "https://gw.example.com/v1", FARM_INFERENCE_HOSTS: "inference.partner.io" };
  assert.deepEqual([...allowedInferenceHosts(env)].sort(), ["api.anthropic.com", "gw.example.com", "inference.partner.io"]);
  // anthropic key, no url
  assert.equal(checkInference({ ...cred }, env).provider, "anthropic");
  // gateway key defaults to the farm's gateway
  assert.equal(checkInference({ ...cred, provider: "gateway", apiKey: "gw-key-12345678" }, env).baseUrl, "https://gw.example.com/v1");
  // an allowed partner host is fine; an arbitrary one is not (the sealed prompt would go there)
  assert.equal(checkInference({ ...cred, provider: "gateway", baseUrl: "https://inference.partner.io/v1" }, env).baseUrl, "https://inference.partner.io/v1");
  assert.throws(() => checkInference({ ...cred, provider: "gateway", baseUrl: "https://evil.example.net/v1" }, env), /allowlist/);
  assert.throws(() => checkInference({ ...cred, provider: "gateway", baseUrl: "http://gw.example.com/v1" }, env), /https/);
  assert.throws(() => checkInference({ ...cred, provider: "gateway", baseUrl: "https://u:p@gw.example.com/v1" }, env), /credentials/);
  assert.throws(() => checkInference({ ...cred, apiKey: "short" }, env), /missing fields/);
  // a dev gateway on loopback may be plain http
  assert.equal(checkInference({ ...cred, provider: "gateway", baseUrl: "http://127.0.0.1:8000/v1" }, { FARM_INFERENCE_HOSTS: "127.0.0.1:8000" }).baseUrl, "http://127.0.0.1:8000/v1");
});
