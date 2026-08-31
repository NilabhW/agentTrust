import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signWebhookPayload, verifyWebhookSignature } from "../../src/razorpay/webhook-signature";

const SECRET = "test-webhook-secret";

function sign(body: string, secret: string = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ event: "order.paid" });
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ event: "order.paid" });
    const signature = sign(body);
    const tampered = JSON.stringify({ event: "payment.failed" });
    expect(verifyWebhookSignature(tampered, signature, SECRET)).toBe(false);
  });

  it("rejects a signature produced with the wrong secret", () => {
    const body = JSON.stringify({ event: "order.paid" });
    const signature = sign(body, "wrong-secret");
    expect(verifyWebhookSignature(body, signature, SECRET)).toBe(false);
  });

  it("rejects a malformed signature format without throwing", () => {
    const body = JSON.stringify({ event: "order.paid" });
    expect(() => verifyWebhookSignature(body, "not-hex-!!!", SECRET)).not.toThrow();
    expect(verifyWebhookSignature(body, "not-hex-!!!", SECRET)).toBe(false);
  });

  it("rejects an empty signature", () => {
    const body = JSON.stringify({ event: "order.paid" });
    expect(verifyWebhookSignature(body, "", SECRET)).toBe(false);
  });

  it("works against a Buffer body identically to the equivalent string", () => {
    const body = JSON.stringify({ event: "order.paid" });
    const signature = sign(body);
    expect(verifyWebhookSignature(Buffer.from(body, "utf8"), signature, SECRET)).toBe(true);
  });
});

describe("signWebhookPayload", () => {
  it("produces a signature that verifyWebhookSignature accepts", () => {
    const body = JSON.stringify({ event: "payment.failed" });
    const signature = signWebhookPayload(body, SECRET);
    expect(verifyWebhookSignature(body, signature, SECRET)).toBe(true);
  });

  it("matches a manually computed HMAC-SHA256 hex digest", () => {
    const body = JSON.stringify({ event: "order.paid" });
    expect(signWebhookPayload(body, SECRET)).toBe(sign(body));
  });
});
