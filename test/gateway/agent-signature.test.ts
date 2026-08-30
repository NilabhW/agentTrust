import { describe, it, expect } from "vitest";
import {
  generateAgentKeypair,
  signAgentRequest,
  verifyAgentSignature,
  AgentSignedPayload,
} from "../../src/gateway/agent-signature";

function validPayload(overrides: Partial<AgentSignedPayload> = {}): AgentSignedPayload {
  return {
    mandate_id: "mandate-1",
    amount: 100,
    category: "groceries",
    item_description: "weekly groceries",
    timestamp: Date.now(),
    nonce: "nonce-1",
    ...overrides,
  };
}

describe("generateAgentKeypair", () => {
  it("produces a 43-character base64url public key", () => {
    const { publicKey } = generateAgentKeypair();
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("signAgentRequest / verifyAgentSignature", () => {
  it("verifies a signature produced by signAgentRequest over the same payload and matching keypair", () => {
    const { publicKey, privateKeyJwk } = generateAgentKeypair();
    const payload = validPayload();
    const signature = signAgentRequest(payload, privateKeyJwk);
    expect(verifyAgentSignature(payload, signature, publicKey)).toBe(true);
  });

  it("produces a 128-character hex signature", () => {
    const { privateKeyJwk } = generateAgentKeypair();
    const signature = signAgentRequest(validPayload(), privateKeyJwk);
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
  });

  it("returns false when any field in the signed payload changes after signing", () => {
    const { publicKey, privateKeyJwk } = generateAgentKeypair();
    const payload = validPayload();
    const signature = signAgentRequest(payload, privateKeyJwk);
    expect(verifyAgentSignature({ ...payload, amount: 101 }, signature, publicKey)).toBe(false);
  });

  it("returns false when the signature was produced by a different keypair", () => {
    const { privateKeyJwk } = generateAgentKeypair();
    const { publicKey: unrelatedPublicKey } = generateAgentKeypair();
    const payload = validPayload();
    const signature = signAgentRequest(payload, privateKeyJwk);
    expect(verifyAgentSignature(payload, signature, unrelatedPublicKey)).toBe(false);
  });

  it("returns false (not throws) for a public key that isn't valid base64url of the right length", () => {
    const { privateKeyJwk } = generateAgentKeypair();
    const payload = validPayload();
    const signature = signAgentRequest(payload, privateKeyJwk);
    expect(verifyAgentSignature(payload, signature, "not-a-valid-key")).toBe(false);
    expect(verifyAgentSignature(payload, signature, "")).toBe(false);
  });

  it("returns false (not throws) for a well-formed-length but bogus public key", () => {
    const { privateKeyJwk } = generateAgentKeypair();
    const payload = validPayload();
    const signature = signAgentRequest(payload, privateKeyJwk);
    const bogusKey = "A".repeat(43);
    expect(verifyAgentSignature(payload, signature, bogusKey)).toBe(false);
  });

  it("returns false (not throws) for a signature that isn't valid hex or the wrong length", () => {
    const { publicKey } = generateAgentKeypair();
    const payload = validPayload();
    expect(verifyAgentSignature(payload, "not-hex-!!", publicKey)).toBe(false);
    expect(verifyAgentSignature(payload, "ab", publicKey)).toBe(false);
  });

  it("verification is independent of the JS object's key order (canonicalization exercised end-to-end)", () => {
    const { publicKey, privateKeyJwk } = generateAgentKeypair();
    const payload = validPayload();
    const signature = signAgentRequest(payload, privateKeyJwk);
    const reordered: AgentSignedPayload = {
      nonce: payload.nonce,
      timestamp: payload.timestamp,
      item_description: payload.item_description,
      category: payload.category,
      amount: payload.amount,
      mandate_id: payload.mandate_id,
    };
    expect(verifyAgentSignature(reordered, signature, publicKey)).toBe(true);
  });
});
