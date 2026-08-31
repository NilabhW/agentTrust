import { createHmac, timingSafeEqual } from "node:crypto";

const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function signWebhookPayload(rawBody: string | Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHex: string,
  secret: string
): boolean {
  if (!HEX_SHA256_PATTERN.test(signatureHex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const actual = Buffer.from(signatureHex, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
