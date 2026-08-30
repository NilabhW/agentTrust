import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalBytes } from "./canonical";

const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function sign(payload: unknown, key: string): string {
  return createHmac("sha256", key).update(canonicalBytes(payload)).digest("hex");
}

export function verify(payload: unknown, signature: string, key: string): boolean {
  if (!HEX_SHA256_PATTERN.test(signature)) return false;
  const expected = Buffer.from(sign(payload, key), "hex");
  const actual = Buffer.from(signature, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
