import { describe, it, expect } from "vitest";
import { validateVerifyRequestBody } from "../../src/gateway/validation";
import { GatewayValidationError } from "../../src/gateway/errors";

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    mandate_id: "mandate-1",
    agent_signature: "a".repeat(128),
    amount: 100,
    category: "groceries",
    item_description: "weekly groceries",
    timestamp: Date.now(),
    nonce: "nonce-1",
    ...overrides,
  };
}

describe("validateVerifyRequestBody", () => {
  it("returns a fully-typed VerifyRequestBody on valid input", () => {
    expect(() => validateVerifyRequestBody(validBody())).not.toThrow();
  });

  for (const field of [
    "mandate_id",
    "agent_signature",
    "amount",
    "category",
    "item_description",
    "timestamp",
    "nonce",
  ]) {
    it(`throws GatewayValidationError with a field-specific message when ${field} is missing`, () => {
      const { [field]: _omit, ...rest } = validBody() as Record<string, unknown>;
      expect(() => validateVerifyRequestBody(rest)).toThrow(GatewayValidationError);
      expect(() => validateVerifyRequestBody(rest)).toThrow(new RegExp(field));
    });
  }

  it("throws for a category outside the fixed enum", () => {
    expect(() => validateVerifyRequestBody(validBody({ category: "gambling" }))).toThrow(
      GatewayValidationError
    );
  });

  it("throws for a non-positive or non-finite amount", () => {
    expect(() => validateVerifyRequestBody(validBody({ amount: 0 }))).toThrow(GatewayValidationError);
    expect(() => validateVerifyRequestBody(validBody({ amount: -5 }))).toThrow(GatewayValidationError);
    expect(() => validateVerifyRequestBody(validBody({ amount: NaN }))).toThrow(GatewayValidationError);
  });

  it("throws for a non-positive-integer timestamp", () => {
    expect(() => validateVerifyRequestBody(validBody({ timestamp: -1 }))).toThrow(GatewayValidationError);
    expect(() => validateVerifyRequestBody(validBody({ timestamp: 1.5 }))).toThrow(GatewayValidationError);
    expect(() => validateVerifyRequestBody(validBody({ timestamp: "not-a-number" }))).toThrow(
      GatewayValidationError
    );
  });

  it("throws for a non-string mandate_id, agent_signature, item_description, or nonce", () => {
    expect(() => validateVerifyRequestBody(validBody({ mandate_id: 123 }))).toThrow(GatewayValidationError);
    expect(() => validateVerifyRequestBody(validBody({ agent_signature: 123 }))).toThrow(
      GatewayValidationError
    );
    expect(() => validateVerifyRequestBody(validBody({ item_description: 123 }))).toThrow(
      GatewayValidationError
    );
    expect(() => validateVerifyRequestBody(validBody({ nonce: 123 }))).toThrow(GatewayValidationError);
  });
});
