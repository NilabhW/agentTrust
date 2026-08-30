import { describe, it, expect } from "vitest";
import { validateCreateMandateInput } from "../../src/mandate/validation";
import { ValidationError } from "../../src/mandate/errors";

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    user_id: "user-1",
    agent_id: "agent-1",
    agent_public_key: "pubkey-abc",
    category: ["groceries"],
    max_per_transaction: 500,
    max_cumulative: 2000,
    rolling_window_seconds: 86400,
    expires_at: Date.now() + 1000 * 60 * 60 * 24,
    ...overrides,
  };
}

describe("validateCreateMandateInput", () => {
  it("accepts a fully valid create-mandate payload", () => {
    expect(() => validateCreateMandateInput(validPayload())).not.toThrow();
  });

  it("rejects a payload missing user_id", () => {
    const { user_id, ...rest } = validPayload();
    expect(() => validateCreateMandateInput(rest)).toThrow(ValidationError);
    expect(() => validateCreateMandateInput(rest)).toThrow(/user_id/);
  });

  it("rejects a payload missing agent_id", () => {
    const { agent_id, ...rest } = validPayload();
    expect(() => validateCreateMandateInput(rest)).toThrow(/agent_id/);
  });

  it("rejects a payload missing expires_at", () => {
    const { expires_at, ...rest } = validPayload();
    expect(() => validateCreateMandateInput(rest)).toThrow(/expires_at/);
  });

  it("rejects a payload missing agent_public_key", () => {
    const { agent_public_key, ...rest } = validPayload();
    expect(() => validateCreateMandateInput(rest)).toThrow(/agent_public_key/);
  });

  it("rejects a payload missing category", () => {
    const { category, ...rest } = validPayload();
    expect(() => validateCreateMandateInput(rest)).toThrow(/category/);
  });

  it("rejects a payload with an empty category array", () => {
    expect(() => validateCreateMandateInput(validPayload({ category: [] }))).toThrow(/category/);
  });

  it("rejects a category value outside the fixed enum", () => {
    expect(() =>
      validateCreateMandateInput(validPayload({ category: ["gambling"] }))
    ).toThrow(/category/);
  });

  it("rejects max_per_transaction that is zero or negative", () => {
    expect(() => validateCreateMandateInput(validPayload({ max_per_transaction: 0 }))).toThrow(
      /max_per_transaction/
    );
    expect(() => validateCreateMandateInput(validPayload({ max_per_transaction: -5 }))).toThrow(
      /max_per_transaction/
    );
  });

  it("rejects max_cumulative that is zero or negative", () => {
    expect(() => validateCreateMandateInput(validPayload({ max_cumulative: 0 }))).toThrow(
      /max_cumulative/
    );
  });

  it("rejects max_per_transaction that is not a finite number", () => {
    expect(() =>
      validateCreateMandateInput(validPayload({ max_per_transaction: NaN }))
    ).toThrow(/max_per_transaction/);
    expect(() =>
      validateCreateMandateInput(validPayload({ max_per_transaction: Infinity }))
    ).toThrow(/max_per_transaction/);
    expect(() =>
      validateCreateMandateInput(validPayload({ max_per_transaction: "500" }))
    ).toThrow(/max_per_transaction/);
  });

  it("rejects rolling_window_seconds that is zero, negative, or non-integer", () => {
    expect(() =>
      validateCreateMandateInput(validPayload({ rolling_window_seconds: 0 }))
    ).toThrow(/rolling_window_seconds/);
    expect(() =>
      validateCreateMandateInput(validPayload({ rolling_window_seconds: -1 }))
    ).toThrow(/rolling_window_seconds/);
    expect(() =>
      validateCreateMandateInput(validPayload({ rolling_window_seconds: 1.5 }))
    ).toThrow(/rolling_window_seconds/);
  });

  it("deduplicates repeated category values instead of erroring", () => {
    const result = validateCreateMandateInput(
      validPayload({ category: ["groceries", "groceries", "electronics"] })
    );
    expect(result.category.sort()).toEqual(["electronics", "groceries"]);
  });
});
