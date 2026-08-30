import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sign, verify } from "../../src/mandate/signer";

const KEY = "test-signing-key-do-not-use-in-prod";
const payload = { mandate_id: "m1", user_id: "u1", amount: 100 };

describe("signer", () => {
  it("sign() produces a hex HMAC-SHA256 signature over the canonical payload", () => {
    const sig = sign(payload, KEY);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verify() returns true for a signature produced by sign() over the same payload and key", () => {
    const sig = sign(payload, KEY);
    expect(verify(payload, sig, KEY)).toBe(true);
  });

  it("verify() returns false if any single field in the payload changes", () => {
    const sig = sign(payload, KEY);
    expect(verify({ ...payload, amount: 101 }, sig, KEY)).toBe(false);
  });

  it("verify() returns false if the signature string is altered by one character", () => {
    const sig = sign(payload, KEY);
    const tampered = sig[0] === "0" ? "1" + sig.slice(1) : "0" + sig.slice(1);
    expect(verify(payload, tampered, KEY)).toBe(false);
  });

  it("verify() returns false if the wrong signing key is used", () => {
    const sig = sign(payload, KEY);
    expect(verify(payload, sig, "a-completely-different-key")).toBe(false);
  });

  it("verify() returns false (not throws) when the signature is not valid hex or wrong length", () => {
    expect(verify(payload, "not-hex-!!", KEY)).toBe(false);
    expect(verify(payload, "ab", KEY)).toBe(false);
  });

  it("no error thrown by sign/verify ever includes the raw signing key in its message", () => {
    const secret = "super-secret-signing-key-12345";
    try {
      sign(undefined as unknown as object, secret);
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(secret);
    }
    try {
      verify(undefined as unknown as object, "not-hex-!!", secret);
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(secret);
    }
  });
});

describe("config MANDATE_SIGNING_KEY", () => {
  const ORIGINAL = process.env.MANDATE_SIGNING_KEY;

  beforeEach(() => {
    delete process.env.MANDATE_SIGNING_KEY;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MANDATE_SIGNING_KEY;
    else process.env.MANDATE_SIGNING_KEY = ORIGINAL;
  });

  it("throws a descriptive error at startup if MANDATE_SIGNING_KEY is unset", async () => {
    vi.resetModules();
    await expect(async () => {
      await import("../../src/config");
    }).rejects.toThrow(/MANDATE_SIGNING_KEY/);
  });
});
